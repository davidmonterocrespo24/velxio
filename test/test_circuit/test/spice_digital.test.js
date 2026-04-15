import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Digital logic via ngspice B-sources (behavioral voltage sources).
 * Uses the u() step function: u(x) = 1 if x>0, else 0.
 *
 *   AND:  5 * u(V(a)-2.5) * u(V(b)-2.5)
 *   OR:   5 * (1 - (1-u(V(a)-2.5)) * (1-u(V(b)-2.5)))
 *   NAND: 5 * (1 - u(V(a)-2.5) * u(V(b)-2.5))
 *   XOR:  5 * ((u(V(a)-2.5) + u(V(b)-2.5)) - 2*u(V(a)-2.5)*u(V(b)-2.5))
 *   NOT:  5 * (1 - u(V(a)-2.5))
 */

describe('ngspice — digital gates via B-sources (u-function)', () => {
  it('AND truth table', { timeout: 60_000 }, async () => {
    const rows = [
      { a: 0, b: 0, expected: 0 },
      { a: 0, b: 5, expected: 0 },
      { a: 5, b: 0, expected: 0 },
      { a: 5, b: 5, expected: 5 },
    ];
    for (const r of rows) {
      const netlist = `AND
Va a 0 DC ${r.a}
Vb b 0 DC ${r.b}
Band y 0 V = 5 * u(V(a)-2.5) * u(V(b)-2.5)
Rload y 0 1k
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      expect(dcValue('v(y)')).toBeCloseTo(r.expected, 0);
    }
  });

  it('NAND truth table', { timeout: 60_000 }, async () => {
    const rows = [
      { a: 0, b: 0, expected: 5 },
      { a: 0, b: 5, expected: 5 },
      { a: 5, b: 0, expected: 5 },
      { a: 5, b: 5, expected: 0 },
    ];
    for (const r of rows) {
      const netlist = `NAND
Va a 0 DC ${r.a}
Vb b 0 DC ${r.b}
Bnand y 0 V = 5 * (1 - u(V(a)-2.5) * u(V(b)-2.5))
Rload y 0 1k
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      expect(dcValue('v(y)')).toBeCloseTo(r.expected, 0);
    }
  });

  it('XOR truth table', { timeout: 60_000 }, async () => {
    const rows = [
      { a: 0, b: 0, expected: 0 },
      { a: 0, b: 5, expected: 5 },
      { a: 5, b: 0, expected: 5 },
      { a: 5, b: 5, expected: 0 },
    ];
    for (const r of rows) {
      const netlist = `XOR
Va a 0 DC ${r.a}
Vb b 0 DC ${r.b}
Bxor y 0 V = 5 * (u(V(a)-2.5) + u(V(b)-2.5) - 2*u(V(a)-2.5)*u(V(b)-2.5))
Rload y 0 1k
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      expect(dcValue('v(y)')).toBeCloseTo(r.expected, 0);
    }
  });
});

describe('ngspice — logic + analog mixed', () => {
  it('AND gate drives an RC low-pass: filter smooths the square wave', { timeout: 60_000 }, async () => {
    const netlist = `AND -> RC
Va a 0 PULSE(0 5 0 1n 1n 1m 2m)
Vb b 0 PULSE(0 5 0 1n 1n 0.75m 1.5m)
Band y 0 V = 5 * u(V(a)-2.5) * u(V(b)-2.5)
R1 y filt 10k
C1 filt 0 1u IC=0
.tran 10u 20m
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const filt = vec('v(filt)');
    const y = vec('v(y)');

    // After 5τ (50ms wait is overkill — actually 5·10kΩ·1µF = 50ms exactly,
    // but 20ms is enough to see settling happen).
    const last = filt.slice(-50);
    const mean = last.reduce((s, v) => s + v, 0) / last.length;

    // Filter ripple should be much smaller than 5 V swing (the raw AND gate output)
    const filtMin = Math.min(...last);
    const filtMax = Math.max(...last);
    const ripple = filtMax - filtMin;
    expect(ripple).toBeLessThan(1.5);

    // Over the whole run, the raw AND output must have toggled between 0 and 5
    const rawMin = Math.min(...y);
    const rawMax = Math.max(...y);
    expect(rawMin).toBeLessThan(0.5);
    expect(rawMax).toBeGreaterThan(4.5);

    // Mean of the filtered signal is strictly between 0 and 5 V
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan(5);
  });
});
