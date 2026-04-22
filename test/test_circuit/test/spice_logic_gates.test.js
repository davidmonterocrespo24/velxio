import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Full logic-gate suite via ngspice B-sources (behavioral voltage sources).
 *
 * Logic convention: VDD = 5 V, threshold at 2.5 V, u(x) = 1 if x > 0, else 0.
 *
 *   NOT:  5 * (1 - u(V(a)-2.5))
 *   AND:  5 * u(V(a)-2.5) * u(V(b)-2.5)
 *   OR:   5 * (1 - (1-u(V(a)-2.5)) * (1-u(V(b)-2.5)))
 *   NAND: 5 * (1 - u(V(a)-2.5) * u(V(b)-2.5))
 *   NOR:  5 * (1-u(V(a)-2.5)) * (1-u(V(b)-2.5))
 *   XOR:  5 * ((u(V(a)-2.5) + u(V(b)-2.5)) - 2*u(V(a)-2.5)*u(V(b)-2.5))
 *   XNOR: 5 * (1 - (u(V(a)-2.5) + u(V(b)-2.5) - 2*u(V(a)-2.5)*u(V(b)-2.5)))
 *
 * Gates are written as reusable subcircuits (".subckt") so complex circuits
 * (half adder, full adder, mux, latch) stay readable.
 */

const GATE_SUBCKTS = `
.subckt NOT_G a y
Bnot y 0 V = 5 * (1 - u(V(a)-2.5))
Rl y 0 1Meg
.ends
.subckt AND_G a b y
Band y 0 V = 5 * u(V(a)-2.5) * u(V(b)-2.5)
Rl y 0 1Meg
.ends
.subckt OR_G a b y
Bor y 0 V = 5 * (1 - (1-u(V(a)-2.5)) * (1-u(V(b)-2.5)))
Rl y 0 1Meg
.ends
.subckt NAND_G a b y
Bnand y 0 V = 5 * (1 - u(V(a)-2.5) * u(V(b)-2.5))
Rl y 0 1Meg
.ends
.subckt NOR_G a b y
Bnor y 0 V = 5 * (1-u(V(a)-2.5)) * (1-u(V(b)-2.5))
Rl y 0 1Meg
.ends
.subckt XOR_G a b y
Bxor y 0 V = 5 * (u(V(a)-2.5) + u(V(b)-2.5) - 2*u(V(a)-2.5)*u(V(b)-2.5))
Rl y 0 1Meg
.ends
.subckt XNOR_G a b y
Bxnor y 0 V = 5 * (1 - (u(V(a)-2.5) + u(V(b)-2.5) - 2*u(V(a)-2.5)*u(V(b)-2.5)))
Rl y 0 1Meg
.ends
`;

function twoInputTruthTable(gateName, rows) {
  return async () => {
    for (const r of rows) {
      const netlist = `${gateName} truth test
Va a 0 DC ${r.a}
Vb b 0 DC ${r.b}
X1 a b y ${gateName}_G
${GATE_SUBCKTS}
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      expect(dcValue('v(y)')).toBeCloseTo(r.expected, 0);
    }
  };
}

describe('ngspice — 7 basic logic gates (truth tables)', () => {
  it('NOT (inverter) truth table', { timeout: 60_000 }, async () => {
    for (const r of [{ a: 0, expected: 5 }, { a: 5, expected: 0 }]) {
      const netlist = `NOT truth test
Va a 0 DC ${r.a}
X1 a y NOT_G
${GATE_SUBCKTS}
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      expect(dcValue('v(y)')).toBeCloseTo(r.expected, 0);
    }
  });

  it('AND truth table', { timeout: 60_000 }, twoInputTruthTable('AND', [
    { a: 0, b: 0, expected: 0 },
    { a: 0, b: 5, expected: 0 },
    { a: 5, b: 0, expected: 0 },
    { a: 5, b: 5, expected: 5 },
  ]));

  it('OR truth table', { timeout: 60_000 }, twoInputTruthTable('OR', [
    { a: 0, b: 0, expected: 0 },
    { a: 0, b: 5, expected: 5 },
    { a: 5, b: 0, expected: 5 },
    { a: 5, b: 5, expected: 5 },
  ]));

  it('NAND truth table', { timeout: 60_000 }, twoInputTruthTable('NAND', [
    { a: 0, b: 0, expected: 5 },
    { a: 0, b: 5, expected: 5 },
    { a: 5, b: 0, expected: 5 },
    { a: 5, b: 5, expected: 0 },
  ]));

  it('NOR truth table', { timeout: 60_000 }, twoInputTruthTable('NOR', [
    { a: 0, b: 0, expected: 5 },
    { a: 0, b: 5, expected: 0 },
    { a: 5, b: 0, expected: 0 },
    { a: 5, b: 5, expected: 0 },
  ]));

  it('XOR truth table', { timeout: 60_000 }, twoInputTruthTable('XOR', [
    { a: 0, b: 0, expected: 0 },
    { a: 0, b: 5, expected: 5 },
    { a: 5, b: 0, expected: 5 },
    { a: 5, b: 5, expected: 0 },
  ]));

  it('XNOR truth table', { timeout: 60_000 }, twoInputTruthTable('XNOR', [
    { a: 0, b: 0, expected: 5 },
    { a: 0, b: 5, expected: 0 },
    { a: 5, b: 0, expected: 0 },
    { a: 5, b: 5, expected: 5 },
  ]));
});

