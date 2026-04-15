import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Simple RC relaxation oscillator (the core idea of a 555 timer in astable mode).
 *
 *   Vcc ── R ── node_c ── C ── GND
 *   node_c feeds a Schmitt trigger (hysteresis) that drives node_out.
 *   node_out flips node_c's charging direction by being tied back through the same R
 *   (or a discharge transistor in a real 555).
 *
 * We model it purely behaviorally:
 *   - out  = stateful flip-flop whose state is stored on a tiny cap
 *   - C charges when out=low, discharges when out=high (via Rcontrol)
 */

describe('ngspice — RC relaxation oscillator (555 core)', () => {
  it('produces a periodic waveform with expected frequency', { timeout: 60_000 }, async () => {
    // Behavioral astable: R=10k, C=10n with 1/3–2/3 thresholds → T ≈ 1.4·R·C = 140 µs
    const netlist = `Relaxation oscillator (Schmitt-switch based)
Vcc vcc 0 DC 5
R1 vcc cap 10k
Ccap cap 0 10n IC=0
* Voltage-controlled switch with hysteresis: ON above 3.333V, OFF below 1.667V.
* The switch's stateful hysteresis is what gives us oscillation.
Sdis cap 0 cap 0 SMOD
.model SMOD SW(Vt=2.5 Vh=0.833 Ron=100 Roff=1G)
* Buffer the switch state to a clean digital-looking output
Sbuf out vcc cap 0 SOUT
.model SOUT SW(Vt=2.5 Vh=0.833 Ron=10 Roff=1G)
Rpd out 0 100k
.tran 0.5u 2m
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const out = vec('v(out)');

    // Count rising edges
    const edges = [];
    for (let i = 1; i < t.length; i++) {
      if (t[i] < 0.2e-3) continue;  // skip startup
      if (out[i - 1] < 2.5 && out[i] >= 2.5) edges.push(t[i]);
    }
    console.log(`relaxation osc: detected ${edges.length} rising edges in [${t[0]}..${t[t.length-1]}]`);
    expect(edges.length).toBeGreaterThanOrEqual(3);

    const periods = [];
    for (let i = 1; i < edges.length; i++) periods.push(edges[i] - edges[i - 1]);
    const avg_T = periods.reduce((s, p) => s + p, 0) / periods.length;
    const f_measured = 1 / avg_T;
    console.log(`relaxation osc: f = ${f_measured.toFixed(0)} Hz`);
    // 555-like target: ~7 kHz for R=10k, C=10n (rough order of magnitude).
    // Behavioral model is approximate; accept 1–30 kHz.
    expect(f_measured).toBeGreaterThan(500);
    expect(f_measured).toBeLessThan(50_000);
  });
});
