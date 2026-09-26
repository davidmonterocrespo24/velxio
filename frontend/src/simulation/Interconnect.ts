/**
 * Cross-board interconnect router.
 *
 * Reactive subsystem that watches `useSimulatorStore.wires` and
 * `useSimulatorStore.boards` and propagates digital pin transitions
 * between boards along the wires the user drew. UART, I2C, SPI, and
 * SoftwareSerial protocols all "just work" on top of pin propagation
 * because each board's hardware peripherals decode the actual
 * transitions. For cross-process boards (ESP32 backend QEMU, Pi3B
 * QEMU) it additionally enables a byte-level shortcut on hardware
 * UART pins so that high-baud links don't drop bytes when the
 * WebSocket round-trip would be too slow for bit-level transport.
 *
 * Design:
 *   - Singleton `interconnect`. The store calls `bindBoard` /
 *     `unbindBoard` from `addBoard` / `removeBoard`, and the wires
 *     array drives route resolution via `updateWires`.
 *   - For browser-side simulators (AVR, RP2040, Esp32C3, RiscV) we
 *     subscribe to each board's `PinManager.onPinChange` and forward
 *     to the other endpoint's `setPinState`.
 *   - For ESP32 / Pi3B bridges, we install fan-out callbacks on
 *     `bridge.onPinChange` and `bridge.onSerialData` (overwriting
 *     the bridge's single-callback slot — the store's serial-monitor
 *     plumbing is preserved by chaining the previous callback).
 *   - Re-entrancy guard: a `Set` of `${boardId}:${pin}` keys flagged
 *     during synchronous propagation prevents the reverse hop from
 *     firing a feedback echo.
 */

import type { BoardKind } from '../types/board';
import type { Wire } from '../types/wire';
import { boardPinToNumber } from '../utils/boardPinMapping';
import { classifyPin, isUartWire } from '../utils/boardProtocols';
import {
  resolveCrossBoardChipNets,
  type ChipNetState,
  type CrossBoardChipNet,
} from './customChips/chipNets';

// ── Bridge / sim runtime references ──────────────────────────────────────────
//
// Provided by the store via setRuntimeAccessors() to avoid a circular
// import. The store exports `getBoardSimulator`, `getBoardPinManager`,
// `getBoardBridge`, `getEsp32Bridge` — we need them at runtime.

interface RuntimeAccessors {
  getBoardSimulator: (id: string) => any | undefined;
  getBoardPinManager: (id: string) => any | undefined;
  getBoardBridge: (id: string) => any | undefined; // Pi3B
  getEsp32Bridge: (id: string) => any | undefined;
  getStm32Bridge: (id: string) => any | undefined;
  /** The diagram as chipNets.ts reads it (wires, components, boards), for
   *  the cross-board chip-net links. Optional: a runtime without it has no
   *  such links, which is what every caller before this seam had. */
  getChipNetState?: () => ChipNetState | null;
}

let runtime: RuntimeAccessors | null = null;

export function setInterconnectRuntime(r: RuntimeAccessors): void {
  runtime = r;
}

// ── Internal types ───────────────────────────────────────────────────────────

type BoardKindOrId = string;

interface BoardEntry {
  id: string;
  kind: BoardKind;
  /** Original onSerialData (so we don't clobber the store's serial-monitor) */
  origSerialCallback?: ((ch: string, uart?: number) => void) | null;
  /** Original bridge.onPinChange (so we don't clobber whatever the store wired) */
  origPinChangeCallback?: ((pin: number, state: boolean) => void) | null;
  /** Per-pin fan-out map (used for bridges where only one onPinChange slot exists) */
  pinChangeFanout: Map<number, Set<(state: boolean) => void>>;
  /** Per-uart fan-out for serial output bytes from this board */
  serialFanout: Map<number, Set<(ch: string) => void>>;
  /** Pin propagation listeners we installed on PinManager — call to unsubscribe */
  pinUnsubs: Array<() => void>;
}

interface RouteHandle {
  wireId: string;
  teardown: () => void;
}

const boards = new Map<string, BoardEntry>();
const routes = new Map<string, RouteHandle>();
const propagatingPins = new Set<string>(); // re-entrancy guard