describe('ngspice — combinational building blocks', () => {
  it('half adder: S = A XOR B, C = A AND B', { timeout: 60_000 }, async () => {
    const rows = [
      { a: 0, b: 0, sum: 0, carry: 0 },
      { a: 0, b: 5, sum: 5, carry: 0 },
      { a: 5, b: 0, sum: 5, carry: 0 },
      { a: 5, b: 5, sum: 0, carry: 5 },
    ];
    for (const r of rows) {
      const netlist = `Half adder A=${r.a} B=${r.b}
Va a 0 DC ${r.a}
Vb b 0 DC ${r.b}
X1 a b sumn XOR_G
X2 a b carryn AND_G
${GATE_SUBCKTS}
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      expect(dcValue('v(sumn)')).toBeCloseTo(r.sum, 0);
      expect(dcValue('v(carryn)')).toBeCloseTo(r.carry, 0);
    }
  });

  it('full adder: S = A XOR B XOR Cin, Cout = (A·B)+(Cin·(A XOR B))', { timeout: 90_000 }, async () => {
    const rows = [
      { a: 0, b: 0, cin: 0, sum: 0, cout: 0 },
      { a: 0, b: 0, cin: 5, sum: 5, cout: 0 },
      { a: 0, b: 5, cin: 0, sum: 5, cout: 0 },
      { a: 5, b: 5, cin: 0, sum: 0, cout: 5 },
      { a: 5, b: 5, cin: 5, sum: 5, cout: 5 },
      { a: 5, b: 0, cin: 5, sum: 0, cout: 5 },
    ];
    for (const r of rows) {
      const netlist = `Full adder A=${r.a} B=${r.b} Cin=${r.cin}
Va a 0 DC ${r.a}
Vb b 0 DC ${r.b}
Vcin cin 0 DC ${r.cin}
X1 a b ab_xor XOR_G
X2 ab_xor cin sumn XOR_G
X3 a b ab_and AND_G
X4 ab_xor cin cin_and AND_G
X5 ab_and cin_and coutn OR_G
${GATE_SUBCKTS}
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      expect(dcValue('v(sumn)')).toBeCloseTo(r.sum, 0);
      expect(dcValue('v(coutn)')).toBeCloseTo(r.cout, 0);
    }
  });

  it('2:1 multiplexer: Y = (A AND NOT S) OR (B AND S)', { timeout: 90_000 }, async () => {
    const rows = [
      { a: 0, b: 5, s: 0, y: 0 },
      { a: 0, b: 5, s: 5, y: 5 },
      { a: 5, b: 0, s: 0, y: 5 },
      { a: 5, b: 0, s: 5, y: 0 },
    ];
    for (const r of rows) {
      const netlist = `2:1 MUX sel=${r.s}
Va a 0 DC ${r.a}
Vb b 0 DC ${r.b}
Vs s 0 DC ${r.s}
X1 s sn NOT_G
X2 a sn a_masked AND_G
X3 b s b_masked AND_G
X4 a_masked b_masked yn OR_G
${GATE_SUBCKTS}
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      expect(dcValue('v(yn)')).toBeCloseTo(r.y, 0);
    }
  });

  it('2-to-4 decoder: Y[i] = 1 iff selector == i', { timeout: 90_000 }, async () => {
    const sels = [
      { a: 0, b: 0, winner: 'y0' },
      { a: 5, b: 0, winner: 'y1' },
      { a: 0, b: 5, winner: 'y2' },
      { a: 5, b: 5, winner: 'y3' },
    ];
    for (const s of sels) {
      const netlist = `2:4 decoder a=${s.a} b=${s.b}
Va a 0 DC ${s.a}
Vb b 0 DC ${s.b}
X1 a an NOT_G
X2 b bn NOT_G
X3 an bn y0 AND_G
X4 a bn y1 AND_G
X5 an b y2 AND_G
X6 a b y3 AND_G
${GATE_SUBCKTS}
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      for (const name of ['y0', 'y1', 'y2', 'y3']) {
        const v = dcValue(`v(${name})`);
        if (name === s.winner) expect(v).toBeCloseTo(5, 0);
        else expect(v).toBeCloseTo(0, 0);
      }
    }
  });
});

describe('ngspice — transient logic', () => {
  it('XOR-as-frequency-doubler: inverted+original produces 2× edges', { timeout: 60_000 }, async () => {
    // Classic frequency-doubler: Y = A XOR delayed(A).
    // We fake "delayed" by driving two phase-shifted pulses that overlap.
    const netlist = `Freq doubler
Va a 0 PULSE(0 5 0 1u 1u 0.5m 1m)
Vb b 0 PULSE(0 5 0.25m 1u 1u 0.5m 1m)
X1 a b y XOR_G
${GATE_SUBCKTS}
.tran 10u 5m
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const y = vec('v(y)');
    // Count rising edges in y
    let edges = 0;
    for (let i = 1; i < t.length; i++) {
      if (y[i - 1] < 2.5 && y[i] >= 2.5) edges++;
    }
    // In 5 ms with 1 ms base period, base freq = 1 kHz → doubled = 2 kHz → ~10 rising edges
    expect(edges).toBeGreaterThanOrEqual(6);
  });
});
