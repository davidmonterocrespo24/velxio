import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Sanity check for the 3- and 4-input gate mappers (fase 9.5).
 * Verifies the exact behavioural expressions componentToSpice.ts emits
 * for AND/OR/NAND/NOR with 3 and 4 inputs.
 */

const VCC = 5;
const T = VCC / 2;

function buildCard(variant, inputs) {
  const U = inputs.map(n => `u(V(${n})-${T})`);
  const NU = inputs.map(n => `(1-u(V(${n})-${T}))`);
  switch (variant) {
    case 'and':  return `${VCC} * ${U.join(' * ')}`;
    case 'or':   return `${VCC} * (1 - ${NU.join(' * ')})`;
    case 'nand': return `${VCC} * (1 - ${U.join(' * ')})`;
    case 'nor':  return `${VCC} * ${NU.join(' * ')}`;
    default: throw new Error(`unknown ${variant}`);
  }
}

async function evalGate(variant, values) {
  const inputs = Object.keys(values);
  const sources = inputs.map(n => `V${n} ${n} 0 DC ${values[n]}`).join('\n');
  const expr = buildCard(variant, inputs);
  const netlist = `gate ${variant} ${inputs.length}-in
${sources}
B_g y 0 V = ${expr}
R_g_load y 0 1Meg
.op
.end`;
  const { dcValue } = await runNetlist(netlist);
  return dcValue('v(y)');
}

function hi(n) { return Array.from({ length: n }, () => 5); }
function lo(n) { return Array.from({ length: n }, () => 0); }
function mixed(n, highIdx) {
  return Array.from({ length: n }, (_, i) => (i === highIdx ? 5 : 0));
}
function named(values) {
  return Object.fromEntries(values.map((v, i) => [String.fromCharCode(65 + i), v]));
}

describe('componentToSpice — 3-input gates', () => {
  it('AND-3 truth table (all HIGH → 5, any LOW → 0)', { timeout: 60_000 }, async () => {
    expect(await evalGate('and', named(hi(3)))).toBeCloseTo(5, 0);
    expect(await evalGate('and', named(mixed(3, 0)))).toBeCloseTo(0, 0);
    expect(await evalGate('and', named(lo(3)))).toBeCloseTo(0, 0);
  });

  it('OR-3 truth table (any HIGH → 5, all LOW → 0)', { timeout: 60_000 }, async () => {
    expect(await evalGate('or', named(lo(3)))).toBeCloseTo(0, 0);
    expect(await evalGate('or', named(mixed(3, 2)))).toBeCloseTo(5, 0);
    expect(await evalGate('or', named(hi(3)))).toBeCloseTo(5, 0);
  });

  it('NAND-3 is complement of AND-3', { timeout: 60_000 }, async () => {
    expect(await evalGate('nand', named(hi(3)))).toBeCloseTo(0, 0);
    expect(await evalGate('nand', named(mixed(3, 0)))).toBeCloseTo(5, 0);
  });

  it('NOR-3 is complement of OR-3', { timeout: 60_000 }, async () => {
    expect(await evalGate('nor', named(lo(3)))).toBeCloseTo(5, 0);
    expect(await evalGate('nor', named(mixed(3, 2)))).toBeCloseTo(0, 0);
  });
});

describe('componentToSpice — 4-input gates', () => {
  it('AND-4 only HIGH when all 4 inputs are HIGH', { timeout: 60_000 }, async () => {
    expect(await evalGate('and', named(hi(4)))).toBeCloseTo(5, 0);
    expect(await evalGate('and', named(mixed(4, 3)))).toBeCloseTo(0, 0);
  });

  it('OR-4 HIGH when any input is HIGH (even the last one)', { timeout: 60_000 }, async () => {
    expect(await evalGate('or', named(lo(4)))).toBeCloseTo(0, 0);
    expect(await evalGate('or', named(mixed(4, 3)))).toBeCloseTo(5, 0);
  });

  it('NAND-4 HIGH unless all 4 inputs are HIGH', { timeout: 60_000 }, async () => {
    expect(await evalGate('nand', named(hi(4)))).toBeCloseTo(0, 0);
    expect(await evalGate('nand', named(mixed(4, 2)))).toBeCloseTo(5, 0);
  });

  it('NOR-4 LOW whenever any input is HIGH', { timeout: 60_000 }, async () => {
    expect(await evalGate('nor', named(lo(4)))).toBeCloseTo(5, 0);
    expect(await evalGate('nor', named(mixed(4, 0)))).toBeCloseTo(0, 0);
  });
});
