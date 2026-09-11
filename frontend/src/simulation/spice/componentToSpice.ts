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

export interface SpiceEmission {
  /** One or more netlist lines (without trailing newline). */
  cards: string[];
  /** Model or subckt names this emission depends on (so the builder adds `.model` later). */
  modelsUsed: Set<string>;
}

export type NetLookup = (pinName: string) => string | null;

export interface MapperContext {
  /** Supply voltage in effect (V). Boards set this; ground is 0. */
  vcc: number;
}

export type Mapper = (
  comp: ComponentForSpice,
  netLookup: NetLookup,
  ctx: MapperContext,
) => SpiceEmission | null;

// ── Helpers ────────────────────────────────────────────────────────────────

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

// ── LED colour → Shockley params (tuned so V_f at 10 mA matches datasheet) ──
const LOGIC_EDGE_VOLTS = 0.05;
/** `0..1` step of `V(net)` around `threshold`, with a finite slope (see the gates note). */
function logicStep(net: string, threshold: number): string {
  return `(0.5*(1+tanh((V(${net})-${threshold})/${LOGIC_EDGE_VOLTS})))`;
}

const LED_MODELS: Record<string, { name: string; Is: string; n: string }> = {
  red: { name: 'LED_RED', Is: '1e-20', n: '1.7' },
  green: { name: 'LED_GREEN', Is: '1e-22', n: '1.9' },
  yellow: { name: 'LED_YELLOW', Is: '1e-21', n: '1.8' },
  blue: { name: 'LED_BLUE', Is: '1e-28', n: '2.0' },
  white: { name: 'LED_WHITE', Is: '1e-28', n: '2.0' },
};

// ── NTC β-model ────────────────────────────────────────────────────────────
function ntcResistance(Tc: number, R0 = 10_000, T0 = 298.15, beta = 3950): number {
  const T = Tc + 273.15;
  return R0 * Math.exp(beta * (1 / T - 1 / T0));
}