// ── Cross-board chip nets ────────────────────────────────────────────────────
//
// A chip-to-chip net with chips on two boards (see resolveCrossBoardChipNets).
// Browser-hosted endpoints live on their board's PinManager under one shared
// synthetic key; a worker-hosted board (ESP32 QEMU, STM32) keeps the net on
// its own bus and publishes `chip_net`. This mirrors a level change from any
// of them to all the others: PinManager.setPinState on the browser boards,
// sendChipNet on the worker bridges. Last writer wins, like the worker bus.
const chipNetLinks = new Map<string, CrossBoardChipNet>();
let chipNetUnsubs: Array<() => void> = [];
const propagatingChipNets = new Set<string>();

function propagateChipNet(net: string, fromBoardId: string, level: boolean, ts: number): void {
  if (!runtime) return;
  const link = chipNetLinks.get(net);
  if (!link) return;
  if (propagatingChipNets.has(net)) return;
  propagatingChipNets.add(net);
  try {
    for (const boardId of link.boards) {
      if (boardId === fromBoardId) continue;
      const entry = boards.get(boardId);
      // The browser side: every endpoint on this board reads the shared key.
      const pm = runtime.getBoardPinManager(boardId);
      if (pm?.setPinState && pm.getPinState?.(link.pin) !== level) pm.setPinState(link.pin, level);
      // The worker side, when this board has one. A bridge without
      // sendChipNet (an in-browser engine) hosts its chips in the browser
      // and was served by the PinManager write above.
      if (entry && isEsp32Bridge(entry.kind)) {
        runtime.getEsp32Bridge(boardId)?.sendChipNet?.(net, level ? 1 : 0, ts);
      } else if (entry && isStm32Bridge(entry.kind)) {
        runtime.getStm32Bridge(boardId)?.sendChipNet?.(net, level ? 1 : 0, ts);
      }
    }
  } finally {
    propagatingChipNets.delete(net);
  }
}

/** Rebuild the cross-board chip-net links from the diagram. Called with every
 *  wire update; idempotent. */
function updateChipNetLinks(): void {
  for (const u of chipNetUnsubs) u();
  chipNetUnsubs = [];
  chipNetLinks.clear();
  const state = runtime?.getChipNetState?.();
  if (!runtime || !state) return;
  for (const link of resolveCrossBoardChipNets(state)) {
    chipNetLinks.set(link.net, link);
    for (const boardId of link.boards) {
      const pm = runtime.getBoardPinManager(boardId);
      if (!pm?.onPinChange) continue;
      const unsub = pm.onPinChange(link.pin, (_p: number, state: boolean) => {
        propagateChipNet(link.net, boardId, state, nowNs());
      });
      if (typeof unsub === 'function') chipNetUnsubs.push(unsub);
    }
  }
}

function nowNs(): number {
  return Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1e6);
}

