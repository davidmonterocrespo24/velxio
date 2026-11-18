/**
 * Map Velxio components (identified by `metadataId`) to SPICE netlist cards.
 *
 * Public contract:
 *   componentToSpice(comp, netLookup, context)
 *     → { cards: string[], modelsUsed: Set<string> }
 *
 * `netLookup(pinName)` returns the canonical net name for that pin. Callers
 * (the NetlistBuilder) are responsible for feeding in a lookup that already
 * knows about Union-Find / canonicalization.
 *
 * Adding new component mappings: append an entry to `MAPPERS`.
 */

import type { ComponentForSpice } from './types';
import { parseValueWithUnits } from './valueParser';
import { isAuxRailNet } from './boardPinGroups';
import { LM358_SUBCKT } from './models/lm358Subckt';
import { getChipDrivenPins } from '../customChips/chipPinDrives';
import { HC14_VT_NEG_FRACTION, HC14_VT_POS_FRACTION } from '../LogicFamilies';
import { ldrModuleFixedOhms, ldrParams, ldrResistance } from './ldrModel';

export interface SpiceEmission {
  /** One or more netlist lines (without trailing newline). */
  cards: string[];
  /** Model or subckt names this emission depends on (so the builder adds `.model` later). */
  modelsUsed: Set<string>;
  /**
   * Nets this part powers: a battery's or a bench supply's positive terminal,
   * a generator's output, a regulator's VOUT. NetlistBuilder reads it before
   * it names the rails: a part's VCC pin on such a net, or behind series
   * parts from it (a switch, an ammeter, a fuse), is powered by it and is not
   * joined to the logic rail its name suggests (velxio/velxio-prod#102).
   */
  supplies?: string[];
  /**
   * Other nets this part holds at a voltage of its own (an op-amp's OUT): a
   * VCC pin wired straight to one is powered by it, but no supply reaches
   * past it. A V, B, E or H card on a wired net says so already; declare the
   * nets the cards do not show (a subcircuit's output).
   */
  drives?: string[];
  /**
   * A switch with memory (a relay's armature): the node its S cards follow
   * and where they change state. The circuit service reads the node after a
   * solve and builds the next deck with the switches where they ended
   * (MapperContext.operated), so a sealed-in relay stays in.
   */
  memory?: { control: string; on: number; off: number };
}

export type NetLookup = (pinName: string) => string | null;

export interface MapperContext {
  /** Supply voltage in effect (V). Boards set this; ground is 0. */
  vcc: number;
  /** A part with memory (SpiceEmission.memory): whether its last solve left
   *  it operated. Absent: released, as at power-up. */
  operated?: boolean;
  /** Nets driven by a logic gate on a feedback loop (an SR latch), which the
   *  deck seeds with .nodeset (velxio/velxio-prod#147). */
  latchNets?: ReadonlySet<string>;
}

export type Mapper = (
  comp: ComponentForSpice,
  netLookup: NetLookup,
  ctx: MapperContext,
) => SpiceEmission | null;

// ── Helpers ────────────────────────────────────────────────────────────────

/** An op-amp's supply nets: its V+ and V- pins, null for a pin left unwired. */
function opampSupply(netLookup: NetLookup): { vp: string | null; vm: string | null } {
  return { vp: netLookup('V+'), vm: netLookup('V-') };
}

/**
 * A saturating op-amp: V_out = clamp(gain · (V+in − V-in), V- + lo, V+ − hi).
 *
 * A supply pin that is wired puts its net in the clamp, so an LM741 on ±12 V
 * swings to ±10.5 V. One left unwired is the board's logic rail (V+) or
 * ground (V-), as numbers, which is exactly the netlist these parts produced
 * before they had supply pins. A wired V+ also draws the part's quiescent
 * current, `iq`, the resistor that keeps a supply net with nothing else on it
 * from floating.
 */
function behaviouralOpamp(
  comp: ComponentForSpice,
  netLookup: NetLookup,
  ctx: MapperContext,
  p: { gain: number; rin: string; lo: number; hi: number; iq: string },
): SpiceEmission | null {
  const inp = netLookup('IN+');
  const inn = netLookup('IN-');
  const out = netLookup('OUT');
  if (!inp || !inn || !out) return null;
  const { vp, vm } = opampSupply(netLookup);
  const vLo = vm ? `V(${vm})+${p.lo}` : `${p.lo}`;
  const vHi = vp ? `V(${vp})-${p.hi}` : `${ctx.vcc - p.hi}`;
  const cards = [
    `R_${comp.id}_inp ${inp} 0 ${p.rin}`,
    `R_${comp.id}_inn ${inn} 0 ${p.rin}`,
    `B_${comp.id} ${out} 0 V = max(${vLo}, min(${vHi}, ${p.gain}*(V(${inp})-V(${inn}))))`,
    `R_${comp.id}_out ${out} 0 1Meg`,
  ];
  if (vp) cards.push(`R_${comp.id}_iq ${vp} ${vm ?? '0'} ${p.iq}`);
  return { cards, modelsUsed: new Set() };
}

/** A volt figure for a card, without float noise (0.55 * 5 is 2.7500000000000004). */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function twoPin(
  comp: ComponentForSpice,
  netLookup: NetLookup,
  pinA: string,
  pinB: string,
): [string, string] | null {
  const a = netLookup(pinA);
  const b = netLookup(pinB);
  if (!a || !b) return null;
  return [a, b];
}

function emitResistor(
  comp: ComponentForSpice,
  pins: [string, string],
  value: number,
): SpiceEmission {
  return {
    cards: [`R_${comp.id} ${pins[0]} ${pins[1]} ${value}`],
    modelsUsed: new Set(),
  };
}

function emitCapacitor(
  comp: ComponentForSpice,
  pins: [string, string],
  value: number,
  ic = 0,
): SpiceEmission {
  return {
    cards: [`C_${comp.id} ${pins[0]} ${pins[1]} ${value} IC=${ic}`],
    modelsUsed: new Set(),
  };
}

function emitInductor(
  comp: ComponentForSpice,
  pins: [string, string],
  value: number,
): SpiceEmission {
  return {
    cards: [`L_${comp.id} ${pins[0]} ${pins[1]} ${value}`],
    modelsUsed: new Set(),
  };
}

// ── Bench power supply (constant voltage / constant current) ─────────────
/** Output resistance of the supply in constant-voltage mode. */
const SUPPLY_OUTPUT_OHMS = '10m';
/** Gain of its current limiter (V/A): a dead short overshoots the limit by
 *  setpoint / gain, 0.9 mA at 9 V. */
const SUPPLY_CC_GAIN = 1e4;
/** The lowest current limit the supply takes (A); the circuit check uses it too. */
export const MIN_SUPPLY_LIMIT_A = 0.01;

// ── LED colour → Shockley params (tuned so V_f at 10 mA matches datasheet) ──
const LOGIC_EDGE_VOLTS = 0.05;
/**
 * The L293D's input threshold: the midpoint of its guaranteed levels, VIL 1.5 V
 * max and VIH 2.3 V min (TI SLRS008D, 6.3), for any board supply.
 */
const L293D_VT = 1.9;

/** `0..1` step of `V(net)` around `threshold`, with a finite slope (see the gates note). */
function logicStep(net: string, threshold: number): string {
  return `(0.5*(1+tanh((V(${net})-${threshold})/${LOGIC_EDGE_VOLTS})))`;
}

/**
 * Output resistance of a logic gate on a feedback loop, about a 74HC output
 * (TI SN74HC00: VOH 4.31 V min at -4 mA from 4.5 V). It is what lets the
 * deck's .nodeset place the loop in a state (see the gates note).
 */
const LATCH_GATE_OHMS = 25;

/** The node a gate's B source drives: its output pin, or, on a feedback loop
 *  (MapperContext.latchNets), an internal node behind LATCH_GATE_OHMS. */
function gateOutput(id: string, y: string, ctx: MapperContext): { node: string; cards: string[] } {
  if (!ctx.latchNets?.has(y)) return { node: y, cards: [] };
  const node = `${id}_yi`;
  return { node, cards: [`R_${id}_ro ${node} ${y} ${LATCH_GATE_OHMS}`] };
}

/** Which pins of a logic part drive which: per gate, its inputs and its output. */
export interface GateLink {
  inputs: string[];
  output: string;
}

const GATE_LINKS: Record<string, GateLink[]> = (() => {
  const t: Record<string, GateLink[]> = {};
  for (const g of ['and', 'or', 'nand', 'nor', 'xor', 'xnor']) t[`logic-gate-${g}`] = [{ inputs: ['A', 'B'], output: 'Y' }];
  t['logic-gate-not'] = [{ inputs: ['A'], output: 'Y' }];
  for (const g of ['and', 'or', 'nand', 'nor']) {
    t[`logic-gate-${g}-3`] = [{ inputs: ['A', 'B', 'C'], output: 'Y' }];
    t[`logic-gate-${g}-4`] = [{ inputs: ['A', 'B', 'C', 'D'], output: 'Y' }];
  }
  for (const ic of ['ic-74hc00', 'ic-74hc08', 'ic-74hc32', 'ic-74hc02', 'ic-74hc86']) {
    t[ic] = [1, 2, 3, 4].map((i) => ({ inputs: [`${i}A`, `${i}B`], output: `${i}Y` }));
  }
  for (const ic of ['ic-74hc04', 'ic-74hc14']) {
    t[ic] = [1, 2, 3, 4, 5, 6].map((i) => ({ inputs: [`${i}A`], output: `${i}Y` }));
  }
  return t;
})();

/** The gates of a logic part (inputs -> output), or null for any other part.
 *  NetlistBuilder finds the feedback loops (latches) from them. */
export function logicGateLinks(metadataId: string): readonly GateLink[] | null {
  return GATE_LINKS[metadataId] ?? null;
}

// One entry per colour the part's colour select offers: a colour missing here
// used to take the red card silently, so orange and purple (velxio/velxio-prod
// #95) ran at 1.8 V. Forward voltage at 10 mA / 20 mA:
//   red     1.82 / 1.85 V
//   orange  1.98 / 2.01 V  Kingbright WP7113SED, 601 nm: 2.0 V typ at 20 mA
//   yellow  2.04 / 2.07 V
//   green   2.26 / 2.30 V
//   blue    3.10 / 3.13 V  (white: the same InGaN die)
//   purple  3.27 / 3.30 V  Lumimax LED5-PUR420, 420 nm: 3.3 V typ at 20 mA
//                          (LED5PUR, 395 nm: 3.4 V)
// ngspice keeps Is at 1e-28 or more, so a higher voltage than blue's takes a
// larger emission coefficient, not a smaller Is.
const LED_MODELS: Record<string, { name: string; Is: string; n: string }> = {
  red: { name: 'LED_RED', Is: '1e-20', n: '1.7' },
  orange: { name: 'LED_ORANGE', Is: '1e-21', n: '1.75' },
  green: { name: 'LED_GREEN', Is: '1e-22', n: '1.9' },
  yellow: { name: 'LED_YELLOW', Is: '1e-21', n: '1.8' },
  blue: { name: 'LED_BLUE', Is: '1e-28', n: '2.0' },
  white: { name: 'LED_WHITE', Is: '1e-28', n: '2.0' },
  purple: { name: 'LED_PURPLE', Is: '1e-28', n: '2.11' },
};

