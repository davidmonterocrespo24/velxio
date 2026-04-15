/**
 * Measurement probes (voltmeters, ammeters, scope probes).
 *
 * Probes are Velxio components with `metadataId` starting with `instr-`.
 * They do NOT contribute SPICE cards themselves (so `componentToSpice`
 * returns null for them). Instead, they read the already-solved result
 * via net names derived from the same Union-Find used in NetlistBuilder.
 *
 * The ammeter is special: it *does* inject a "V_name_sense 0" voltage
 * source (0 V) in series with one of its pins so ngspice reports a
 * branch current for it. Phase 8.5 MVP: emit the sense source by extending
 * componentToSpice with an ammeter mapper.
 */
import type { ComponentForSpice, ElectricalSolveResult } from './types';
import type { Wire } from '../../types/wire';
import { UnionFind } from './unionFind';

export type ProbeKind = 'voltmeter' | 'ammeter' | 'multimeter';

export interface ProbeReading {
  kind: ProbeKind;
  /** Primary numeric value (volts for voltmeter, amps for ammeter). */
  value: number;
  /** Pretty string for UI display. */
  display: string;
  /** Unit label shown next to the value. */
  unit: 'V' | 'mV' | 'µV' | 'A' | 'mA' | 'µA' | 'nA' | 'Ω' | 'kΩ' | 'MΩ' | '—';
  /** Whether the reading is stale / invalid. */
  stale: boolean;
}

/** True if a component is an instrument (doesn't stamp SPICE cards itself). */
export function isInstrument(metadataId: string): boolean {
  return metadataId.startsWith('instr-');
}

function formatV(v: number): { value: number; unit: ProbeReading['unit']; display: string } {
  const abs = Math.abs(v);
  if (abs < 1e-6) return { value: v * 1e6, unit: 'µV', display: `${(v * 1e6).toFixed(2)} µV` };
  if (abs < 1) return { value: v * 1e3, unit: 'mV', display: `${(v * 1e3).toFixed(2)} mV` };
  return { value: v, unit: 'V', display: `${v.toFixed(3)} V` };
}

function formatI(i: number): { value: number; unit: ProbeReading['unit']; display: string } {
  const abs = Math.abs(i);
  if (abs < 1e-9) return { value: 0, unit: 'nA', display: `0 nA` };
  if (abs < 1e-6) return { value: i * 1e9, unit: 'nA', display: `${(i * 1e9).toFixed(1)} nA` };
  if (abs < 1e-3) return { value: i * 1e6, unit: 'µA', display: `${(i * 1e6).toFixed(2)} µA` };
  if (abs < 1) return { value: i * 1e3, unit: 'mA', display: `${(i * 1e3).toFixed(2)} mA` };
  return { value: i, unit: 'A', display: `${i.toFixed(3)} A` };
}

/**
 * Build a pin → net lookup identical to what NetlistBuilder uses. Used by
 * probe readings so we can map `voltmeter:Vin` / `voltmeter:Vout` etc. to
 * actual net names in the solve result.
 */
export function buildPinNetLookup(
  wires: Wire[],
  groundPins: Array<{ componentId: string; pinName: string }>,
  vccPins: Array<{ componentId: string; pinName: string }>,
): (componentId: string, pinName: string) => string | null {
  const uf = new UnionFind();
  for (const w of wires) {
    const a = `${w.start.componentId}:${w.start.pinName}`;
    const b = `${w.end.componentId}:${w.end.pinName}`;
    uf.union(a, b);
  }
  for (const g of groundPins) uf.setCanonical(`${g.componentId}:${g.pinName}`, '0');
  for (const v of vccPins) uf.setCanonical(`${v.componentId}:${v.pinName}`, 'vcc_rail');
  // Build deterministic net names matching NetlistBuilder's scheme (n0, n1, …)
  const reps = [...uf.nets()].sort();
  const netNames = new Map<string, string>();
  let counter = 0;
  for (const rep of reps) {
    if (rep === '0' || rep === 'vcc_rail') netNames.set(rep, rep);
    else netNames.set(rep, `n${counter++}`);
  }
  return (componentId, pinName) => {
    const key = `${componentId}:${pinName}`;
    if (!uf.has(key)) return null;
    return netNames.get(uf.find(key)) ?? null;
  };
}

export function readVoltmeter(
  comp: ComponentForSpice,
  netLookup: (componentId: string, pinName: string) => string | null,
  solve: ElectricalSolveResult,
): ProbeReading {
  const plusNet = netLookup(comp.id, 'V+');
  const minusNet = netLookup(comp.id, 'V-');
  if (!plusNet || !minusNet) {
    return { kind: 'voltmeter', value: 0, unit: '—', display: '— probe not connected', stale: true };
  }
  const vp = solve.nodeVoltages[plusNet] ?? 0;
  const vm = solve.nodeVoltages[minusNet] ?? 0;
  const diff = vp - vm;
  const fmt = formatV(diff);
  return { kind: 'voltmeter', value: fmt.value, unit: fmt.unit, display: fmt.display, stale: !solve.converged };
}

export function readAmmeter(
  comp: ComponentForSpice,
  solve: ElectricalSolveResult,
): ProbeReading {
  const key = `v_${comp.id}_sense`;
  const i = solve.branchCurrents[key];
  if (i == null) {
    return { kind: 'ammeter', value: 0, unit: '—', display: '— no sense reading', stale: true };
  }
  // Convention: ngspice reports positive current flowing from + terminal into
  // the source (which is our "entry" terminal). Ammeters typically want the
  // current through, with a sign convention of + out of the "+" probe.
  const signed = -i;
  const fmt = formatI(signed);
  return { kind: 'ammeter', value: fmt.value, unit: fmt.unit, display: fmt.display, stale: !solve.converged };
}
