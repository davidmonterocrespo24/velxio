import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

describe('ngspice — diode', () => {
  it('1N4148 forward drop ≈ 0.6–0.75V at ~4 mA', { timeout: 30_000 }, async () => {
    const netlist = `Diode forward
V1 vcc 0 DC 5
R1 vcc a 1k
D1 a 0 DMOD
.model DMOD D(Is=2.52n N=1.752 Rs=0.568 Ibv=0.1u Bv=100)
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    const Va = dcValue('v(a)');
    expect(Va).toBeGreaterThan(0.55);
    expect(Va).toBeLessThan(0.80);
  });

  it('full-wave bridge rectifier outputs ~|Vin| − 2·Vf', { timeout: 30_000 }, async () => {
    // Classic 4-diode bridge. AC 6V peak, 50 Hz.
    const netlist = `Bridge rectifier
V1 a b SIN(0 6 50)
D1 a p DMOD
D2 b p DMOD
D3 n a DMOD
D4 n b DMOD
R1 p n 1k
.model DMOD D(Is=1e-14 N=1)
.tran 0.1m 40m
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const vp = vec('v(p)');
    const vn = vec('v(n)');
    // Compute peak of (Vp − Vn)
    let peakOut = -Infinity, minOut = Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 20e-3) continue; // skip first half-period
      const d = vp[i] - vn[i];
      if (d > peakOut) peakOut = d;
      if (d < minOut) minOut = d;
    }
    // 6 V peak − 2 · 0.65 V ≈ 4.7 V
    expect(peakOut).toBeGreaterThan(4.2);
    expect(peakOut).toBeLessThan(5.4);
    // Output should always be positive (bridge)
    expect(minOut).toBeGreaterThan(-0.1);
  });
});

describe('ngspice — BJT', () => {
  it('common-emitter amplifier inverts and amplifies a small signal', { timeout: 30_000 }, async () => {
    // Q1 = 2N2222. R_C=4.7k, R_E=1k, R_B1=47k, R_B2=10k, Vcc=12V
    // Input AC 10 mV peak at 1 kHz, coupled through C=1µF.
    const netlist = `Common-emitter
Vcc vcc 0 DC 12
Vin in 0 SIN(0 0.01 1k)
Cin in b 1u
RB1 vcc b 47k
RB2 b 0 10k
RC vcc c 4.7k
RE e 0 1k
CE e 0 100u
Q1 c b e Q2N2222
Cout c out 1u
Rout out 0 100k
.model Q2N2222 NPN(Is=1e-14 Bf=200 Vaf=75)
.tran 10u 6m
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const vin = vec('v(in)');
    const vout = vec('v(out)');

    // Skip startup transient
    const steady = i => t[i] > 3e-3;
    let maxIn = 0, maxOut = 0, minOut = Infinity;
    for (let i = 0; i < t.length; i++) {
      if (!steady(i)) continue;
      if (Math.abs(vin[i]) > maxIn) maxIn = Math.abs(vin[i]);
      if (vout[i] > maxOut) maxOut = vout[i];
      if (vout[i] < minOut) minOut = vout[i];
    }
    const outSwing = maxOut - minOut;
    const gain = outSwing / (2 * maxIn);
    // Common-emitter with R_C=4.7k, R_E=1k (CE bypassed) → gain_mid ≈ R_C · gm ≈ 100-200
    // With emitter resistor unbypassed (CE omitted) gain ~R_C/R_E = 4.7
    // Our netlist bypasses R_E with 100 µF, so gain should be high.
    expect(gain).toBeGreaterThan(30);
  });
});

describe('ngspice — MOSFET', () => {
  it('N-MOS switch: V_GS > Vth pulls drain to ground', { timeout: 30_000 }, async () => {
    // M1 drain gate source bulk MODEL
    // Use a simple level-1 model.
    const netlist = `N-MOS switch
Vcc vcc 0 DC 5
Vgate gate 0 DC 5
RL vcc drain 1k
M1 drain gate 0 0 NMOS_L1 L=1u W=100u
.model NMOS_L1 NMOS(Level=1 Vto=1.0 Kp=50u Lambda=0.01)
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // Drain should be pulled near 0 (ON)
    expect(dcValue('v(drain)')).toBeLessThan(1.0);
  });
  it('N-MOS switch: V_GS < Vth leaves drain near V_dd', { timeout: 30_000 }, async () => {
    const netlist = `N-MOS off
Vcc vcc 0 DC 5
Vgate gate 0 DC 0
RL vcc drain 1k
M1 drain gate 0 0 NMOS_L1 L=1u W=100u
.model NMOS_L1 NMOS(Level=1 Vto=1.0 Kp=50u Lambda=0.01)
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(drain)')).toBeGreaterThan(4.9);
  });
});

describe('ngspice — op-amp (behavioral E-source)', () => {
  it('Inverting amplifier: V_out = −(R_f/R_in) · V_in', { timeout: 30_000 }, async () => {
    // Ideal op-amp as E-source with huge gain and virtual ground
    // Rin = 1k, Rf = 10k → gain = -10
    const netlist = `Inverting amp
Vin in 0 DC 0.2
Rin in n 1k
Rf n out 10k
* Ideal op-amp: E_opa output 0 (non-inverting 0, inverting n)
Eopa out 0 0 n 1e6
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(out)')).toBeCloseTo(-2.0, 2);
  });
});
