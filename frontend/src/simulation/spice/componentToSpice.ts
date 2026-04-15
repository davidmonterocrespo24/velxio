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

type Mapper = (comp: ComponentForSpice, netLookup: NetLookup, ctx: MapperContext) => SpiceEmission | null;

// ── Helpers ────────────────────────────────────────────────────────────────

function twoPin(comp: ComponentForSpice, netLookup: NetLookup, pinA: string, pinB: string): [string, string] | null {
  const a = netLookup(pinA);
  const b = netLookup(pinB);
  if (!a || !b) return null;
  return [a, b];
}

function emitResistor(comp: ComponentForSpice, pins: [string, string], value: number): SpiceEmission {
  return {
    cards: [`R_${comp.id} ${pins[0]} ${pins[1]} ${value}`],
    modelsUsed: new Set(),
  };
}

function emitCapacitor(comp: ComponentForSpice, pins: [string, string], value: number, ic = 0): SpiceEmission {
  return {
    cards: [`C_${comp.id} ${pins[0]} ${pins[1]} ${value} IC=${ic}`],
    modelsUsed: new Set(),
  };
}

function emitInductor(comp: ComponentForSpice, pins: [string, string], value: number): SpiceEmission {
  return {
    cards: [`L_${comp.id} ${pins[0]} ${pins[1]} ${value}`],
    modelsUsed: new Set(),
  };
}

