/**
 * Board buses F4: the QEMU lane as the browser sees it
 * (project/board-buses-2026-09, F4-SPEC "Protocolo").
 *
 * A board whose firmware runs in a backend worker has one controller port in
 * the tab and one map going the other way:
 *
 *  - the PORT is fed by the worker's `spi_batch` and pushes those bytes into
 *    the board's fabric, so a display, an e-paper or any other SINK decodes
 *    them exactly as it does on an in-browser engine. What a device here
 *    answers goes nowhere, because the guest clocked those bytes before the
 *    batch was even sent.
 *  - the MAP carries the responders that DO have to answer, as portable
 *    models, to run beside the guest. A responder with no portable model is
 *    named in a diagnostic instead of half working (decisions.md, resolved
 *    question 2).
 *
 * The rig is the one board-buses-repro-qemu-shim.test.ts uses: the real store,
 * the real Esp32Bridge behind the real shim, a scripted socket in place of the
 * WebSocket, and real parts from PartSimulationRegistry.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});
vi.stubGlobal('document', { getElementById: () => null });

class ScriptedSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: ScriptedSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  sent: Array<{ type: string; data?: Record<string, unknown> }> = [];
  constructor(_url: string) {
    ScriptedSocket.last = this;
  }
  send(frame: string): void {
    this.sent.push(JSON.parse(frame));
  }
  close(): void {
    this.readyState = ScriptedSocket.CLOSED;
  }
  open(): void {
    this.readyState = ScriptedSocket.OPEN;
    this.onopen?.();
  }
  receive(type: string, data: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}
vi.stubGlobal('WebSocket', ScriptedSocket);

import { useSimulatorStore, getBoardSimulator, getEsp32Bridge } from '../../store/useSimulatorStore';
import {
  attachSpiDevice,
  busRegistry,
  createStoreNetResolver,
  isBusCapable,
} from '../../simulation/buses';
import { SYNTHETIC_CHIP_PIN_BASE } from '../../simulation/customChips/syntheticPins';
import type {
  BusDiagnostic,
  EngineBinding,
  RemoteSpiMapEntry,
  RemoteSpiSinksEntry,
} from '../../simulation/buses';

// VSPI on an ESP32 DevKit, and the pad the peripheral uses as its own CS0.
const ESP32_SPI = { SCK: 'D18', MOSI: 'D23', MISO: 'D19' };
const ESP32_PIN = { SCK: 18, MOSI: 23, MISO: 19 };
const GPIO_CS = 15;
const HW_CS_PAD = 5; // VSPI's default SS in the board pin table

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
  busRegistry.resetDiagnostics();
});

function wire(boardId: string, componentId: string, pads: Record<string, string>): void {
  const wires = Object.entries(pads).map(([pinName, pad], i) => ({
    id: `${componentId}-w${i}`,
    start: { componentId, pinName, x: 0, y: 0 },
    end: { componentId: boardId, pinName: pad, x: 0, y: 0 },
    waypoints: [],
    color: '#0a0',
  }));
  useSimulatorStore.setState((s) => ({ wires: [...s.wires, ...wires] }) as never);
}

function qemuBoard() {
  const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
  const bridge = getEsp32Bridge(id)!;
  bridge.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return { id, ws, bridge };
}

function bindingOf(boardId: string): EngineBinding | null {
  const sim = getBoardSimulator(boardId);
  return isBusCapable(sim) ? sim.getBusBinding() : null;
}

const WASM_B64 = 'AGFzbQEAAAA='; // the 8-byte WASM header; the tab never runs it

/**
 * A device on the board's SPI. `remote` gives it a portable model, which is
 * what decides whether it travels to the worker or is reported as a gap.
 * `sink` drops its MISO leg, which is what a display is.
 */
