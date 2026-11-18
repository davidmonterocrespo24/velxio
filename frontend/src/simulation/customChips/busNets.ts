/**
 * Multi-driver bus net registry — Phase 1 of the multi-chip digital bus track
 * (project/multichip-bus/). Sits between the chip runtime and the PinManager
 * for chip-to-chip BUS net keys (syntheticNetPin), and, since board-buses F7,
 * for the board pins a chip drives.
 *
 * Phase 0 gave every endpoint of a chip-to-chip net one shared PinManager key,
 * but PinManager is last-writer-wins — wrong for a bus where several chips can
 * drive one data line and the rest release it (Hi-Z). This registry tracks each
 * chip pin's (value, strength) contribution per net, resolves the net with the
 * 4-valued rules (busLogic.resolveNet), and pushes the RESOLVED level into the
 * PinManager so readers see the bus, not the last writer. Contention (two strong
 * drivers disagree -> X) is surfaced as a console warning, like Proteus.
 *
 * A board pin is a net like any other, with one more driver on it: the MCU's
 * pad. What the guest does to the pad is on the PinManager's pad channel
 * (driving low, driving high, or released with a pull), so the resolution
 * here is the wired-AND every open-drain line relies on: a chip that pulls
 * the pin low wins over the pull-up, and a chip that goes back to VX_INPUT
 * stops contributing, and the pull restores the level. The resolved level
 * goes to the PinManager and, through the sink the chip host registers,
 * into the guest's input register. It used to be that a chip wrote the
 * PinManager and the guest straight from vx_pin_write, and its release wrote
 * nothing at all, so the board read the chip's last level forever (finding
 * chip-release-to-input-keeps-board-pin-driven).
 *
 * A module's own resistor on a line (the 10k pull-ups of a Grove 4-Digit
 * Display on CLK and DIO, the 4.7k of a DS18B20 module) is one more driver of
 * the board pin, of PULL strength, that stays on the net for as long as the
 * part is on the canvas (setBoardPinPull). The resolution is in tiers, as the
 * wire does it: any strong drive (the MCU's output, a chip pulling low, a
 * part's injection) decides the level; with none, the module's pull does,
 * and it beats the MCU's internal pull the other way because the smaller
 * resistor sets the divider (an external 4.7k-10k against the 20k-100k of a
 * pad); with neither, the pad's own pull. A released line on a module with a
 * pull-up therefore reads HIGH in the guest and on the level channel, which
 * is what every open-drain driver that releases with pinMode(INPUT) relies on
 * (avishorp's TM1637Display, finding module-pullup-not-modelled).
 *
 * Single-chip-to-component synthetic pins keep the legacy direct PinManager
 * path untouched.
 */
import { resolveNet, resolvedToBool, Strength, HIGHZ_DRIVE, type Drive, type Resolved } from './busLogic';
import { publishNetLevel, resetBusKernel } from './busKernel';

interface PinManagerLike {
  triggerPinChange(pin: number, state: boolean, source?: 'mcu' | 'external'): void;
}

/**
 * A board's PinManager as a board-pin net sees it: the level channel plus the
 * pad channel the engines report the guest's drive on. A manager without the
 * pad channel (a test double) has pads that are never driving and never
 * pulled, so a chip's own drive alone decides its pins.
 */
export interface BoardPinHost extends PinManagerLike {
  onPinChange?(pin: number, cb: (pin: number, state: boolean) => void): () => void;
  peekPad?(pin: number): { drive: 'low' | 'high' | 'z'; pull: 0 | 1 | 2 } | undefined;
  onPadChange?(pin: number, cb: () => void): () => void;
  /**
   * What an engine without the pad channel still reports: the direction and
   * the internal pull the guest programmed (PinManager.setPinDirection /
   * setPinPull, fed by every ESP32 bridge's onPinDir / onPinPull). Read only
   * when peekPad has nothing for the pin.
   */
  getPinDirection?(pin: number): 0 | 1 | undefined;
  getPinPull?(pin: number): 0 | 1 | 2;
  /** The level the channel carries now: what an output pad of such an
   *  engine last put on it, read when a net forms over that pad. */
  getPinState?(pin: number): boolean;
  /** The net answers every level proposed for the pin (PinManager.claimLevel). */
  claimLevel?(
    pin: number,
    resolve: (proposed: boolean, source: 'mcu' | 'external' | 'pull') => boolean | undefined,
  ): () => void;
  /**
   * Changes of the pin's direction or internal pull (PinManager.
   * onPinConfigChange): how an engine without the pad channel says the guest
   * released a pin, which moves no level there.
   */
  onPinConfigChange?(pin: number, cb: () => void): () => void;
}