/** Diagnostic: the cross-board chip-net links in force (for tests). */
export function getChipNetLinks(): CrossBoardChipNet[] {
  return [...chipNetLinks.values()];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isBrowserSim(boardKind: string): boolean {
  // Browser-side simulators expose a `setPinState` method directly on the
  // simulator instance (AVR, RP2040).  ESP32-C3 family was historically
  // here when Esp32C3Simulator ran in-browser, but per the store's
  // ESP32_RISCV_KINDS routing the c3 boards now go through the same
  // Esp32Bridge (qemu-system-riscv32 via libqemu-riscv32.dll) as the
  // Xtensa ESP32s — so they belong on the bridge side.
  return (
    boardKind === 'arduino-uno' ||
    boardKind === 'arduino-nano' ||
    boardKind === 'arduino-mega' ||
    boardKind === 'attiny85' ||
    boardKind === 'raspberry-pi-pico' ||
    boardKind === 'pi-pico-w'
  );
}

function isEsp32Bridge(boardKind: string): boolean {
  return (
    boardKind === 'esp32' ||
    boardKind === 'esp32-s3' ||
    boardKind === 'esp32-devkit-c-v4' ||
    boardKind === 'esp32-cam' ||
    boardKind === 'wemos-lolin32-lite' ||
    boardKind === 'xiao-esp32-s3' ||
    boardKind === 'arduino-nano-esp32' ||
    // RISC-V ESP32-C3 family — same Esp32Bridge plumbing, just a
    // different QEMU binary on the backend (libqemu-riscv32).
    boardKind === 'esp32-c3' ||
    boardKind === 'xiao-esp32-c3' ||
    boardKind === 'aitewinrobot-esp32c3-supermini' ||
    boardKind === 'xiao-c3' ||
    boardKind === 'c3-supermini'
  );
}

function isPi3Bridge(boardKind: string): boolean {
  // Pi Zero / 1 / 2 / 3 / 4 / 5 all use the same backend bridge
  // (QEMU virt + virtio-serial). Exclude raspberry-pi-pico (RP2040).
  return boardKind.startsWith('raspberry-pi-') && boardKind !== 'raspberry-pi-pico';
}

function isStm32Bridge(boardKind: string): boolean {
  // STM32 family via libqemu-arm (Stm32Bridge). Same single-slot
  // onPinChange/onSerialData + sendPinEvent/sendSerialBytes shape as Esp32Bridge.
  return boardKind === 'stm32-bluepill' || boardKind.startsWith('stm32-');
}

/** Resolve `(componentId, pinName)` to a `(boardId, pinNumber)` pair. */
function resolveEndpoint(
  componentId: string,
  pinName: string,
): { boardId: string; pin: number } | null {
  const entry = boards.get(componentId);
  if (!entry) return null;
  const pin = boardPinToNumber(entry.kind, pinName);
  if (pin === null || pin < 0) return null; // null = unknown; -1 = power
  return { boardId: componentId, pin };
}

// ── Pin propagation primitives ───────────────────────────────────────────────

/** Drive a pin state on the receiving board (one-way). */
function pushPinState(boardId: string, pin: number, state: boolean): void {
  if (!runtime) return;
  const entry = boards.get(boardId);
  if (!entry) return;

  // Re-entrancy guard
  const key = `${boardId}:${pin}`;
  if (propagatingPins.has(key)) return;
  propagatingPins.add(key);
  try {
    if (isBrowserSim(entry.kind)) {
      const sim = runtime.getBoardSimulator(boardId);
      if (sim?.setPinState) sim.setPinState(pin, state);
    } else if (isEsp32Bridge(entry.kind)) {
      const bridge = runtime.getEsp32Bridge(boardId);
      bridge?.sendPinEvent?.(pin, state);
    } else if (isStm32Bridge(entry.kind)) {
      const bridge = runtime.getStm32Bridge(boardId);
      bridge?.sendPinEvent?.(pin, state);
    } else if (isPi3Bridge(entry.kind)) {
      const bridge = runtime.getBoardBridge(boardId);
      bridge?.sendPinEvent?.(pin, state);
    }
  } finally {
    propagatingPins.delete(key);
  }
}

// ── Serial seam for boards driven from outside the sim/bridge pair ───────
//
// A QEMU-Linux board can also run its Python in the tab (no WebSocket, no
// bridge object). Such a board still has UART wires on the canvas, so it
// needs both directions of the routing: a sink to receive bytes, and a way
// to announce the ones it sends. Both are plain callbacks — nothing here
// knows what is on the other end.
const serialSinks = new Map<string, (ch: string, uart: number) => void>();

/** Receive UART bytes addressed to this board. Returns an unregister fn. */
export function registerSerialSink(
  boardId: string,
  sink: (ch: string, uart: number) => void,
): () => void {
  serialSinks.set(boardId, sink);
  return () => {
    if (serialSinks.get(boardId) === sink) serialSinks.delete(boardId);
  };
}

/** Announce a UART byte this board just transmitted, so the wires route it. */
export function feedBoardSerialOut(boardId: string, ch: string, uart = 0): void {
  const subs = boards.get(boardId)?.serialFanout.get(uart);
  if (subs) for (const cb of subs) cb(ch);
}

/** Push a UART byte into the receiving board's UART RX. */
function pushSerialByte(boardId: string, ch: string, uart: number): void {
  if (!runtime) return;
  const entry = boards.get(boardId);
  if (!entry) return;

  const sink = serialSinks.get(boardId);
  if (sink) {
    sink(ch, uart);
    return;
  }

  if (isBrowserSim(entry.kind)) {
    const sim = runtime.getBoardSimulator(boardId);
    // RP2040Simulator doesn't yet expose feedUart per-UART — fall back
    // to serialWrite (which feeds UART0) for uart === 0.
    if (sim?.feedUart) {
      sim.feedUart(uart, ch);
    } else if (uart === 0 && sim?.serialWrite) {
      sim.serialWrite(ch);
    }
  } else if (isEsp32Bridge(entry.kind)) {
    const bridge = runtime.getEsp32Bridge(boardId);
    bridge?.sendSerialBytes?.([ch.charCodeAt(0)], uart);
  } else if (isStm32Bridge(entry.kind)) {
    const bridge = runtime.getStm32Bridge(boardId);
    bridge?.sendSerialBytes?.([ch.charCodeAt(0)], uart);
  } else if (isPi3Bridge(entry.kind)) {
    const bridge = runtime.getBoardBridge(boardId) as
      | { sendUartBytes?: (b: number[]) => void; sendSerialBytes?: (b: number[]) => void }
      | undefined;
    // The header UART is a different pipe from the console: typing a
    // peer's bytes into the shell used to be the only option, and it
    // meant the guest's own boot chatter went out on the wire while the
    // data a script wrote never did.
    if (bridge?.sendUartBytes) bridge.sendUartBytes([ch.charCodeAt(0)]);
    else bridge?.sendSerialBytes?.([ch.charCodeAt(0)]);
  }
}

// ── Pin-change fan-in (browser sims) ─────────────────────────────────────────
//
// For browser sims we subscribe to PinManager.onPinChange directly per
// pin; PinManager handles fan-out internally so we don't need our own
// fanout map for these.

function installBrowserPinSubscription(
  fromBoardId: string,
  fromPin: number,
  toBoardId: string,
  toPin: number,
): () => void {
  if (!runtime) return () => {};
  const pm = runtime.getBoardPinManager(fromBoardId);
  if (!pm?.onPinChange) return () => {};
  const unsub = pm.onPinChange(fromPin, (_p: number, state: boolean) => {
    pushPinState(toBoardId, toPin, state);
  });
  return typeof unsub === 'function' ? unsub : () => {};
}

// ── Pin-change fan-in (bridges) ──────────────────────────────────────────────
//
// Bridges expose a single `onPinChange` slot. We take ownership of it
// once per board and fan out through `pinChangeFanout`.

function ensureBridgePinHook(entry: BoardEntry): void {
  if (!runtime) return;
  const bridge = isEsp32Bridge(entry.kind)
    ? runtime.getEsp32Bridge(entry.id)
    : isStm32Bridge(entry.kind)
      ? runtime.getStm32Bridge(entry.id)
      : runtime.getBoardBridge(entry.id);
  if (!bridge) return;

  // Already installed?
  if ((bridge as any).__icPinHookInstalled) return;
  (bridge as any).__icPinHookInstalled = true;

  // Save whatever was there before so we can chain it.
  entry.origPinChangeCallback = bridge.onPinChange ?? null;

  // Capture a stable "get current entry" closure — survives Interconnect
  // resets (where the entry object is replaced) by re-resolving via the
  // boards Map at call time.
  const boardId = entry.id;
  bridge.onPinChange = (pin: number, state: boolean) => {
    const liveEntry = boards.get(boardId);
    // First, let the existing callback (e.g. PinManager.triggerPinChange
    // installed by the store for sensor wiring) run.
    liveEntry?.origPinChangeCallback?.(pin, state);
    // Then fan out to all wired endpoints.
    const subs = liveEntry?.pinChangeFanout.get(pin);
    if (subs) for (const cb of subs) cb(state);
  };
}

function installBridgePinFanout(
  fromBoardId: string,
  fromPin: number,
  toBoardId: string,
  toPin: number,
): () => void {
  const entry = boards.get(fromBoardId);
  if (!entry) return () => {};
  ensureBridgePinHook(entry);
  let set = entry.pinChangeFanout.get(fromPin);
  if (!set) {
    set = new Set();
    entry.pinChangeFanout.set(fromPin, set);
  }
  const cb = (state: boolean) => pushPinState(toBoardId, toPin, state);
  set.add(cb);
  return () => {
    entry.pinChangeFanout.get(fromPin)?.delete(cb);
  };
}

// ── Serial fan-in (browser sims and bridges) ─────────────────────────────────

function ensureSerialHook(entry: BoardEntry): void {
  if (!runtime) return;

  const boardId = entry.id;

  // Browser sims: wrap sim.onSerialData
  if (isBrowserSim(entry.kind)) {
    const sim = runtime.getBoardSimulator(entry.id);
    if (!sim) return;
    if ((sim as any).__icSerialHookInstalled) return;
    (sim as any).__icSerialHookInstalled = true;
    entry.origSerialCallback = sim.onSerialData ?? null;
    sim.onSerialData = (ch: string, uart?: number) => {
      const liveEntry = boards.get(boardId);
      liveEntry?.origSerialCallback?.(ch, uart);
      // Browser sims (e.g. RP2040) currently lump UART0 + UART1 into the
      // same callback. Default to UART0 for routing.
      const u = uart ?? 0;
      const subs = liveEntry?.serialFanout.get(u);
      if (subs) for (const cb of subs) cb(ch);
    };
    return;
  }

  // Bridges: same pattern on bridge.onSerialData
  const bridge = isEsp32Bridge(entry.kind)
    ? runtime.getEsp32Bridge(entry.id)
    : isStm32Bridge(entry.kind)
      ? runtime.getStm32Bridge(entry.id)
      : runtime.getBoardBridge(entry.id);
  if (!bridge) return;

  // A QEMU-Linux board has TWO serial streams: the console (the shell)
  // and the header UART. Only the second one is on the wire — hooking the
  // console here would send the guest's boot chatter and shell prompt to
  // the peer board, which is what used to happen for lack of anything
  // better.
  const piBridge = bridge as unknown as { onUartTx?: ((t: string) => void) | null };
  if (isPi3Bridge(entry.kind) && 'onUartTx' in piBridge) {
    if ((bridge as unknown as { __icUartHook?: boolean }).__icUartHook) return;
    (bridge as unknown as { __icUartHook?: boolean }).__icUartHook = true;
    const prevUart = piBridge.onUartTx ?? null;
    piBridge.onUartTx = (text: string) => {
      prevUart?.(text);
      const subs = boards.get(boardId)?.serialFanout.get(0);
      if (subs) for (const ch of text) for (const cb of subs) cb(ch);
    };
    return;
  }
  if ((bridge as any).__icSerialHookInstalled) return;
  (bridge as any).__icSerialHookInstalled = true;
  entry.origSerialCallback = bridge.onSerialData ?? null;
  bridge.onSerialData = (ch: string, uart?: number) => {
    const liveEntry = boards.get(boardId);
    liveEntry?.origSerialCallback?.(ch, uart);
    const u = uart ?? 0;
    const subs = liveEntry?.serialFanout.get(u);
    if (subs) for (const cb of subs) cb(ch);
  };
}

// ── Chip-to-chip net bridge (cross-worker) ───────────────────────────────────
//
// A custom chip on an ESP32 board runs inside that board's QEMU worker. Two
// chips wired to each other across two boards are therefore two processes, and
// the worker's ChipNetBus fans a level out only to the chips it hosts. The
// worker publishes those nets as `chip_net` events; this relays each one to
// every other bound ESP32 board, which applies it to its own bus.
//
// Cost: one WebSocket hop out and one back per edge, through the browser. That
// is milliseconds, not microseconds, so a chip protocol carried this way needs
// a bit period well above the round trip. Measured numbers and the bit period
// they imply are in docs/wiki/custom-chips-chip-nets.md.
//
// No wire lookup is involved: the net id already names the net, both workers
// were handed the same id by chipNets.ts, and a board with no member for that
// id ignores the message.

function ensureChipNetHook(entry: BoardEntry): void {
  if (!runtime) return;
  if (!isEsp32Bridge(entry.kind)) return;
  const bridge = runtime.getEsp32Bridge(entry.id);
  if (!bridge) return;
  if ((bridge as any).__icChipNetHookInstalled) return;
  (bridge as any).__icChipNetHookInstalled = true;

  const prev = bridge.onChipNet ?? null;
  const boardId = entry.id;
  bridge.onChipNet = (net: string, level: 0 | 1, ts: number) => {
    prev?.(net, level, ts);
    if (!runtime) return;
    for (const other of boards.values()) {
      if (other.id === boardId) continue;
      if (!isEsp32Bridge(other.kind)) continue;
      runtime.getEsp32Bridge(other.id)?.sendChipNet?.(net, level, ts);
    }
    // A browser-hosted chip on another board sits on the same net under its
    // PinManager key; the worker bridges above were already served, so the
    // link propagation only has the PinManagers left to write.
    const link = chipNetLinks.get(net);
    if (!link) return;
    for (const other of link.boards) {
      if (other === boardId) continue;
      const entry = boards.get(other);
      if (entry && isEsp32Bridge(entry.kind)) continue;
      const pm = runtime.getBoardPinManager(other);
      const lv = !!level;
      if (pm?.setPinState && pm.getPinState?.(link.pin) !== lv) {
        propagatingChipNets.add(net);
        try {
          pm.setPinState(link.pin, lv);
        } finally {
          propagatingChipNets.delete(net);
        }
      }
    }
  };
}

/**
 * Install (or reinstall) the chip-net relay on every bound ESP32 board. The
 * bridge object is created at Run, after the routes are built, so the store
 * calls this again from `reensureSerialHooks`; the flag on the instance keeps
 * it idempotent.
 */
export function ensureChipNetHooks(): void {
  for (const entry of boards.values()) ensureChipNetHook(entry);
}

function installSerialFanout(
  fromBoardId: string,
  fromUart: number,
  toBoardId: string,
  toUart: number,
): () => void {
  const entry = boards.get(fromBoardId);
  if (!entry) return () => {};
  ensureSerialHook(entry);
  let set = entry.serialFanout.get(fromUart);
  if (!set) {
    set = new Set();
    entry.serialFanout.set(fromUart, set);
  }
  const cb = (ch: string) => pushSerialByte(toBoardId, ch, toUart);
  set.add(cb);
  return () => {
    entry.serialFanout.get(fromUart)?.delete(cb);
  };
}

// ── Route building per wire ──────────────────────────────────────────────────

function buildRouteForWire(wire: Wire): RouteHandle | null {
  const aEntry = boards.get(wire.start.componentId);
  const bEntry = boards.get(wire.end.componentId);
  if (!aEntry || !bEntry) return null;

  const aRes = resolveEndpoint(wire.start.componentId, wire.start.pinName);
  const bRes = resolveEndpoint(wire.end.componentId, wire.end.pinName);
  if (!aRes || !bRes) return null;

  // Power pins / GND short-circuit (already filtered to >= 0 by resolveEndpoint).

  const teardowns: Array<() => void> = [];

  // ─ Digital pin propagation A → B ─────────────────────────────────────────
  if (isBrowserSim(aEntry.kind)) {
    teardowns.push(
      installBrowserPinSubscription(aEntry.id, aRes.pin, bEntry.id, bRes.pin),
    );
  } else {
    teardowns.push(installBridgePinFanout(aEntry.id, aRes.pin, bEntry.id, bRes.pin));
  }

  // ─ Digital pin propagation B → A ─────────────────────────────────────────
  if (isBrowserSim(bEntry.kind)) {
    teardowns.push(
      installBrowserPinSubscription(bEntry.id, bRes.pin, aEntry.id, aRes.pin),
    );
  } else {
    teardowns.push(installBridgePinFanout(bEntry.id, bRes.pin, aEntry.id, aRes.pin));
  }

  // ─ Optional UART byte-level shortcut ────────────────────────────────────
  // Enable when at least one side is a cross-process bridge (latency
  // would drop bit-level transport) AND when both pins classify as
  // matching UART TX/RX endpoints.
  const aIsCross = isEsp32Bridge(aEntry.kind) || isPi3Bridge(aEntry.kind);
  const bIsCross = isEsp32Bridge(bEntry.kind) || isPi3Bridge(bEntry.kind);
  const uartInfo = isUartWire(aEntry.kind, wire.start.pinName, bEntry.kind, wire.end.pinName);

  // Always wire the byte-level shortcut for hardware-UART pin pairs —
  // even browser-only cases benefit: AVR/RP2040 sims emit per-byte
  // events that cleanly arrive at the other side without depending on
  // bit-level pin replay timing.
  if (uartInfo) {
    const aRoleIsTx = classifyPin(aEntry.kind, wire.start.pinName).kind === 'uart-tx';
    const aUart = uartInfo.uartA;
    const bUart = uartInfo.uartB;
    if (aRoleIsTx) {
      // A.TX → B.RX
      teardowns.push(installSerialFanout(aEntry.id, aUart, bEntry.id, bUart));
    } else {
      // A.RX → B.TX (the wire's "start" was the RX side)
      teardowns.push(installSerialFanout(bEntry.id, bUart, aEntry.id, aUart));
    }
    void aIsCross;
    void bIsCross;
  }

  return {
    wireId: wire.id,
    teardown: () => {
      for (const t of teardowns) t();
    },
  };
}

// ── Public API used by the store ─────────────────────────────────────────────

export function bindBoard(boardId: string, kind: BoardKind | string): void {
  if (boards.has(boardId)) return;
  boards.set(boardId, {
    id: boardId,
    kind: kind as BoardKind,
    pinChangeFanout: new Map(),
    serialFanout: new Map(),
    pinUnsubs: [],
  });
  // After binding, any wires referencing this board can be re-resolved.
  // The store will call updateWires() with the latest list.
}

export function unbindBoard(boardId: string): void {
  // Tear down any routes that touch this board
  for (const [wireId, route] of routes.entries()) {
    // We don't keep wire→endpoint mapping; clearing all routes that
    // mention this board requires a re-scan. The store calls
    // updateWires(currentWires) right after removeBoard which will
    // rebuild from scratch. Just drop the entry.
    void wireId;
    void route;
  }
  // Remove the board entry; subsequent updateWires() will re-resolve.
  boards.delete(boardId);
}

let lastWireSnapshot: string = '';

/**
 * Idempotent: rebuilds route table to match the supplied wires array.
 * Called by the store on every wire mutation and also on board
 * add/remove.
 */
export function updateWires(wires: readonly Wire[]): void {
  // Quick skip if nothing changed (compare by composite identity).
  const sig = wires
    .map(
      (w) =>
        `${w.id}|${w.start.componentId}:${w.start.pinName}|${w.end.componentId}:${w.end.pinName}`,
    )
    .join(',');
  if (sig === lastWireSnapshot && wires.length === routes.size) {
    // Nothing changed in the routing-relevant fields.
    return;
  }
  lastWireSnapshot = sig;

  // Tear down all existing routes first (simplest correct strategy).
  for (const r of routes.values()) r.teardown();
  routes.clear();

  // Build fresh routes for each wire whose endpoints both resolve.
  for (const w of wires) {
    const r = buildRouteForWire(w);
    if (r) routes.set(w.id, r);
  }

  // I2C between boards needs no route here: a chip is on a controller's bus
  // because its SDA and SCL are on that controller's nets, and a net wired
  // from one board's I2C pins to another's reaches both masters, so the bus
  // fabric places the chip on both (simulation/buses/registry.ts).

  // Chip-to-chip nets are not routed per wire (the worker keys them by net id),
  // so the relay is installed per board rather than per route.
  ensureChipNetHooks();
  updateChipNetLinks();
}

/**
 * Re-attempt the serial hook for a board whose sim/bridge did not exist
 * when the routes were built. Routes are installed at page load; a Pi's
 * bridge is created at Run — so the TX hook silently no-opped and the
 * guest's UART bytes never reached the wire. The store calls this when
 * the bridge connects; ensureSerialHook is idempotent via its flag.
 */
export function reensureSerialHooks(boardId: string): void {
  const entry = boards.get(boardId);
  if (!entry) return;
  // The chip-net relay lives on the same fresh bridge instance and, unlike the
  // serial hook, is needed even when this board has no UART wire at all.
  ensureChipNetHook(entry);
  if (entry.serialFanout.size === 0) return;
  // The hook lives on the sim/bridge INSTANCE and marks it with a flag.
  // A fresh instance carries no flag, so ensureSerialHook installs on it;
  // this call is what makes that happen after a compile or a reconnect.
  ensureSerialHook(entry);
}

/** For tests: reset all internal state. */
export function resetInterconnect(): void {
  for (const r of routes.values()) r.teardown();
  routes.clear();
  for (const e of boards.values()) {
    e.pinChangeFanout.clear();
    e.serialFanout.clear();
    for (const u of e.pinUnsubs) u();
    e.pinUnsubs = [];
  }
  boards.clear();
  propagatingPins.clear();
  for (const u of chipNetUnsubs) u();
  chipNetUnsubs = [];
  chipNetLinks.clear();
  propagatingChipNets.clear();
  lastWireSnapshot = '';
}

/** Diagnostic: return route count (for tests). */
export function getRouteCount(): number {
  return routes.size;
}

export function getBoundBoardIds(): string[] {
  return Array.from(boards.keys());
}
