/**
 * digitalGateEngine — evaluate a board-less DIGITAL circuit (logic gates +
 * switches + LEDs + power rails) on the event-driven settle kernel instead of
 * ngspice B-sources. Phase 1 of project/digital-gate-engine/.
 *
 * It reuses the multichip-bus substrate (customChips/{busLogic,busNets,
 * busKernel} + PinManager): every wire-connected set of pins becomes one bus
 * net key, each primitive contributes a driver (or, for gates, an event-driven
 * compute), and busKernel.settle() ripples the network to its fixed point. The
 * same kernel that boots a Z80 over a chip bus evaluates the gate network — so a
 * 4-bit ripple adder settles exactly, which the cascaded-B-source SPICE model
 * does not (00-problem-analysis.md).
 *
 * Digital abstraction of the analog scaffolding the examples use:
 *   - signal-generator SIG = STRONG 1 (the 5 V rail); its GND pin = node 0.
 *   - a resistor with one end on GND  = PULL 0 on the other net (pull-down).
 *   - a resistor with one end on rail = PULL 1 on the other net (pull-up).
 *   - a resistor between two signal nets = pass-through (the nets merge).
 *   - a slide-switch closed = pass its rail-side level to its other pin (STRONG);
 *     open = Hi-Z (the pull-down then wins -> 0).
 *   - a gate computes its boolean and drives Y STRONG.
 *   - an LED is a pure sink: it reads its anode net (lit iff the net is 1).
 *
 * `buildDigitalNetwork` returns a controller: drive switches, read LED/net
 * levels. It does not touch the DOM or the store — the app layer (Phase 2)
 * wires those in.
 */
import { PinManager } from '../PinManager';
import { setBusDrive } from '../customChips/busNets';
import { Strength, type Drive } from '../customChips/busLogic';
import { isJunction } from '../../utils/junction';

const STRONG = (v: 0 | 1): Drive => ({ value: v, strength: Strength.STRONG });
const PULL = (v: 0 | 1): Drive => ({ value: v, strength: Strength.PULL });

export interface DigitalComponent {
  id: string;
  /** Raw example type (`velxio-logic-gate-and`, `wokwi-slide-switch`, …). */
  type?: string;
  /** Store-normalised id (`logic-gate-and`, `slide-switch`, …). */
  metadataId?: string;
  properties?: Record<string, unknown>;
}
export interface DigitalWire {
  start: { componentId: string; pinName: string };
  end: { componentId: string; pinName: string };
}

/**
 * Canonical kind for a component, tolerant of both shapes: the raw example data
 * carries `type: 'velxio-logic-gate-and'` / `'wokwi-led'`, the loaded store
 * carries `metadataId: 'logic-gate-and'` / `'led'`. Strip the vendor prefixes so
 * both resolve to the same kind.
 */
function kindOf(c: DigitalComponent): string {
  const raw = String(c.metadataId ?? c.type ?? '');
  return raw.replace(/^velxio-/, '').replace(/^wokwi-/, '');
}

// Boolean primitives (match parts/LogicGateParts.ts; XOR = parity).
const OPS: Record<string, (b: boolean[]) => boolean> = {
  and: (b) => b.every(Boolean),
  or: (b) => b.some(Boolean),
  nand: (b) => !b.every(Boolean),
  nor: (b) => !b.some(Boolean),
  xor: (b) => b.filter(Boolean).length % 2 === 1,
  xnor: (b) => b.filter(Boolean).length % 2 === 0,
  not: (b) => !b[0],
  buffer: (b) => !!b[0],
};

/** Parse a normalised gate kind `logic-gate-<base>(-<n>)?` into pins + fn. */
function parseGate(kind: string): { inputs: string[]; fn: (b: boolean[]) => boolean } | null {
  const m = /^logic-gate-([a-z]+)(?:-(\d))?$/.exec(kind);
  if (!m) return null;
  const base = m[1];
  const fn = OPS[base];
  if (!fn) return null;
  if (base === 'not' || base === 'buffer') return { inputs: ['A'], fn };
  const n = m[2] ? Number(m[2]) : 2;
  const inputs = ['A', 'B', 'C', 'D'].slice(0, n);
  return { inputs, fn };
}

// Edge-triggered flip-flops (match parts/LogicGateParts.ts edgeTriggeredFF):
// sample the data inputs on the rising edge of CLK, drive Q + Qbar. They hold
// state between edges and so break combinational loops (a counter / shift
// register feeds Q back without the settle kernel oscillating).
const FF: Record<string, { data: string[]; sample: (q: boolean, inputs: boolean[]) => boolean }> = {
  'flip-flop-d': { data: ['D'], sample: (_q, [d]) => d },
  'flip-flop-t': { data: ['T'], sample: (q, [t]) => (t ? !q : q) },
  'flip-flop-jk': { data: ['J', 'K'], sample: (q, [j, k]) => (j && k ? !q : j ? true : k ? false : q) },
};