function device(
  boardId: string,
  owner: string,
  opts: {
    cs?: number | null;
    remote?: boolean;
    sink?: boolean;
    /** The model's blob writes can come back (`remoteBlobWrite`). */
    blobWrite?: boolean;
    csActive?: 'low' | 'high';
  } = {},
) {
  const cs = opts.cs === undefined ? GPIO_CS : opts.cs;
  const seen: number[] = [];
  const blobs: Array<{ name: string; offset: number; data: number[]; blobId?: string }> = [];
  const pads: Record<string, string> = { ...ESP32_SPI };
  if (cs !== null) pads.CS = `D${cs}`;
  wire(boardId, owner, pads);
  const handle = attachSpiDevice(
    {
      owner,
      pins: {
        sck: 'SCK',
        mosi: 'MOSI',
        ...(opts.sink ? {} : { miso: 'MISO' }),
        ...(cs === null ? {} : { cs: 'CS' }),
      },
      ...(opts.csActive ? { csActive: opts.csActive } : {}),
      ...(opts.blobWrite
        ? {
            remoteBlobWrite: (name: string, offset: number, data: Uint8Array, blobId?: string) =>
              blobs.push({ name, offset, data: [...data], ...(blobId === undefined ? {} : { blobId }) }),
          }
        : {}),
      ...(opts.remote
        ? {
            remoteModel: () => ({
              wasmB64: WASM_B64,
              pinMap: { CS: cs ?? -1, SCK: ESP32_PIN.SCK },
              attrs: { gain: 2 },
              blobs: { card: 'AAEC' },
              blobIds: { card: 'img-a' },
            }),
          }
        : {}),
    },
    {
      transfer: (mosi: number) => {
        seen.push(mosi);
        return opts.sink ? null : 0x01;
      },
    },
  );
  cleanups.push(() => handle.dispose());
  return { seen, blobs };
}

/** A write-only device whose select is wired to a rail pad of the board. */
function tiedDevice(boardId: string, owner: string, railPad: string): void {
  wire(boardId, owner, { SCK: ESP32_SPI.SCK, MOSI: ESP32_SPI.MOSI, CS: railPad });
  const handle = attachSpiDevice(
    { owner, pins: { sck: 'SCK', mosi: 'MOSI', cs: 'CS' } },
    { transfer: () => null },
  );
  cleanups.push(() => handle.dispose());
}

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

type Published = Array<RemoteSpiMapEntry | RemoteSpiSinksEntry>;

function published(ws: ScriptedSocket): Published[] {
  const out: Published[] = [];
  for (const m of ws.sent) {
    if (m.type === 'start_esp32') {
      out.push(((m.data?.bus_map as { spi?: Published })?.spi ?? []) as Published);
    } else if (m.type === 'esp32_bus_map') {
      out.push((m.data?.spi ?? []) as Published);
    }
  }
  return out;
}

/** The responders of every map sent, in order (the entries with an owner). */
function maps(ws: ScriptedSocket): RemoteSpiMapEntry[][] {
  return published(ws).map((p) => p.filter((e): e is RemoteSpiMapEntry => 'owner' in e));
}

/** The sinks entry of the last map sent. */
function lastSinks(ws: ScriptedSocket): RemoteSpiSinksEntry['sinks'] {
  const last = published(ws).at(-1) ?? [];
  const entries = last.filter((e): e is RemoteSpiSinksEntry => 'sinks' in e);
  expect(entries, 'one sinks entry per map').toHaveLength(1);
  expect(last.at(-1), 'and it is the last one').toBe(entries[0]);
  return entries[0].sinks;
}

function collectDiagnostics(): BusDiagnostic[] {
  const seen: BusDiagnostic[] = [];
  cleanups.push(busRegistry.onDiagnostic((d) => seen.push(d)));
  return seen;
}

// ── The port: the worker's bytes reach the tab's devices ────────────────────

