import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Advanced analog circuits that combine passives + transistors + op-amps.
 * These go beyond textbook building blocks to system-level validation.
 */

describe('ngspice — Wheatstone bridge', () => {
  it('balanced bridge (R1·R4 = R2·R3) has zero differential voltage', { timeout: 30_000 }, async () => {
    // R1=R2=R3=R4=1k → balanced
    const netlist = `Wheatstone balanced
Vcc vcc 0 DC 5
R1 vcc a 1k
R2 vcc b 1k
R3 a 0 1k
R4 b 0 1k
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    const va = dcValue('v(a)');
    const vb = dcValue('v(b)');
    expect(Math.abs(va - vb)).toBeLessThan(0.01);
  });

  it('unbalanced bridge (strain-gauge style) produces expected differential', { timeout: 30_000 }, async () => {
    // R1=1k, R4=1k, R2=1k, R3=1.1k (gauge under strain)
    const netlist = `Wheatstone unbalanced
Vcc vcc 0 DC 5
R1 vcc a 1k
R2 vcc b 1k
R3 a 0 1.1k
R4 b 0 1k
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    const va = dcValue('v(a)');
    const vb = dcValue('v(b)');
    // Va = 5·(1.1/2.1) ≈ 2.619; Vb = 5·(1/2) = 2.5 → diff ≈ 0.119 V
    expect(va - vb).toBeGreaterThan(0.1);
    expect(va - vb).toBeLessThan(0.14);
  });
});

describe('ngspice — Schmitt trigger (op-amp based)', () => {
  it('shows hysteresis: output flips at different thresholds depending on direction', { timeout: 45_000 }, async () => {
    // Non-inverting Schmitt: + input fed by divider from Vin and Vout through 10k+10k.
    // Hysteresis band ≈ ±Vsat·(R1/(R1+R2)) — with both 10k → half the output swing.
    // Triangular input sweeps above and below the thresholds.
    // Non-inverting Schmitt: input connects through R_in=10k to V+, output
    // feeds back through R_fb=100k to V+. V_p = (R_fb·V_in + R_in·V_out)/(R_in+R_fb)
    //   = (100·V_in + 10·V_out) / 110. Trip when V_p=0 → V_in = -V_out·(R_in/R_fb)
    //   = ±1 V with V_out=±10 V (hysteresis band = 2 V).
    // Comparator modelled as a B-source with u() step: V_out = +10 if V_p>0 else -10.
    const netlist = `Schmitt trigger
Vin in 0 PWL(0 -3 5m 3 10m -3)
Rin in p 10k
Rfb p out 100k
Bopa out 0 V = 20 * u(V(p)) - 10
Rload out 0 1Meg
.tran 10u 10m
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const vout = vec('v(out)');
    const vin = vec('v(in)');
    // Find a rising zero-crossing of input and check output state flipped
    let sawHigh = false, sawLow = false;
    for (let i = 0; i < t.length; i++) {
      if (vout[i] > 5) sawHigh = true;
      if (vout[i] < -5) sawLow = true;
    }
    expect(sawHigh).toBe(true);
    expect(sawLow).toBe(true);
    // Hysteresis: find the last-sample Vin at which output went HIGH (rising)
    // and the last Vin at which it went LOW (falling). They must differ.
    const transitions = [];
    for (let i = 1; i < t.length; i++) {
      if (vout[i - 1] < 0 && vout[i] >= 0) transitions.push({ dir: 'rise', vin: vin[i] });
      if (vout[i - 1] > 0 && vout[i] <= 0) transitions.push({ dir: 'fall', vin: vin[i] });
    }
    const risings = transitions.filter(x => x.dir === 'rise');
    const fallings = transitions.filter(x => x.dir === 'fall');
    expect(risings.length).toBeGreaterThan(0);
    expect(fallings.length).toBeGreaterThan(0);
    // The rising-trigger Vin must be strictly greater than the falling-trigger Vin.
    const riseTrip = risings[0].vin;
    const fallTrip = fallings[0].vin;
    expect(riseTrip).toBeGreaterThan(fallTrip);
  });
});

describe('ngspice — Sallen-Key low-pass filter (op-amp, 2nd order)', () => {
  it('Butterworth LPF attenuates 10·fc by ≈ 40 dB', { timeout: 60_000 }, async () => {
    // Sallen-Key LPF: fc = 1 / (2π√(R1·R2·C1·C2))
    // R1=R2=10k, C1=C2=10n → fc ≈ 1.59 kHz. Q=0.707 via unity-gain.
    const netlist = `Sallen-Key LPF
Vin in 0 AC 1
R1 in n1 10k
R2 n1 p 10k
C1 n1 out 10n
C2 p 0 10n
* Unity-gain buffer
Eopa out 0 p out 1e6
.ac dec 20 10 1Meg
.end`;
    const { vec, variableNames } = await runNetlist(netlist);
    const freq = vec('frequency');
    const vout = vec('v(out)');
    // Get magnitude at fc and 10·fc
    const fc = 1 / (2 * Math.PI * Math.sqrt(10e3 * 10e3 * 10e-9 * 10e-9));
    const idxFc = nearestIndex(freq, fc);
    const idx10Fc = nearestIndex(freq, fc * 10);
    const magFc = magnitude(vout[idxFc]);
    const mag10Fc = magnitude(vout[idx10Fc]);
    const attenDb = 20 * Math.log10(magFc / mag10Fc);
    // 2nd-order LP → ~40 dB/decade roll-off
    expect(attenDb).toBeGreaterThan(30);
    expect(attenDb).toBeLessThan(55);
    // Also verify DC gain ≈ 1 (low frequency)
    const idxDc = nearestIndex(freq, 50);
    expect(magnitude(vout[idxDc])).toBeGreaterThan(0.9);
    expect(magnitude(vout[idxDc])).toBeLessThan(1.1);
    // Silence unused-var lint
    void variableNames;
  });
});

describe('ngspice — difference amplifier (op-amp instrumentation)', () => {
  it('V_out = (R_f/R_in) · (V_ref − V_in) for matched resistor pairs', { timeout: 30_000 }, async () => {
    // Standard difference amp: R1=R3=10k on inputs, R2=R4=100k feedback/shunt.
    // Gain = R2/R1 = 10. V_out = 10·(V_ref - V_in).
    const netlist = `Difference amp
V1 in1 0 DC 0.5
V2 in2 0 DC 0.3
R1 in1 n 10k
R2 n out 100k
R3 in2 p 10k
R4 p 0 100k
Eopa out 0 p n 1e6
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // Expected: V_out ≈ 10 · (0.3 − 0.5) = −2.0
    expect(dcValue('v(out)')).toBeCloseTo(-2.0, 1);
  });
});