// netKey -> (driverId -> Drive). driverId = `${componentId}::${pinName}`.
const nets = new Map<number, Map<string, Drive>>();
// Nets currently flagged as in contention — so we warn once per onset, not per
// re-resolve, and clear when the contention is gone.
const inContention = new Set<number>();

function recompute(pm: PinManagerLike, netKey: number): void {
  const drivers = nets.get(netKey);
  const resolved = resolveNet(drivers ? drivers.values() : []);

  if (resolved.v === 'X') {
    if (!inContention.has(netKey)) {
      inContention.add(netKey);
      console.warn(
        `[chipbus] bus contention on net ${netKey}: two strong drivers disagree (resolved X)`,
      );
    }
  } else {
    inContention.delete(netKey);
  }

  // PinManager is boolean; push the projected level (only a driven 1 is high)
  // through the settle kernel so the change propagates as a bounded delta-cycle
  // pass rather than a recursive cascade.
  publishNetLevel(pm, netKey, resolvedToBool(resolved));
}

/** Set (or replace) one chip pin's contribution to a bus net and re-resolve. */
export function setBusDrive(
  pm: PinManagerLike,
  netKey: number,
  driverId: string,
  drive: Drive,
): void {
  let m = nets.get(netKey);
  if (!m) {
    m = new Map();
    nets.set(netKey, m);
  }
  m.set(driverId, drive);
  recompute(pm, netKey);
}

/**
 * How a net resolves without one of its drivers: what a two-way element (a
 * closed switch) sees on one side, so that what it passes on to the other
 * side never includes its own pass-through back.
 */
export function resolveBusNetWithout(netKey: number, driverId: string): Resolved {
  const m = nets.get(netKey);
  if (!m) return resolveNet([]);
  const others: Drive[] = [];
  for (const [id, d] of m) if (id !== driverId) others.push(d);
  return resolveNet(others);
}

// ── Board pins ──────────────────────────────────────────────────────────────

/** Where a resolved level goes besides the PinManager: the guest's input
 *  register, through the host of the chip that drives the pin. */
type BoardPinSink = (level: boolean) => void;

interface BoardNet {
  /** The chip pins holding this board pin, by driver id. A pin that lets go
   *  (VX_INPUT) is removed, not kept at Hi-Z: an empty net is torn down. */
  drivers: Map<string, Drive>;
  sinks: Map<string, BoardPinSink>;
  /** Off the pad and level channels when the last driver leaves. */
  unwatch: () => void;
  /** Warned about contention with the pad; cleared when it ends. */
  contended: boolean;
  /** Warned about two modules pulling the line opposite ways. */
  pullsFight: boolean;
  /** The level this net last put on the channel, to tell its own echo from
   *  a write by someone else. */
  lastLevel: boolean | undefined;
  /** An engine without the pad channel: the level its output pad drives,
   *  from the levels it reports (it reports one only when its latch moves). */
  mcuLevel: boolean | undefined;
}

// One table per PinManager: board pin numbers repeat on every board, so D2
// of two Unos in one project are two nets, never one.
const boardNets = new Map<BoardPinHost, Map<number, BoardNet>>();

// ── Module pulls, for a board whose guest runs elsewhere ────────────────────

/** One module resistor on a board pin, as the bus map carries it to a QEMU
 *  worker (field names are the wire's). */
export interface BoardPinPullEntry {
  pin: number;
  pull: 'up' | 'down';
  owner: string;
}

type PullsListener = (host: BoardPinHost) => void;
const pullsListeners = new Set<PullsListener>();

/**
 * Hear that the module pulls on some host's board pins changed: a part
 * mounted, re-wired or removed. A board whose guest runs in a QEMU worker
 * forwards them (boardPinPulls) in its bus map, because the guest's input
 * register is the worker's and only a pad model there can put the resistor
 * on it (backend pad_model.py). The listener filters by host.
 */
