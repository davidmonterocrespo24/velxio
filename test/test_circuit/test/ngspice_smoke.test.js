import { describe, it, expect } from 'vitest';
import { Simulation } from 'eecircuit-engine';

/**
 * Smoke test: bring up ngspice-WASM and run one DC analysis.
 *
 * Netlist is the classic voltage divider: 9V across 1k + 2k.
 * Expected: V(out) = 6.000 V
 */
describe('ngspice-WASM — smoke test', () => {
  it('runs a voltage-divider DC op-point', { timeout: 60_000 }, async () => {
    const sim = new Simulation();
    await sim.start();

    const netlist = `Voltage divider
V1 vcc 0 DC 9
R1 vcc out 1k
R2 out 0 2k
.op
.end`;

    sim.setNetList(netlist);
    const result = await sim.runSim();
    expect(result).toBeDefined();
    expect(result.variableNames.length).toBeGreaterThan(0);
    console.log('variables:', result.variableNames);
    console.log('numPoints:', result.numPoints);
    console.log('dataType:', result.dataType);

    // Find the voltage on node 'out'
    const outIdx = result.variableNames.findIndex(n => /v\(out\)/i.test(n) || n.toLowerCase() === 'v(out)');
    expect(outIdx).toBeGreaterThanOrEqual(0);
    const outVoltage = result.data[outIdx].values[0];
    console.log('V(out) =', outVoltage);
    expect(outVoltage).toBeCloseTo(6.0, 2);
  });
});
