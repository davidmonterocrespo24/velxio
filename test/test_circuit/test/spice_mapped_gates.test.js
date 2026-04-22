import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Sanity check for the exact netlist cards emitted by
 * `frontend/src/simulation/spice/componentToSpice.ts` for the 7 logic gates
 * (fase 9.1). Each test builds the literal card string the mapper produces
 * and verifies ngspice returns the right truth-table value.
 *
 * If any of these fails, the corresponding mapper in componentToSpice.ts
 * must be fixed before users see broken behaviour in electrical mode.
 */

const VCC = 5;
const T = VCC / 2; // threshold = 2.5

function runGate(card, a, b = null) {
  const aCard = `Va a 0 DC ${a}`;
  const bCard = b != null ? `Vb b 0 DC ${b}` : '';
  const netlist = `Mapped gate
${aCard}
${bCard}
${card}
.op
.end`;
  return runNetlist(netlist);
}

describe('componentToSpice mappers — gate cards as emitted', () => {
  const cases = {
    and: {
      card: (id) =>
        `B_${id} y 0 V = ${VCC} * u(V(a)-${T}) * u(V(b)-${T})\nR_${id}_load y 0 1Meg`,
      table: [[0,0,0],[0,5,0],[5,0,0],[5,5,5]],
    },
    or: {
      card: (id) =>
        `B_${id} y 0 V = ${VCC} * (1 - (1-u(V(a)-${T})) * (1-u(V(b)-${T})))\nR_${id}_load y 0 1Meg`,
      table: [[0,0,0],[0,5,5],[5,0,5],[5,5,5]],
    },
    nand: {
      card: (id) =>
        `B_${id} y 0 V = ${VCC} * (1 - u(V(a)-${T}) * u(V(b)-${T}))\nR_${id}_load y 0 1Meg`,
      table: [[0,0,5],[0,5,5],[5,0,5],[5,5,0]],
    },
    nor: {
      card: (id) =>
        `B_${id} y 0 V = ${VCC} * (1-u(V(a)-${T})) * (1-u(V(b)-${T}))\nR_${id}_load y 0 1Meg`,
      table: [[0,0,5],[0,5,0],[5,0,0],[5,5,0]],
    },
    xor: {
      card: (id) =>
        `B_${id} y 0 V = ${VCC} * (u(V(a)-${T}) + u(V(b)-${T}) - 2*u(V(a)-${T})*u(V(b)-${T}))\nR_${id}_load y 0 1Meg`,
      table: [[0,0,0],[0,5,5],[5,0,5],[5,5,0]],
    },
    xnor: {
      card: (id) =>
        `B_${id} y 0 V = ${VCC} * (1 - (u(V(a)-${T}) + u(V(b)-${T}) - 2*u(V(a)-${T})*u(V(b)-${T})))\nR_${id}_load y 0 1Meg`,
      table: [[0,0,5],[0,5,0],[5,0,0],[5,5,5]],
    },
  };

  for (const [name, { card, table }] of Object.entries(cases)) {
    it(`2-input ${name.toUpperCase()} produces expected truth table`, { timeout: 60_000 }, async () => {
      for (const [a, b, y] of table) {
        const { dcValue } = await runGate(card(`g1`), a, b);
        expect(dcValue('v(y)'), `${name.toUpperCase()}(${a},${b})`).toBeCloseTo(y, 0);
      }
    });
  }

  it('1-input NOT produces expected truth table', { timeout: 60_000 }, async () => {
    const card = (id) =>
      `B_${id} y 0 V = ${VCC} * (1 - u(V(a)-${T}))\nR_${id}_load y 0 1Meg`;
    for (const [a, y] of [[0, 5], [5, 0]]) {
      const { dcValue } = await runGate(card('g1'), a);
      expect(dcValue('v(y)'), `NOT(${a})`).toBeCloseTo(y, 0);
    }
  });
});
