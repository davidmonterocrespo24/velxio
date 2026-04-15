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

  // BJT real part numbers
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

  // MOSFETs
  'mosfet-2n7000': (comp, netLookup) => {
    const d = netLookup('D');
    const g = netLookup('G');
    const s = netLookup('S');
    if (!d || !g || !s) return null;
    return {
      cards: [`M_${comp.id} ${d} ${g} ${s} ${s} M2N7000 L=2u W=0.1`],
      modelsUsed: new Set(['.model M2N7000 NMOS(Level=3 Vto=1.6 Kp=0.1 Rd=1 Rs=0.5)']),
    };
  },
  'mosfet-irf540': (comp, netLookup) => {
    const d = netLookup('D');
    const g = netLookup('G');
    const s = netLookup('S');
    if (!d || !g || !s) return null;
    return {
      cards: [`M_${comp.id} ${d} ${g} ${s} ${s} MIRF540 L=2u W=1`],
      modelsUsed: new Set(['.model MIRF540 NMOS(Level=3 Vto=3 Kp=20 Rd=0.044)']),
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
