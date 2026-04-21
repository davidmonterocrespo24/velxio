import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Sanity check for power-supply mappers (fase 9.4):
 *   - reg-7805 / -7812 / -7905 / -lm317
 *   - battery-9v / -aa / -coin-cell
 *   - signal-generator (sine / square / dc)
 *
 * Each test builds the literal card string the mapper emits and verifies
 * ngspice returns the expected steady-state voltage / waveform.
 */

describe('componentToSpice — fixed 78xx / 79xx regulators', () => {
  it('7805 regulates to 5V when V_in > 7V', { timeout: 30_000 }, async () => {
    for (const vin of [7.5, 9, 12, 15]) {
      const netlist = `7805 healthy V_in=${vin}
Vin vin 0 DC ${vin}
B_u1 vout 0 V = min(V(vin)-V(0)-2, 5)
R_u1_out vout 0 10Meg
Rload vout 0 1k
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      expect(dcValue('v(vout)')).toBeCloseTo(5, 2);
    }
  });

  it('7805 drops out when V_in < 7V: V_out = V_in − 2', { timeout: 30_000 }, async () => {
    const netlist = `7805 dropout
Vin vin 0 DC 4
B_u1 vout 0 V = min(V(vin)-V(0)-2, 5)
R_u1_out vout 0 10Meg
Rload vout 0 1k
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(vout)')).toBeCloseTo(2, 1);
  });

  it('7812 regulates to 12V when V_in > 14V', { timeout: 30_000 }, async () => {
    const netlist = `7812 healthy
Vin vin 0 DC 18
B_u1 vout 0 V = min(V(vin)-V(0)-2, 12)
R_u1_out vout 0 10Meg
Rload vout 0 1k
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(vout)')).toBeCloseTo(12, 2);
  });

  it('7905 delivers −5V relative to GND', { timeout: 30_000 }, async () => {
    const netlist = `7905 negative
Vin vin 0 DC -9
B_u1 vout 0 V = max(V(vin)-V(0)+2, -5)
R_u1_out vout 0 10Meg
Rload vout 0 1k
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(vout)')).toBeCloseTo(-5, 2);
  });
});

describe('componentToSpice — LM317 adjustable regulator', () => {
  it('LM317 with R1=240Ω, R2=720Ω yields V_out ≈ 5V (ideal ratio)', { timeout: 30_000 }, async () => {
    // V_out = 1.25·(1 + R2/R1) = 1.25·(1 + 720/240) = 1.25·4 = 5.0
    const netlist = `LM317 5V
Vin vin 0 DC 12
B_u1 vout 0 V = V(adj) + min(V(vin)-V(adj)-2, 1.25)
R_u1_out vout 0 10Meg
R1 vout adj 240
R2 adj 0 720
Rload vout 0 10k
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(vout)')).toBeCloseTo(5, 1);
  });

  it('LM317 with R1=240Ω, R2=1920Ω yields V_out ≈ 11.25V', { timeout: 30_000 }, async () => {
    // V_out = 1.25·(1 + 1920/240) = 1.25·9 = 11.25
    const netlist = `LM317 11.25V
Vin vin 0 DC 15
B_u1 vout 0 V = V(adj) + min(V(vin)-V(adj)-2, 1.25)
R_u1_out vout 0 10Meg
R1 vout adj 240
R2 adj 0 1920
Rload vout 0 10k
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(vout)')).toBeCloseTo(11.25, 1);
  });
});

describe('componentToSpice — batteries', () => {
  it('9V battery no-load: +/− = 9V', { timeout: 30_000 }, async () => {
    const netlist = `9V no load
V_b1 pos b1_int DC 9
R_b1_esr b1_int 0 1.5
R_meter pos 0 10Meg
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(pos)')).toBeCloseTo(9, 2);
  });

  it('9V battery sags under 100Ω load: V ≈ 9·100/(100+1.5) ≈ 8.87V', { timeout: 30_000 }, async () => {
    const netlist = `9V loaded
V_b1 pos b1_int DC 9
R_b1_esr b1_int 0 1.5
Rload pos 0 100
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    const expected = 9 * 100 / (100 + 1.5);
    expect(dcValue('v(pos)')).toBeCloseTo(expected, 2);
  });

  it('coin cell high ESR limits current to ~300 mA into short', { timeout: 30_000 }, async () => {
    const netlist = `coin cell short
V_b1 pos b1_int DC 3
R_b1_esr b1_int 0 10
Rshort pos 0 0.001
.op
.end`;
    const { vec } = await runNetlist(netlist);
    // I through short ≈ 3V / 10Ω = 300 mA
    const iVb1 = vec('i(v_b1)')[0];
    expect(Math.abs(iVb1)).toBeGreaterThan(0.25);
    expect(Math.abs(iVb1)).toBeLessThan(0.35);
  });
});

describe('componentToSpice — signal generator', () => {
  it('sine 1kHz / 1V amplitude / 0 offset has correct peak-to-peak', { timeout: 30_000 }, async () => {
    const netlist = `sine
V_sg sig 0 SIN(0 1 1000)
Rload sig 0 1k
.tran 10u 3m
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const vs = vec('v(sig)');
    let mx = -Infinity, mn = Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 0.5e-3) continue;
      if (vs[i] > mx) mx = vs[i];
      if (vs[i] < mn) mn = vs[i];
    }
    expect(mx - mn).toBeCloseTo(2, 1);
  });

  it('square 500Hz toggles between −1V and +1V', { timeout: 30_000 }, async () => {
    const netlist = `square
V_sg sig 0 PULSE(-1 1 0 1n 1n 1m 2m)
Rload sig 0 1k
.tran 20u 5m
.end`;
    const { vec } = await runNetlist(netlist);
    const vs = vec('v(sig)');
    const hi = vs.some(v => v > 0.9);
    const lo = vs.some(v => v < -0.9);
    expect(hi && lo).toBe(true);
  });

  it('DC mode: offset=3, amplitude ignored → V=3', { timeout: 30_000 }, async () => {
    const netlist = `dc source
V_sg sig 0 DC 3
Rload sig 0 1k
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(sig)')).toBeCloseTo(3, 2);
  });
});
