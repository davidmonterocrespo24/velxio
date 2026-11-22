/**
 * A transient ngspice abandons is reported on the Node path too
 * (velxio/velxio-prod#145).
 *
 * When ngspice cannot find the next time step it stops ("Timestep too
 * small"), returns success, and leaves the samples it has. The browser's
 * worker captures ngspice's stderr, and the circuit service compares the
 * last sample with the stop time (transientShortfall, #144). The Node
 * adapter, which the tests, the scripts and the circuit check run in Node
 * use, called ngSpice_Init with no output callback, so ngspice said nothing
 * to it; and runNetlist, the one-shot solve the circuit check uses, never
 * compared the time axis with the stop time. A latch of two ideal-step
 * NANDs whose inputs rise together stopped at 0.5 ns of 80 ms with
 * `warnings: []` on both.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { NgSpiceNodeAdapter } from '../simulation/spice/adapters/NgSpiceNodeAdapter';
import { runNetlist } from '../simulation/spice/runNetlist';
import { TRANSIENT_SHORTFALL_PREFIX } from '../simulation/spice/transientShortfall';

/** Two NANDs with ideal (step) edges, cross-coupled, both inputs rising at once. */
const RACE = [
  '* latch with ideal steps',
  'V_s s 0 PULSE(0 5 0 1n 1n 0.01 0.02)',
  'V_r r 0 PULSE(0 5 0 1n 1n 0.01 0.02)',
  'B_q q 0 V = 5*(1 - u(V(s)-2.5)*u(V(qb)-2.5))',
  'R_q q 0 1Meg',
  'B_qb qb 0 V = 5*(1 - u(V(r)-2.5)*u(V(q)-2.5))',
  'R_qb qb 0 1Meg',
  '.tran 1e-3 8e-2',
  '.end',
].join('\n');

const RC = ['* rc', 'V1 a 0 SIN(0 1 50)', 'R1 a b 1k', 'C1 b 0 1u', '.tran 1e-3 8e-2', '.end'].join('\n');
const DIVIDER = ['* divider', 'V1 a 0 DC 5', 'R1 a b 1k', 'R2 b 0 1k', '.op', '.end'].join('\n');

const adapter = new NgSpiceNodeAdapter();
afterAll(() => adapter.dispose());

describe('the Node adapter hears ngspice (#145)', () => {
  it('returns ngspice\'s own words when a transient is abandoned', { timeout: 60_000 }, async () => {
    await adapter.loadCircuit(RACE);
    const r = await adapter.solve({ kind: 'tran', step: '1e-3', stop: '8e-2' }, { vectorsOfInterest: [] });
    expect(r.timeAxis.length).toBeGreaterThan(0);
    expect(r.timeAxis[r.timeAxis.length - 1]).toBeLessThan(1e-6);
    expect(r.warnings.join('\n')).toMatch(/timestep too small/i);
  });

  it('keeps ngspice\'s progress chatter out of the warnings', { timeout: 60_000 }, async () => {
    await adapter.loadCircuit(RC);
    const tran = await adapter.solve({ kind: 'tran', step: '1e-3', stop: '8e-2' }, { vectorsOfInterest: [] });
    expect(tran.warnings).toEqual([]);
    await adapter.loadCircuit(DIVIDER);
    const op = await adapter.solve({ kind: 'op' }, { vectorsOfInterest: [] });
    expect(op.warnings).toEqual([]);
  });
});

describe('runNetlist says where a transient stopped (#145)', () => {
  it('adds the shortfall to the warnings', { timeout: 60_000 }, async () => {
    const r = await runNetlist(RACE);
    const shortfall = r.warnings.find((w) => w.startsWith(TRANSIENT_SHORTFALL_PREFIX));
    expect(shortfall).toBeDefined();
    expect(shortfall).toContain('of 80.00 ms');
  });

  it('adds nothing to a run that completes', { timeout: 60_000 }, async () => {
    expect((await runNetlist(RC)).warnings).toEqual([]);
    expect((await runNetlist(DIVIDER)).warnings).toEqual([]);
  });
});
