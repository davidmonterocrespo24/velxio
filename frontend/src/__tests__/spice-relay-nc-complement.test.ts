/**
 * A relay's NC contact is the complement of its NO contact
 * (velxio/velxio-prod#169).
 *
 * In a changeover relay one armature moves COM between NC and NO, so for any
 * steady coil voltage exactly one of them is closed (relay.md: NC is "joined
 * to COM while the coil is idle"). The model gave NC its own switch, driven by
 * Vnom - V(coil) through the same RELAY_SW: it opened at 55 % of the nominal
 * coil voltage and reclosed at 25 %, while NO closes at 75 % and opens at
 * 45 %. On a 0 -> 5 -> 0 V ramp both contacts were open from 2.75 to 3.75 V
 * rising and from 2.25 to 1.25 V falling; in an operating point with no
 * history NC was open anywhere from 25 % up. The book's appendix F, problem
 * 8.11: a 12 V relay fed 5 V (4.77 V on the coil) cannot pull in, so its NC
 * load should stay lit; Velxio switched it off.
 *
 * NC is now the same switch as NO with the conductances swapped: one control,
 * one hysteresis state, so NC = !NO in .op and in .tran.
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from './helpers/testSolver';
import type { BuildNetlistInput } from '../simulation/spice/types';

const PINS: Record<string, Record<string, string>> = {
  relay: { 'COIL+': 'cp', 'COIL-': '0', COM: 'vs', NO: 'no', NC: 'nc' },
  'ks2e-m-dc5': { COIL1: 'cp', COIL2: '0', P1: 'vs', NO1: 'no', NC1: 'nc' },
};

/** The relay's cards with its coil on `drive` (a source card on node cp), COM
 *  on 5 V, and 1 k from each of NO and NC to ground. */
function deck(metadataId: string, properties: Record<string, unknown>, drive: string, analysis: string): string {
  const em = componentToSpice({ id: 'k1', metadataId, properties }, (pin) => PINS[metadataId]![pin] ?? null, {
    vcc: 5,
  });
  if (!em) throw new Error(`no emission for ${metadataId}`);
  return [
    `* ${metadataId} contacts`,
    ...em.cards,
    ...em.modelsUsed,
    'V_s vs 0 DC 5',
    'R_no no 0 1k',
    'R_nc nc 0 1k',
    drive,
    analysis,
    '.end',
  ].join('\n');
}

async function contactsAt(metadataId: string, coilVolts: number, properties: Record<string, unknown> = {}) {
  const r = await runNetlist(deck(metadataId, properties, `V_c cp 0 DC ${coilVolts}`, '.op'));
  return { no: r.dcValue('v(no)') > 2.5, nc: r.dcValue('v(nc)') > 2.5 };
}

describe('relay NC is the complement of NO in an operating point (velxio/velxio-prod#169)', () => {
  it.each([0, 1, 2, 3, 3.3, 3.7])('5 V coil at %s V: NC closed, NO open', { timeout: 60_000 }, async (v) => {
    expect(await contactsAt('relay', v, { coil_voltage: 5 })).toEqual({ no: false, nc: true });
  });

  it.each([3.8, 4.5, 5])('5 V coil at %s V: NO closed, NC open', { timeout: 60_000 }, async (v) => {
    expect(await contactsAt('relay', v, { coil_voltage: 5 })).toEqual({ no: true, nc: false });
  });

  it('12 V coil fed 4.77 V cannot pull in, so its NC load stays on (book appendix F, 8.11)', {
    timeout: 60_000,
  }, async () => {
    expect(await contactsAt('relay', 4.772, { coil_voltage: 12 })).toEqual({ no: false, nc: true });
  });

  it('the KS2E-M-DC5 at 3.3 V: NC closed, NO open', { timeout: 60_000 }, async () => {
    expect(await contactsAt('ks2e-m-dc5', 3.3)).toEqual({ no: false, nc: true });
    expect(await contactsAt('ks2e-m-dc5', 2.0)).toEqual({ no: false, nc: true });
  });
});

describe('relay NC follows NO through a coil ramp (velxio/velxio-prod#169)', () => {
  it.each([
    ['relay', { coil_voltage: 5, include_flyback: false }],
    ['relay', { coil_voltage: 12, include_flyback: false }],
    ['ks2e-m-dc5', {}],
  ] as const)('%s %j: exactly one contact closed at every sample of 0 -> Vnom -> 0', { timeout: 60_000 }, async (id, props) => {
    const vnom = (props as { coil_voltage?: number }).coil_voltage ?? 5;
    const r = await runNetlist(
      deck(id, props, `V_c cp 0 PWL(0 0 10m ${vnom} 20m 0)`, '.tran 10u 20m'),
    );
    const no = r.vec('v(no)') as number[];
    const nc = r.vec('v(nc)') as number[];
    const both: number[] = [];
    for (let i = 0; i < no.length; i++) {
      if ((no[i]! > 2.5) === (nc[i]! > 2.5)) both.push(i);
    }
    expect(both, `${both.length} samples with both contacts open or both closed`).toEqual([]);
  });
});

describe('two relays with different coils keep their own thresholds', () => {
  // Each relay's switch model carries its coil voltage. Under one shared name
  // the first .model line won for both, so a 12 V relay next to a 5 V one
  // closed at 5 V (5 V relay first) or the 5 V one never closed (12 V first).
  function pair(order: 'five-first' | 'twelve-first'): BuildNetlistInput {
    const k5 = { id: 'k5', metadataId: 'relay', properties: { coil_voltage: 5 } };
    const k12 = { id: 'k12', metadataId: 'relay', properties: { coil_voltage: 12 } };
    const w = (id: string, a: [string, string], b: [string, string]) => ({
      id,
      start: { componentId: a[0], pinName: a[1] },
      end: { componentId: b[0], pinName: b[1] },
    });
    return {
      components: [
        ...(order === 'five-first' ? [k5, k12] : [k12, k5]),
        { id: 'r5', metadataId: 'resistor', properties: { value: '1000' } },
        { id: 'r12', metadataId: 'resistor', properties: { value: '1000' } },
      ],
      wires: [
        w('w1', ['uno', '5V'], ['k5', 'COIL+']),
        w('w2', ['k5', 'COIL-'], ['uno', 'GND']),
        w('w3', ['uno', '5V'], ['k12', 'COIL+']),
        w('w4', ['k12', 'COIL-'], ['uno', 'GND']),
        w('w5', ['uno', '5V'], ['k5', 'COM']),
        w('w6', ['k5', 'NO'], ['r5', '1']),
        w('w7', ['r5', '2'], ['uno', 'GND']),
        w('w8', ['uno', '5V'], ['k12', 'COM']),
        w('w9', ['k12', 'NO'], ['r12', '1']),
        w('w10', ['r12', '2'], ['uno', 'GND']),
      ],
      boards: [{ id: 'uno', vcc: 5, pins: {}, groundPinNames: ['GND'], vccPinNames: ['5V'] }],
      analysis: { kind: 'op' },
    };
  }

  it.each(['five-first', 'twelve-first'] as const)('%s: on 5 V the 5 V relay closes and the 12 V one does not', {
    timeout: 60_000,
  }, async (order) => {
    const { netlist, pinNetMap } = buildNetlist(pair(order));
    const r = await runNetlist(netlist);
    expect(r.dcValue(`v(${pinNetMap.get('r5:1')})`)).toBeGreaterThan(4.9);
    expect(r.dcValue(`v(${pinNetMap.get('r12:1')})`)).toBeLessThan(0.01);
  });
});
