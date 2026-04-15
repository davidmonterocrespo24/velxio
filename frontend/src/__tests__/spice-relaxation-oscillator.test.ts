import { describe, it, expect } from 'vitest';
import { runNetlist } from '../simulation/spice/SpiceEngine';

/**
 * RC relaxation oscillator — the core idea of a 555 astable.
 * Uses a voltage-controlled switch with hysteresis (stateful) to toggle
 * the cap charge direction.
 */
describe('ngspice — RC relaxation oscillator (Schmitt-switch memory)', () => {
  it('produces a periodic waveform with expected frequency', { timeout: 30_000 }, async () => {
    const netlist = `Relaxation oscillator
Vcc vcc 0 DC 5
R1 vcc cap 10k
Ccap cap 0 10n IC=0
Sdis cap 0 cap 0 SMOD
.model SMOD SW(Vt=2.5 Vh=0.833 Ron=100 Roff=1G)
Sbuf out vcc cap 0 SOUT
.model SOUT SW(Vt=2.5 Vh=0.833 Ron=10 Roff=1G)
Rpd out 0 100k
.tran 0.5u 2m
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time') as number[];
    const out = vec('v(out)') as number[];

    const edges: number[] = [];
    for (let i = 1; i < t.length; i++) {
      if (t[i] < 0.2e-3) continue;
      if (out[i - 1] < 2.5 && out[i] >= 2.5) edges.push(t[i]);
    }
    expect(edges.length).toBeGreaterThanOrEqual(3);

    const periods: number[] = [];
    for (let i = 1; i < edges.length; i++) periods.push(edges[i] - edges[i - 1]);
    const avgT = periods.reduce((s, p) => s + p, 0) / periods.length;
    const fMeasured = 1 / avgT;
    expect(fMeasured).toBeGreaterThan(500);
    expect(fMeasured).toBeLessThan(50_000);
  });
});
