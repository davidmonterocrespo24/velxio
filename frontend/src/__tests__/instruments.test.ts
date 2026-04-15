/**
 * Voltmeter and Ammeter instrument tests.
 *
 *   Voltmeter reads v(+) − v(−) across a pair of probe terminals.
 *   Ammeter reports current through an inline 0 V sense source.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from '../simulation/spice/SpiceEngine';

describe('Voltmeter (instr-voltmeter)', () => {
  it('reads ~3.33V across the midpoint of a 1k+2k divider', { timeout: 30_000 }, async () => {
    const netlist = buildNetlist({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '1k' } },
        { id: 'r2', metadataId: 'resistor', properties: { value: '2k' } },
        { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
      ],
      wires: [
        { id: 'w1', start: { componentId: 'uno', pinName: '5V' }, end: { componentId: 'r1', pinName: '1' } },
        { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'r2', pinName: '1' } },
        { id: 'w3', start: { componentId: 'r2', pinName: '2' }, end: { componentId: 'uno', pinName: 'GND' } },
        { id: 'w4', start: { componentId: 'vm', pinName: 'V+' }, end: { componentId: 'r1', pinName: '2' } },
        { id: 'w5', start: { componentId: 'vm', pinName: 'V-' }, end: { componentId: 'uno', pinName: 'GND' } },
      ],
      boards: [{ id: 'uno', vcc: 5, pins: {}, groundPinNames: ['GND'], vccPinNames: ['5V'] }],
      analysis: { kind: 'op' },
    });

    expect(netlist).toMatch(/R_vm_vmR/);
    const result = await runNetlist(netlist);
    // Find any voltage variable whose value is ≈ 3.33 V (the midpoint)
    const expected = (5 * 2) / 3;
    let found = false;
    for (const name of result.variableNames) {
      if (!name.startsWith('v(')) continue;
      const v = result.dcValue(name);
      if (Math.abs(v - expected) < 0.05) {
        found = true;
        break;
      }
    }
    expect(found, `No net with V≈3.33V. Vars: ${result.variableNames.join(',')}`).toBe(true);
  });
});

describe('Ammeter (instr-ammeter)', () => {
  it('reads ~22.7 mA through a 220 Ω load on 5V', { timeout: 30_000 }, async () => {
    // Circuit:
    //   +5V ── R (220Ω) ── [A+ ammeter A-] ── GND
    const netlist = buildNetlist({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'am', metadataId: 'instr-ammeter', properties: {} },
      ],
      wires: [
        { id: 'w1', start: { componentId: 'uno', pinName: '5V' }, end: { componentId: 'r1', pinName: '1' } },
        { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'am', pinName: 'A+' } },
        { id: 'w3', start: { componentId: 'am', pinName: 'A-' }, end: { componentId: 'uno', pinName: 'GND' } },
      ],
      boards: [{ id: 'uno', vcc: 5, pins: {}, groundPinNames: ['GND'], vccPinNames: ['5V'] }],
      analysis: { kind: 'op' },
    });

    expect(netlist).toMatch(/V_am_sense/);
    const result = await runNetlist(netlist);
    // i(V_am_sense) — ngspice names the branch current for V-source "v_am_sense"
    const idx = result.findVar('i(v_am_sense)');
    expect(idx).toBeGreaterThanOrEqual(0);
    const i = result.dcValue('i(v_am_sense)');
    // Convention: positive current enters the + terminal, flows into the source
    expect(Math.abs(i)).toBeCloseTo(5 / 220, 3);
  });
});
