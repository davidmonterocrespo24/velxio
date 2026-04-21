import { describe, it, expect } from 'vitest';
import { runNetlist, NL } from '../src/spice/SpiceEngine.js';

describe('ngspice — transient analysis', () => {
  it('RC charging: V(τ) ≈ 63.2% of Vsource (R=10k, C=100µF, V=5V)', { timeout: 30_000 }, async () => {
    const netlist = `RC charging
${NL.pulse('V1', 'vcc', '0', 0, 5, 0, '1n', '1n', '10', '20')}
R1 vcc out 10k
C1 out 0 100u IC=0
.tran 10m 3
.ic v(out)=0
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const v = vec('v(out)');
    const tau = 10_000 * 100e-6; // 1 s
    // Find sample nearest t=τ
    let bestI = 0, bestDt = Infinity;
    for (let i = 0; i < t.length; i++) {
      const d = Math.abs(t[i] - tau);
      if (d < bestDt) { bestDt = d; bestI = i; }
    }
    const v_at_tau = v[bestI];
    const expected = 5 * (1 - 1 / Math.E);
    expect(v_at_tau).toBeGreaterThan(expected * 0.97);
    expect(v_at_tau).toBeLessThan(expected * 1.03);
  });

  it('RLC oscillator: underdamped ringing with expected frequency', { timeout: 30_000 }, async () => {
    // L=10mH, C=10µF → ω0 = 1/√(LC) = 1/√(1e-7) = 3162.3 rad/s → f0 ≈ 503 Hz
    // Use tiny series R (R=1Ω) for light damping
    const netlist = `RLC ringing
V1 in 0 PULSE(0 5 1m 1u 1u 1 2)
R1 in n1 1
L1 n1 out 10m
C1 out 0 10u IC=0
.tran 10u 30m
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const v = vec('v(out)');

    // Detect zero-crossings above 0.5·Vf around the ringing part (t > 2 ms)
    const crossings = [];
    for (let i = 1; i < t.length; i++) {
      if (t[i] < 2e-3) continue;
      const a = v[i - 1] - 2.5;
      const b = v[i] - 2.5;
      if (a * b < 0) crossings.push(t[i]);
    }
    expect(crossings.length).toBeGreaterThan(4);
    // Average period = spacing between zero-crossings × 2 (one period = two crossings)
    const diffs = [];
    for (let i = 1; i < crossings.length; i++) diffs.push(crossings[i] - crossings[i - 1]);
    const avgHalfPeriod = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const measured_f = 1 / (2 * avgHalfPeriod);
    const expected_f = 1 / (2 * Math.PI * Math.sqrt(10e-3 * 10e-6));
    expect(measured_f).toBeGreaterThan(expected_f * 0.85);
    expect(measured_f).toBeLessThan(expected_f * 1.15);
  });
});