// ── Relays: pull-in, drop-out, and which pins are the coil ────────────────
// ngspice SW closes at Vt + Vh and opens at Vt - Vh. With Vt = 0.6 and
// Vh = 0.15 of the nominal coil voltage a relay's contacts close at 75 % of
// it and, within a time-domain run, open again below 45 %. 75 % is the
// Songle SRD-05VDC-SL-C's must-operate maximum, the voltage at which every
// relay is guaranteed to close (Omron: apply that percentage or more to make
// sure it operates); 45 % is above its guaranteed 10 % release.
const RELAY_SW_VT = 0.6;
const RELAY_SW_VH = 0.15;
/** The fraction of its nominal coil voltage at which a relay pulls in. The
 *  circuit check warns about a coil fed below it (velxio/velxio-prod#108). */
export const RELAY_PULL_IN_FRACTION = RELAY_SW_VT + RELAY_SW_VH;
/** ...and the fraction below which a pulled-in relay drops out again. */
const RELAY_DROP_OUT_FRACTION = RELAY_SW_VT - RELAY_SW_VH;

/**
 * A relay contact set's memory (SpiceEmission.memory) and the state flag its S
 * cards start in. ngspice starts a switch whose control sits inside its
 * hysteresis band in the state its ON/OFF instance flag gives it, OFF by
 * default; with no flag every solve began with the contacts open, so a relay
 * fed through its own NO contact (a seal-in) dropped out the moment its
 * START button was released (velxio/velxio-prod#109).
 */
function relayMemory(
  control: string,
  coilV: number,
  operated: boolean | undefined,
): { memory: NonNullable<SpiceEmission['memory']>; flag: string } {
  return {
    memory: {
      control,
      on: round3(coilV * RELAY_PULL_IN_FRACTION),
      off: round3(coilV * RELAY_DROP_OUT_FRACTION),
    },
    flag: operated ? ' ON' : '',
  };
}
/**
 * The two switch models of a relay contact set for a coil of `coilV`, named by
 * that voltage: NO conducts while the switch is on, NC is the same switch with
 * the conductances swapped, so it conducts while the switch is off. Sharing
 * the control and the hysteresis state makes NC exactly the complement of NO
 * (velxio/velxio-prod#169). A name per coil voltage keeps a 5 V and a 12 V
 * relay on one canvas from sharing one `.model` line (the first one won).
 */
function relaySwitchModels(
  prefix: string,
  coilV: number,
): { no: string; nc: string; noCard: string; ncCard: string } {
  const tag = String(round3(coilV)).replace('-', 'm').replace('.', 'p');
  const no = `${prefix}_NO_${tag}`;
  const nc = `${prefix}_NC_${tag}`;
  const vt = round3(coilV * RELAY_SW_VT);
  const vh = round3(coilV * RELAY_SW_VH);
  return {
    no,
    nc,
    noCard: `.model ${no} SW(Vt=${vt} Vh=${vh} Ron=0.05 Roff=1G)`,
    ncCard: `.model ${nc} SW(Vt=${vt} Vh=${vh} Ron=1G Roff=0.05)`,
  };
}

/** The KS2E-M-DC5 has no coil_voltage field: its coil is the 5 V of its name. */
const KS2E_COIL_VOLTS = 5;

/** A relay part's coil, as the circuit check needs it. */
export interface RelayCoil {
  /** The coil's two pins. */
  coil: [string, string];
  /** Each group of contact pins the armature switches among; galvanically
   *  isolated from the coil and from each other. */
  contacts: string[][];
  /** The property holding the nominal coil voltage, when the part has one. */
  voltageField?: string;
  /** The nominal coil voltage when no field sets it (and the field's default). */
  volts: number;
}

const RELAY_COILS: Record<string, RelayCoil> = {
  relay: { coil: ['COIL+', 'COIL-'], contacts: [['COM', 'NO', 'NC']], voltageField: 'coil_voltage', volts: 5 },
  'ks2e-m-dc5': {
    coil: ['COIL1', 'COIL2'],
    contacts: [
      ['P1', 'NO1', 'NC1'],
      ['P2', 'NO2', 'NC2'],
    ],
    volts: KS2E_COIL_VOLTS,
  },
};

/** The coil of a relay part, or null for a part that is not a relay. */
export function relayCoilOf(metadataId: string): RelayCoil | null {
  return RELAY_COILS[metadataId] ?? null;
}

/** Colours already reported as missing from LED_MODELS (one warning each). */
const unknownLedColours = new Set<string>();

// ── NTC β-model ────────────────────────────────────────────────────────────
function ntcResistance(Tc: number, R0 = 10_000, T0 = 298.15, beta = 3950): number {
  const T = Tc + 273.15;
  return R0 * Math.exp(beta * (1 / T - 1 / T0));
}

// ── Mappers (one per metadataId) ───────────────────────────────────────────

/**
 * A linear regulator: a behavioural source holding VOUT, plus the current it
 * delivers drawn back out of VIN.
 *
 * The B source alone took nothing from its input, so a reservoir capacitor in
 * front of a regulator never discharged into the load: no ripple, and a
 * "linear" regulator that dissipated nothing. A 0 V source senses the output
 * current and an F source (current-controlled current source) pulls the same
 * current from VIN to the reference, which is what a series-pass regulator
 * does (quiescent current left out).
 */
function regulatorCards(id: string, vin: string, ref: string, vout: string, expr: string): string[] {
  return [
    `B_${id} ${id}_reg ${ref} V = ${expr}`,
    `V_${id}_iout ${id}_reg ${vout} DC 0`,
    `F_${id}_iin ${vin} ${ref} V_${id}_iout 1`,
    `R_${id}_out ${vout} ${ref} 10Meg`,
  ];
}