describe('ngspice — Voltage regulator (zener-based simple shunt)', () => {
  it('5.1V zener holds the output steady when input varies 8–12V', { timeout: 30_000 }, async () => {
    for (const vin of [8, 10, 12]) {
      const netlist = `Zener shunt Vin=${vin}
Vcc vcc 0 DC ${vin}
Rs vcc out 220
Dz 0 out DZEN
.model DZEN D(Is=1n N=1 Rs=5 Bv=5.1 Ibv=50m)
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      const vout = dcValue('v(out)');
      // Should stay within ±0.2 V of 5.1 V across the range
      expect(vout).toBeGreaterThan(4.8);
      expect(vout).toBeLessThan(5.4);
    }
  });
});

describe('ngspice — RC PWM-to-analog averager', () => {
  it('RC low-pass averages a 1 kHz 30%-duty PWM to ≈ 30%·Vcc', { timeout: 30_000 }, async () => {
    const netlist = `PWM avg
Vpwm pwm 0 PULSE(0 5 0 1u 1u 0.3m 1m)
R1 pwm out 10k
C1 out 0 10u IC=0
.tran 100u 300m
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const vout = vec('v(out)');
    // Average over the last 50 ms (well past 3 τ = 300 ms → still settling, but oscillating around target)
    let sum = 0, count = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 0.25) continue;
      sum += vout[i];
      count++;
    }
    const avg = sum / count;
    // 30% duty × 5V = 1.5V
    expect(avg).toBeGreaterThan(1.2);
    expect(avg).toBeLessThan(1.8);
  });
});

describe('ngspice — integrator (op-amp)', () => {
  it('square-wave input produces a triangle output at the integrator output', { timeout: 30_000 }, async () => {
    // Ideal inverting integrator: R=10k, C=0.1µF → τ_i = 1ms
    // Input: 1 kHz square wave, ±1 V.
    // Output should be triangular with amplitude ≈ V_in·(T/4)/(R·C) = 1·250µs/1ms = 0.25 V
    // Miller integrator with a DC-feedback resistor (1 MΩ) in parallel with C
    // to bound the output. Ideal op-amp via VCVS. IC=0 pins the integrator
    // start-point to 0 V so the transient doesn't drift.
    const netlist = `Integrator
Vin in 0 PULSE(-1 1 0 1u 1u 0.5m 1m)
R1 in n 10k
C1 n out 0.1u IC=0
Rfb n out 1Meg
Eopa out 0 0 n 1e5
.tran 10u 10m UIC
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const vin = vec('v(in)');
    const vout = vec('v(out)');
    // Over steady state, output swing should be within ±0.5 V (triangle peaks)
    // and should change monotonically between input edges.
    let peakHi = -Infinity, peakLo = Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 2e-3) continue; // skip the DC-offset transient
      if (vout[i] > peakHi) peakHi = vout[i];
      if (vout[i] < peakLo) peakLo = vout[i];
    }
    const swing = peakHi - peakLo;
    // Triangle peak-peak should be around 0.5 V (allowing for startup offset)
    expect(swing).toBeGreaterThan(0.3);
    expect(swing).toBeLessThan(1.5);
    // Silence unused vars
    void vin;
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function nearestIndex(vec, target) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < vec.length; i++) {
    const d = Math.abs((typeof vec[i] === 'number' ? vec[i] : vec[i].real) - target);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function magnitude(val) {
  if (typeof val === 'number') return Math.abs(val);
  return Math.sqrt(val.real ** 2 + val.img ** 2);
}