// ── Mappers (one per metadataId) ───────────────────────────────────────────

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
    const model = LED_MODELS[color] ?? LED_MODELS.red;
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
  'diode-1n4007': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} D1N4007`],
      modelsUsed: new Set(['.model D1N4007 D(Is=76.9n N=1.45 Rs=0.0342 Ikf=2.34 Bv=1000 Ibv=5u)']),
    };
  },
  'zener-1n4733': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} D1N4733`],
      modelsUsed: new Set(['.model D1N4733 D(Is=1n N=1 Rs=5 Bv=5.1 Ibv=50m)']),
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
        '.model Q2N2222 NPN(IS=1E-14 VAF=100 BF=200 IKF=0.3 XTB=1.5 BR=3 CJC=8E-12 CJE=25E-12 TR=100E-9 TF=400E-12 ITF=1 VTF=2 XTF=3 RB=10 RC=.3 RE=.2)',
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
        '.model Q2N3055 NPN(BF=73 BR=2.66 RB=.81 RC=.0856 RE=.000856 CJC=1000P PC=.75 MC=.33 TR=.5703U IS=2.37E-8 CJE=415P PE=.75 ME=.5 TF=99.52N NE=1.26 IK=1)',
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
  'mosfet-2n7000': (comp, netLookup) => {
    const d = netLookup('D');
    const g = netLookup('G');
    const s = netLookup('S');
    if (!d || !g || !s) return null;
    return {
      cards: [`M_${comp.id} ${d} ${g} ${s} M2N7000`],
      modelsUsed: new Set([
        '.model M2N7000 VDMOS(Rg=3 Vto=1.6 Rd=0 Rs=.75 Rb=.14 Kp=.17 mtriode=1.25 Cgdmax=80p Cgdmin=12p Cgs=50p Cjo=50p Is=.04p Vds=60 Ron=2 Qg=1.5n)',
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
        '.model MIRF540 VDMOS(Rg=3 Vto=4 Rd=50m Rs=12m Rb=60m Kp=5 lambda=.01 Cgdmax=1n Cgdmin=.26n Cgs=.2n Cjo=.4n Is=52p Vds=100 Ron=160m Qg=26n)',
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
        // identical pin-out and similar Vto. The `pchan` keyword is what
        // tells the VDMOS engine to flip polarity.
        '.model MIRF9540 VDMOS(pchan Rg=3 Vto=-3.5 Rd=.15 Rs=.15 Rb=.15 Kp=8 lambda=.01 mtriode=.5 Cgdmax=1.5n Cgdmin=.07n Cgs=1n Cjo=1n Is=38p Vds=-200 Ron=.5 Qg=44n)',
      ]),
    };
  },
  // FQP27P06 has no good LTSpice equivalent — kept on Level=1 PMOS with the
  // historical parameter set. Upgrade when a Fairchild VDMOS model is found.
  'mosfet-fqp27p06': (comp, netLookup) => {
    const d = netLookup('D');
    const g = netLookup('G');
    const s = netLookup('S');
    if (!d || !g || !s) return null;
    return {
      cards: [`M_${comp.id} ${d} ${g} ${s} ${s} MFQP27P06 L=2u W=500u`],
      modelsUsed: new Set(['.model MFQP27P06 PMOS(Level=1 Vto=-2.5 Kp=50u Lambda=0.01)']),
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
  // All 4 mappers follow the same shape:
  //   V_out = clamp(A · (V_in+ − V_in-), Vsat_lo, Vsat_hi)
  // Rails are derived from ctx.vcc. Single-supply assumption: output saturates
  // between a low rail (ground + headroom) and a high rail (vcc − headroom).
  // Headroom is chip-specific (LM358/LM324 are near rail-to-rail output,
  // LM741 needs ~1.5 V, TL072 with JFET input needs ~2 V).
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
    // where the prior `.op` skipped.  Power rails wire implicitly to
    // vcc_rail / 0 (the canvas doesn't draw op-amp power pins).
    // Real slew rate (~0.5 V/µs), GBW (~1 MHz), and rail headroom
    // come for free vs the prior behavioural B-source clamp.
    return {
      cards: [`X_${comp.id} ${inp} ${inn} vcc_rail 0 ${out} LM358`],
      modelsUsed: new Set([LM358_SUBCKT]),
    };
  },
  'opamp-lm741': (comp, netLookup, ctx) => {
    const inp = netLookup('IN+');
    const inn = netLookup('IN-');
    const out = netLookup('OUT');
    if (!inp || !inn || !out) return null;
    const A = 2e5;
    const vLo = 1.5;
    const vHi = ctx.vcc - 1.5;
    return {
      cards: [
        `R_${comp.id}_inp ${inp} 0 2Meg`,
        `R_${comp.id}_inn ${inn} 0 2Meg`,
        `B_${comp.id} ${out} 0 V = max(${vLo}, min(${vHi}, ${A}*(V(${inp})-V(${inn}))))`,
        `R_${comp.id}_out ${out} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'opamp-tl072': (comp, netLookup, ctx) => {
    const inp = netLookup('IN+');
    const inn = netLookup('IN-');
    const out = netLookup('OUT');
    if (!inp || !inn || !out) return null;
    const A = 2e5;
    const vLo = 2.0;
    const vHi = ctx.vcc - 2.0;
    return {
      cards: [
        // JFET input: huge Z_in — model with 1 TΩ
        `R_${comp.id}_inp ${inp} 0 1T`,
        `R_${comp.id}_inn ${inn} 0 1T`,
        `B_${comp.id} ${out} 0 V = max(${vLo}, min(${vHi}, ${A}*(V(${inp})-V(${inn}))))`,
        `R_${comp.id}_out ${out} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'opamp-lm324': (comp, netLookup, ctx) => {
    // Quad op-amp — electrically identical to LM358 per-channel
    const inp = netLookup('IN+');
    const inn = netLookup('IN-');
    const out = netLookup('OUT');
    if (!inp || !inn || !out) return null;
    const A = 1e5;
    const vLo = 0.05;
    const vHi = ctx.vcc - 1.5;
    return {
      cards: [
        `R_${comp.id}_inp ${inp} 0 10Meg`,
        `R_${comp.id}_inn ${inn} 0 10Meg`,
        `B_${comp.id} ${out} 0 V = max(${vLo}, min(${vHi}, ${A}*(V(${inp})-V(${inn}))))`,
        `R_${comp.id}_out ${out} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },

  // ── Linear voltage regulators ────────────────────────────────────────────
  // Behavioral model: V_out = min(V_in - V_dropout, V_nom). Dropout voltage
  // ≈ 2V for classic 78xx / 79xx series. When V_in is too low, V_out drops
  // to (V_in − V_dropout), matching real-chip behaviour in under-voltage.
  // Pin names: VIN, VOUT, GND (for 78xx) — for 79xx GND swaps to be a
  // reference rail since V_out is negative.
  'reg-7805': (comp, netLookup) => {
    const vin = netLookup('VIN');
    const gnd = netLookup('GND');
    const vout = netLookup('VOUT');
    if (!vin || !gnd || !vout) return null;
    return {
      cards: [
        `B_${comp.id} ${vout} ${gnd} V = min(V(${vin})-V(${gnd})-2, 5)`,
        `R_${comp.id}_out ${vout} ${gnd} 10Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'reg-7812': (comp, netLookup) => {
    const vin = netLookup('VIN');
    const gnd = netLookup('GND');
    const vout = netLookup('VOUT');
    if (!vin || !gnd || !vout) return null;
    return {
      cards: [
        `B_${comp.id} ${vout} ${gnd} V = min(V(${vin})-V(${gnd})-2, 12)`,
        `R_${comp.id}_out ${vout} ${gnd} 10Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'reg-7905': (comp, netLookup) => {
    // 7905 delivers −5 V relative to its GND pin. V_in is negative (below GND).
    const vin = netLookup('VIN');
    const gnd = netLookup('GND');
    const vout = netLookup('VOUT');
    if (!vin || !gnd || !vout) return null;
    return {
      cards: [
        `B_${comp.id} ${vout} ${gnd} V = max(V(${vin})-V(${gnd})+2, -5)`,
        `R_${comp.id}_out ${vout} ${gnd} 10Meg`,
      ],
      modelsUsed: new Set(),
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
      cards: [
        `B_${comp.id} ${vout} 0 V = V(${adj}) + min(V(${vin})-V(${adj})-2, 1.25)`,
        `R_${comp.id}_out ${vout} 0 10Meg`,
      ],
      modelsUsed: new Set(),
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
    };
  },

  // ── Regulated power supply (DC / AC, current-limit aware) ───────────────
  // Properties:
  //   mode:         'dc' | 'ac'   (default 'dc')
  //   voltage:      V             (default 5)
  //   frequency:    Hz            (default 50, only used in AC mode)
  //   currentLimit: A             (default 1; enforced by circuitVerifier,
  //                                NOT SPICE — ngspice has no native
  //                                foldback limiter)
  // The visual element reuses wokwi-signal-generator (no new Web Component
  // needed). ESR is derived from the currentLimit so a near-short reads
  // as I ≈ 1.5·limit, which the verifier then flags as source-overload.
  'power-supply': (comp, netLookup) => {
    const pos = netLookup('+') ?? netLookup('SIG') ?? netLookup('VCC');
    const neg = netLookup('−') ?? netLookup('-') ?? netLookup('GND');
    if (!pos || !neg) return null;
    const mode = String(comp.properties.mode ?? 'dc').toLowerCase();
    const voltage = Number(comp.properties.voltage ?? 5);
    const currentLimit = Math.max(0.01, Number(comp.properties.currentLimit ?? 1));
    const esr = Math.max(0.01, voltage / (currentLimit * 1.5));
    let source: string;
    if (mode === 'ac') {
      const freq = Number(comp.properties.frequency ?? 50);
      source = `SIN(0 ${voltage} ${freq})`;
    } else {
      source = `DC ${voltage}`;
    }
    return {
      cards: [
        `V_${comp.id} ${pos} ${comp.id}_int ${source}`,
        `R_${comp.id}_esr ${comp.id}_int ${neg} ${esr}`,
      ],
      modelsUsed: new Set(),
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
    const freq = Number(comp.properties.frequency ?? 1000);
    const amp = Number(comp.properties.amplitude ?? 1);
    const off = Number(comp.properties.offset ?? 0);
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
  // same numbers to two decimals) and gives the loop a solution: the
  // symmetric midpoint at power-up, which is what a real latch does until an
  // input breaks the tie. The Schmitt inverter (hysteresis by design) and
  // the L293D enable logic keep the ideal step: neither is cross-coupled.
  // Written as one helper so the edge width is a single number.

  // Convention: inputs at 2-input gates are 'A','B'; output is 'Y'. Threshold
  // is ctx.vcc/2. A 1 MΩ load keeps the output node DC-connected so ngspice
  // doesn't see it as floating (otherwise .op returns matrix singular).
  'logic-gate-and': (comp, netLookup, ctx) => {
    const a = netLookup('A'),
      b = netLookup('B'),
      y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * ${logicStep(a, T)} * ${logicStep(b, T)}`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-or': (comp, netLookup, ctx) => {
    const a = netLookup('A'),
      b = netLookup('B'),
      y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (1 - (1-${logicStep(a, T)}) * (1-${logicStep(b, T)}))`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-nand': (comp, netLookup, ctx) => {
    const a = netLookup('A'),
      b = netLookup('B'),
      y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (1 - ${logicStep(a, T)} * ${logicStep(b, T)})`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-nor': (comp, netLookup, ctx) => {
    const a = netLookup('A'),
      b = netLookup('B'),
      y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (1-${logicStep(a, T)}) * (1-${logicStep(b, T)})`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-xor': (comp, netLookup, ctx) => {
    const a = netLookup('A'),
      b = netLookup('B'),
      y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (${logicStep(a, T)} + ${logicStep(b, T)} - 2*${logicStep(a, T)}*${logicStep(b, T)})`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-xnor': (comp, netLookup, ctx) => {
    const a = netLookup('A'),
      b = netLookup('B'),
      y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (1 - (${logicStep(a, T)} + ${logicStep(b, T)} - 2*${logicStep(a, T)}*${logicStep(b, T)}))`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-not': (comp, netLookup, ctx) => {
    const a = netLookup('A'),
      y = netLookup('Y');
    if (!a || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (1 - ${logicStep(a, T)})`,
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
        return {
          cards: [
            `B_${comp.id} ${y} 0 V = ${build(inputs as string[], T, ctx.vcc)}`,
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

  // ── L293D dual H-bridge motor driver ────────────────────────────────────
  // 16-pin package with two independent channels. Per channel:
  //   EN, IN1, IN2, OUT1, OUT2  + shared VCC1 (logic) and VCC2 (motor)
  //
  // Truth table per output:
  //   EN=LOW  → output high-Z (modeled as weak 10MΩ pull to GND)
  //   EN=HIGH → OUT follows IN: HIGH → V_motor, LOW → 0
  //
  // Uses ctx.vcc as the logic threshold reference; V_motor is taken from the
  // VCC2 net if wired, otherwise defaults to ctx.vcc. The behavioural output
  // linearly drives OUT via a B-source + load resistor for DC path.
  'motor-driver-l293d': (comp, netLookup, ctx) => {
    const T = ctx.vcc / 2;
    const vcc2 = netLookup('VCC2') ?? netLookup('+VS') ?? netLookup('VS');
    const vMotorExpr = vcc2 ? `V(${vcc2})` : `${ctx.vcc}`;
    const cards: string[] = [];

    for (const ch of [1, 2]) {
      const en = netLookup(`EN${ch}`);
      const in1 = netLookup(`IN${2 * ch - 1}`);
      const in2 = netLookup(`IN${2 * ch}`);
      const out1 = netLookup(`OUT${2 * ch - 1}`);
      const out2 = netLookup(`OUT${2 * ch}`);
      if (!en) continue;
      if (in1 && out1) {
        // OUT1 = u(EN-T) * (u(IN1-T) * V_motor)
        cards.push(
          `B_${comp.id}_ch${ch}a ${out1} 0 V = u(V(${en})-${T}) * u(V(${in1})-${T}) * ${vMotorExpr}`,
        );
        cards.push(`R_${comp.id}_ch${ch}a_load ${out1} 0 10Meg`);
      }
      if (in2 && out2) {
        cards.push(
          `B_${comp.id}_ch${ch}b ${out2} 0 V = u(V(${en})-${T}) * u(V(${in2})-${T}) * ${vMotorExpr}`,
        );
        cards.push(`R_${comp.id}_ch${ch}b_load ${out2} 0 10Meg`);
      }
    }

    if (cards.length === 0) return null;
    return { cards, modelsUsed: new Set() };
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
          cards.push(`B_${comp.id}_${i} ${y} 0 V = ${build(a, b, y, T, ctx.vcc)}`);
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
          cards.push(`B_${comp.id}_${i} ${y} 0 V = ${build(a, y, T, ctx.vcc)}`);
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
      // 74HC14 — hex Schmitt-trigger inverter. Threshold moves based on
      // current output state: high output → lower trip (0.4·Vcc), low output
      // → higher trip (0.6·Vcc). This is the hysteresis band.
      'ic-74hc14': ic1InputHex((a, y, _T, vcc) => {
        const hi = 0.6 * vcc;
        const lo = 0.4 * vcc;
        return `${vcc} * (1 - u(V(${a}) - (${hi} - u(V(${y})-${vcc / 2}) * ${hi - lo})))`;
      }),
    };
  })(),

  // ── Optocouplers (LED + phototransistor in one package) ─────────────────
  // Pattern: LED on input side, current-sense resistor (0V source) measures
  // I_LED, an F-source (CCCS) mirrors that current into the phototransistor
  // output with the part's Current Transfer Ratio (CTR).
  'opto-4n25': (comp, netLookup) => {
    const an = netLookup('AN');
    const cat = netLookup('CAT');
    const col = netLookup('COL');
    const emit = netLookup('EMIT');
    if (!an || !cat || !col || !emit) return null;
    const CTR = 0.5; // 50%
    return {
      cards: [
        `D_${comp.id}_led ${an} ${comp.id}_mid DLED_OPTO`,
        `V_${comp.id}_sense ${comp.id}_mid ${cat} DC 0`,
        `F_${comp.id}_pt ${col} ${emit} V_${comp.id}_sense ${CTR}`,
        `R_${comp.id}_leak ${col} ${emit} 100Meg`,
      ],
      modelsUsed: new Set(['.model DLED_OPTO D(Is=1e-14 N=2 Rs=5)']),
    };
  },
  'opto-pc817': (comp, netLookup) => {
    const an = netLookup('AN');
    const cat = netLookup('CAT');
    const col = netLookup('COL');
    const emit = netLookup('EMIT');
    if (!an || !cat || !col || !emit) return null;
    const CTR = 1.0; // 100% (typical for PC817, min 50% max 600%)
    return {
      cards: [
        `D_${comp.id}_led ${an} ${comp.id}_mid DLED_OPTO`,
        `V_${comp.id}_sense ${comp.id}_mid ${cat} DC 0`,
        `F_${comp.id}_pt ${col} ${emit} V_${comp.id}_sense ${CTR}`,
        `R_${comp.id}_leak ${col} ${emit} 100Meg`,
      ],
      modelsUsed: new Set(['.model DLED_OPTO D(Is=1e-14 N=2 Rs=5)']),
    };
  },

  // ── Electromechanical relay (SPDT, 5-pin) ───────────────────────────────
  // Coil is modelled as R + L in parallel. Contacts are voltage-controlled
  // switches (ngspice `S` element) with native hysteresis via Vt/Vh — avoids
  // chatter when V_COIL sits near the activation threshold. The NC contact
  // uses a B-source that inverts the coil voltage as its control signal,
  // because ngspice SW has no "normally closed" mode.
  // Optional flyback diode across the coil (anode on COIL-, cathode on COIL+).
  // NO and NC contact cards are only emitted when their respective pins are
  // wired — leaving NC unconnected is a very common pattern and must not
  // suppress the rest of the relay (coil + NO switch).
  relay: (comp, netLookup) => {
    const cp = netLookup('COIL+');
    const cn = netLookup('COIL-');
    const com = netLookup('COM');
    const no = netLookup('NO');
    const nc = netLookup('NC');
    // Coil pins must be present — without them the relay can't be energised.
    // COM is required too; without it, neither NO nor NC contact is useful.
    if (!cp || !cn || !com) return null;
    const coilR = Number(comp.properties.coil_resistance ?? 70);
    const coilV = Number(comp.properties.coil_voltage ?? 5);
    const threshold = coilV * 0.6; // drop-in at 60% of nominal
    const hysteresis = coilV * 0.15;
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
    if (no) {
      // NO: closes when V_coil > Vt (normal SW behaviour)
      cards.push(`S_${comp.id}_no ${com} ${no} ${cp} ${cn} RELAY_SW`);
    }
    if (nc) {
      // NC: inverted control — B-source maps (V_coil → Vnom − V_coil) so that
      // SW still "turns on when ctrl > Vt", but meaning is inverted.
      const ctrlInvNet = `${comp.id}_ncctrl`;
      cards.push(`B_${comp.id}_ncctrl ${ctrlInvNet} 0 V = ${coilV} - (V(${cp}) - V(${cn}))`);
      cards.push(`S_${comp.id}_nc ${com} ${nc} ${ctrlInvNet} 0 RELAY_SW`);
    }
    if (includeFlyback) {
      cards.push(`D_${comp.id}_fly ${cn} ${cp} D1N4148`);
    }
    return {
      cards,
      modelsUsed: new Set([
        `.model RELAY_SW SW(Vt=${threshold} Vh=${hysteresis} Ron=0.05 Roff=1G)`,
        // Must match the canonical D1N4148 in `diode-1n4148` exactly, or
        // the netlist dedupe Set will emit two `.model D1N4148` lines.
        '.model D1N4148 D(Is=2.52n Rs=.568 N=1.752 Cjo=4p M=.4 tt=20n Bv=100 Ibv=0.1u)',
      ]),
    };
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

  // Photoresistor (R(lux) = R_dark / (1 + k·lux))
  // Photoresistor sensor — 4-pin breakout module (VCC, GND, DO, AO).
  // Internal topology: LDR between VCC and AO, plus an internal 10k pull-down
  // from AO to GND. Brighter light → LDR resistance drops → V_AO rises.
  // The DO (digital threshold) pin is ignored for analog simulation.
  photoresistor: (comp, netLookup) => {
    const lux = Number(comp.properties.lux ?? 500);
    // `dark` goes through the SPICE suffix convention, where M is MILLI and
    // mega is `Meg`. A dark resistance below 1k is not a photoresistor — it
    // is almost always "1M" written meaning 1 megaohm, which parses to
    // 0.001 ohm and shorts AO straight to VCC. The symptom is nasty because
    // it looks like the part works: the ADC just reads full scale forever and
    // the lux control does nothing (every value is still a short). Clamp to
    // the documented default and say so, rather than emitting a short.
    const darkRaw = parseValueWithUnits(comp.properties.dark, 1_000_000);
    let Rdark = darkRaw;
    if (!(darkRaw >= 1_000)) {
      Rdark = 1_000_000;
      // eslint-disable-next-line no-console
      console.warn(
        `[spice] ${comp.id}: dark resistance ${JSON.stringify(comp.properties.dark)} ` +
          `parsed as ${darkRaw} ohm — too low for a photoresistor. SPICE reads M as ` +
          `milli; write "1Meg" for 1 megaohm. Using 1Meg.`,
      );
    }
    const k = Number(comp.properties.k ?? 5);
    const Rldr = Rdark / (1 + (k * lux) / 1000);
    const vcc = netLookup('VCC');
    const gnd = netLookup('GND');
    const ao = netLookup('AO');
    if (vcc && gnd && ao) {
      const Rpull = parseValueWithUnits(comp.properties.pullup, 10_000);
      return {
        cards: [`R_${comp.id}_ldr ${vcc} ${ao} ${Rldr}`, `R_${comp.id}_pull ${ao} ${gnd} ${Rpull}`],
        modelsUsed: new Set(),
      };
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