const MAPPERS: Record<string, Mapper> = {
  // Custom chip — emit a DC voltage source for every pin the chip's WASM is
  // currently driving as an output (recorded in customChips/chipPinDrives).
  // This makes the chip a first-class SPICE source on its nets, so LEDs,
  // resistors and analog parts wired straight to a chip output pin are driven
  // by the engine — exactly like a board GPIO. Chip pins wired to a real board
  // pin resolve to that board's source instead and aren't recorded here.
  'custom-chip': (comp, netLookup) => {
    const driven = getChipDrivenPins(comp.id);
    if (driven.length === 0) return null;
    const cid = String(comp.id).replace(/[^A-Za-z0-9_]/g, '_');
    const cards: string[] = [];
    for (const { pin, voltage } of driven) {
      const net = netLookup(pin);
      // Never stamp a chip source onto a rail — it would fight the rail's own
      // ideal source (aux rails included).
      if (!net || net === '0' || net === 'vcc_rail' || isAuxRailNet(net)) continue;
      const pid = String(pin).replace(/[^A-Za-z0-9_]/g, '_');
      cards.push(`V_${cid}_${pid} ${net} 0 DC ${voltage}`);
    }
    if (cards.length === 0) return null;
    return { cards, modelsUsed: new Set() };
  },

  // Passive — Velxio existing parts
  resistor: (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, '1', '2');
    if (!pins) return null;
    const ohms = parseValueWithUnits(comp.properties.value, 1000);
    return emitResistor(comp, pins, ohms);
  },
  'resistor-us': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, '1', '2');
    if (!pins) return null;
    const ohms = parseValueWithUnits(comp.properties.value, 1000);
    return emitResistor(comp, pins, ohms);
  },
  capacitor: (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, '1', '2');
    if (!pins) return null;
    const farads = parseValueWithUnits(comp.properties.value, 1e-6);
    return emitCapacitor(comp, pins, farads);
  },
  // Polarized aluminum-can cap. Pin names match the visual SVG ('+' / '−');
  // SPICE itself is bidirectional so the order doesn't matter for the solve,
  // but the names let us validate user wiring later.
  'capacitor-electrolytic': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, '+', '−');
    if (!pins) return null;
    const farads = parseValueWithUnits(comp.properties.value, 1e-6);
    return emitCapacitor(comp, pins, farads);
  },
  inductor: (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, '1', '2');
    if (!pins) return null;
    const henries = parseValueWithUnits(comp.properties.value, 1e-3);
    return emitInductor(comp, pins, henries);
  },

  // Passive (new generic parts — Phase 8.4 seeds)
  'analog-resistor': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'B');
    if (!pins) return null;
    const ohms = parseValueWithUnits(comp.properties.value, 1000);
    return emitResistor(comp, pins, ohms);
  },
  'analog-capacitor': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'B');
    if (!pins) return null;
    const farads = parseValueWithUnits(comp.properties.value, 1e-6);
    return emitCapacitor(comp, pins, farads);
  },
  'analog-inductor': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'B');
    if (!pins) return null;
    const henries = parseValueWithUnits(comp.properties.value, 1e-3);
    return emitInductor(comp, pins, henries);
  },

  // LEDs (colored)
  // A zero-volt sense source is inserted in series so ngspice emits
  // `i(v_<id>_sense)` in the branch currents (diodes on their own produce no
  // `i(...)` vector). BasicParts.ts reads that key to drive `el.brightness`.
  led: (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    const color = String(comp.properties.color ?? 'red').toLowerCase();
    let model = LED_MODELS[color];
    if (!model) {
      // An imported project can name any colour. Say which curve it gets
      // instead of handing it the red one in silence.
      if (!unknownLedColours.has(color)) {
        unknownLedColours.add(color);
        // eslint-disable-next-line no-console
        console.warn(`[spice] LED colour "${color}" has no diode model; simulated as red (1.8 V).`);
      }
      model = LED_MODELS.red;
    }
    const midNet = `${comp.id}_sense_mid`;
    return {
      cards: [
        `V_${comp.id}_sense ${pins[0]} ${midNet} DC 0`,
        `D_${comp.id} ${midNet} ${pins[1]} ${model.name}`,
      ],
      modelsUsed: new Set([`.model ${model.name} D(Is=${model.Is} N=${model.n})`]),
    };
  },

  // Generic diode
  diode: (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} DGENERIC`],
      modelsUsed: new Set(['.model DGENERIC D(Is=1e-14 N=1)']),
    };
  },
  'diode-1n4148': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} D1N4148`],
      // Source: LTSpice-Libraries / Linear Tech standard.dio (OnSemi origin).
      // Adds reverse-recovery time (tt=20n) so AC/transient behaviour is
      // correct at MHz speeds. Original Bv/Ibv preserved for breakdown.
      modelsUsed: new Set([
        '.model D1N4148 D(Is=2.52n Rs=.568 N=1.752 Cjo=4p M=.4 tt=20n Bv=100 Ibv=0.1u)',
      ]),
    };
  },
  // Vishay's own 1N4007 model (vishay.com/docs/89789/1n4007.txt): 0.63 V at
  // 10 mA, 0.74 V at 0.1 A and 0.89 V at 1 A, on the typical curve of the
  // 1N4001-1N4007 datasheet (Fig. 4: about 0.62 / 0.75 / 0.9 V; 1.1 V max at
  // 1 A). The card before dropped 0.44 V at 10 mA and 0.67 V at 1 A, 0.2 V
  // under any silicon rectifier (velxio/velxio-prod#132). Its storage time,
  // Tt=4.10886u, is left out: at an amp it is a diffusion capacitance of
  // about 90 uF, and on the trapezoidal method a rectifier charging 1000 uF
  // from the lab supply rang +-17 mA every sample (power-supply-cv-cc spec)
  // for a recovery that only matters at tens of kHz, where a 1N4007 is the
  // wrong part anyway.
  'diode-1n4007': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} D1N4007`],
      modelsUsed: new Set([
        '.model D1N4007 D(Is=14.3733n N=1.80829 Rs=0.0414712 Eg=1.11 Xti=3 Cjo=28.119p Vj=0.700053 M=0.346714 Fc=0.5 Bv=1100 Ibv=10)',
      ]),
    };
  },
  // 1N4733A (Vishay 1N4728A series): VZ 5.1 V at IZT = 49 mA, ZZT 7 ohm max,
  // VF 1.2 V max at 200 mA. ngspice puts the junction at Bv when it carries
  // Ibv, and Rs adds IZT * Rs on top, so Bv is 5.1 V less that: the card had
  // Bv=5.1 with Rs=5 and read 5.34 V at IZT (velxio/velxio-prod#132). Rs=2
  // gives a 2.5 ohm slope at IZT (4.95 V at 5 mA, 5.22 V at 0.1 A) and keeps
  // the forward drop a silicon one: 0.69 V at 10 mA, 1.15 V at 200 mA (it was
  // 0.47 V and 1.49 V).
  'zener-1n4733': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} D1N4733`],
      modelsUsed: new Set(['.model D1N4733 D(Is=50f N=1 Rs=2 Bv=5.002 Ibv=49m)']),
    };
  },

  // BJT real part numbers — NPN. Phase 2: full Gummel-Poon parameters sourced
  // from LTSpice-Libraries (Linear Tech standard.bjt). These include junction
  // capacitances (CJC/CJE) and transit times (TF/TR/ITF/VTF/XTF) so the parts
  // model AC and switching behaviour correctly, not just DC saturation.
  'bjt-2n2222': (comp, netLookup) => {
    const c = netLookup('C');
    const b = netLookup('B');
    const e = netLookup('E');
    if (!c || !b || !e) return null;
    return {
      cards: [`Q_${comp.id} ${c} ${b} ${e} Q2N2222`],
      modelsUsed: new Set([
        // ISE/NE (velxio/velxio-prod#136): the stock card had no base
        // leakage term, so its gain stayed at 218 down to 0.1 mA. onsemi's
        // P2N2222A typical curve (Fig. 3, VCE 10 V) falls to about 150 at
        // 1 mA and 105 at 0.1 mA; with these two the card gives 152 and 108
        // (179 at 10 mA, 141 at 150 mA as before, every point above the
        // datasheet minimums 35 / 50 / 75 / 100).
        '.model Q2N2222 NPN(IS=1E-14 VAF=100 BF=200 IKF=0.3 ISE=2.5E-13 NE=1.588 XTB=1.5 BR=3 CJC=8E-12 CJE=25E-12 TR=100E-9 TF=400E-12 ITF=1 VTF=2 XTF=3 RB=10 RC=.3 RE=.2)',
      ]),
    };
  },
  'bjt-bc547': (comp, netLookup) => {
    const c = netLookup('C');
    const b = netLookup('B');
    const e = netLookup('E');
    if (!c || !b || !e) return null;
    return {
      cards: [`Q_${comp.id} ${c} ${b} ${e} QBC547`],
      modelsUsed: new Set([
        '.model QBC547 NPN(IS=2.39E-14 NF=1.008 ISE=3.545E-15 NE=1.541 BF=294.3 IKF=0.1357 VAF=63.2 NR=1.004 ISC=6.272E-14 NC=1.243 BR=7.946 IKR=0.1144 VAR=25.9 RB=1 IRB=1u RBM=1 RE=0.4683 RC=0.85 XTB=0 EG=1.11 XTI=3 CJE=1.358E-11 VJE=0.65 MJE=0.3279 TF=4.391E-10 XTF=120 VTF=2.643 ITF=0.7495 CJC=3.728E-12 VJC=0.3997 MJC=0.2955 XCJC=0.6193 TR=1E-32)',
      ]),
    };
  },
  'bjt-2n3055': (comp, netLookup) => {
    const c = netLookup('C');
    const b = netLookup('B');
    const e = netLookup('E');
    if (!c || !b || !e) return null;
    return {
      cards: [`Q_${comp.id} ${c} ${b} ${e} Q2N3055`],
      modelsUsed: new Set([
        // Fitted to onsemi's 2N3055 (Rev. 7) at VCE 4 V (velxio/velxio-prod
        // #136): VBE 0.63 V at 0.1 A and 0.73 V at 1 A (Fig. 7: about 0.62 /
        // 0.72 V), hFE 112 / 92 (Fig. 3: about 110 / 95) and 57 at 4 A
        // (guaranteed 20-70). The card before (IS=2.37E-8 BF=73 IK=1) read
        // VBE 0.40 / 0.50 V and hFE 66 / 36 / 15, under the 4 A minimum.
        // Junction capacitances and transit times are the old card's.
        '.model Q2N3055 NPN(IS=3E-12 BF=115 IKF=4 BR=2.66 RB=.81 RC=.0856 RE=.03 CJC=1000P PC=.75 MC=.33 TR=.5703U CJE=415P PE=.75 ME=.5 TF=99.52N)',
      ]),
    };
  },

  // BJT — PNP
  'bjt-2n3906': (comp, netLookup) => {
    const c = netLookup('C');
    const b = netLookup('B');
    const e = netLookup('E');
    if (!c || !b || !e) return null;
    return {
      cards: [`Q_${comp.id} ${c} ${b} ${e} Q2N3906`],
      modelsUsed: new Set([
        '.model Q2N3906 PNP(IS=1E-14 VAF=100 BF=200 IKF=0.4 XTB=1.5 BR=4 CJC=4.5E-12 CJE=10E-12 RB=20 RC=0.1 RE=0.1 TR=250E-9 TF=350E-12 ITF=1 VTF=2 XTF=3)',
      ]),
    };
  },
  'bjt-bc557': (comp, netLookup) => {
    const c = netLookup('C');
    const b = netLookup('B');
    const e = netLookup('E');
    if (!c || !b || !e) return null;
    return {
      cards: [`Q_${comp.id} ${c} ${b} ${e} QBC557`],
      modelsUsed: new Set([
        '.model QBC557 PNP(IS=3.83E-14 NF=1.008 ISE=1.22E-14 NE=1.528 BF=344.4 IKF=0.08039 VAF=21.11 NR=1.005 ISC=2.85E-13 NC=1.28 BR=14.84 IKR=0.047 VAR=32.02 RB=1 IRB=1u RBM=1 RE=0.6202 RC=0.5713 XTB=0 EG=1.11 XTI=3 CJE=1.23E-11 VJE=0.6106 MJE=0.378 TF=5.60E-10 XTF=3.414 VTF=5.23 ITF=0.1483 CJC=1.08E-11 VJC=0.1022 MJC=0.3563 XCJC=0.6288 TR=1E-32)',
      ]),
    };
  },

  // MOSFETs — NMOS. Phase 2.1: VDMOS macro-models from LTSpice-Libraries.
  // VDMOS is 3-terminal (D G S) — no body, no L/W — and uses physical
  // parameters (Ron, Vto, gate capacitances, Qg) instead of Level=1's
  // process-level Kp/W/L. Models reflect manufacturer datasheets so the
  // simulator now sees real Ron, switching speed, and gate-charge effects.
  //
  // Library coverage gaps: IRF540 and IRF9540 are not in LTSpice's
  // `standard.mos`. IRF530 (100 V N-MOS, same series) substitutes for IRF540.
  // IRF9640 (200 V P-MOS) substitutes for IRF9540 — both close enough that
  // a casual circuit drawn around "IRF540" still behaves correctly.
  //
  // Breakdown: LTspice's `Vds=` is a label ngspice ignores, so none of these
  // ever broke down, and a coil switched off with no flyback diode drove the
  // drain to kilovolts (2.6 kV on a 2N7000 from 5 V). `BV` puts the
  // avalanche on the body diode (ngspice README.vdmos), at the part's rated
  // V(BR)DSS: 60 V for the 2N7000 (onsemi), 100 V for the IRF540 and the
  // IRF9540 (Vishay). The drain now clamps there, as a real part's does
  // before it dissipates the energy or fails (velxio/velxio-prod#110).
  'mosfet-2n7000': (comp, netLookup) => {
    const d = netLookup('D');
    const g = netLookup('G');
    const s = netLookup('S');
    if (!d || !g || !s) return null;
    return {
      cards: [`M_${comp.id} ${d} ${g} ${s} M2N7000`],
      modelsUsed: new Set([
        '.model M2N7000 VDMOS(Rg=3 Vto=1.6 Rd=0 Rs=.75 Rb=.14 Kp=.17 mtriode=1.25 Cgdmax=80p Cgdmin=12p Cgs=50p Cjo=50p Is=.04p BV=60 Vds=60 Ron=2 Qg=1.5n)',
      ]),
    };
  },
  'mosfet-irf540': (comp, netLookup) => {
    const d = netLookup('D');
    const g = netLookup('G');
    const s = netLookup('S');
    if (!d || !g || !s) return null;
    return {
      cards: [`M_${comp.id} ${d} ${g} ${s} MIRF540`],
      modelsUsed: new Set([
        // Substitute: LTSpice ships IRF530 (same TO-220, 100 V, slightly
        // smaller die). Close enough for the canvas.
        '.model MIRF540 VDMOS(Rg=3 Vto=4 Rd=50m Rs=12m Rb=60m Kp=5 lambda=.01 Cgdmax=1n Cgdmin=.26n Cgs=.2n Cjo=.4n Is=52p BV=100 Vds=100 Ron=160m Qg=26n)',
      ]),
    };
  },

  // MOSFETs — PMOS (P-channel: Vto is negative, V_GS < Vto turns device ON)
  'mosfet-irf9540': (comp, netLookup) => {
    const d = netLookup('D');
    const g = netLookup('G');
    const s = netLookup('S');
    if (!d || !g || !s) return null;
    return {
      cards: [`M_${comp.id} ${d} ${g} ${s} MIRF9540`],
      modelsUsed: new Set([
        // Substitute: LTSpice ships IRF9640. 200 V vs IRF9540's 100 V, but
        // identical pin-out and similar Vto; BV gives it the IRF9540's own
        // 100 V breakdown. The `pchan` keyword is what tells the VDMOS
        // engine to flip polarity.
        '.model MIRF9540 VDMOS(pchan Rg=3 Vto=-3.5 Rd=.15 Rs=.15 Rb=.15 Kp=8 lambda=.01 mtriode=.5 Cgdmax=1.5n Cgdmin=.07n Cgs=1n Cjo=1n Is=38p BV=100 Vds=-100 Ron=.5 Qg=44n)',
      ]),
    };
  },
  // FQP27P06: a VDMOS card fitted to Fairchild's datasheet (Rev. A2), as no
  // library carries one (velxio/velxio-prod#136). RDS(on) 54 mohm at VGS
  // -10 V, ID -13.5 A (0.055 typ, 0.07 max); VGS(th) -2.66 V at 250 uA
  // (-2 to -4 V); gFS 12.6 S at 13.5 A (12.4 typ); 14.8 A at VGS -5 V, VDS
  // -30 V (Fig. 2: about 15 A); Ciss / Crss / Coss 1114 / 114 / 466 pF at
  // VDS -25 V (1100 / 120 / 510 typ); BV at its -60 V rating (#110). A 5 V
  // gate swing turns it well on (0.11 ohm at 1 A); 3.3 V barely (0.5 A at
  // VDS -1 V). The Level-1 placeholder it replaces was 32.6 ohm at -5 V and
  // 10.7 ohm at -10 V (200 times the datasheet), with no breakdown.
  'mosfet-fqp27p06': (comp, netLookup) => {
    const d = netLookup('D');
    const g = netLookup('G');
    const s = netLookup('S');
    if (!d || !g || !s) return null;
    return {
      cards: [`M_${comp.id} ${d} ${g} ${s} MFQP27P06`],
      modelsUsed: new Set([
        '.model MFQP27P06 VDMOS(pchan Vto=-2.9 Kp=6 Rd=20m Rs=10m Rb=10m lambda=.01 Cgdmax=1n Cgdmin=.1n Cgs=1n Cjo=2n BV=60 Vds=-60 Ron=55m Qg=33n)',
      ]),
    };
  },

  // Op-amp (behavioral VCVS — simplest macro)
  'opamp-ideal': (comp, netLookup) => {
    const inp = netLookup('IN+');
    const inn = netLookup('IN-');
    const out = netLookup('OUT');
    if (!inp || !inn || !out) return null;
    return {
      cards: [`E_${comp.id} ${out} 0 ${inp} ${inn} 1e6`],
      modelsUsed: new Set(),
    };
  },

  // ── Real op-amp part numbers (behavioral, saturation-clamped) ─────────────
  // The three behavioural mappers follow the same shape:
  //   V_out = clamp(A · (V_in+ − V_in-), Vsat_lo, Vsat_hi)
  // The output saturates between a low rail (V- + headroom) and a high rail
  // (V+ − headroom). Headroom is chip-specific (LM324 swings close to its
  // negative rail, LM741 needs ~1.5 V from each, TL072 with JFET input ~2 V).
  // The LM358 is a real macro-model whose supply pins carry the same rails.
  //
  // The rails are the part's V+ and V- pins (see opampSupply). Unwired, they
  // are the board's logic rail and ground, the only supply an op-amp had
  // before the pins existed, so a circuit drawn then solves as it always did.
  //
  // Input impedance is 1 MΩ differential + a 10 MΩ common-mode load so the
  // netlist never has floating inputs during DC.
  'opamp-lm358': (comp, netLookup) => {
    const inp = netLookup('IN+');
    const inn = netLookup('IN-');
    const out = netLookup('OUT');
    if (!inp || !inn || !out) return null;
    // Phase 1d #9: real LM358 macro-model subckt enabled now that
    // Phase 1d #2 added `.options gmin=1e-10 gminsteps=20 sourcesteps=10
    // method=gear maxord=2` to both adapters — the subckt converges
    // where the prior `.op` skipped. Real slew rate (~0.5 V/µs), GBW
    // (~1 MHz), and rail headroom come for free vs the prior behavioural
    // B-source clamp. Its supply pins take the part's V+ / V- nets.
    const { vp, vm } = opampSupply(netLookup);
    return {
      cards: [`X_${comp.id} ${inp} ${inn} ${vp ?? 'vcc_rail'} ${vm ?? '0'} ${out} LM358`],
      modelsUsed: new Set([LM358_SUBCKT]),
      drives: [out],
    };
  },
  'opamp-lm741': (comp, netLookup, ctx) =>
    behaviouralOpamp(comp, netLookup, ctx, { gain: 2e5, rin: '2Meg', lo: 1.5, hi: 1.5, iq: '9k' }),
  // JFET input: huge Z_in, modelled with 1 TΩ
  'opamp-tl072': (comp, netLookup, ctx) =>
    behaviouralOpamp(comp, netLookup, ctx, { gain: 2e5, rin: '1T', lo: 2.0, hi: 2.0, iq: '11k' }),
  // Quad op-amp — electrically identical to LM358 per-channel
  'opamp-lm324': (comp, netLookup, ctx) =>
    behaviouralOpamp(comp, netLookup, ctx, { gain: 1e5, rin: '10Meg', lo: 0.05, hi: 1.5, iq: '82k' }),

  // ── Linear voltage regulators ────────────────────────────────────────────
  // Behavioral model: V_out = min(V_in - V_dropout, V_nom). Dropout voltage
  // ≈ 2V for classic 78xx / 79xx series. When V_in is too low, V_out drops
  // to (V_in − V_dropout), matching real-chip behaviour in under-voltage,
  // down to 0 V and no further: the pass transistor only sources from VIN
  // ("the output of the device does not sink current", TI LM340 8.1.2).
  // Unclamped, 0 V in gave -2 V out (+2 V on a 7905), and the input mirror
  // pushed the load's reverse current into VIN, so a supply's reservoir
  // capacitor sat at 2 V before anything had powered it
  // (velxio/velxio-prod#130).
  // Pin names: VIN, VOUT, GND (for 78xx) — for 79xx GND swaps to be a
  // reference rail since V_out is negative.
  'reg-7805': (comp, netLookup) => {
    const vin = netLookup('VIN');
    const gnd = netLookup('GND');
    const vout = netLookup('VOUT');
    if (!vin || !gnd || !vout) return null;
    return {
      cards: regulatorCards(comp.id, vin, gnd, vout, `max(0, min(V(${vin})-V(${gnd})-2, 5))`),
      modelsUsed: new Set(),
      supplies: [vout],
    };
  },
  'reg-7812': (comp, netLookup) => {
    const vin = netLookup('VIN');
    const gnd = netLookup('GND');
    const vout = netLookup('VOUT');
    if (!vin || !gnd || !vout) return null;
    return {
      cards: regulatorCards(comp.id, vin, gnd, vout, `max(0, min(V(${vin})-V(${gnd})-2, 12))`),
      modelsUsed: new Set(),
      supplies: [vout],
    };
  },
  'reg-7905': (comp, netLookup) => {
    // 7905 delivers −5 V relative to its GND pin. V_in is negative (below GND).
    const vin = netLookup('VIN');
    const gnd = netLookup('GND');
    const vout = netLookup('VOUT');
    if (!vin || !gnd || !vout) return null;
    return {
      cards: regulatorCards(comp.id, vin, gnd, vout, `min(0, max(V(${vin})-V(${gnd})+2, -5))`),
      modelsUsed: new Set(),
      supplies: [vout],
    };
  },
  // Adjustable regulator: V(VOUT) − V(ADJ) = 1.25 V (ideal). User wires
  // R1 from VOUT to ADJ, R2 from ADJ to ground: V_out = 1.25·(1+R2/R1).
  // The B-source references ground (not ADJ) so load current has a proper
  // return path — otherwise SPICE can't close the circuit.
  'reg-lm317': (comp, netLookup) => {
    const vin = netLookup('VIN');
    const adj = netLookup('ADJ');
    const vout = netLookup('VOUT');
    if (!vin || !adj || !vout) return null;
    return {
      cards: regulatorCards(
        comp.id,
        vin,
        '0',
        vout,
        `max(0, V(${adj}) + min(V(${vin})-V(${adj})-2, 1.25))`,
      ),
      modelsUsed: new Set(),
      supplies: [vout],
    };
  },

  // ── Battery / DC cell sources ────────────────────────────────────────────
  // Modelled as a V-source + tiny series resistance (approx. ESR). The
  // positive terminal is 'VCC' / '+' and the negative is 'GND' / '−'.
  'battery-9v': (comp, netLookup) => {
    const pos = netLookup('+') ?? netLookup('VCC');
    const neg = netLookup('−') ?? netLookup('-') ?? netLookup('GND');
    if (!pos || !neg) return null;
    return {
      cards: [
        `V_${comp.id} ${pos} ${comp.id}_int DC 9`,
        `R_${comp.id}_esr ${comp.id}_int ${neg} 1.5`,
      ],
      modelsUsed: new Set(),
      supplies: [pos],
    };
  },
  'battery-aa': (comp, netLookup) => {
    const pos = netLookup('+') ?? netLookup('VCC');
    const neg = netLookup('−') ?? netLookup('-') ?? netLookup('GND');
    if (!pos || !neg) return null;
    return {
      cards: [
        `V_${comp.id} ${pos} ${comp.id}_int DC 1.5`,
        `R_${comp.id}_esr ${comp.id}_int ${neg} 0.15`,
      ],
      modelsUsed: new Set(),
      supplies: [pos],
    };
  },
  'battery-coin-cell': (comp, netLookup) => {
    const pos = netLookup('+') ?? netLookup('VCC');
    const neg = netLookup('−') ?? netLookup('-') ?? netLookup('GND');
    if (!pos || !neg) return null;
    return {
      cards: [
        `V_${comp.id} ${pos} ${comp.id}_int DC 3`,
        `R_${comp.id}_esr ${comp.id}_int ${neg} 10`,
      ],
      modelsUsed: new Set(),
      supplies: [pos],
    };
  },

  // ── Regulated power supply: constant voltage, then constant current ─────
  // Properties:
  //   mode:         'dc' | 'ac'   (default 'dc')
  //   voltage:      V             (default 5; the peak in AC mode)
  //   frequency:    Hz            (default 50, only used in AC mode)
  //   currentLimit: A             (default 1)
  // The visual element reuses wokwi-signal-generator (no new Web Component
  // needed).
  //
  // A bench supply holds its voltage within millivolts whatever the load
  // (Rigol DP800: load regulation < 0.01 % + 2 mV) until the load asks for
  // more than the current limit; then it holds the current and lets its
  // voltage fall (B&K: constant voltage / constant current). This one was
  // an ideal source behind V / (1.5 · limit), a battery whose resistance
  // grew with the setpoint: 9 V read 8.946 V on 1 kΩ (8.49 V with a 0.1 A
  // limit), and a 9 Ω load on 9 V / 1 A silently read 5.4 V at 0.6 A
  // (velxio/velxio-prod#96). Now:
  //
  //   B_<id>     <id>_int <neg>  V = Vset - G·(max(i - Ilim, 0) - max(-i - Ilim, 0))
  //   R_<id>_out <id>_int <id>_a 10m
  //   V_<id>     <id>_a   <pos>  DC 0        senses i: the circuit check reads i(v_<id>)
  //
  // Below the limit the B source is the setpoint and the output sits
  // 10 mΩ · i under it. At the limit the gain G pulls the source down until
  // the current is the limit (plus Vset / G at a dead short: 0.9 mA at
  // 9 V). The limit acts on both signs, so a negative setpoint mirrors a
  // positive one (#133). In AC mode the setpoint is the sine (B sources read
  // `time`, which is 0 in an operating point, like SIN's), behind the same
  // limiter.
  //
  // The B source sits on an internal node on purpose: the circuit check
  // folds 0 V sense sources into wires (parseSourceCards), so a B source
  // right behind the sense would count as an ideal source across the
  // supply's terminals and make a supply wired to a board's 5V pin, or in
  // parallel with another supply, a "source conflict". Through 10 mΩ it is
  // none: two supplies in parallel share the load. One wired onto a board
  // rail at another voltage runs at its limit, which the check names as a
  // fight with the rail, not an overload; on a 3.3 V board's VIN / 5V it
  // powers the board (NetlistBuilder, poweredInputRails).
  //
  // Known artefact: under the trapezoidal integration every Velxio deck
  // runs, the supply's current can ring for a few dozen steps after a
  // transient takes it from its limit back to constant voltage with a large
  // capacitor on its output, while the voltages stay right (9 V / 0.1 A
  // recharging 100 µF behind a 20 Ω load switched at 50 Hz: samples down to
  // -48 mA where 9 mA flows). Gear integration damps that, but it also
  // damps every resonance in the deck (a series RLC at 5 kHz read 8 % low),
  // so the supply does not switch the method.
  'power-supply': (comp, netLookup) => {
    const pos = netLookup('+') ?? netLookup('SIG') ?? netLookup('VCC');
    const neg = netLookup('−') ?? netLookup('-') ?? netLookup('GND');
    if (!pos || !neg) return null;
    const mode = String(comp.properties.mode ?? 'dc').toLowerCase();
    // Read like every other field (valueParser): "9V", "500m" and "1k" are
    // numbers. Number() made them NaN and ngspice refused the whole deck.
    const voltage = parseValueWithUnits(comp.properties.voltage, 5);
    const limit = Math.max(MIN_SUPPLY_LIMIT_A, parseValueWithUnits(comp.properties.currentLimit, 1));
    const setpoint =
      mode === 'ac'
        ? `${voltage}*sin(${2 * Math.PI}*${parseValueWithUnits(comp.properties.frequency, 50)}*time)`
        : `${voltage}`;
    const i = `i(V_${comp.id})`;
    return {
      cards: [
        `B_${comp.id} ${comp.id}_int ${neg} V = ${setpoint} - ${SUPPLY_CC_GAIN}*(max(${i}-${limit}, 0) - max(-${i}-${limit}, 0))`,
        `R_${comp.id}_out ${comp.id}_int ${comp.id}_a ${SUPPLY_OUTPUT_OHMS}`,
        `V_${comp.id} ${comp.id}_a ${pos} DC 0`,
      ],
      modelsUsed: new Set(),
      supplies: [pos],
    };
  },

  // ── Signal generator (AC / pulse / DC) ───────────────────────────────────
  // Properties:
  //   waveform: 'sine' | 'square' | 'dc'   (default 'sine')
  //   frequency: Hz                         (default 1000)
  //   amplitude: V peak                     (default 1)
  //   offset:    V DC                       (default 0)
  // Emits a SIN / PULSE / DC source accordingly. For square waves uses
  // PULSE with ~1ns edges; for DC, amplitude is ignored.
  'signal-generator': (comp, netLookup) => {
    const sig = netLookup('SIG') ?? netLookup('+');
    const gnd = netLookup('GND') ?? netLookup('-') ?? netLookup('−');
    if (!sig || !gnd) return null;
    const waveform = String(comp.properties.waveform ?? 'sine').toLowerCase();
    // "1k", "3V" and "500mV" are values (valueParser); Number() made them NaN
    // and the deck was rejected with nothing pointing at the field.
    const freq = parseValueWithUnits(comp.properties.frequency, 1000);
    const amp = parseValueWithUnits(comp.properties.amplitude, 1);
    const off = parseValueWithUnits(comp.properties.offset, 0);
    let source: string;
    if (waveform === 'square') {
      const period = 1 / freq;
      const pw = period / 2;
      const vlo = off - amp;
      const vhi = off + amp;
      source = `PULSE(${vlo} ${vhi} 0 1n 1n ${pw} ${period})`;
    } else if (waveform === 'dc') {
      source = `DC ${off}`;
    } else {
      source = `SIN(${off} ${amp} ${freq})`;
    }
    return {
      cards: [`V_${comp.id} ${sig} ${gnd} ${source}`],
      modelsUsed: new Set(),
      supplies: [sig],
    };
  },

  // Switch / pushbutton — a real 4-pin tactile switch. The two legs of each
  // terminal are internally shorted (1.l is the same node as 1.r; 2.l as 2.r),
  // and pressing bridges terminal 1 to terminal 2. Modelling BOTH legs (not
  // just 1.l/2.l) means a user can wire GND/GPIO to any leg and it behaves like
  // hardware — and wiring both a GPIO and GND to the SAME terminal is a dead
  // short, exactly as on a real button. Back-compat: 2-pin variants expose A/B.
  // The 6mm variant is the same switch with a smaller body and the same pad
  // names, and it is registered as a part that DEFERS to the circuit. Without
  // a model here it deferred to nothing: on every board with spiceDrivenInputs
  // (which is all of them) pressing it did nothing at all. Aliased below the
  // definition so the two can never drift.
  pushbutton: (comp, netLookup) => {
    const t1l = netLookup('1.l');
    const t1r = netLookup('1.r');
    const t2l = netLookup('2.l');
    const t2r = netLookup('2.r');
    const cards: string[] = [];
    // Internal shorts between the two legs of a terminal, when both are wired.
    if (t1l && t1r && t1l !== t1r) cards.push(`R_${comp.id}_t1 ${t1l} ${t1r} 0.01`);
    if (t2l && t2r && t2l !== t2r) cards.push(`R_${comp.id}_t2 ${t2l} ${t2r} 0.01`);
    // The switch itself: terminal 1 to terminal 2 (prefer the .l leg's net).
    const term1 = t1l ?? t1r ?? netLookup('A');
    const term2 = t2l ?? t2r ?? netLookup('B');
    if (term1 && term2) {
      const R = Boolean(comp.properties.pressed) ? 0.01 : 1e9;
      cards.push(`R_${comp.id}_sw ${term1} ${term2} ${R}`);
    }
    return cards.length ? { cards, modelsUsed: new Set() } : null;
  },
  // Slide switch — a 3-terminal SPDT (matching the wokwi-slide-switch element,
  // pins '1','2','3' with '2' the middle/common wiper). The handle sits left at
  // value 0 and right at value 1, so the wiper (pin '2') connects to pin '1' at
  // value 0 and to pin '3' at value 1; the selected leg is a near-short (0.01Ω)
  // and the opposite leg is open (1e9Ω). Modeling only the 1<->2 leg (the old
  // behaviour) ignored pin '3' entirely, so a switch wired GND-1 / signal-2 /
  // VCC-3 (the natural, Wokwi hookup) could never pull its signal high — the
  // common was always tied to pin 1 or left floating. A leg whose outer pin is
  // unwired is simply omitted; with no common wired the switch contributes
  // nothing.
  'slide-switch': (comp, netLookup) => {
    const common = netLookup('2');
    if (!common) return null;
    const pin1 = netLookup('1');
    const pin3 = netLookup('3');
    const toPin3 = comp.properties.value === 1 || comp.properties.value === '1';
    const cards: string[] = [];
    if (pin1) cards.push(`R_${comp.id}_1 ${common} ${pin1} ${toPin3 ? 1e9 : 0.01}`);
    if (pin3) cards.push(`R_${comp.id}_3 ${common} ${pin3} ${toPin3 ? 0.01 : 1e9}`);
    return cards.length ? { cards, modelsUsed: new Set() } : null;
  },

  // Rotary potentiometer — 3-terminal divider. `value` lives in [min..max]
  // (defaults match the wokwi-potentiometer element: 0..1023). Total track
  // resistance defaults to 10 kΩ; callers can override via `properties.total`.
  potentiometer: (comp, netLookup) => {
    const top = netLookup('VCC');
    const wiper = netLookup('SIG');
    const bot = netLookup('GND');
    if (!top || !wiper || !bot) return null;
    const total = parseValueWithUnits(comp.properties.total ?? comp.properties.resistance, 10_000);
    const min = Number(comp.properties.min ?? 0);
    const max = Number(comp.properties.max ?? 1023);
    const raw = Number(comp.properties.value ?? min);
    const span = max - min || 1;
    const ratio = Math.max(0, Math.min(1, (raw - min) / span));
    const Rtop = Math.max(1, (1 - ratio) * total);
    const Rbot = Math.max(1, ratio * total);
    return {
      cards: [
        `R_${comp.id}_top ${top} ${wiper} ${Rtop}`,
        `R_${comp.id}_bot ${wiper} ${bot} ${Rbot}`,
      ],
      modelsUsed: new Set(),
    };
  },

  // Slide potentiometer (3-terminal voltage divider)
  'slide-potentiometer': (comp, netLookup) => {
    const top = netLookup('VCC');
    const wiper = netLookup('SIG');
    const bot = netLookup('GND');
    if (!top || !wiper || !bot) return null;
    const total = parseValueWithUnits(comp.properties.value, 10_000);
    const pos = Number(comp.properties.position ?? comp.properties.percent ?? 50) / 100;
    const Rtop = Math.max(1, (1 - pos) * total);
    const Rbot = Math.max(1, pos * total);
    return {
      cards: [
        `R_${comp.id}_top ${top} ${wiper} ${Rtop}`,
        `R_${comp.id}_bot ${wiper} ${bot} ${Rbot}`,
      ],
      modelsUsed: new Set(),
    };
  },

  // NTC temperature sensor — 3-pin breakout module (VCC, GND, OUT).
  // Internal topology: a 10k pull-up from VCC to OUT, with the NTC thermistor
  // from OUT to GND, so V_OUT = Vcc · R_ntc / (R_ntc + R_pull). Temperature up
  // → R_ntc down → V_OUT down. This is the exact divider the ntc-temperature
  // example sketch inverts to recover R_ntc (rNtc = R_PULL · v / (5 − v)); with
  // VCC and GND swapped (NTC on top) the decoded temperature ran backwards.
  'ntc-temperature-sensor': (comp, netLookup) => {
    const vcc = netLookup('VCC');
    const gnd = netLookup('GND');
    const out = netLookup('OUT');
    const Tc = Number(comp.properties.temperature ?? 25);
    const R0 = parseValueWithUnits(comp.properties.R0, 10_000);
    const beta = Number(comp.properties.beta ?? 3950);
    const Rntc = ntcResistance(Tc, R0, 298.15, beta);
    if (!vcc || !gnd || !out) {
      // Fallback for legacy 2-pin wiring ('1' / '2'): emit bare thermistor.
      const pins = twoPin(comp, netLookup, '1', '2');
      if (!pins) return null;
      return emitResistor(comp, pins, Rntc);
    }
    const Rpull = parseValueWithUnits(comp.properties.pullup, 10_000);
    return {
      cards: [`R_${comp.id}_pull ${vcc} ${out} ${Rpull}`, `R_${comp.id}_ntc ${out} ${gnd} ${Rntc}`],
      modelsUsed: new Set(),
    };
  },

  // Ammeter — inserts a 0 V source so ngspice reports the branch current.
  // Terminals are 'A+' and 'A-'. The probe is modelled as:
  //    A+ ──[V_<id>_sense=0]── mid ──[shunt=1mΩ]── A-
  // The tiny shunt is there only to ensure the mid node has a DC path if
  // one of the terminals is otherwise floating.
  'instr-ammeter': (comp, netLookup) => {
    const ap = netLookup('A+');
    const am = netLookup('A-');
    if (!ap || !am) return null;
    const senseName = `v_${comp.id}_sense`;
    const midNet = `amm_${comp.id}_mid`;
    return {
      cards: [`V_${comp.id}_sense ${ap} ${midNet} DC 0`, `R_${comp.id}_shunt ${midNet} ${am} 1m`],
      modelsUsed: new Set([`* ammeter probe: read i(${senseName})`]),
    };
  },

  // Voltmeter — pure probe. Emits a 10 MΩ resistor across its terminals so
  // ngspice has a real element there (and so the net isn't floating).
  'instr-voltmeter': (comp, netLookup) => {
    const vp = netLookup('V+');
    const vm = netLookup('V-');
    if (!vp || !vm) return null;
    return {
      cards: [`R_${comp.id}_vmR ${vp} ${vm} 10Meg`],
      modelsUsed: new Set([`* voltmeter probe: read v(${vp}) - v(${vm})`]),
    };
  },

  // ── Digital logic gates (behavioral, via ngspice B-sources) ────────────
  // A logic transition with a FINITE slope. The ideal step u(x) has none,
  // and two gates wired into each other (an SR latch of two NANDs) then form
  // a loop ngspice cannot solve: no operating point, no voltages anywhere on
  // the canvas, and the pre-flight refuses the example before it compiles
  // (project/gallery-libraries-2026-09, cause H). A 50 mV tanh edge keeps
  // every truth table exact at 0 V / vcc (the gate examples solve to the
  // same numbers to two decimals) and gives the loop a solution. A real
  // latch powers up in one of its two states and keeps it; the symmetric
  // midpoint the loop also has is an unstable equilibrium a real one leaves
  // in nanoseconds, but an operating point with no history lands on it. So a
  // gate on a feedback loop (MapperContext.latchNets) drives its pin through
  // LATCH_GATE_OHMS, and the deck seeds the loop's nets with .nodeset
  // (NetlistBuilder): with the state they had at the last solve, or a
  // definite power-up state. ngspice's .nodeset cannot move an ideal source's
  // node, hence the resistance (velxio/velxio-prod#147). The Schmitt inverter
  // (hysteresis by design) and the L293D enable logic keep the ideal step:
  // neither is cross-coupled. Written as one helper so the edge width is a
  // single number.

  // Convention: inputs at 2-input gates are 'A','B'; output is 'Y'. Threshold
  // is ctx.vcc/2. A 1 MΩ load keeps the output node DC-connected so ngspice
  // doesn't see it as floating (otherwise .op returns matrix singular).
  ...(() => {
    const twoInput = (expr: (a: string, b: string, T: number, vcc: number) => string): Mapper => (comp, netLookup, ctx) => {
      const a = netLookup('A'),
        b = netLookup('B'),
        y = netLookup('Y');
      if (!a || !b || !y) return null;
      const out = gateOutput(comp.id, y, ctx);
      return {
        cards: [
          `B_${comp.id} ${out.node} 0 V = ${expr(a, b, ctx.vcc / 2, ctx.vcc)}`,
          ...out.cards,
          `R_${comp.id}_load ${y} 0 1Meg`,
        ],
        modelsUsed: new Set(),
      };
    };
    return {
      'logic-gate-and': twoInput((a, b, T, vcc) => `${vcc} * ${logicStep(a, T)} * ${logicStep(b, T)}`),
      'logic-gate-or': twoInput(
        (a, b, T, vcc) => `${vcc} * (1 - (1-${logicStep(a, T)}) * (1-${logicStep(b, T)}))`,
      ),
      'logic-gate-nand': twoInput((a, b, T, vcc) => `${vcc} * (1 - ${logicStep(a, T)} * ${logicStep(b, T)})`),
      'logic-gate-nor': twoInput((a, b, T, vcc) => `${vcc} * (1-${logicStep(a, T)}) * (1-${logicStep(b, T)})`),
      'logic-gate-xor': twoInput(
        (a, b, T, vcc) =>
          `${vcc} * (${logicStep(a, T)} + ${logicStep(b, T)} - 2*${logicStep(a, T)}*${logicStep(b, T)})`,
      ),
      'logic-gate-xnor': twoInput(
        (a, b, T, vcc) =>
          `${vcc} * (1 - (${logicStep(a, T)} + ${logicStep(b, T)} - 2*${logicStep(a, T)}*${logicStep(b, T)}))`,
      ),
    };
  })(),
  'logic-gate-not': (comp, netLookup, ctx) => {
    const a = netLookup('A'),
      y = netLookup('Y');
    if (!a || !y) return null;
    const T = ctx.vcc / 2;
    const out = gateOutput(comp.id, y, ctx);
    return {
      cards: [
        `B_${comp.id} ${out.node} 0 V = ${ctx.vcc} * (1 - ${logicStep(a, T)})`,
        ...out.cards,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },

  // ── Multi-input logic gates (3 / 4 inputs) ──────────────────────────────
  // Build the u() product/sum across all inputs. Same 1 MΩ load convention.
  ...(() => {
    type MultiMapper = (
      comp: ComponentForSpice,
      netLookup: NetLookup,
      ctx: MapperContext,
    ) => SpiceEmission | null;
    function multiGate(
      inputNames: string[],
      build: (inputs: string[], T: number, vcc: number) => string,
    ): MultiMapper {
      return (comp, netLookup, ctx) => {
        const inputs = inputNames.map((n) => netLookup(n));
        const y = netLookup('Y');
        if (inputs.some((n) => !n) || !y) return null;
        const T = ctx.vcc / 2;
        const out = gateOutput(comp.id, y, ctx);
        return {
          cards: [
            `B_${comp.id} ${out.node} 0 V = ${build(inputs as string[], T, ctx.vcc)}`,
            ...out.cards,
            `R_${comp.id}_load ${y} 0 1Meg`,
          ],
          modelsUsed: new Set(),
        };
      };
    }
    const andExpr = (inputs: string[], T: number, vcc: number) =>
      `${vcc} * ${inputs.map((n) => `${logicStep(n, T)}`).join(' * ')}`;
    const orExpr = (inputs: string[], T: number, vcc: number) =>
      `${vcc} * (1 - ${inputs.map((n) => `(1-${logicStep(n, T)})`).join(' * ')})`;
    const nandExpr = (inputs: string[], T: number, vcc: number) =>
      `${vcc} * (1 - ${inputs.map((n) => `${logicStep(n, T)}`).join(' * ')})`;
    const norExpr = (inputs: string[], T: number, vcc: number) =>
      `${vcc} * ${inputs.map((n) => `(1-${logicStep(n, T)})`).join(' * ')}`;
    return {
      'logic-gate-and-3': multiGate(['A', 'B', 'C'], andExpr),
      'logic-gate-or-3': multiGate(['A', 'B', 'C'], orExpr),
      'logic-gate-nand-3': multiGate(['A', 'B', 'C'], nandExpr),
      'logic-gate-nor-3': multiGate(['A', 'B', 'C'], norExpr),
      'logic-gate-and-4': multiGate(['A', 'B', 'C', 'D'], andExpr),
      'logic-gate-or-4': multiGate(['A', 'B', 'C', 'D'], orExpr),
      'logic-gate-nand-4': multiGate(['A', 'B', 'C', 'D'], nandExpr),
      'logic-gate-nor-4': multiGate(['A', 'B', 'C', 'D'], norExpr),
    };
  })(),

  // ── L293D quadruple half-H driver (TI SLRS008D) ─────────────────────────
  // Pins: EN1 (IN1 -> OUT1, IN2 -> OUT2), EN2 (IN3 -> OUT3, IN4 -> OUT4),
  // VCC1 (logic), VCC2 (the load supply), GND.1..GND.4.
  //
  // Each output is a pseudo-Darlington source from VCC2 and a Darlington sink
  // to GND (8.1), as two switches with the drop of their stage behind them:
  //   VCC2 --S_src-- D_src -- OUT -- S_snk -- D_snk -- GND
  // The source conducts while EN and IN are high, the sink while EN is high
  // and IN is low, and with EN low neither does: the output is
  // high-impedance (8.1, Table 1), so a motor across a channel coasts. The
  // stages drop what 6.5 gives at 0.6 A, VCC2 - 1.4 V and 1.2 V typical, and
  // less at a smaller current (two junctions each); the current comes out of
  // VCC2, so a supply or a meter there sees the load. The integrated clamp
  // diodes (VOKH = VCC2 + 1.3 V, VOKL = 1.3 V at 0.6 A) catch an output
  // pushed past either rail. The chip limits no current (600 mA is a rating,
  // 6.1), so nothing is limited here.
  //
  // The inputs switch at the chip's own thresholds (VIH 2.3 V min, VIL 1.5 V
  // max, 6.3), the midpoint here, whatever the board's supply. An input left
  // open reads HIGH: each sits on a current source from VCC1 (Figure 3).
  //
  // This replaced an ideal source per output, `V(OUT) = EN * IN * V(VCC2)`
  // from ground: 0 V with EN low (it braked a motor and sank 5 mA from a
  // 1 kohm pull-up), no drop, and a current that never came out of VCC2
  // (velxio/velxio-prod#165).
  'motor-driver-l293d': (comp, netLookup) => {
    const vcc2 = netLookup('VCC2') ?? netLookup('+VS') ?? netLookup('VS');
    const high = (net: string | null): string => (net ? `u(V(${net})-${L293D_VT})` : '1');
    const cards: string[] = [];
    for (const ch of [1, 2]) {
      const enabled = high(netLookup(`EN${ch}`));
      for (const k of [2 * ch - 1, 2 * ch]) {
        const out = netLookup(`OUT${k}`);
        if (!out) continue;
        const input = high(netLookup(`IN${k}`));
        const o = `${comp.id}_o${k}`;
        cards.push(`B_${o}_src ${o}_srcc 0 V = ${enabled} * ${input}`);
        cards.push(`B_${o}_snk ${o}_snkc 0 V = ${enabled} * (1 - ${input})`);
        if (vcc2) {
          cards.push(`S_${o}_src ${vcc2} ${o}_src ${o}_srcc 0 L293D_SW`);
          cards.push(`D_${o}_src ${o}_src ${out} L293D_SRC`);
          cards.push(`D_${o}_clamph ${out} ${vcc2} L293D_CLAMP`);
        }
        cards.push(`S_${o}_snk ${out} ${o}_snk ${o}_snkc 0 L293D_SW`);
        cards.push(`D_${o}_snk ${o}_snk 0 L293D_SNK`);
        cards.push(`D_${o}_clampl 0 ${out} L293D_CLAMP`);
      }
    }
    if (cards.length === 0) return null;
    return {
      cards,
      modelsUsed: new Set([
        // Closed above 0.6 V of its control, open below 0.4 V: the controls
        // are 0 or 1 V.
        '.model L293D_SW SW(Vt=0.5 Vh=0.1 Ron=0.01 Roff=1G)',
        // Two junctions (N = 2) and a little bulk resistance, sized to the
        // typical drops at 0.6 A: 1.40 V for the source, 1.20 V for the sink.
        '.model L293D_SRC D(Is=1.35e-11 N=2 Rs=0.22)',
        '.model L293D_SNK D(Is=6.5e-10 N=2 Rs=0.22)',
        // One junction, 1.3 V at 0.6 A.
        '.model L293D_CLAMP D(Is=1e-12 N=1 Rs=1)',
      ]),
    };
  },

  // ── 74HC series logic ICs (multiple gates per package) ──────────────────
  // Each IC emits one B-source + pull-down per internal gate. Pin naming
  // follows the datasheet: gate index prefixes (1A, 1B, 1Y, 2A, ...) plus
  // VCC / GND for the package power (not used by the behavioral gates here —
  // they reference ctx.vcc directly).
  ...(() => {
    type MultiMapper = (
      comp: ComponentForSpice,
      netLookup: NetLookup,
      ctx: MapperContext,
    ) => SpiceEmission | null;

    function ic2InputQuad(
      build: (a: string, b: string, y: string, T: number, vcc: number) => string,
    ): MultiMapper {
      return (comp, netLookup, ctx) => {
        const T = ctx.vcc / 2;
        const cards: string[] = [];
        for (let i = 1; i <= 4; i++) {
          const a = netLookup(`${i}A`);
          const b = netLookup(`${i}B`);
          const y = netLookup(`${i}Y`);
          if (!a || !b || !y) continue; // skip unwired gates silently
          const out = gateOutput(`${comp.id}_${i}`, y, ctx);
          cards.push(`B_${comp.id}_${i} ${out.node} 0 V = ${build(a, b, y, T, ctx.vcc)}`);
          cards.push(...out.cards);
          cards.push(`R_${comp.id}_${i}_load ${y} 0 1Meg`);
        }
        if (cards.length === 0) return null;
        return { cards, modelsUsed: new Set() };
      };
    }

    function ic1InputHex(
      build: (a: string, y: string, T: number, vcc: number) => string,
    ): MultiMapper {
      return (comp, netLookup, ctx) => {
        const T = ctx.vcc / 2;
        const cards: string[] = [];
        for (let i = 1; i <= 6; i++) {
          const a = netLookup(`${i}A`);
          const y = netLookup(`${i}Y`);
          if (!a || !y) continue;
          const out = gateOutput(`${comp.id}_${i}`, y, ctx);
          cards.push(`B_${comp.id}_${i} ${out.node} 0 V = ${build(a, y, T, ctx.vcc)}`);
          cards.push(...out.cards);
          cards.push(`R_${comp.id}_${i}_load ${y} 0 1Meg`);
        }
        if (cards.length === 0) return null;
        return { cards, modelsUsed: new Set() };
      };
    }

    return {
      // 74HC00 — quad 2-input NAND
      'ic-74hc00': ic2InputQuad(
        (a, b, _y, T, vcc) => `${vcc} * (1 - ${logicStep(a, T)} * ${logicStep(b, T)})`,
      ),
      // 74HC08 — quad 2-input AND
      'ic-74hc08': ic2InputQuad((a, b, _y, T, vcc) => `${vcc} * ${logicStep(a, T)} * ${logicStep(b, T)}`),
      // 74HC32 — quad 2-input OR
      'ic-74hc32': ic2InputQuad(
        (a, b, _y, T, vcc) => `${vcc} * (1 - (1-${logicStep(a, T)}) * (1-${logicStep(b, T)}))`,
      ),
      // 74HC02 — quad 2-input NOR
      'ic-74hc02': ic2InputQuad(
        (a, b, _y, T, vcc) => `${vcc} * (1-${logicStep(a, T)}) * (1-${logicStep(b, T)})`,
      ),
      // 74HC86 — quad 2-input XOR
      'ic-74hc86': ic2InputQuad(
        (a, b, _y, T, vcc) =>
          `${vcc} * (${logicStep(a, T)} + ${logicStep(b, T)} - 2*${logicStep(a, T)}*${logicStep(b, T)})`,
      ),
      // 74HC04 — hex inverter
      'ic-74hc04': ic1InputHex((a, _y, T, vcc) => `${vcc} * (1 - ${logicStep(a, T)})`),
      // 74HC14 — hex Schmitt-trigger inverter. The trip point follows the
      // output: while Y is high (input low) the input must rise past VT+ to
      // switch it, and once Y is low it must fall below VT-. The two were
      // swapped (VT- while Y was high), so inside the band each output state
      // implied the other and there was no solution: an RC on the input
      // stopped the transient at 5 ms without a word, and an input parked
      // at 2.5 V hung the operating point (velxio/velxio-prod#144).
      'ic-74hc14': ic1InputHex((a, y, _T, vcc) => {
        const hi = round3(HC14_VT_POS_FRACTION * vcc);
        const lo = round3(HC14_VT_NEG_FRACTION * vcc);
        return `${vcc} * (1 - u(V(${a}) - (${lo} + u(V(${y})-${vcc / 2}) * ${round3(hi - lo)})))`;
      }),
    };
  })(),

  // ── Optocouplers (LED + phototransistor in one package) ─────────────────
  // The IR LED's current, read by a 0 V sense source, is mirrored by an F
  // source (CCCS) as photocurrent from the collector into the base of an NPN
  // phototransistor, which amplifies it: I_C = CTR * I_LED while V_CE is above
  // saturation, and the transistor saturates when the load cannot take that
  // much. The output used to be the F source alone, an ideal current source
  // from collector to emitter: behind the usual 10 k pull-up it drove the
  // collector to -59.67 V (4N25) in the gallery's optocoupler-signal, and to
  // -124 V with a PC817 (velxio/velxio-prod#131).
  //
  // The LED (shared by both parts) drops 1.18 V at 10 mA, 1.22 V at 20 mA and
  // 1.30 V at 50 mA: Vishay 4N25 1.3 V typ / 1.5 max at 50 mA, Sharp PC817X
  // 1.2 V typ / 1.4 max at 20 mA. The old card dropped 1.48 V at 10 mA and
  // 1.76 V at 50 mA. The transistor: BF = 100, and RC = 50 ohm for the
  // phototransistor's collector body, so V_CE(sat) is about 0.1 V at 1 mA and
  // 0.15 V at 2 mA (PC817 0.1 typ / 0.2 max at IC 1 mA; 4N25 0.5 max at
  // 2 mA). The base has no pin: 100 Meg to the emitter keeps it defined in
  // the dark, and 100 Meg from collector to emitter stays as before.
  ...(() => {
    const OPTO_BF = 100;
    const optocoupler =
      (ctr: number): Mapper =>
      (comp, netLookup) => {
        const an = netLookup('AN');
        const cat = netLookup('CAT');
        const col = netLookup('COL');
        const emit = netLookup('EMIT');
        if (!an || !cat || !col || !emit) return null;
        const base = `${comp.id}_base`;
        return {
          cards: [
            `D_${comp.id}_led ${an} ${comp.id}_mid DLED_OPTO`,
            `V_${comp.id}_sense ${comp.id}_mid ${cat} DC 0`,
            // Photocurrent: I_LED * CTR / (BF + 1), so I_C = CTR * I_LED.
            `F_${comp.id}_pt ${col} ${base} V_${comp.id}_sense ${ctr / (OPTO_BF + 1)}`,
            `Q_${comp.id}_pt ${col} ${base} ${emit} QOPTO_PT`,
            `R_${comp.id}_be ${base} ${emit} 100Meg`,
            `R_${comp.id}_leak ${col} ${emit} 100Meg`,
          ],
          modelsUsed: new Set([
            '.model DLED_OPTO D(Is=1.3e-13 N=1.8 Rs=1.1)',
            `.model QOPTO_PT NPN(IS=1e-14 BF=${OPTO_BF} RC=50)`,
          ]),
        };
      };
    return {
      // 4N25: CTR 50 % typ at IF 10 mA (20 % min).
      'opto-4n25': optocoupler(0.5),
      // PC817: CTR 50-600 % by rank; 100 % here.
      'opto-pc817': optocoupler(1.0),
    };
  })(),

  // ── Electromechanical relay (SPDT, 5-pin) ───────────────────────────────
  // Coil is modelled as R in series with L. Contacts are voltage-controlled
  // switches (ngspice `S` element) with native hysteresis via Vt/Vh — avoids
  // chatter when V_COIL sits near the activation threshold. ngspice SW has no
  // "normally closed" mode, so NC is a second switch on the SAME control with
  // its on and off resistances swapped (relaySwitchModels): one armature, one
  // hysteresis state, NC closed exactly when NO is open. It used to be a
  // switch of its own on Vnom - V(coil), which opened at 55 % and reclosed at
  // 25 % of Vnom, so whole ranges of coil voltage left both contacts open
  // (velxio/velxio-prod#169).
  // Optional flyback diode across the coil (anode on COIL-, cathode on COIL+).
  // NO and NC contact cards are only emitted when their respective pins are
  // wired — leaving NC unconnected is a very common pattern and must not
  // suppress the rest of the relay (coil + NO switch).
  relay: (comp, netLookup, ctx) => {
    const cp = netLookup('COIL+');
    const cn = netLookup('COIL-');
    const com = netLookup('COM');
    const no = netLookup('NO');
    const nc = netLookup('NC');
    // Coil pins must be present — without them the relay can't be energised.
    // COM is required too; without it, neither NO nor NC contact is useful.
    if (!cp || !cn || !com) return null;
    const coilR = parseValueWithUnits(comp.properties.coil_resistance, 70);
    const coilV = parseValueWithUnits(comp.properties.coil_voltage, 5);
    // The contacts follow the coil current, read as the voltage across the
    // coil's resistance, R * I (below). At DC that IS the voltage across the
    // coil (L is a short), so a threshold in volts is the same test as one in
    // amps, and it stays right for every Vnom / R pair: a 12 V / 400 Ω relay
    // (30 mA) pulls in at 12 V exactly like the 5 V / 70 Ω default (71 mA).
    // coil_resistance therefore sets the CURRENT the coil draws (an ammeter
    // in series reads Vnom / R: 71.4 mA at 70 Ω, 0.9 nA at 5.365 GΩ) and
    // matters as soon as the drive has resistance of its own: through 1 kΩ a
    // 70 Ω coil keeps 0.33 V and stays open while a 5 GΩ one keeps 5 V and
    // closes. From an ideal rail at Vnom the contact state cannot depend on
    // R, which is what issue #373 read as the field being "non-functional".
    //
    // ngspice SW closes at Vt + Vh and opens at Vt - Vh, so these give
    // pull-in at 0.75 Vnom and drop-out at 0.45 Vnom. Measured on a
    // 0 -> 5 -> 0 V ramp with the default coil: NO closes at 3.754 V and
    // opens at 2.248 V. A Songle SRD-05VDC-SL-C, the 5 V / 70 Ω part the
    // defaults describe, specifies 75% pull-in, so the closing edge is the
    // datasheet figure. Inside the band an operating point keeps the state
    // the deck starts the switches in: released on a fresh deck (3.3 V on a
    // 5 V coil solves open), and where the last solve left them once the
    // circuit service carries it (ctx.operated, velxio/velxio-prod#109).
    const includeFlyback = comp.properties.include_flyback !== false;
    // A relay coil is a wire-wound inductor: R (of the copper) in SERIES
    // with ideal L. Modelling R and L in parallel would make the coil a DC
    // short — V(COIL+) ≡ V(COIL-) in .op analysis — so the switch control
    // voltage is always 0 and the NO contact never closes.
    const coilMidNet = `${comp.id}_coilmid`;
    const cards = [
      `R_${comp.id}_coil ${cp} ${coilMidNet} ${coilR}`,
      `L_${comp.id}_coil ${coilMidNet} ${cn} 20m`,
    ];
    // What the armature responds to: the flux, which the coil CURRENT sets.
    // The control is R * I, the voltage across the coil's resistance. When
    // the drive is cut the current keeps flowing through the suppressor and
    // decays with L/R and the clamp voltage, and the contacts hold until it
    // falls below the drop-out: about 0.19 ms behind the built-in 1N4148,
    // sooner behind a diode and a Zener, as TE and Omron describe (a
    // suppressor that lets the energy decay slowly retards the release).
    // Read off the terminal voltage, which a diode collapses to one drop at
    // once, the contacts opened in the first time step and a diode and a
    // Zener could not be told apart (velxio/velxio-prod#137).
    //
    // A bare coil has no polarity: current either way magnetises it, so the
    // contacts follow |R * I| and a relay wired COIL+ to GND with the drive on
    // COIL- pulls in like any other (the component doc always said "polarity
    // only matters for the flyback diode"). With the diode fitted the part IS
    // polarised: driven backwards the diode conducts and, on silicon, clamps
    // the coil to a diode drop, so it never pulls in. The solve's sources are
    // ideal and would hold the full voltage across coil and diode alike,
    // hence the signed control in that case.
    const coilDrive = includeFlyback
      ? `V(${cp}) - V(${coilMidNet})`
      : `abs(V(${cp}) - V(${coilMidNet}))`;
    const ctrl = `${comp.id}_coilv 0`;
    if (no || nc) cards.push(`B_${comp.id}_coilv ${comp.id}_coilv 0 V = ${coilDrive}`);
    const sw = relaySwitchModels('RELAY', coilV);
    const mem = relayMemory(`${comp.id}_coilv`, coilV, ctx.operated);
    if (no) {
      // NO: closes when the coil drive exceeds Vt + Vh (normal SW behaviour)
      cards.push(`S_${comp.id}_no ${com} ${no} ${ctrl} ${sw.no}${mem.flag}`);
    }
    if (nc) {
      // NC: the same switch, conducting while it is off.
      cards.push(`S_${comp.id}_nc ${com} ${nc} ${ctrl} ${sw.nc}${mem.flag}`);
    }
    if (includeFlyback) {
      cards.push(`D_${comp.id}_fly ${cn} ${cp} D1N4148`);
    }
    return {
      cards,
      modelsUsed: new Set([
        ...(no ? [sw.noCard] : []),
        ...(nc ? [sw.ncCard] : []),
        // Must match the canonical D1N4148 in `diode-1n4148` exactly, or
        // the netlist dedupe Set will emit two `.model D1N4148` lines.
        '.model D1N4148 D(Is=2.52n Rs=.568 N=1.752 Cjo=4p M=.4 tt=20n Bv=100 Ibv=0.1u)',
      ]),
      ...(no || nc ? { memory: mem.memory } : {}),
    };
  },

  // ── KS2E-M-DC5 relay (DPDT, 8-pin) ───────────────────────────────────────
  // One coil between COIL1 and COIL2 and two change-over poles: P1 to NO1 /
  // NC1 and P2 to NO2 / NC2, switched together. Same coil and switch model as
  // `relay` above (R in series with L, 75 % pull-in, 45 % drop-out), with two
  // differences. The coil is not polarised, so the contacts follow |R * I|
  // through it and a relay wired COIL2-high still pulls in. And the part has no
  // properties, so the coil is the 5 V nominal on its label; the KEST sheet
  // only gives coil power < 0.36 W, i.e. at least ~70 ohm, the generic
  // relay's default. Without this mapper the contacts were open pins in the
  // netlist: a load on any of them never conducted.
  'ks2e-m-dc5': (comp, netLookup, ctx) => {
    const c1 = netLookup('COIL1');
    const c2 = netLookup('COIL2');
    if (!c1 || !c2) return null;
    const coilV = KS2E_COIL_VOLTS;
    const coilMid = `${comp.id}_coilmid`;
    const ctrl = `${comp.id}_coilv`;
    const cards = [
      `R_${comp.id}_coil ${c1} ${coilMid} 70`,
      `L_${comp.id}_coil ${coilMid} ${c2} 20m`,
      // |R * I|: the coil current, as the generic relay (velxio/velxio-prod#137).
      `B_${comp.id}_coilv ${ctrl} 0 V = abs(V(${c1}) - V(${coilMid}))`,
    ];
    // Both poles' NO and NC on one control (relaySwitchModels): NC closed
    // exactly when NO is open, as the generic relay (velxio/velxio-prod#169).
    const sw = relaySwitchModels('KS2E', coilV);
    const mem = relayMemory(ctrl, coilV, ctx.operated);
    const models = new Set<string>();
    for (const pole of ['1', '2']) {
      const com = netLookup(`P${pole}`);
      if (!com) continue;
      const no = netLookup(`NO${pole}`);
      const nc = netLookup(`NC${pole}`);
      if (no) {
        cards.push(`S_${comp.id}_no${pole} ${com} ${no} ${ctrl} 0 ${sw.no}${mem.flag}`);
        models.add(sw.noCard);
      }
      if (nc) {
        cards.push(`S_${comp.id}_nc${pole} ${com} ${nc} ${ctrl} 0 ${sw.nc}${mem.flag}`);
        models.add(sw.ncCard);
      }
    }
    return { cards, modelsUsed: models, ...(models.size ? { memory: mem.memory } : {}) };
  },

  // ── Schottky diodes (Vf ≈ 0.3–0.45 V at 1 A). Phase 2: LTSpice models
  // sourced from OnSemi via Linear Tech standard.dio.
  'diode-1n5817': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} D1N5817`],
      modelsUsed: new Set([
        '.model D1N5817 D(Is=31.7u Rs=.051 N=1.373 Cjo=190p M=.3 Eg=.69 Xti=2 Bv=20 Ibv=10m)',
      ]),
    };
  },
  'diode-1n5819': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} D1N5819`],
      modelsUsed: new Set([
        '.model D1N5819 D(Is=31.7u Rs=.051 N=1.373 Cjo=110p M=.35 Eg=.69 Xti=2 Bv=40 Ibv=10m)',
      ]),
    };
  },

  // ── Photodiode (reverse-biased, current proportional to lux) ─────────────
  // Model: regular diode in parallel with a current source that sinks photo-
  // current from cathode to anode (reverse direction). Typical responsivity:
  // 100 nA/lux for small-package silicon. User sets `lux` property.
  photodiode: (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    const lux = Number(comp.properties.lux ?? 500);
    const iph = lux * 100e-9; // 100 nA/lux
    return {
      cards: [
        `D_${comp.id} ${pins[0]} ${pins[1]} DPHOTO`,
        `I_${comp.id}_ph ${pins[1]} ${pins[0]} DC ${iph}`,
      ],
      modelsUsed: new Set(['.model DPHOTO D(Is=10p N=1.1 Rs=10)']),
    };
  },

  // Photoresistor sensor — 4-pin breakout module (VCC, GND, DO, AO), the
  // LM393 light-sensor board. Internal topology, as on the real board and in
  // Wokwi: a fixed 10k from VCC to AO and the LDR from AO to GND. Brighter
  // light → LDR resistance drops → V_AO FALLS (ldrModel.ts). The DO
  // (comparator) pin is not modelled.
  // The LDR is a GL5528 by default, R = rl10 · (10 / lux)^gamma up to its
  // dark resistance (ldrModel.ts, velxio/velxio-prod#103).
  photoresistor: (comp, netLookup) => {
    const lux = Number(comp.properties.lux ?? 500);
    const Rldr = ldrResistance(
      lux,
      ldrParams(comp.properties, (raw, parsed) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[spice] ${comp.id}: dark resistance ${JSON.stringify(raw)} ` +
            `parsed as ${parsed} ohm — too low for a photoresistor (a lower-case m is ` +
            `milli; write "1M" or "1Meg" for 1 megaohm). Using the LDR's own dark resistance.`,
        );
      }),
    );
    const vcc = netLookup('VCC');
    const gnd = netLookup('GND');
    const ao = netLookup('AO');
    if (ao && (vcc || gnd)) {
      // The legs that are wired: a module missing its GND reads VCC through
      // the fixed resistor, one missing its VCC reads 0 V through the LDR. The
      // solve then owns AO in every wiring that powers the module at all
      // (velxio/velxio-prod#188: the part no longer writes it).
      const cards: string[] = [];
      if (gnd) cards.push(`R_${comp.id}_ldr ${ao} ${gnd} ${Rldr}`);
      if (vcc) cards.push(`R_${comp.id}_pull ${vcc} ${ao} ${ldrModuleFixedOhms(comp.properties)}`);
      return { cards, modelsUsed: new Set() };
    }
    // Legacy / discrete LDR fallbacks: emit bare 2-terminal resistor.
    const pins = twoPin(comp, netLookup, 'LDR1', 'LDR2') ?? twoPin(comp, netLookup, '1', '2');
    if (!pins) return null;
    return emitResistor(comp, pins, Rldr);
  },
};