describe('QEMU lane: the remote controller port', () => {
  it('hands a batch to the selected device and to nobody else', () => {
    const { id, ws } = qemuBoard();
    const a = device(id, 'a', { cs: GPIO_CS });
    const b = device(id, 'b', { cs: 4 });
    ws.receive('gpio_change', { pin: 4, state: 1 });
    ws.receive('gpio_change', { pin: GPIO_CS, state: 0 });
    ws.receive('spi_batch', { b64: b64([0x11, 0x22, 0x33]) });
    expect(a.seen).toEqual([0x11, 0x22, 0x33]);
    expect(b.seen).toEqual([]);
  });

  it('hands nothing to a device whose chip select is high', () => {
    const { id, ws } = qemuBoard();
    const a = device(id, 'a', { cs: GPIO_CS });
    ws.receive('gpio_change', { pin: GPIO_CS, state: 1 });
    ws.receive('spi_batch', { b64: b64([0x11, 0x22]) });
    expect(a.seen).toEqual([]);
  });

  it('sends no answer back: a device here would be answering the wrong byte', () => {
    const { id, ws } = qemuBoard();
    device(id, 'a', { cs: GPIO_CS });
    ws.receive('gpio_change', { pin: GPIO_CS, state: 0 });
    const before = ws.sent.length;
    ws.receive('spi_batch', { b64: b64([0x11, 0x22, 0x33]) });
    expect(ws.sent.slice(before), 'frames the tab sent while decoding a batch').toEqual([]);
  });

  it('follows a chip select the SPI peripheral drives itself', () => {
    // QEMU moves no GPIO for a pad the peripheral owns, so the op 0x01 event
    // is the only place that level exists in the tab.
    const { id, ws } = qemuBoard();
    const a = device(id, 'a', { cs: HW_CS_PAD });
    const csEvent = (level: 0 | 1) => ((((0 & 3) << 1) | level) << 8) | 0x01;
    ws.receive('spi_event', { bus: 0, event: csEvent(1) });
    ws.receive('spi_batch', { b64: b64([0x11]) });
    expect(a.seen, 'deasserted').toEqual([]);
    ws.receive('spi_event', { bus: 0, event: csEvent(0) });
    ws.receive('spi_batch', { b64: b64([0x22, 0x33]) });
    expect(a.seen, 'asserted').toEqual([0x22, 0x33]);
  });
});

// ── The map: the responders that go the other way ───────────────────────────

describe('QEMU lane: the bus map the tab sends', () => {
  it('rides with start_esp32, so the worker knows the bus before the guest clocks', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    device(id, 'sd1', { cs: GPIO_CS, remote: true });
    getEsp32Bridge(id)!.connect();
    const ws = ScriptedSocket.last!;
    ws.open();
    const start = ws.sent.find((m) => m.type === 'start_esp32');
    const spi = (start!.data!.bus_map as { spi: Published }).spi;
    expect(spi.filter((e) => 'owner' in e)).toHaveLength(1);
    // The sinks ride with it too. This card cannot take its writes back, so
    // it is one of them (see "counts a hosted model whose blob...").
    expect(spi.at(-1)).toEqual({
      sinks: { all: false, cs: [{ kind: 'pin', gpio: GPIO_CS, active_low: true }] },
    });
  });

  it('names the owner, the controller, the chip select and the model', () => {
    const { id, ws } = qemuBoard();
    device(id, 'sd1', { cs: GPIO_CS, remote: true });
    const entry = maps(ws).at(-1)![0];
    expect(entry.owner).toBe('sd1');
    expect(entry.bus_id, 'VSPI is unit 3 in the board pin table').toBe(3);
    expect(entry.cs).toEqual({ kind: 'pin', gpio: GPIO_CS, active_low: true });
    expect(entry.model).toEqual({
      wasm_b64: WASM_B64,
      // Every bus leg the circuit resolved, under the pad name the device
      // registered with: the model's own pin watches are registered against
      // these, and a model that is handed only some of them watches a pad the
      // worker cannot move.
      pin_map: {
        CS: GPIO_CS,
        SCK: ESP32_PIN.SCK,
        MOSI: ESP32_PIN.MOSI,
        MISO: ESP32_PIN.MISO,
      },
      attrs: { gain: 2 },
      blobs: { card: 'AAEC' },
      // Which image the blob is: a host keeps its running model while this
      // holds, and replaces it when the part loads another card.
      blob_ids: { card: 'img-a' },
    });
  });

  it('lets the model name a leg the circuit does not', () => {
    // An interrupt output, a busy line: a leg that is not on the bus has no
    // resolved pin, so the model's own pinMap is the only place it exists and
    // it must survive the merge.
    const { id, ws } = qemuBoard();
    const owner = 'touch1';
    wire(id, owner, { ...ESP32_SPI, CS: `D${GPIO_CS}` });
    const handle = attachSpiDevice(
      {
        owner,
        pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' },
        remoteModel: () => ({ wasmB64: WASM_B64, pinMap: { IRQ: 27 } }),
      },
      { transfer: () => 0x01 },
    );
    cleanups.push(() => handle.dispose());
    expect(maps(ws).at(-1)![0].model.pin_map).toEqual({
      IRQ: 27,
      CS: GPIO_CS,
      SCK: ESP32_PIN.SCK,
      MOSI: ESP32_PIN.MOSI,
      MISO: ESP32_PIN.MISO,
    });
  });

  it('carries a hardware chip select as the peripheral index and the pad', () => {
    // The worker never sees a GPIO edge for that pad, so the index is how it
    // reads the level and the pad is how it tells the model.
    const { id, ws } = qemuBoard();
    device(id, 'sd1', { cs: HW_CS_PAD, remote: true });
    expect(maps(ws).at(-1)![0].cs).toEqual({
      kind: 'hw',
      index: 0,
      gpio: HW_CS_PAD,
      active_low: true,
    });
  });

  it('leaves out a responder with no portable model', () => {
    const { id, ws } = qemuBoard();
    device(id, 'sd1', { cs: GPIO_CS, remote: true });
    device(id, 'touch1', { cs: 4 });
    expect(maps(ws).at(-1)!.map((e) => e.owner)).toEqual(['sd1']);
  });

  it('leaves out a sink: a display never answers, so nothing waits for it', () => {
    const { id, ws } = qemuBoard();
    device(id, 'tft1', { cs: GPIO_CS, sink: true });
    expect(maps(ws).at(-1)).toEqual([]);
  });

  it('is sent again, whole, when a device leaves the bus', () => {
    const { id, ws } = qemuBoard();
    device(id, 'sd1', { cs: GPIO_CS, remote: true });
    expect(maps(ws).at(-1)!.map((e) => e.owner)).toEqual(['sd1']);
    while (cleanups.length) cleanups.pop()!();
    expect(maps(ws).at(-1), 'a device that left is gone by being absent').toEqual([]);
  });
});

