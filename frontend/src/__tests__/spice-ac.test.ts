import { describe, it, expect } from 'vitest';
import { runNetlist, type ComplexNumber } from '../simulation/spice/SpiceEngine';

function magDB(c: ComplexNumber): number {
  return 20 * Math.log10(Math.sqrt(c.real * c.real + c.img * c.img));
}
function phaseDeg(c: ComplexNumber): number {
  return (Math.atan2(c.img, c.real) * 180) / Math.PI;
}
function re(v: number | ComplexNumber): number {
  return typeof v === 'number' ? v : v.real;
}

describe('ngspice — AC (small-signal) analysis', () => {
  it('RC low-pass: −3 dB at f_c = 1/(2πRC)', { timeout: 30_000 }, async () => {
    const netlist = `AC sweep RC low-pass
V1 in 0 AC 1
R1 in out 1k
C1 out 0 159.155n
.ac dec 20 10 1Meg
.end`;
    const { vec } = await runNetlist(netlist);
    const freq = vec('frequency');
    const vout = vec('v(out)') as ComplexNumber[];
    const mag = vout.map(magDB);

    let f3db: number | null = null;
    for (let i = 0; i < freq.length - 1; i++) {
      if (mag[i] > -3 && mag[i + 1] <= -3) {
        const a = mag[i];
        const b = mag[i + 1];
        const fa = re(freq[i]);
        const fb = re(freq[i + 1]);
        f3db = fa + ((-3 - a) / (b - a)) * (fb - fa);
        break;
      }
    }
    expect(f3db).not.toBeNull();
    expect(f3db!).toBeGreaterThan(900);
    expect(f3db!).toBeLessThan(1100);

    expect(mag[0]).toBeGreaterThan(-0.5);

    // Phase at cutoff ≈ −45°
    let fcIdx = 0;
    for (let i = 0; i < freq.length; i++) {
      if (re(freq[i]) >= 1000) {
        fcIdx = i;
        break;
      }
    }
    const ph = phaseDeg(vout[fcIdx]);
    expect(ph).toBeLessThan(-40);
    expect(ph).toBeGreaterThan(-50);
  });

  it('Parallel-tank RLC bandpass: peak at f₀ = 1/(2π√LC)', { timeout: 30_000 }, async () => {
    const netlist = `RLC bandpass
V1 in 0 AC 1
R1 in out 1k
L1 out 0 1m
C1 out 0 1u
.ac dec 30 10 1Meg
.end`;
    const { vec } = await runNetlist(netlist);
    const freq = vec('frequency');
    const vout = vec('v(out)') as ComplexNumber[];
    const mag = vout.map(magDB);

    let peakIdx = 0;
    for (let i = 1; i < mag.length; i++) if (mag[i] > mag[peakIdx]) peakIdx = i;
    const fpeak = re(freq[peakIdx]);
    const expectedF0 = 1 / (2 * Math.PI * Math.sqrt(1e-3 * 1e-6));
    expect(fpeak).toBeGreaterThan(expectedF0 * 0.8);
    expect(fpeak).toBeLessThan(expectedF0 * 1.2);
    expect(mag[peakIdx]).toBeGreaterThan(-1);
    expect(mag[peakIdx]).toBeLessThan(0.01);
  });
});