/**
 * Preset variants of the generic passive parts. Each preset shares the
 * same web-component tag and the same SPICE emit logic as its base; the
 * picker uses different `defaultValues.value` per entry so users get
 * common values one click away (e.g. drop in a "Resistor 1kΩ" instead of
 * having to type "1000" into the property dialog).
 *
 * Exported so storeAdapter and DynamicComponent can keep their meta-id
 * tables in sync without restating the list.
 */
export const PASSIVE_PRESETS: Readonly<
  Record<string, 'resistor' | 'capacitor' | 'capacitor-electrolytic' | 'inductor'>
> = {
  // Resistors — E12 series subset covering the common Arduino-bench picks
  'resistor-220': 'resistor',
  'resistor-330': 'resistor',
  'resistor-470': 'resistor',
  'resistor-1k': 'resistor',
  'resistor-2k2': 'resistor',
  'resistor-4k7': 'resistor',
  'resistor-10k': 'resistor',
  'resistor-22k': 'resistor',
  'resistor-47k': 'resistor',
  'resistor-100k': 'resistor',
  'resistor-1m': 'resistor',
  // Ceramic caps (non-polarized, smaller end of the range)
  'cap-10p': 'capacitor',
  'cap-22p': 'capacitor',
  'cap-100p': 'capacitor',
  'cap-1n': 'capacitor',
  'cap-10n': 'capacitor',
  'cap-100n': 'capacitor',
  'cap-1u': 'capacitor',
  // Electrolytic caps (polarized, larger values)
  'cap-elec-1u': 'capacitor-electrolytic',
  'cap-elec-10u': 'capacitor-electrolytic',
  'cap-elec-47u': 'capacitor-electrolytic',
  'cap-elec-100u': 'capacitor-electrolytic',
  'cap-elec-470u': 'capacitor-electrolytic',
  'cap-elec-1000u': 'capacitor-electrolytic',
  // Inductors
  'ind-100u': 'inductor',
  'ind-1m': 'inductor',
  'ind-10m': 'inductor',
};