const isGate = (t: string) => t.startsWith('logic-gate-');
const isFlipFlop = (t: string) => t in FF;
const isSwitch = (t: string) => t === 'slide-switch';
const isLed = (t: string) => t === 'led';
const isResistor = (t: string) => t === 'resistor';
const isPower = (t: string) => t === 'signal-generator';

/** Components this engine understands. Anything else => analog => bail.
 *  A junction is pure connectivity (union-find handles the shared pin), so it
 *  must not push an otherwise all-digital circuit onto the analog path. */
function isDigitalPrimitive(t: string): boolean {
  return isGate(t) || isFlipFlop(t) || isSwitch(t) || isLed(t) || isResistor(t) || isPower(t)
    || isJunction(t);
}

/** The engine's switch, read like chipBusEnabled / mixedmode: `?digitalgates=`
 *  or localStorage `velxio.digitalgates` set to on / off. ON by default since
 *  4f4ee0bf (2026-06-05); `off` sends all-digital circuits back to ngspice. */
export function digitalGatesEnabled(): boolean {
  try {
    if (typeof window !== 'undefined' && window.location) {
      const q = new URLSearchParams(window.location.search).get('digitalgates');
      if (q === 'on' || q === '1' || q === 'true') return true;
      if (q === 'off' || q === '0' || q === 'false') return false;
    }
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem('velxio.digitalgates');
      if (v === 'on' || v === '1' || v === 'true') return true;
      if (v === 'off' || v === '0' || v === 'false') return false;
    }
  } catch {
    /* missing globals in tests / SecurityError — fall through */
  }
  // On by default: all-digital gate circuits are evaluated exactly + instantly by
  // the event-driven engine (the ngspice B-source path could not light a 4-bit
  // adder). Only pure all-digital-with-a-gate circuits take this path; mixed /
  // analog circuits stay on ngspice. Override with ?digitalgates=off.
  return true;
}

/**
 * True iff every component is a digital primitive AND at least one is a logic
 * gate. The gate requirement keeps the engine from claiming degenerate analog
 * circuits that happen to use only {source, resistor, LED} with no logic — those
 * stay on ngspice.
 */
export function isAllDigital(components: DigitalComponent[]): boolean {
  if (components.length === 0) return false;
  if (!components.every((c) => isDigitalPrimitive(kindOf(c)))) return false;
  return components.some((c) => isGate(kindOf(c)) || isFlipFlop(kindOf(c)));
}

// Endpoint key. A printable separator (NOT a space — a lone space gets stored
// as a NUL byte by the edit tools, turning the source into a git-binary).
const epKey = (compId: string, pin: string) => `${compId}::${pin}`;