// ── The sinks: what the worker relays ──────────────────────────────────────
//
// The worker answers every byte beside the guest and relays to the tab only
// what a device kept HERE could be selected for (F4-SPEC, "Worker, por byte",
// step 3). The tab is the only side that knows those devices, so the map ends
// with their chip selects. The property is one-sided: a byte relayed for
// nobody costs time, a byte withheld from a display is a wrong picture, so
// every select the worker could not follow must turn the saving off.

describe('QEMU lane: the sinks the map lists', () => {
  it('names a display beside a card by its own select, and not the card', () => {
    const { id, ws } = qemuBoard();
    device(id, 'sd1', { cs: 4, remote: true, blobWrite: true });
    device(id, 'tft1', { cs: GPIO_CS, sink: true });
    expect(maps(ws).at(-1)!.map((e) => e.owner)).toEqual(['sd1']);
    expect(lastSinks(ws)).toEqual({
      all: false,
      cs: [{ kind: 'pin', gpio: GPIO_CS, active_low: true }],
    });
  });

  it('names a display on the peripheral select by index AND pad', () => {
    // The worker has to consider both: the tab believes the GPIO until it
    // hears from the peripheral.
    const { id, ws } = qemuBoard();
    device(id, 'tft1', { cs: HW_CS_PAD, sink: true });
    expect(lastSinks(ws).cs).toEqual([{ kind: 'hw', index: 0, gpio: HW_CS_PAD, active_low: true }]);
  });

  it('keeps an active-high select with its polarity', () => {
    const { id, ws } = qemuBoard();
    device(id, 'tft1', { cs: GPIO_CS, sink: true, csActive: 'high' });
    expect(lastSinks(ws).cs).toEqual([{ kind: 'pin', gpio: GPIO_CS, active_low: false }]);
  });

  it('counts a responder with no portable model as a sink: it still decodes here', () => {
    const { id, ws } = qemuBoard();
    device(id, 'touch1', { cs: 4 });
    expect(lastSinks(ws).cs).toEqual([{ kind: 'pin', gpio: 4, active_low: true }]);
  });

  it('counts a hosted model whose blob cannot come back as a sink', () => {
    // Its copy here follows the guest's writes only through the relayed
    // bytes, so withholding them would lose what the guest wrote.
    const { id, ws } = qemuBoard();
    device(id, 'sd1', { cs: 4, remote: true });
    expect(maps(ws).at(-1)!.map((e) => e.owner)).toEqual(['sd1']);
    expect(lastSinks(ws).cs).toEqual([{ kind: 'pin', gpio: 4, active_low: true }]);
  });

  it('says `all` for a sink with no select line: it is always listening', () => {
    const { id, ws } = qemuBoard();
    device(id, 'sd1', { cs: 4, remote: true, blobWrite: true });
    device(id, 'latch1', { cs: null, sink: true });
    expect(lastSinks(ws)).toEqual({ all: true, cs: [] });
  });

  it('says `all` for a sink whose select is tied active', () => {
    const { id, ws } = qemuBoard();
    tiedDevice(id, 'tft1', 'GND.1');
    expect(lastSinks(ws)).toEqual({ all: true, cs: [] });
  });

  it('says `all` for a sink whose select a chip on the canvas drives', () => {
    // A custom chip (or a decoder) between the board and the display's CS:
    // the level lives on a chip net the worker never sees, so it cannot tell
    // when the display listens.
    const { id, ws } = qemuBoard();
    const store = createStoreNetResolver(() => useSimulatorStore.getState() as never);
    busRegistry.setResolver({
      boards: () => store.boards(),
      boardKind: (b) => store.boardKind(b),
      resolve: (ref) =>
        ref.kind === 'component' && ref.componentId === 'tft1' && ref.pinName === 'CS'
          ? { kind: 'chip', boardId: id, pin: SYNTHETIC_CHIP_PIN_BASE + 3 }
          : store.resolve(ref),
    });
    cleanups.push(() => busRegistry.setResolver(store));
    device(id, 'sd1', { cs: 4, remote: true, blobWrite: true });
    device(id, 'tft1', { cs: GPIO_CS, sink: true });
    expect(lastSinks(ws)).toEqual({ all: true, cs: [] });
  });

  it('leaves out a sink whose select is tied inactive: the fabric never selects it', () => {
    const { id, ws } = qemuBoard();
    tiedDevice(id, 'tft1', '3V3');
    expect(lastSinks(ws)).toEqual({ all: false, cs: [] });
  });

  it('lists the same select once, and follows a device that leaves', () => {
    const { id, ws } = qemuBoard();
    device(id, 'tft1', { cs: GPIO_CS, sink: true });
    device(id, 'tft2', { cs: GPIO_CS, sink: true });
    expect(lastSinks(ws).cs).toHaveLength(1);
    while (cleanups.length) cleanups.pop()!();
    expect(lastSinks(ws)).toEqual({ all: false, cs: [] });
  });

  it('delivers exactly the relayed bytes to the display when the card is quiet', () => {
    // What the worker relays under the list is what the display decodes: the
    // tab's fabric still arbitrates by chip select on this side.
    const { id, ws } = qemuBoard();
    device(id, 'sd1', { cs: 4, remote: true, blobWrite: true });
    const tft = device(id, 'tft1', { cs: GPIO_CS, sink: true });
    ws.receive('gpio_change', { pin: 4, state: 1 });
    ws.receive('gpio_change', { pin: GPIO_CS, state: 0 });
    ws.receive('spi_batch', { b64: b64([0x2a, 0x00, 0xef]) });
    expect(tft.seen).toEqual([0x2a, 0x00, 0xef]);
  });
});