// Wire each preset to its base mapper.
for (const [presetId, baseId] of Object.entries(PASSIVE_PRESETS)) {
  MAPPERS[presetId] = MAPPERS[baseId];
}

// Alias: metadata id for the wokwi-photoresistor-sensor breakout is
// `photoresistor-sensor`, but the mapper is registered under the short
// name `photoresistor` (matches the bare LDR/discrete element). Without
// this alias, any example that drops a photoresistor sensor on the
// canvas gets a null mapping → no R_ldr / R_pull emitted → A0 net
// floats → analogRead returns 0 even though the divider should solve.
MAPPERS['photoresistor-sensor'] = MAPPERS['photoresistor'];

/**
 * Public entry: map one Velxio component to SPICE cards.
 * Returns null if we have no mapping for this metadataId (caller should
 * skip the component gracefully — it just won't participate in the solve).
 */
// Overlay seam: a private build registers SPICE mappers for components it
// ships outside the OSS tree (e.g. the DFRobot Gravity analog sensors emit a
// voltage source at AOUT). Same contract as the other pro seams — empty in a
// pure OSS build. Consulted after the static MAPPERS so OSS mappings win.
const proMappers: Record<string, Mapper> = {};

export function registerSpiceMapper(id: string, mapper: Mapper): void {
  proMappers[id] = mapper;
}