// ── LED colour → Shockley params (tuned so V_f at 10 mA matches datasheet) ──
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
  led: (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    const color = String(comp.properties.color ?? 'red').toLowerCase();
    const model = LED_MODELS[color] ?? LED_MODELS.red;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} ${model.name}`],
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
      modelsUsed: new Set([
        '.model D1N4148 D(Is=2.52n N=1.752 Rs=0.568 Ibv=0.1u Bv=100 Cjo=4p M=0.333 Vj=0.5)',
      ]),
    };
  },
  'diode-1n4007': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} D1N4007`],
      modelsUsed: new Set([
        '.model D1N4007 D(Is=76.9n N=1.45 Rs=0.0342 Ikf=2.34 Bv=1000 Ibv=5u)',
      ]),
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

  // BJT real part numbers — NPN
  'bjt-2n2222': (comp, netLookup) => {
    const c = netLookup('C');
    const b = netLookup('B');
    const e = netLookup('E');
    if (!c || !b || !e) return null;
    return {
      cards: [`Q_${comp.id} ${c} ${b} ${e} Q2N2222`],
      modelsUsed: new Set(['.model Q2N2222 NPN(Is=14.34f Bf=200 Vaf=74 Rb=10 Rc=1)']),
    };
  },
  'bjt-bc547': (comp, netLookup) => {
    const c = netLookup('C');
    const b = netLookup('B');
    const e = netLookup('E');
    if (!c || !b || !e) return null;
    return {
      cards: [`Q_${comp.id} ${c} ${b} ${e} QBC547`],
      modelsUsed: new Set(['.model QBC547 NPN(Is=7.05f Bf=378 Vaf=85 Rb=10 Rc=1.32)']),
    };
  },
  'bjt-2n3055': (comp, netLookup) => {
    const c = netLookup('C');
    const b = netLookup('B');
    const e = netLookup('E');
    if (!c || !b || !e) return null;
    return {
      cards: [`Q_${comp.id} ${c} ${b} ${e} Q2N3055`],
      modelsUsed: new Set(['.model Q2N3055 NPN(Is=974f Bf=70 Vaf=100 Rb=0.5 Rc=0.05)']),
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
      modelsUsed: new Set(['.model Q2N3906 PNP(Is=1.41f Bf=180 Vaf=18.7 Rb=10)']),
    };
  },
  'bjt-bc557': (comp, netLookup) => {
    const c = netLookup('C');
    const b = netLookup('B');
    const e = netLookup('E');
    if (!c || !b || !e) return null;
    return {
      cards: [`Q_${comp.id} ${c} ${b} ${e} QBC557`],
      modelsUsed: new Set(['.model QBC557 PNP(Is=6.73f Bf=250 Vaf=80 Rb=10)']),
    };
  },

  // MOSFETs — NMOS
  // Level=1 Shichman-Hodges with moderate W/L avoids ngspice convergence
  // issues seen with Level=3 + W=0.1 m (which is literally 100 mm channel
  // width — unphysical and causes .op to hang).
  'mosfet-2n7000': (comp, netLookup) => {
    const d = netLookup('D');
    const g = netLookup('G');
    const s = netLookup('S');
    if (!d || !g || !s) return null;
    return {
      cards: [`M_${comp.id} ${d} ${g} ${s} ${s} M2N7000 L=2u W=200u`],
      modelsUsed: new Set(['.model M2N7000 NMOS(Level=1 Vto=1.6 Kp=50u Lambda=0.01)']),
    };
  },
  'mosfet-irf540': (comp, netLookup) => {
    const d = netLookup('D');
    const g = netLookup('G');
    const s = netLookup('S');
    if (!d || !g || !s) return null;
    return {
      cards: [`M_${comp.id} ${d} ${g} ${s} ${s} MIRF540 L=2u W=2m`],
      modelsUsed: new Set(['.model MIRF540 NMOS(Level=1 Vto=3 Kp=20u Lambda=0.01)']),
    };
  },

  // MOSFETs — PMOS (P-channel: Vto is negative, V_GS < Vto turns device ON)
  'mosfet-irf9540': (comp, netLookup) => {
    const d = netLookup('D');
    const g = netLookup('G');
    const s = netLookup('S');
    if (!d || !g || !s) return null;
    return {
      cards: [`M_${comp.id} ${d} ${g} ${s} ${s} MIRF9540 L=2u W=2m`],
      modelsUsed: new Set(['.model MIRF9540 PMOS(Level=1 Vto=-3 Kp=20u Lambda=0.01)']),
    };
  },
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
  'opamp-lm358': (comp, netLookup, ctx) => {
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

  // Switch / pushbutton
  pushbutton: (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, '1.l', '2.l');
    const alt = pins ?? twoPin(comp, netLookup, 'A', 'B');
    if (!alt) return null;
    const pressed = Boolean(comp.properties.pressed);
    const R = pressed ? 0.01 : 1e9;
    return emitResistor(comp, alt, R);
  },
  'slide-switch': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, '1', '2');
    if (!pins) return null;
    const closed = comp.properties.value === 1 || comp.properties.value === '1';
    return emitResistor(comp, pins, closed ? 0.01 : 1e9);
  },

  // Potentiometer (3-terminal voltage divider)
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

  // NTC temperature sensor (β-model)
  'ntc-temperature-sensor': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, '1', '2');
    if (!pins) return null;
    const Tc = Number(comp.properties.temperature ?? 25);
    const R0 = parseValueWithUnits(comp.properties.R0, 10_000);
    const beta = Number(comp.properties.beta ?? 3950);
    const R = ntcResistance(Tc, R0, 298.15, beta);
    return emitResistor(comp, pins, R);
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
      cards: [
        `V_${comp.id}_sense ${ap} ${midNet} DC 0`,
        `R_${comp.id}_shunt ${midNet} ${am} 1m`,
      ],
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
  // Convention: inputs at 2-input gates are 'A','B'; output is 'Y'. Threshold
  // is ctx.vcc/2. A 1 MΩ load keeps the output node DC-connected so ngspice
  // doesn't see it as floating (otherwise .op returns matrix singular).
  'logic-gate-and': (comp, netLookup, ctx) => {
    const a = netLookup('A'), b = netLookup('B'), y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * u(V(${a})-${T}) * u(V(${b})-${T})`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-or': (comp, netLookup, ctx) => {
    const a = netLookup('A'), b = netLookup('B'), y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (1 - (1-u(V(${a})-${T})) * (1-u(V(${b})-${T})))`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-nand': (comp, netLookup, ctx) => {
    const a = netLookup('A'), b = netLookup('B'), y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (1 - u(V(${a})-${T}) * u(V(${b})-${T}))`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-nor': (comp, netLookup, ctx) => {
    const a = netLookup('A'), b = netLookup('B'), y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (1-u(V(${a})-${T})) * (1-u(V(${b})-${T}))`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-xor': (comp, netLookup, ctx) => {
    const a = netLookup('A'), b = netLookup('B'), y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (u(V(${a})-${T}) + u(V(${b})-${T}) - 2*u(V(${a})-${T})*u(V(${b})-${T}))`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-xnor': (comp, netLookup, ctx) => {
    const a = netLookup('A'), b = netLookup('B'), y = netLookup('Y');
    if (!a || !b || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (1 - (u(V(${a})-${T}) + u(V(${b})-${T}) - 2*u(V(${a})-${T})*u(V(${b})-${T})))`,
        `R_${comp.id}_load ${y} 0 1Meg`,
      ],
      modelsUsed: new Set(),
    };
  },
  'logic-gate-not': (comp, netLookup, ctx) => {
    const a = netLookup('A'), y = netLookup('Y');
    if (!a || !y) return null;
    const T = ctx.vcc / 2;
    return {
      cards: [
        `B_${comp.id} ${y} 0 V = ${ctx.vcc} * (1 - u(V(${a})-${T}))`,
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
        const inputs = inputNames.map(n => netLookup(n));
        const y = netLookup('Y');
        if (inputs.some(n => !n) || !y) return null;
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
      `${vcc} * ${inputs.map(n => `u(V(${n})-${T})`).join(' * ')}`;
    const orExpr = (inputs: string[], T: number, vcc: number) =>
      `${vcc} * (1 - ${inputs.map(n => `(1-u(V(${n})-${T}))`).join(' * ')})`;
    const nandExpr = (inputs: string[], T: number, vcc: number) =>
      `${vcc} * (1 - ${inputs.map(n => `u(V(${n})-${T})`).join(' * ')})`;
    const norExpr = (inputs: string[], T: number, vcc: number) =>
      `${vcc} * ${inputs.map(n => `(1-u(V(${n})-${T}))`).join(' * ')}`;
    return {
      'logic-gate-and-3':  multiGate(['A', 'B', 'C'],      andExpr),
      'logic-gate-or-3':   multiGate(['A', 'B', 'C'],      orExpr),
      'logic-gate-nand-3': multiGate(['A', 'B', 'C'],      nandExpr),
      'logic-gate-nor-3':  multiGate(['A', 'B', 'C'],      norExpr),
      'logic-gate-and-4':  multiGate(['A', 'B', 'C', 'D'], andExpr),
      'logic-gate-or-4':   multiGate(['A', 'B', 'C', 'D'], orExpr),
      'logic-gate-nand-4': multiGate(['A', 'B', 'C', 'D'], nandExpr),
      'logic-gate-nor-4':  multiGate(['A', 'B', 'C', 'D'], norExpr),
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
      'ic-74hc00': ic2InputQuad((a, b, _y, T, vcc) =>
        `${vcc} * (1 - u(V(${a})-${T}) * u(V(${b})-${T}))`),
      // 74HC08 — quad 2-input AND
      'ic-74hc08': ic2InputQuad((a, b, _y, T, vcc) =>
        `${vcc} * u(V(${a})-${T}) * u(V(${b})-${T})`),
      // 74HC32 — quad 2-input OR
      'ic-74hc32': ic2InputQuad((a, b, _y, T, vcc) =>
        `${vcc} * (1 - (1-u(V(${a})-${T})) * (1-u(V(${b})-${T})))`),
      // 74HC02 — quad 2-input NOR
      'ic-74hc02': ic2InputQuad((a, b, _y, T, vcc) =>
        `${vcc} * (1-u(V(${a})-${T})) * (1-u(V(${b})-${T}))`),
      // 74HC86 — quad 2-input XOR
      'ic-74hc86': ic2InputQuad((a, b, _y, T, vcc) =>
        `${vcc} * (u(V(${a})-${T}) + u(V(${b})-${T}) - 2*u(V(${a})-${T})*u(V(${b})-${T}))`),
      // 74HC04 — hex inverter
      'ic-74hc04': ic1InputHex((a, _y, T, vcc) =>
        `${vcc} * (1 - u(V(${a})-${T}))`),
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
  relay: (comp, netLookup) => {
    const cp = netLookup('COIL+');
    const cn = netLookup('COIL-');
    const com = netLookup('COM');
    const no = netLookup('NO');
    const nc = netLookup('NC');
    if (!cp || !cn || !com || !no || !nc) return null;
    const coilR = Number(comp.properties.coil_resistance ?? 70);
    const coilV = Number(comp.properties.coil_voltage ?? 5);
    const threshold = coilV * 0.6; // drop-in at 60% of nominal
    const hysteresis = coilV * 0.15;
    const includeFlyback = comp.properties.include_flyback !== false;
    const ctrlInvNet = `${comp.id}_ncctrl`;
    const cards = [
      `R_${comp.id}_coil ${cp} ${cn} ${coilR}`,
      `L_${comp.id}_coil ${cp} ${cn} 20m`,
      // NO: closes when V_coil > Vt (normal SW behaviour)
      `S_${comp.id}_no ${com} ${no} ${cp} ${cn} RELAY_SW`,
      // NC: inverted control — B-source maps (V_coil → Vnom − V_coil) so that
      // SW still "turns on when ctrl > Vt", but meaning is inverted.
      `B_${comp.id}_ncctrl ${ctrlInvNet} 0 V = ${coilV} - (V(${cp}) - V(${cn}))`,
      `S_${comp.id}_nc ${com} ${nc} ${ctrlInvNet} 0 RELAY_SW`,
    ];
    if (includeFlyback) {
      cards.push(`D_${comp.id}_fly ${cn} ${cp} D1N4148`);
    }
    return {
      cards,
      modelsUsed: new Set([
        `.model RELAY_SW SW(Vt=${threshold} Vh=${hysteresis} Ron=0.05 Roff=1G)`,
        '.model D1N4148 D(Is=2.52n N=1.752 Rs=0.568 Ibv=0.1u Bv=100)',
      ]),
    };
  },

  // ── Schottky diodes (Vf ≈ 0.3–0.45 V at 1 A) ────────────────────────────
  'diode-1n5817': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} D1N5817`],
      modelsUsed: new Set([
        '.model D1N5817 D(Is=3.3u N=1 Rs=0.025 Bv=20 Ibv=10m Cjo=120p)',
      ]),
    };
  },
  'diode-1n5819': (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'A', 'C');
    if (!pins) return null;
    return {
      cards: [`D_${comp.id} ${pins[0]} ${pins[1]} D1N5819`],
      modelsUsed: new Set([
        '.model D1N5819 D(Is=3u N=1 Rs=0.027 Bv=40 Ibv=10m Cjo=150p)',
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
      modelsUsed: new Set([
        '.model DPHOTO D(Is=10p N=1.1 Rs=10)',
      ]),
    };
  },

  // Photoresistor (R(lux) = R_dark / (1 + k·lux))
  photoresistor: (comp, netLookup) => {
    const pins = twoPin(comp, netLookup, 'LDR1', 'LDR2');
    const alt = pins ?? twoPin(comp, netLookup, '1', '2');
    if (!alt) return null;
    const lux = Number(comp.properties.lux ?? 500);
    const Rdark = parseValueWithUnits(comp.properties.dark, 1_000_000);
    const k = Number(comp.properties.k ?? 5);
    const R = Rdark / (1 + k * lux / 1000);
    return emitResistor(comp, alt, R);
  },
};

/**
 * Public entry: map one Velxio component to SPICE cards.
 * Returns null if we have no mapping for this metadataId (caller should
 * skip the component gracefully — it just won't participate in the solve).
 */
export function componentToSpice(
  comp: ComponentForSpice,
  netLookup: NetLookup,
  ctx: MapperContext,
): SpiceEmission | null {
  const mapper = MAPPERS[comp.metadataId];
  if (!mapper) return null;
  return mapper(comp, netLookup, ctx);
}

/** True if we have a mapping for this metadataId. */
export function isSpiceMapped(metadataId: string): boolean {
  return metadataId in MAPPERS;
}

/** All metadataIds with a SPICE mapping (for docs / UI hints). */
export function mappedMetadataIds(): string[] {
  return Object.keys(MAPPERS);
}