describe('QEMU lane: what a hosted model wrote comes back', () => {
  it('hands a bus_blob span to the device that shipped the blob', () => {
    const { id, ws } = qemuBoard();
    const sd = device(id, 'sd1', { cs: 4, remote: true, blobWrite: true });
    ws.receive('system', { event: 'bus_blob', owner: 'sd1', name: 'card', offset: 1536, data: b64([1, 2, 3]) });
    expect(sd.blobs).toEqual([{ name: 'card', offset: 1536, data: [1, 2, 3] }]);
  });

  it('passes on which image the span was written to', () => {
    // The device drops a span meant for a card it has since replaced; the
    // worker's `blob_id` is how it can tell.
    const { id, ws } = qemuBoard();
    const sd = device(id, 'sd1', { cs: 4, remote: true, blobWrite: true });
    ws.receive('system', {
      event: 'bus_blob', owner: 'sd1', name: 'card', offset: 0, data: b64([7]), blob_id: 'img-3',
    });
    expect(sd.blobs).toEqual([{ name: 'card', offset: 0, data: [7], blobId: 'img-3' }]);
  });

  it('ignores a span for an owner that is not on this board', () => {
    const { id, ws } = qemuBoard();
    const sd = device(id, 'sd1', { cs: 4, remote: true, blobWrite: true });
    ws.receive('system', { event: 'bus_blob', owner: 'sd9', name: 'card', offset: 0, data: b64([9]) });
    expect(sd.blobs).toEqual([]);
  });
});

