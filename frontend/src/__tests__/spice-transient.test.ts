import { describe, it, expect } from 'vitest';
import { runNetlist, NL } from '../simulation/spice/SpiceEngine';

describe('ngspice — transient analysis', () => {
  it(
    'RC charging: V(τ) ≈ 63.2% of Vsource (R=10k, C=100µF, V=5V)',
    { timeout: 30_000 },
    async () => {
      const netlist = `RC charging
${NL.pulse('V1', 'vcc', '0', 0, 5, 0, '1n', '1n', 10, 20)}
R1 vcc out 10k
C1 out 0 100u IC=0
.tran 10m 3
.ic v(out)=0
.end`;
      const { vec } = await runNetlist(netlist);
      const t = vec('time') as number[];
      const v = vec('v(out)') as number[];
      const tau = 10_000 * 100e-6; // 1 s
      let bestI = 0;
      let bestDt = Infinity;
      for (let i = 0; i < t.length; i++) {
        const d = Math.abs(t[i] - tau);
        if (d < bestDt) {
          bestDt = d;
          bestI = i;
        }
      }
      const vAtTau = v[bestI];
      const expected = 5 * (1 - 1 / Math.E);
      expect(vAtTau).toBeGreaterThan(expected * 0.97);
      expect(vAtTau).toBeLessThan(expected * 1.03);
    },
  );

  it(
    'RLC oscillator: underdamped ringing with expected frequency',
    { timeout: 30_000 },
    async () => {
      // L=10mH, C=10µF → f0 ≈ 503 Hz. Light damping via R=1Ω.
      const netlist = `RLC ringing
V1 in 0 PULSE(0 5 1m 1u 1u 1 2)
R1 in n1 1
L1 n1 out 10m
C1 out 0 10u IC=0
.tran 10u 30m
.end`;
      const { vec } = await runNetlist(netlist);
      const t = vec('time') as number[];
      const v = vec('v(out)') as number[];

      const crossings: number[] = [];
      for (let i = 1; i < t.length; i++) {
        if (t[i] < 2e-3) continue;
        const a = v[i - 1] - 2.5;
        const b = v[i] - 2.5;
        if (a * b < 0) crossings.push(t[i]);
      }
      expect(crossings.length).toBeGreaterThan(4);
      const diffs: number[] = [];
      for (let i = 1; i < crossings.length; i++) diffs.push(crossings[i] - crossings[i - 1]);
      const avgHalf = diffs.reduce((s, d) => s + d, 0) / diffs.length;
      const measuredF = 1 / (2 * avgHalf);
      const expectedF = 1 / (2 * Math.PI * Math.sqrt(10e-3 * 10e-6));
      expect(measuredF).toBeGreaterThan(expectedF * 0.85);
      expect(measuredF).toBeLessThan(expectedF * 1.15);
    },
  );
});
