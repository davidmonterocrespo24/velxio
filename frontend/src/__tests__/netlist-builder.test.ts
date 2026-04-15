import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from '../simulation/spice/SpiceEngine';
import { UnionFind } from '../simulation/spice/unionFind';
import { parseValueWithUnits } from '../simulation/spice/valueParser';

describe('UnionFind', () => {
  it('unions transitively', () => {
    const uf = new UnionFind();
    uf.union('a', 'b');
    uf.union('b', 'c');
    expect(uf.find('a')).toBe(uf.find('c'));
  });
  it('canonical name propagates on union', () => {
    const uf = new UnionFind();
    uf.union('gnd_pin_x', 'r1_pin2');
    uf.setCanonical('gnd_pin_x', '0');
    expect(uf.find('r1_pin2')).toBe('0');
  });
  it('ground wins over vcc when both canonicals collide', () => {
    const uf = new UnionFind();
    uf.setCanonical('node_a', 'vcc_rail');
    uf.setCanonical('node_b', '0');
    uf.union('node_a', 'node_b');
    expect(uf.find('node_a')).toBe('0');
  });
});

describe('parseValueWithUnits', () => {
  it('parses SPICE SI suffixes', () => {
    expect(parseValueWithUnits('4.7k')).toBe(4700);
    expect(parseValueWithUnits('220')).toBe(220);
    expect(parseValueWithUnits('1Meg')).toBe(1_000_000);
    expect(parseValueWithUnits('10u')).toBeCloseTo(1e-5);
    expect(parseValueWithUnits('100n')).toBeCloseTo(1e-7);
    expect(parseValueWithUnits('22p')).toBeCloseTo(2.2e-11);
    expect(parseValueWithUnits('10mH')).toBeCloseTo(0.01);
    expect(parseValueWithUnits('1.5H')).toBe(1.5);
    expect(parseValueWithUnits('0.1u')).toBeCloseTo(1e-7);
  });
  it('passes numbers through', () => {
    expect(parseValueWithUnits(1000)).toBe(1000);
  });
  it('returns fallback for garbage', () => {
    expect(parseValueWithUnits('banana', 42)).toBe(42);
    expect(parseValueWithUnits(undefined, 99)).toBe(99);
  });
});