// ── bus-remote-responder-missing ────────────────────────────────────────────

describe('QEMU lane: a responder that cannot run where the master is', () => {
  it('is reported when its chip select selects it', () => {
    const { id, ws } = qemuBoard();
    const seen = collectDiagnostics();
    device(id, 'touch1', { cs: GPIO_CS });
    expect(seen.map((d) => d.code), 'nothing while it is deselected').toEqual([]);
    ws.receive('gpio_change', { pin: GPIO_CS, state: 0 });
    const missing = seen.filter((d) => d.code === 'bus-remote-responder-missing');
    expect(missing.map((d) => d.owners)).toEqual([['touch1']]);
    expect(missing[0].boardId).toBe(id);
  });

  it('is reported once, not once per selection', () => {
    const { id, ws } = qemuBoard();
    const seen = collectDiagnostics();
    device(id, 'touch1', { cs: GPIO_CS });
    for (let i = 0; i < 4; i++) {
      ws.receive('gpio_change', { pin: GPIO_CS, state: 0 });
      ws.receive('gpio_change', { pin: GPIO_CS, state: 1 });
    }
    expect(seen.filter((d) => d.code === 'bus-remote-responder-missing')).toHaveLength(1);
  });

  it('is not reported for a responder that HAS a portable model', () => {
    const { id, ws } = qemuBoard();
    const seen = collectDiagnostics();
    device(id, 'sd1', { cs: GPIO_CS, remote: true });
    ws.receive('gpio_change', { pin: GPIO_CS, state: 0 });
    expect(seen.filter((d) => d.code === 'bus-remote-responder-missing')).toEqual([]);
  });

  it('is not reported for a sink', () => {
    const { id, ws } = qemuBoard();
    const seen = collectDiagnostics();
    device(id, 'tft1', { cs: GPIO_CS, sink: true });
    ws.receive('gpio_change', { pin: GPIO_CS, state: 0 });
    expect(seen.filter((d) => d.code === 'bus-remote-responder-missing')).toEqual([]);
  });

  it('is not reported on a board whose engine runs in this tab', () => {
    // The same part on an in-browser engine answers in time, so there is
    // nothing to warn about. A Pico stands in for every local engine here.
    const id = useSimulatorStore.getState().addBoard('raspberry-pi-pico', 0, 0);
    const seen = collectDiagnostics();
    const pads = { SCK: 'GP18', MOSI: 'GP19', MISO: 'GP16', CS: 'GP17' };
    wire(id, 'touch1', pads);
    const handle = attachSpiDevice(
      { owner: 'touch1', pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } },
      { transfer: () => 0x01 },
    );
    cleanups.push(() => handle.dispose());
    const binding = bindingOf(id);
    expect(binding!.spi.some((p) => p.remote), 'a local engine publishes no remote port').toBe(
      false,
    );
    expect(seen.filter((d) => d.code === 'bus-remote-responder-missing')).toEqual([]);
  });
});
