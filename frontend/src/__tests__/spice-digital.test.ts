import { describe, it, expect } from 'vitest';
import { runNetlist } from '../simulation/spice/SpiceEngine';

/**
 * Behavioral logic gates via ngspice B-sources + `u()` step function.
 * Validates that digital logic and analog can live in the same netlist.
 */

describe('ngspice — digital gates via B-sources', () => {
  it('AND truth table', { timeout: 30_000 }, async () => {
    const rows = [
      { a: 0, b: 0, y: 0 },
      { a: 0, b: 5, y: 0 },
      { a: 5, b: 0, y: 0 },
      { a: 5, b: 5, y: 5 },
    ];
    for (const r of rows) {
      const { dcValue } = await runNetlist(`AND
Va a 0 DC ${r.a}
Vb b 0 DC ${r.b}
Band y 0 V = 5 * u(V(a)-2.5) * u(V(b)-2.5)
Rload y 0 1k
.op
.end`);
      expect(dcValue('v(y)')).toBeCloseTo(r.y, 0);
    }
  });

  it('NAND truth table', { timeout: 30_000 }, async () => {
    const rows = [
      { a: 0, b: 0, y: 5 },
      { a: 0, b: 5, y: 5 },
      { a: 5, b: 0, y: 5 },
      { a: 5, b: 5, y: 0 },
    ];
    for (const r of rows) {
      const { dcValue } = await runNetlist(`NAND
Va a 0 DC ${r.a}
Vb b 0 DC ${r.b}
Bnand y 0 V = 5 * (1 - u(V(a)-2.5) * u(V(b)-2.5))
Rload y 0 1k
.op
.end`);
      expect(dcValue('v(y)')).toBeCloseTo(r.y, 0);
    }
  });

  it('XOR truth table', { timeout: 30_000 }, async () => {
    const rows = [
      { a: 0, b: 0, y: 0 },
      { a: 0, b: 5, y: 5 },
      { a: 5, b: 0, y: 5 },
      { a: 5, b: 5, y: 0 },
    ];
    for (const r of rows) {
      const { dcValue } = await runNetlist(`XOR
Va a 0 DC ${r.a}
Vb b 0 DC ${r.b}
Bxor y 0 V = 5 * (u(V(a)-2.5) + u(V(b)-2.5) - 2*u(V(a)-2.5)*u(V(b)-2.5))
Rload y 0 1k
.op
.end`);
      expect(dcValue('v(y)')).toBeCloseTo(r.y, 0);
    }
  });

  it('AND drives RC low-pass: filter smooths the square wave', { timeout: 30_000 }, async () => {
    const netlist = `AND -> RC
Va a 0 PULSE(0 5 0 1n 1n 1m 2m)
Vb b 0 PULSE(0 5 0 1n 1n 0.75m 1.5m)
Band y 0 V = 5 * u(V(a)-2.5) * u(V(b)-2.5)
R1 y filt 10k
C1 filt 0 1u IC=0
.tran 10u 20m
.end`;
    const { vec } = await runNetlist(netlist);
    const filt = vec('v(filt)') as number[];
    const y = vec('v(y)') as number[];
    const last = filt.slice(-50);
    const mean = last.reduce((s, v) => s + v, 0) / last.length;
    const filtMin = Math.min(...last);
    const filtMax = Math.max(...last);
    expect(filtMax - filtMin).toBeLessThan(1.5);
    expect(Math.min(...y)).toBeLessThan(0.5);
    expect(Math.max(...y)).toBeGreaterThan(4.5);
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan(5);
  });
});