export function onBoardPinPullsChange(listener: PullsListener): () => void {
  pullsListeners.add(listener);
  return () => pullsListeners.delete(listener);
}

function pullsChanged(host: BoardPinHost): void {
  for (const l of [...pullsListeners]) {
    try {
      l(host);
    } catch (e) {
      console.warn('[chipbus] a pulls listener failed', e);
    }
  }
}

// A part mounting puts several pulls in one go, and a re-wire takes them off
// and back on: the listeners hear the host once, after the burst.
const pendingPulls = new Set<BoardPinHost>();

function queuePullsChanged(host: BoardPinHost): void {
  if (pullsListeners.size === 0 || pendingPulls.has(host)) return;
  pendingPulls.add(host);
  queueMicrotask(() => {
    if (!pendingPulls.delete(host)) return;
    pullsChanged(host);
  });
}

/** Every module pull on `host`'s board pins, sorted so two equal sets
 *  compare equal as JSON. */
export function boardPinPulls(host: BoardPinHost): BoardPinPullEntry[] {
  const out: BoardPinPullEntry[] = [];
  const byPin = boardNets.get(host);
  if (!byPin) return out;
  for (const [pin, net] of byPin) {
    for (const [owner, d] of net.drivers) {
      if (d.strength !== Strength.PULL) continue;
      out.push({ pin, pull: d.value === 1 ? 'up' : 'down', owner });
    }
  }
  out.sort((a, b) => a.pin - b.pin || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  return out;
}

/** The MCU's pad as a driver of its own pin: strong while it drives, a pull
 *  while released with one, nothing while released and floating. A pad the
 *  engine never reported on has not been touched by the guest: floating,
 *  unless the engine reports pulls on their own channel (reportedPull). */
function padDrive(host: BoardPinHost, pin: number): Drive {
  const pad = host.peekPad?.(pin);
  if (!pad) return reportedPull(host, pin);
  if (pad.drive === 'low') return { value: 0, strength: Strength.STRONG };
  if (pad.drive === 'high') return { value: 1, strength: Strength.STRONG };
  if (pad.pull === 1) return { value: 1, strength: Strength.PULL };
  if (pad.pull === 2) return { value: 0, strength: Strength.PULL };
  return HIGHZ_DRIVE;
}

/**
 * The pad of an engine that has no pad channel (the in-browser ESP32 engines
 * and the QEMU bridge): the pull the guest enabled on an input, from the
 * direction and pull channels those engines do report. An output stays
 * Hi-Z here, as before: those engines put their driven level on the level
 * channel, and proposeBoardPin passes it as the wire's.
 *
 * Without this the pull of INPUT_PULLUP was invisible to the net, so a chip
 * that released an open-collector line (vx_pin_set_mode(VX_INPUT), the A3144
 * and every IRQ idiom) resolved it to Z, and a Z leaves the wire where the
 * chip's last pull put it: the ESP32 read LOW for the rest of the run and
 * never saw a second falling edge (finding
 * esp32-open-collector-release-reads-low).
 */
function reportedPull(host: BoardPinHost, pin: number): Drive {
  if (host.getPinDirection?.(pin) === 1) return HIGHZ_DRIVE;
  const pull = host.getPinPull?.(pin) ?? 0;
  if (pull === 1) return { value: 1, strength: Strength.PULL };
  if (pull === 2) return { value: 0, strength: Strength.PULL };
  return HIGHZ_DRIVE;
}

/**
 * The net's resolution, in tiers (see the header): a strong drive, else the
 * modules' pulls, else the pad's own pull. The only PULL-strength drivers a
 * board net holds are module pulls (ChipRuntime keeps a chip's VX_INPUT_PULLUP
 * off board pins), so the tier between them and the pad is the divider rule:
 * the module's resistor wins against the MCU's internal one.
 */
function resolveBoardPin(net: BoardNet, pad: Drive): Resolved {
  const strong: Drive[] = [];
  const pulls: Drive[] = [];
  for (const d of net.drivers.values()) {
    if (d.strength >= Strength.STRONG) strong.push(d);
    else if (d.strength === Strength.PULL) pulls.push(d);
  }
  if (pad.strength >= Strength.STRONG) strong.push(pad);
  if (strong.length > 0) return resolveNet(strong);
  if (pulls.length > 0) return resolveNet(pulls);
  return resolveNet([pad]);
}

function modulePullsFight(net: BoardNet): boolean {
  let up = false;
  let down = false;
  for (const d of net.drivers.values()) {
    if (d.strength !== Strength.PULL) continue;
    if (d.value === 1) up = true;
    else down = true;
  }
  return up && down;
}

/** An engine without the pad channel drives this pad as an output: its
 *  level comes from the level channel, and nothing weaker than a strong
 *  drive moves it. */
function isReportedOutput(host: BoardPinHost, pin: number): boolean {
  return !host.peekPad?.(pin) && host.getPinDirection?.(pin) === 1;
}

/**
 * What the wire holds with `proposed` put on it through `source`.
 *
 * A level the engine reports ('mcu') on a pad it drives is the wire's: it
 * passes, and the chips' contention with it is reported by the pad channel's
 * own resolution. An engine without a pad channel (the ESP32 bridges) reports
 * only the pads its firmware drives, so its level is its drive too. Anything
 * else (a part's injection, the pull of a pad the guest configured as an
 * input) is a proposal the net's resolution answers, which a strong driver
 * decides: undefined for an injection on a pad the guest drives (it moves
 * nothing), the proposal itself when nothing on the net holds the wire.
 *
 * A part's injection ('external': a button, a line model, a bus target, the
 * SPICE connector) is a drive of its own, so it beats a pull, the module's
 * included: a button to GND on a line with a module pull-up reads LOW. The
 * latch of an input pad ('pull', the AVR's PORT bit under INPUT_PULLUP) is
 * the pad's pull, not a drive, and the resolution answers it.
 */
function proposeBoardPin(
  host: BoardPinHost,
  pin: number,
  net: BoardNet,
  proposed: boolean,
  source: 'mcu' | 'external' | 'pull',
): boolean | undefined {
  const pad = padDrive(host, pin);
  if (pad.strength === Strength.STRONG) return source === 'mcu' ? proposed : undefined;
  if (source === 'mcu' && !host.peekPad?.(pin)) {
    net.mcuLevel = proposed;
    return proposed;
  }
  const resolved = resolveBoardPin(net, pad);
  if (resolved.v === 'X' || resolved.v === 'Z') return proposed;
  if (source === 'external' && resolved.strength < Strength.STRONG) return proposed;
  const level = resolved.v === '1';
  net.lastLevel = level;
  // An overridden proposal came through a door that moved the guest's input
  // register before asking (the AVR's setPinState writes PIN first): put the
  // wire's level back into the guest through every chip's sink, as the
  // re-assertion after the write used to. The sink's own write comes back
  // here with the resolved level and changes nothing.
  if (level !== proposed) for (const sink of net.sinks.values()) sink(level);
  return level;
}

function recomputeBoardPin(host: BoardPinHost, pin: number, net: BoardNet): void {
  const pad = padDrive(host, pin);
  // Two modules' resistors the opposite way are a fixed divider, not an
  // event: said once while it lasts, whatever the MCU does meanwhile.
  const pullsFight = modulePullsFight(net);
  if (pullsFight && !net.pullsFight) {
    console.warn(
      `[chipbus] board pin ${pin} has a pull-up and a pull-down from two modules: ` +
        `the line sits mid-rail while nothing drives it, and keeps its level`,
    );
  }
  net.pullsFight = pullsFight;
  const resolved = resolveBoardPin(net, pad);
  if (resolved.v === 'X') {
    if (resolved.strength >= Strength.STRONG && !net.contended) {
      net.contended = true;
      console.warn(
        `[chipbus] contention on board pin ${pin}: a chip and the MCU drive it to opposite levels`,
      );
    }
    return;
  }
  net.contended = false;
  // While the MCU drives the pad its level is the wire's; there is nothing to
  // feed back into the guest (its own output reads its latch). The engine
  // puts that level on the channel when its latch moves, but not when only
  // the direction does: the AVR's pinMode(OUTPUT) over a latch already at 0
  // pulls the line low and moves no PORT bit. On a line the net had pulled
  // HIGH that drive would never reach the parts on the pin (avishorp's
  // TM1637Display clocks every bit that way), so the pad's level is put on
  // the channel here when the channel disagrees. A released pad with nothing
  // pulling it keeps the level it had, as a floating input does.
  if (pad.strength === Strength.STRONG) {
    const driven = pad.value === 1;
    if (host.peekPad?.(pin) && host.getPinState && host.getPinState(pin) !== driven) {
      publishNetLevel(host, pin, driven, (lvl) => {
        net.lastLevel = lvl;
        host.triggerPinChange(pin, lvl, 'mcu');
      });
    }
    return;
  }
  // An engine that reports neither pads nor directions (the Pi and STM32
  // bridges) cannot say when the guest lets go of a pin it has driven, so a
  // pin it has put a level on is taken as still driven, and a module's pull
  // only sets the level of a pin that engine has never driven.
  if (
    resolved.strength < Strength.STRONG &&
    !host.peekPad?.(pin) &&
    host.getPinDirection?.(pin) === undefined &&
    net.mcuLevel !== undefined
  ) {
    return;
  }
  let level: boolean;
  // A pull (a module's resistor) loses to an output of an engine without the
  // pad channel exactly as to any strong drive: that output is simply not in
  // the resolution, so it is handled with the Z case below.
  if (resolved.v === 'Z' || (resolved.strength < Strength.STRONG && isReportedOutput(host, pin))) {
    // An engine without the pad channel keeps an output pad at HIGHZ here
    // and reports its level only when the latch moves. When the chips let go
    // of such a pad, the wire is the MCU's output again, not the chip's last
    // level: a TM1637 that ACKs by pulling DIO low while the sketch's latch
    // is HIGH would otherwise leave the line low, and the next 1 bit, which
    // moves no latch, never reaches the chip (finding
    // chip-release-leaves-esp32-output-at-chip-level).
    const mcu = net.mcuLevel;
    if (mcu === undefined || !isReportedOutput(host, pin)) return;
    if (net.lastLevel === mcu) return;
    level = mcu;
  } else {
    level = resolved.v === '1';
  }
  const sinks = [...net.sinks.values()];
  publishNetLevel(host, pin, level, (lvl) => {
    net.lastLevel = lvl;
    for (const sink of sinks) sink(lvl);
    host.triggerPinChange(pin, lvl, 'external');
  });
}

/**
 * Set (or withdraw) one chip pin's drive of a board pin and re-resolve it.
 * `sink` is the chip host's way into the guest's input register for this pin
 * (its digital-write hook); every chip on the pin registers its own, and the
 * resolved level goes through each, which is how each host claims the pin it
 * drives. A Hi-Z drive withdraws the chip: `vx_pin_set_mode(VX_INPUT)` is the
 * release idiom, and a released chip is simply not on the net.
 */
export function setBoardPinDrive(
  host: BoardPinHost,
  pin: number,
  driverId: string,
  drive: Drive,
  sink: BoardPinSink,
): void {
  let byPin = boardNets.get(host);
  if (!byPin) {
    byPin = new Map();
    boardNets.set(host, byPin);
  }
  let net = byPin.get(pin);
  const wasPull = net?.drivers.get(driverId)?.strength === Strength.PULL;
  if (wasPull || drive.strength === Strength.PULL) queuePullsChanged(host);
  if (drive.strength <= Strength.HIGHZ) {
    if (!net || !net.drivers.has(driverId)) return;
    net.drivers.delete(driverId);
    // The pull, or another chip, has the line now: say so before leaving,
    // and through the leaving chip's own door into the guest as well. Its
    // sink goes after the resolution, or a chip that was alone on the pin
    // would restore the level on the PinManager only, and the sketch would
    // read the chip's last level forever.
    recomputeBoardPin(host, pin, net);
    net.sinks.delete(driverId);
    if (net.drivers.size === 0) dropBoardNet(host, pin, net);
    return;
  }
  if (!net) {
    const created: BoardNet = {
      drivers: new Map(),
      sinks: new Map(),
      unwatch: () => {},
      contended: false,
      pullsFight: false,
      lastLevel: undefined,
      // The channel carries the output pad's level until a chip drives it.
      mcuLevel:
        !host.peekPad?.(pin) && host.getPinDirection?.(pin) === 1 ? host.getPinState?.(pin) : undefined,
    };
    // The pad decides the resolution as much as the chips do, so a pinMode
    // in the sketch re-resolves the pin. And the net claims the pin's level:
    // an engine that writes an input pin's latch onto the channel (the AVR's
    // PORT bit for INPUT_PULLUP), or a part injecting a level, is answered by
    // the resolution before anything reaches the channel, so a second chip
    // watching the pin never sees the latch as an edge. A host without the
    // claim (a test double) is watched instead and re-asserted after the
    // write, glitch included; the net's own publication comes back through
    // the same channel and is not a reason to resolve again.
    const offPad = host.onPadChange?.(pin, () => recomputeBoardPin(host, pin, created)) ?? (() => {});
    // An engine without the pad channel says the guest let go of a pin on
    // the direction and pull channels only; a pad-reporting one says it
    // above, and resolving on both would publish every release twice.
    const offConfig =
      host.onPinConfigChange?.(pin, () => {
        if (!host.peekPad?.(pin)) recomputeBoardPin(host, pin, created);
      }) ?? (() => {});
    const offLevel = host.claimLevel
      ? host.claimLevel(pin, (proposed, source) => proposeBoardPin(host, pin, created, proposed, source))
      : (host.onPinChange?.(pin, (_p, state) => {
          if (state !== created.lastLevel) recomputeBoardPin(host, pin, created);
        }) ?? (() => {}));
    created.unwatch = () => {
      offPad();
      offConfig();
      offLevel();
    };
    net = created;
    byPin.set(pin, net);
  }
  net.drivers.set(driverId, drive);
  net.sinks.set(driverId, sink);
  recomputeBoardPin(host, pin, net);
}

/**
 * A module's own resistor on a board pin (the part's declared pull, see the
 * header): 'up' or 'down' puts it on the net as a PULL-strength driver, null
 * takes it off. `driverId` is the part's, `${componentId}::<pad>~pull` for a
 * chip, so clearBusDriversForChip takes it with the rest of the part. `sink`
 * is the part host's door into the guest's input register, as for a chip's
 * own drive: the level the pull gives a released line has to reach the
 * sketch's digitalRead, not only the parts watching the pin.
 */
export function setBoardPinPull(
  host: BoardPinHost,
  pin: number,
  driverId: string,
  pull: 'up' | 'down' | null,
  sink: BoardPinSink,
): void {
  const drive: Drive =
    pull === null ? HIGHZ_DRIVE : { value: pull === 'up' ? 1 : 0, strength: Strength.PULL };
  setBoardPinDrive(host, pin, driverId, drive, sink);
}

function dropBoardNet(host: BoardPinHost, pin: number, net: BoardNet): void {
  net.unwatch();
  const byPin = boardNets.get(host);
  byPin?.delete(pin);
  if (byPin && byPin.size === 0) boardNets.delete(host);
}

/** Remove every driver a chip contributes (on dispose) and re-resolve its nets. */
export function clearBusDriversForChip(pm: PinManagerLike, componentId: string): void {
  const prefix = `${componentId}::`;
  for (const [netKey, m] of nets) {
    let changed = false;
    for (const id of [...m.keys()]) {
      if (id.startsWith(prefix)) {
        m.delete(id);
        changed = true;
      }
    }
    if (changed) recompute(pm, netKey);
  }
  const byPin = boardNets.get(pm as BoardPinHost);
  if (!byPin) return;
  for (const [pin, net] of [...byPin.entries()]) {
    const gone = [...net.drivers.keys()].filter((id) => id.startsWith(prefix));
    if (gone.length === 0) continue;
    if (gone.some((id) => net.drivers.get(id)?.strength === Strength.PULL)) {
      queuePullsChanged(pm as BoardPinHost);
    }
    for (const id of gone) net.drivers.delete(id);
    // Same order as a release: the level the others leave goes into the
    // guest through the departing chip's door too, then the door closes.
    recomputeBoardPin(pm as BoardPinHost, pin, net);
    for (const id of gone) net.sinks.delete(id);
    if (net.drivers.size === 0) dropBoardNet(pm as BoardPinHost, pin, net);
  }
}

/** Test seam: wipe all bus-net driver state (and the settle kernel). */
export function resetBusNets(): void {
  nets.clear();
  inContention.clear();
  for (const byPin of boardNets.values()) for (const net of byPin.values()) net.unwatch();
  boardNets.clear();
  pendingPulls.clear();
  resetBusKernel();
}