// ── Union-find over wire endpoints ──────────────────────────────────────────
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let r = this.parent.get(x);
    if (r === undefined) {
      this.parent.set(x, x);
      return x;
    }
    while (r !== this.parent.get(r)) {
      const gp = this.parent.get(r)!;
      this.parent.set(r, this.parent.get(gp)!);
      r = gp;
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export interface DigitalNetwork {
  /** True if every component was a digital primitive (else nothing was built). */
  ok: boolean;
  pinManager: PinManager;
  /** Resolve a component pin to its bus-net key (or undefined). */
  netOf(componentId: string, pin: string): number | undefined;
  /** Read a net's resolved logic level. */
  readNet(net: number): 0 | 1;
  /** Read an LED's lit state (its anode net level). */
  readLed(ledId: string): 0 | 1;
  /** Set a slide-switch open/closed and re-settle. */
  setSwitch(switchId: string, value: 0 | 1): void;
  /** All LED ids in the network. */
  ledIds: string[];
}

/**
 * Build the digital network. Returns `{ ok:false }` (and drives nothing) if any
 * component is not a digital primitive — that circuit belongs to ngspice.
 */
export function buildDigitalNetwork(
  components: DigitalComponent[],
  wires: DigitalWire[],
  pinManager?: PinManager,
): DigitalNetwork {
  const pm = pinManager ?? new PinManager();
  const noop: DigitalNetwork = {
    ok: false, pinManager: pm,
    netOf: () => undefined, readNet: () => 0, readLed: () => 0, setSwitch: () => {}, ledIds: [],
  };
  if (components.some((c) => !isDigitalPrimitive(kindOf(c)))) return noop;

  const byId = new Map(components.map((c) => [c.id, c]));
  const uf = new UnionFind();
  for (const w of wires) uf.union(epKey(w.start.componentId, w.start.pinName), epKey(w.end.componentId, w.end.pinName));

  const pinNet = (compId: string, pin: string) => uf.find(epKey(compId, pin));

  // Identify the GND and rail roots from the signal-generator(s).
  const findRailGnd = (gnd: Set<string>, rail: Set<string>) => {
    gnd.clear(); rail.clear();
    for (const c of components) {
      if (isPower(kindOf(c))) {
        gnd.add(pinNet(c.id, 'GND'));
        rail.add(pinNet(c.id, 'SIG'));
      }
    }
  };
  const gndRoots = new Set<string>();
  const railRoots = new Set<string>();
  findRailGnd(gndRoots, railRoots);
  const isGnd = (root: string) => gndRoots.has(root);
  const isRail = (root: string) => railRoots.has(root);

  // Pass-through resistor merge (neither end on rail/gnd), then recompute roots.
  for (const c of components) {
    if (!isResistor(kindOf(c))) continue;
    const r1 = pinNet(c.id, '1'), r2 = pinNet(c.id, '2');
    const special = (r: string) => isGnd(r) || isRail(r);
    if (!special(r1) && !special(r2)) uf.union(epKey(c.id, '1'), epKey(c.id, '2'));
  }
  findRailGnd(gndRoots, railRoots);

  // Assign an integer key per net root.
  const keyOf = new Map<string, number>();
  let nextKey = 1;
  const netKey = (compId: string, pin: string): number => {
    const root = pinNet(compId, pin);
    let k = keyOf.get(root);
    if (k === undefined) { k = nextKey++; keyOf.set(root, k); }
    return k;
  };
  const netOf = (compId: string, pin: string): number | undefined => {
    if (!byId.has(compId)) return undefined;
    return netKey(compId, pin);
  };

  // ── Static drivers: rail, gnd, pull resistors ──────────────────────────────
  for (const c of components) {
    if (isPower(kindOf(c))) {
      setBusDrive(pm, netKey(c.id, 'SIG'), `${c.id}::SIG`, STRONG(1)); // 5 V rail
      setBusDrive(pm, netKey(c.id, 'GND'), `${c.id}::GND`, STRONG(0)); // node 0
    }
  }
  for (const c of components) {
    if (!isResistor(kindOf(c))) continue;
    const r1 = pinNet(c.id, '1'), r2 = pinNet(c.id, '2');
    if (isGnd(r1) && !isGnd(r2)) setBusDrive(pm, netKey(c.id, '2'), `${c.id}::pd`, PULL(0));
    else if (isGnd(r2) && !isGnd(r1)) setBusDrive(pm, netKey(c.id, '1'), `${c.id}::pd`, PULL(0));
    else if (isRail(r1) && !isRail(r2)) setBusDrive(pm, netKey(c.id, '2'), `${c.id}::pu`, PULL(1));
    else if (isRail(r2) && !isRail(r1)) setBusDrive(pm, netKey(c.id, '1'), `${c.id}::pu`, PULL(1));
    // else: pass-through (already merged) — contributes no driver.
  }

  // ── Switches: SPDT. Pin 2 is the common wiper; it connects to pin 1 at
  // value=0 or pin 3 at value=1 and passes that throw's level to the common.
  // A throw that isn't wired leaves the common floating (any pull resistor then
  // decides), mirroring the SPICE model which omits an unwired leg.
  const wiredPins = new Set<string>();
  for (const w of wires) {
    wiredPins.add(epKey(w.start.componentId, w.start.pinName));
    wiredPins.add(epKey(w.end.componentId, w.end.pinName));
  }
  const switchState = new Map<string, 0 | 1>();
  const driveSwitch = (c: DigitalComponent) => {
    const value = switchState.get(c.id) ?? (Number(c.properties?.value) === 1 ? 1 : 0);
    const common = netKey(c.id, '2');
    const throwPin = value === 1 ? '3' : '1';
    if (wiredPins.has(epKey(c.id, throwPin))) {
      const level = pm.getPinState(netKey(c.id, throwPin)) ? 1 : 0;
      setBusDrive(pm, common, `${c.id}::pass`, STRONG(level as 0 | 1));
    } else {
      setBusDrive(pm, common, `${c.id}::pass`, { value: 0, strength: Strength.HIGHZ });
    }
  };
  for (const c of components) if (isSwitch(kindOf(c))) driveSwitch(c);

  // ── Gates: subscribe inputs, compute, drive Y (event-driven) ───────────────
  for (const c of components) {
    if (!isGate(kindOf(c))) continue;
    const spec = parseGate(kindOf(c));
    if (!spec) continue;
    const inNets = spec.inputs.map((p) => netKey(c.id, p));
    const outNet = netKey(c.id, 'Y');
    const st = inNets.map((n) => pm.getPinState(n));
    const update = () => setBusDrive(pm, outNet, `${c.id}::Y`, STRONG(spec.fn(st) ? 1 : 0));
    inNets.forEach((n, i) => pm.onPinChange(n, (_p, s) => { st[i] = s; update(); }));
    update();
  }

  // ── Flip-flops: sample data on the rising CLK edge, drive Q + Qbar ─────────
  // State is held between edges, so a Q->D feedback (counter / shift register)
  // does not oscillate the settle kernel — the clock edge is the only update.
  for (const c of components) {
    const spec = FF[kindOf(c)];
    if (!spec) continue;
    const clkNet = netKey(c.id, 'CLK');
    const dataNets = spec.data.map((p) => netKey(c.id, p));
    const qNet = netKey(c.id, 'Q');
    const qbarNet = netKey(c.id, 'Qbar');
    let prevClk = pm.getPinState(clkNet);
    let q = false;
    const dataSt = dataNets.map((n) => pm.getPinState(n));
    const emit = () => {
      setBusDrive(pm, qNet, `${c.id}::Q`, STRONG(q ? 1 : 0));
      setBusDrive(pm, qbarNet, `${c.id}::Qbar`, STRONG(q ? 0 : 1));
    };
    dataNets.forEach((n, i) => pm.onPinChange(n, (_p, s) => { dataSt[i] = s; }));
    pm.onPinChange(clkNet, (_p, s) => {
      if (!prevClk && s) { q = spec.sample(q, dataSt); emit(); }
      prevClk = s;
    });
    emit(); // drive initial Q / Qbar
  }

  // Re-drive switches now that rail levels have settled (a switch built before
  // its rail driver landed would have passed a stale 0).
  for (const c of components) if (isSwitch(kindOf(c))) driveSwitch(c);

  const ledIds = components.filter((c) => isLed(kindOf(c))).map((c) => c.id);

  return {
    ok: true,
    pinManager: pm,
    netOf,
    readNet: (net) => (pm.getPinState(net) ? 1 : 0),
    readLed: (ledId) => (pm.getPinState(netKey(ledId, 'A')) ? 1 : 0),
    setSwitch: (switchId, value) => {
      switchState.set(switchId, value);
      const c = byId.get(switchId);
      if (c) driveSwitch(c);
    },
    ledIds,
  };
}

// ── Phase 3: mixed digital/analog boundary ──────────────────────────────────

export interface MixedNetwork {
  ok: boolean;
  pinManager: PinManager;
  netOf(componentId: string, pin: string): number | undefined;
  readNet(net: number): 0 | 1;
  setSwitch(switchId: string, value: 0 | 1): void;
  /** Nets that bridge a digital pin (gate/switch) and an analog pin. These are
   *  where the two motors hand off. */
  boundaryNets: number[];
  /** Digital-side level of a boundary net — what to drive into ngspice as a
   *  0 / Vcc voltage source on that node (digital -> analog). */
  readBoundary(net: number): 0 | 1;
  /** Push an analog-side level (ngspice's threshold-converted node voltage) onto
   *  a boundary net so the gates downstream re-evaluate (analog -> digital). */
  setBoundaryInput(net: number, level: 0 | 1): void;
}

/**
 * Build the digital half of a MIXED circuit and expose its boundary with the
 * analog (ngspice) domain. Unlike buildDigitalNetwork it does NOT bail on
 * non-primitive components — those are the analog side; their pins simply mark
 * the nets they touch as boundary. The caller (the ngspice coupler) reads the
 * digital-driven boundary nets to seed voltage sources, and pushes ngspice's
 * solved+thresholded boundary voltages back via setBoundaryInput, iterating to a
 * fixed point. Settle on the digital side is the same exact kernel as the
 * all-digital path.
 *
 * Phase 3 core: the boundary handoff + digital settle, verifiable headlessly
 * (the analog side is supplied by the test). Wiring it to the live ngspice
 * netlist is the follow-up (needs the browser solver; the node loader is broken
 * by a pre-existing path bug).
 */
export function buildMixedNetwork(
  components: DigitalComponent[],
  wires: DigitalWire[],
  pinManager?: PinManager,
): MixedNetwork {
  const pm = pinManager ?? new PinManager();
  const byId = new Map(components.map((c) => [c.id, c]));
  const uf = new UnionFind();
  for (const w of wires) uf.union(epKey(w.start.componentId, w.start.pinName), epKey(w.end.componentId, w.end.pinName));
  const pinNet = (id: string, pin: string) => uf.find(epKey(id, pin));

  const keyOf = new Map<string, number>();
  let nextKey = 1;
  const netKey = (id: string, pin: string): number => {
    const root = pinNet(id, pin);
    let k = keyOf.get(root);
    if (k === undefined) { k = nextKey++; keyOf.set(root, k); }
    return k;
  };
  const netOf = (id: string, pin: string): number | undefined => (byId.has(id) ? netKey(id, pin) : undefined);

  // Classify each net root by who touches it, walking wire endpoints.
  const hasDigital = new Set<string>();
  const hasAnalog = new Set<string>();
  const mark = (compId: string, pin: string) => {
    const c = byId.get(compId);
    if (!c) return;
    const k = kindOf(c);
    // Pure connectivity — a junction must never tip its net analog/boundary.
    if (isJunction(k)) return;
    const root = pinNet(compId, pin);
    if (isGate(k) || isSwitch(k) || isLed(k)) hasDigital.add(root);
    else if (!isPower(k) && !isResistor(k)) hasAnalog.add(root); // non-primitive = analog
  };
  for (const w of wires) { mark(w.start.componentId, w.start.pinName); mark(w.end.componentId, w.end.pinName); }

  // Static rail/gnd + switches + gates (same model as the all-digital path).
  for (const c of components) {
    if (isPower(kindOf(c))) {
      setBusDrive(pm, netKey(c.id, 'SIG'), `${c.id}::SIG`, STRONG(1));
      setBusDrive(pm, netKey(c.id, 'GND'), `${c.id}::GND`, STRONG(0));
    }
  }
  // SPDT (same model as the all-digital path): pin 2 is the common wiper,
  // connecting to pin 1 at value=0 or pin 3 at value=1; an unwired throw leaves
  // the common floating.
  const wiredPins = new Set<string>();
  for (const w of wires) {
    wiredPins.add(epKey(w.start.componentId, w.start.pinName));
    wiredPins.add(epKey(w.end.componentId, w.end.pinName));
  }
  const switchState = new Map<string, 0 | 1>();
  const driveSwitch = (c: DigitalComponent) => {
    const value = switchState.get(c.id) ?? (Number(c.properties?.value) === 1 ? 1 : 0);
    const common = netKey(c.id, '2');
    const throwPin = value === 1 ? '3' : '1';
    if (wiredPins.has(epKey(c.id, throwPin))) {
      setBusDrive(pm, common, `${c.id}::pass`, STRONG(pm.getPinState(netKey(c.id, throwPin)) ? 1 : 0));
    } else {
      setBusDrive(pm, common, `${c.id}::pass`, { value: 0, strength: Strength.HIGHZ });
    }
  };
  for (const c of components) if (isSwitch(kindOf(c))) driveSwitch(c);
  for (const c of components) {
    if (!isGate(kindOf(c))) continue;
    const spec = parseGate(kindOf(c));
    if (!spec) continue;
    const inNets = spec.inputs.map((p) => netKey(c.id, p));
    const outNet = netKey(c.id, 'Y');
    const st = inNets.map((n) => pm.getPinState(n));
    const update = () => setBusDrive(pm, outNet, `${c.id}::Y`, STRONG(spec.fn(st) ? 1 : 0));
    inNets.forEach((n, i) => pm.onPinChange(n, (_p, s) => { st[i] = s; update(); }));
    update();
  }
  for (const c of components) if (isSwitch(kindOf(c))) driveSwitch(c);

  const boundaryRoots = [...hasDigital].filter((r) => hasAnalog.has(r));
  const boundaryNets = boundaryRoots.map((root) => { const k = keyOf.get(root); return k ?? (keyOf.set(root, nextKey).get(root), nextKey++); });

  return {
    ok: true,
    pinManager: pm,
    netOf,
    readNet: (net) => (pm.getPinState(net) ? 1 : 0),
    setSwitch: (switchId, value) => { switchState.set(switchId, value); const c = byId.get(switchId); if (c) driveSwitch(c); },
    boundaryNets,
    readBoundary: (net) => (pm.getPinState(net) ? 1 : 0),
    setBoundaryInput: (net, level) => setBusDrive(pm, net, `analog::${net}`, STRONG(level)),
  };
}
