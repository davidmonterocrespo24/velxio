/**
 * SpiceEngine smoke test — verifies eecircuit-engine boots in the Velxio
 * test environment and that the wrapper returns the expected result for a
 * trivial voltage divider.
 *
 * Mirrors test/test_circuit/test/ngspice_smoke.test.js.
 */
import { describe, it, expect } from 'vitest';
import { runNetlist } from '../simulation/spice/SpiceEngine';

describe('SpiceEngine — smoke test', () => {
  it('boots ngspice and solves a voltage divider (9V across 1k + 2k → 6V)', { timeout: 60_000 }, async () => {
    const netlist = `Voltage divider
V1 vcc 0 DC 9
R1 vcc out 1k
R2 out 0 2k
.op
.end`;

    const result = await runNetlist(netlist);
    expect(result.variableNames.length).toBeGreaterThan(0);
    expect(result.variableNames).toContain('v(vcc)');
    expect(result.variableNames).toContain('v(out)');
    expect(result.dcValue('v(out)')).toBeCloseTo(6, 3);
  });

  it('findVar resolves both "v(node)" and "node"', { timeout: 30_000 }, async () => {
    const result = await runNetlist(`Equal divider
V1 a 0 DC 5
R1 a b 1k
R2 b 0 1k
.op
.end`);
    expect(result.findVar('v(b)')).toBeGreaterThanOrEqual(0);
    expect(result.findVar('b')).toBeGreaterThanOrEqual(0);
    expect(result.findVar('b')).toBe(result.findVar('v(b)'));
  });
});
