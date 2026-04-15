import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/** Convert { real, img } to magnitude in dB. */
function magDB(c) {
  return 20 * Math.log10(Math.sqrt(c.real * c.real + c.img * c.img));
}
function phaseDeg(c) {
  return Math.atan2(c.img, c.real) * 180 / Math.PI;
}

describe('ngspice — AC (small-signal) analysis', () => {
  it('RC low-pass: −3 dB at f_c = 1/(2πRC)', { timeout: 30_000 }, async () => {
    // R=1k, C=159.15nF → f_c = 1000 Hz exactly
    const netlist = `AC sweep RC low-pass
V1 in 0 AC 1
R1 in out 1k
C1 out 0 159.155n
.ac dec 20 10 1Meg
.end`;
    const { vec } = await runNetlist(netlist);
    const freq = vec('frequency');
    const vout = vec('v(out)');

    // Find the frequency where magnitude = −3 dB
    const mag = vout.map(magDB);
    let f3db = null;
    for (let i = 0; i < freq.length - 1; i++) {
      if (mag[i] > -3 && mag[i + 1] <= -3) {
        const a = mag[i], b = mag[i + 1];
        const fa = freq[i].real ?? freq[i];
        const fb = freq[i + 1].real ?? freq[i + 1];
        f3db = fa + ((-3 - a) / (b - a)) * (fb - fa);
        break;
      }
    }
    expect(f3db).not.toBeNull();
    expect(f3db).toBeGreaterThan(900);
    expect(f3db).toBeLessThan(1100);

    // Low-frequency gain ≈ 0 dB
    expect(mag[0]).toBeGreaterThan(-0.5);

    // Well above cutoff: roll-off −20 dB/decade
    const highIdx = mag.length - 1;
    const decadesAbove = Math.log10((freq[highIdx].real ?? freq[highIdx]) / 1000);
    const expectedRolloff = -20 * decadesAbove;
    expect(mag[highIdx]).toBeLessThan(expectedRolloff + 2);
    expect(mag[highIdx]).toBeGreaterThan(expectedRolloff - 2);

    // Phase at cutoff ≈ −45°
    let fcIdx = 0;
    for (let i = 0; i < freq.length; i++) {
      if ((freq[i].real ?? freq[i]) >= 1000) { fcIdx = i; break; }
    }
    const ph = phaseDeg(vout[fcIdx]);
    expect(ph).toBeLessThan(-40);
    expect(ph).toBeGreaterThan(-50);
  });

  it('Parallel-tank RLC bandpass: peak at f₀ = 1/(2π√LC)', { timeout: 30_000 }, async () => {
    // L=1mH, C=1µF → f₀ ≈ 5033 Hz. Parallel LC to ground, R source.
    const netlist = `RLC bandpass
V1 in 0 AC 1
R1 in out 1k
L1 out 0 1m
C1 out 0 1u
.ac dec 30 10 1Meg
.end`;
    const { vec } = await runNetlist(netlist);
    const freq = vec('frequency');
    const vout = vec('v(out)');
    const mag = vout.map(magDB);

    let peakIdx = 0;
    for (let i = 1; i < mag.length; i++) if (mag[i] > mag[peakIdx]) peakIdx = i;
    const fpeak = freq[peakIdx].real ?? freq[peakIdx];
    const expected_f0 = 1 / (2 * Math.PI * Math.sqrt(1e-3 * 1e-6));
    // Peak of LC low-pass with R source is slightly below f0; allow wide band
    expect(fpeak).toBeGreaterThan(expected_f0 * 0.8);
    expect(fpeak).toBeLessThan(expected_f0 * 1.2);
    // Passive network: max gain ≤ 1 (0 dB). At resonance approaches 0 dB.
    expect(mag[peakIdx]).toBeGreaterThan(-1);
    expect(mag[peakIdx]).toBeLessThan(0.01);
    // Stop-band rejection at 10× the resonance frequency should be significant
    let farIdx = 0;
    for (let i = 0; i < freq.length; i++) {
      const f = freq[i].real ?? freq[i];
      if (f > expected_f0 * 10) { farIdx = i; break; }
    }
    if (farIdx > 0) {
      expect(mag[farIdx]).toBeLessThan(mag[peakIdx] - 15);
    }
  });
});