/**
 * The frequency of the periodic source a part emits (a SIN or a PULSE), in
 * hertz, or null when it emits none or a DC one. pickDynamicAnalysis sizes
 * the transient window from it (storeAdapter), so it lives next to the
 * mappers that decide which source a part emits: a part that starts
 * emitting a periodic source adds itself here. The power supply in AC mode
 * was missing: its circuit was solved as .op, at t = 0, where its sine is
 * 0 V, and every meter read 0 (velxio/velxio-prod#113).
 */
const PERIODIC_SOURCES: Readonly<Record<string, (comp: ComponentForSpice) => number | null>> = {
  'signal-generator': (comp) =>
    String(comp.properties.waveform ?? 'sine').toLowerCase() === 'dc'
      ? null
      : parseValueWithUnits(comp.properties.frequency, 1000),
  'power-supply': (comp) =>
    String(comp.properties.mode ?? 'dc').toLowerCase() === 'ac'
      ? parseValueWithUnits(comp.properties.frequency, 50)
      : null,
};

export function periodicSourceHz(comp: ComponentForSpice): number | null {
  const hz = PERIODIC_SOURCES[comp.metadataId]?.(comp) ?? null;
  return hz !== null && Number.isFinite(hz) && hz > 0 ? hz : null;
}

export function componentToSpice(
  comp: ComponentForSpice,
  netLookup: NetLookup,
  ctx: MapperContext,
): SpiceEmission | null {
  const mapper = MAPPERS[comp.metadataId] ?? proMappers[comp.metadataId];
  if (!mapper) return null;
  return mapper(comp, netLookup, ctx);
}

// Variants that are electrically the SAME device as an entry above: one model,
// several catalog ids. Keep this next to MAPPERS so adding a body size or a
// silkscreen variant is one line and cannot forget the netlist.
const MAPPER_ALIASES: Readonly<Record<string, string>> = {
  'pushbutton-6mm': 'pushbutton',
};
for (const [variant, base] of Object.entries(MAPPER_ALIASES)) {
  MAPPERS[variant] = MAPPERS[base];
}

/** True if we have a mapping for this metadataId. */
export function isSpiceMapped(metadataId: string): boolean {
  return metadataId in MAPPERS || metadataId in proMappers;
}

/** All metadataIds with a SPICE mapping (for docs / UI hints). */
export function mappedMetadataIds(): string[] {
  return Object.keys(MAPPERS);
}