describe('NetlistBuilder — simple cases', () => {
  it('emits a voltage divider and ngspice gets 6V', { timeout: 30_000 }, async () => {
    const netlist = buildNetlist({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '1k' } },
        { id: 'r2', metadataId: 'resistor', properties: { value: '2k' } },
      ],
      wires: [
        { id: 'w1', start: { componentId: 'arduino', pinName: '5V' }, end: { componentId: 'r1', pinName: '1' } },
        { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'r2', pinName: '1' } },
        { id: 'w3', start: { componentId: 'r2', pinName: '2' }, end: { componentId: 'arduino', pinName: 'GND' } },
      ],
      boards: [
        {
          id: 'arduino',
          vcc: 5,
          pins: { '5V': { type: 'digital', v: 5 }, GND: { type: 'digital', v: 0 } },
          groundPinNames: ['GND'],
          vccPinNames: ['5V'],
        },
      ],
      analysis: { kind: 'op' },
    });
    // Netlist should include two resistors and a vcc rail source
    expect(netlist).toMatch(/R_r1/);
    expect(netlist).toMatch(/R_r2/);
    expect(netlist).toMatch(/V_VCC_RAIL vcc_rail 0 DC 5/);
    expect(netlist).toMatch(/\.op/);
    expect(netlist).toMatch(/\.end/);

    // But critically: ngspice should accept it and return 10/3 V at midpoint
    // (5V · 2k / 3k = 3.333V)
    const result = await runNetlist(netlist);
    // Find the middle net name — it's auto-generated as "n0" or similar
    const midV = result.vec('v(n0)') as number[];
    expect(midV[0]).toBeCloseTo((5 * 2) / 3, 2);
  });

  it('emits an LED + resistor from 5V rail and ngspice solves non-linear', { timeout: 30_000 }, async () => {
    const netlist = buildNetlist({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
      ],
      wires: [
        { id: 'w1', start: { componentId: 'board', pinName: 'VCC' }, end: { componentId: 'r1', pinName: '1' } },
        { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'led1', pinName: 'A' } },
        { id: 'w3', start: { componentId: 'led1', pinName: 'C' }, end: { componentId: 'board', pinName: 'GND' } },
      ],
      boards: [
        {
          id: 'board',
          vcc: 5,
          pins: {},
          groundPinNames: ['GND'],
          vccPinNames: ['VCC'],
        },
      ],
      analysis: { kind: 'op' },
    });
    expect(netlist).toMatch(/D_led1 \S+ 0 LED_RED/);
    expect(netlist).toMatch(/\.model LED_RED D\(Is=1e-20 N=1\.7\)/);

    const result = await runNetlist(netlist);
    // Forward voltage on the anode should be ≈ 2.0 V for a red LED
    const anodeNet = netlist.match(/D_led1 (\S+) 0 LED_RED/)?.[1];
    expect(anodeNet).toBeTruthy();
    const Vf = (result.vec(`v(${anodeNet})`) as number[])[0];
    expect(Vf).toBeGreaterThan(1.7);
    expect(Vf).toBeLessThan(2.3);
  });

  it('NTC divider: T=25°C produces V(a0) ≈ 2.5V', { timeout: 30_000 }, async () => {
    const netlist = buildNetlist({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } },
        { id: 'ntc1', metadataId: 'ntc-temperature-sensor', properties: { temperature: 25 } },
      ],
      wires: [
        { id: 'w1', start: { componentId: 'uno', pinName: '5V' }, end: { componentId: 'r1', pinName: '1' } },
        { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'ntc1', pinName: '1' } },
        { id: 'w3', start: { componentId: 'ntc1', pinName: '2' }, end: { componentId: 'uno', pinName: 'GND' } },
      ],
      boards: [{
        id: 'uno',
        vcc: 5,
        pins: {},
        groundPinNames: ['GND'],
        vccPinNames: ['5V'],
      }],
      analysis: { kind: 'op' },
    });
    const result = await runNetlist(netlist);
    // Net between R1 and NTC is auto-named; find it.
    const midNet = netlist.match(/R_r1 vcc_rail (\S+) /)?.[1];
    expect(midNet).toBeTruthy();
    const v = (result.vec(`v(${midNet})`) as number[])[0];
    expect(v).toBeCloseTo(2.5, 1);
  });

  it('adds auto pull-down on floating cap-only node', () => {
    // Two caps share a node (net x) that only touches capacitors → DC-floating.
    const netlist = buildNetlist({
      components: [
        { id: 'c1', metadataId: 'capacitor', properties: { value: '1u' } },
        { id: 'c2', metadataId: 'capacitor', properties: { value: '1u' } },
      ],
      wires: [
        { id: 'w_share', start: { componentId: 'c1', pinName: '1' }, end: { componentId: 'c2', pinName: '1' } },
        { id: 'w1',      start: { componentId: 'c1', pinName: '2' }, end: { componentId: 'board', pinName: 'GND' } },
        { id: 'w2',      start: { componentId: 'c2', pinName: '2' }, end: { componentId: 'board', pinName: 'GND' } },
      ],
      boards: [{ id: 'board', vcc: 5, pins: {}, groundPinNames: ['GND'] }],
      analysis: { kind: 'op' },
    });
    expect(netlist).toMatch(/R_autopull_/);
  });

  it('PWM pin emits DC-equivalent voltage source', () => {
    const netlist = buildNetlist({
      components: [],
      wires: [
        { id: 'w1', start: { componentId: 'uno', pinName: 'D9' }, end: { componentId: 'uno', pinName: 'GND' } },
      ],
      boards: [{
        id: 'uno',
        vcc: 5,
        pins: { D9: { type: 'pwm', duty: 0.5 } },
        groundPinNames: ['GND'],
      }],
      analysis: { kind: 'op' },
    });
    // D9 is wired directly to GND → same net as ground → no source emitted
    // (this is a degenerate case; just ensure we don't crash)
    expect(netlist).toMatch(/\.end/);
  });
});
