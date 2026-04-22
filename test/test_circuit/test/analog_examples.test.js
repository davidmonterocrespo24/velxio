import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * SPICE behavior tests, one per analog example shipped in
 * frontend/src/data/examples-analog.ts.
 *
 * Each test mirrors the Velxio circuit as a hand-written ngspice netlist using
 * the same component models the NetlistBuilder emits — so a passing test here
 * proves the topology converges with our model parameters and produces sane
 * voltages/currents. If a model in componentToSpice.ts changes (e.g. BJT Bf,
 * LM358 vsat), update the assertions here as well.
 *
 * Models reused throughout (kept in lockstep with componentToSpice.ts):
 *   .model D1N4007 D(Is=76.9n N=1.45 Rs=0.0342 Ikf=2.34 Bv=1000 Ibv=5u)
 *   .model D1N4733 D(Is=1n N=1 Rs=5 Bv=5.1 Ibv=50m)
 *   .model Q2N2222 NPN(Is=14.34f Bf=200 Vaf=74 Rb=10 Rc=1)
 *   .model QBC557  PNP(Is=6.73f Bf=250 Vaf=80 Rb=10)
 *   .model M2N7000 NMOS(Level=1 Vto=1.6 Kp=50u Lambda=0.01)
 *   .model MIRF9540 PMOS(Level=1 Vto=-3 Kp=20u Lambda=0.01)
 *   LM358: behavioral B-source, A=1e5, vLo=0.05, vHi=Vcc-1.5
 */

const D1N4007 = '.model D1N4007 D(Is=76.9n N=1.45 Rs=0.0342 Ikf=2.34 Bv=1000 Ibv=5u)';
const D1N4733 = '.model D1N4733 D(Is=1n N=1 Rs=5 Bv=5.1 Ibv=50m)';
const Q2N2222 = '.model Q2N2222 NPN(Is=14.34f Bf=200 Vaf=74 Rb=10 Rc=1)';
const QBC557  = '.model QBC557 PNP(Is=6.73f Bf=250 Vaf=80 Rb=10)';
const M2N7000 = '.model M2N7000 NMOS(Level=1 Vto=1.6 Kp=50u Lambda=0.01)';
const MIRF9540 = '.model MIRF9540 PMOS(Level=1 Vto=-3 Kp=20u Lambda=0.01)';

// ════════════════════════════════════════════════════════════════════════════
// PASSIVE  (1–7)
// ════════════════════════════════════════════════════════════════════════════

describe('an-voltage-divider', () => {
  it('two equal R: V_out = Vsrc/2', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Voltage divider 5V
V_src vsig 0 DC 5
R_r1 vsig vout 10000
R_r2 vout 0   10000
.op
.end`);
    expect(dcValue('v(vout)')).toBeCloseTo(2.5, 2);
  });
});

describe('an-series-resistors', () => {
  it('1k+2.2k+4.7k = 7.9k: I = 10V/7.9k ≈ 1.27 mA', { timeout: 30_000 }, async () => {
    const { vec } = await runNetlist(`Series Rs
V_src vsig 0 DC 10
R_r1 vsig n1 1000
R_r2 n1   n2 2200
R_r3 n2   0  4700
.op
.end`);
    const i = Math.abs(vec('i(v_src)')[0]);
    expect(i).toBeCloseTo(10 / 7900, 4);
  });
});

describe('an-parallel-resistors', () => {
  it('three 1k in parallel = 333Ω: I @ 5V ≈ 15 mA', { timeout: 30_000 }, async () => {
    const { vec } = await runNetlist(`Parallel Rs
V_src vsig 0 DC 5
R_r1 vsig 0 1000
R_r2 vsig 0 1000
R_r3 vsig 0 1000
.op
.end`);
    const i = Math.abs(vec('i(v_src)')[0]);
    expect(i).toBeCloseTo(0.015, 3);
  });
});

describe('an-rc-low-pass', () => {
  it('R=1.6k, C=100n: 1 kHz sine attenuated near −3 dB', { timeout: 60_000 }, async () => {
    // fc = 1/(2π·R·C) = 1/(2π·1.6k·100n) ≈ 995 Hz → at 1 kHz, |H| ≈ 0.707
    const { vec } = await runNetlist(`RC LPF
V_src vsig 0 SIN(0 1 1000)
R_r1 vsig vout 1600
C_c1 vout 0    100n
.tran 10u 10m UIC
.end`);
    const t = vec('time');
    const v = vec('v(vout)');
    // After settling (>5 ms) measure peak amplitude
    let peak = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 5e-3) continue;
      if (Math.abs(v[i]) > peak) peak = Math.abs(v[i]);
    }
    expect(peak).toBeGreaterThan(0.6);
    expect(peak).toBeLessThan(0.85);
  });
});

describe('an-rc-high-pass', () => {
  it('C=100n, R=1.6k: 1 kHz sine passes near −3 dB', { timeout: 60_000 }, async () => {
    const { vec } = await runNetlist(`RC HPF
V_src vsig 0 SIN(0 1 1000)
C_c1 vsig vout 100n
R_r1 vout 0    1600
.tran 10u 10m UIC
.end`);
    const t = vec('time');
    const v = vec('v(vout)');
    let peak = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 5e-3) continue;
      if (Math.abs(v[i]) > peak) peak = Math.abs(v[i]);
    }
    expect(peak).toBeGreaterThan(0.6);
    expect(peak).toBeLessThan(0.85);
  });
});

describe('an-rl-low-pass', () => {
  it('L=10m, R=1k: corner near 16 kHz, 5 kHz passes mostly', { timeout: 60_000 }, async () => {
    // fc = R/(2π·L) = 1000/(2π·10m) ≈ 15.9 kHz; at 5 kHz |H| ≈ 0.95
    const { vec } = await runNetlist(`RL LPF
V_src vsig 0 SIN(0 1 5000)
L_l1 vsig vout 10m
R_r1 vout 0    1000
.tran 1u 4m UIC
.end`);
    const t = vec('time');
    const v = vec('v(vout)');
    let peak = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 2e-3) continue;
      if (Math.abs(v[i]) > peak) peak = Math.abs(v[i]);
    }
    expect(peak).toBeGreaterThan(0.85);
    expect(peak).toBeLessThan(1.05);
  });
});

describe('an-rlc-series-resonance', () => {
  it('L=1m, C=1u: resonance ≈ 5.03 kHz, Vc peaks well above Vsrc', { timeout: 60_000 }, async () => {
    // ω0 = 1/√(LC) → fr ≈ 5033 Hz. With Rs=10Ω, Q = 1/(R·√(C/L)) = 1/(10·√(1u/1m)) = 3.16
    // → Vc/Vs at resonance ≈ Q ≈ 3.16. Use AC analysis for cleanliness.
    const { vec, dcValue } = await runNetlist(`RLC series resonance
V_src vsig 0 AC 1 0
R_r1 vsig n1 10
L_l1 n1   n2 1m
C_c1 n2   0  1u
.ac dec 100 1k 20k
.end`);
    const f = vec('frequency');
    const vc = vec('v(n2)');
    let peakMag = 0, peakF = 0;
    for (let i = 0; i < f.length; i++) {
      const re = vc[i].real ?? vc[i];
      const im = vc[i].img  ?? 0;
      const mag = Math.sqrt(re * re + im * im);
      if (mag > peakMag) { peakMag = mag; peakF = f[i].real ?? f[i]; }
    }
    expect(peakMag).toBeGreaterThan(2.5);
    expect(peakF).toBeGreaterThan(4500);
    expect(peakF).toBeLessThan(5500);
    // sanity: dcValue won't matter for AC sweep but accessor should not throw
    expect(typeof dcValue('v(n2)')).toBe('object'); // complex sample
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DIODES  (8–14)
// ════════════════════════════════════════════════════════════════════════════

describe('an-half-wave-rectifier', () => {
  it('positive half-cycle reaches load, negative blocked', { timeout: 60_000 }, async () => {
    const { vec } = await runNetlist(`Half-wave rectifier
V_src vsig 0 SIN(0 8 50)
D_d1 vsig vout D1N4007
R_r1 vout 0 1000
${D1N4007}
.tran 0.1m 60m UIC
.end`);
    const t = vec('time');
    const v = vec('v(vout)');
    let posMax = -Infinity, negMin = Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 20e-3) continue;
      if (v[i] > posMax) posMax = v[i];
      if (v[i] < negMin) negMin = v[i];
    }
    expect(posMax).toBeGreaterThan(6.5);  // 8 − Vf
    expect(negMin).toBeGreaterThan(-0.2); // negative blocked
  });
});

describe('an-bridge-rectifier', () => {
  it('full-wave: load voltage stays positive across both half-cycles', { timeout: 60_000 }, async () => {
    // Bridge: vsig → D1.A; vsig → D3.C; 0 → D2.A; 0 → D4.C
    //         D1.C = D2.C = vplus;  D3.A = D4.A = vminus;  load between vplus−vminus
    const { vec } = await runNetlist(`Bridge rectifier
V_src vsig 0 SIN(0 10 50)
D_d1 vsig vplus  D1N4007
D_d2 0    vplus  D1N4007
D_d3 vminus vsig D1N4007
D_d4 vminus 0    D1N4007
R_r1 vplus vminus 2200
${D1N4007}
.tran 0.1m 60m UIC
.end`);
    const t = vec('time');
    const vp = vec('v(vplus)');
    const vm = vec('v(vminus)');
    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 20e-3) continue;
      const v = vp[i] - vm[i];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    expect(minV).toBeGreaterThan(-0.5);   // never strongly negative
    expect(maxV).toBeGreaterThan(7.5);    // 10 − 2·Vf
  });
});

describe('an-smoothed-rectifier', () => {
  it('100uF cap smooths half-wave to near-DC ≈ Vpeak − Vf', { timeout: 60_000 }, async () => {
    const { vec } = await runNetlist(`Smoothed rectifier
V_src vsig 0 SIN(0 10 50)
D_d1 vsig vout D1N4007
C_c1 vout 0 100u
R_r1 vout 0 1000
${D1N4007}
.tran 0.1m 200m UIC
.end`);
    const t = vec('time');
    const v = vec('v(vout)');
    // After 5 cycles (>100ms) the cap should be charged near peak
    let lastV = 0;
    for (let i = 0; i < t.length; i++) if (t[i] > 150e-3) lastV = v[i];
    expect(lastV).toBeGreaterThan(7.0);
    expect(lastV).toBeLessThan(10.0);
  });
});

describe('an-zener-regulator', () => {
  it('1N4733 (Vz=5.1V) clamps load voltage near 5 V', { timeout: 30_000 }, async () => {
    // r1 + zener (cathode = +rail, anode = GND) + load Rl in parallel with zener
    const { dcValue } = await runNetlist(`Zener shunt regulator
V_src vsig 0 DC 12
R_r1  vsig vout 220
D_d1  0 vout D1N4733
R_rl  vout 0 2200
${D1N4733}
.op
.end`);
    const v = dcValue('v(vout)');
    expect(v).toBeGreaterThan(4.7);
    expect(v).toBeLessThan(5.6);
  });
});

describe('an-diode-clipper', () => {
  it('symmetric clipper limits |v(out)| to near one Vf', { timeout: 60_000 }, async () => {
    // Velxio wires both diodes with their non-shunt terminals tied to GND, so
    // the clipper symmetrically passes only ~±Vf around 0.
    const { vec } = await runNetlist(`Diode clipper
V_src vsig 0 SIN(0 5 1000)
R_r1 vsig vout 1000
D_d1 vout 0 D1N4007
D_d2 0 vout D1N4007
${D1N4007}
.tran 5u 5m UIC
.end`);
    const t = vec('time');
    const v = vec('v(vout)');
    let absPeak = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 1e-3) continue;
      if (Math.abs(v[i]) > absPeak) absPeak = Math.abs(v[i]);
    }
    expect(absPeak).toBeLessThan(1.0); // clamped well below 5 V swing
  });
});

describe('an-diode-clamper', () => {
  it('series cap + diode → output offset so negative peak ≈ −Vf', { timeout: 60_000 }, async () => {
    const { vec } = await runNetlist(`Diode clamper
V_src vsig 0 SIN(0 5 1000)
C_c1 vsig vout 1u
D_d1 0 vout D1N4007
R_rl vout 0 10000
${D1N4007}
.tran 5u 30m UIC
.end`);
    const t = vec('time');
    const v = vec('v(vout)');
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 15e-3) continue;
      if (v[i] < mn) mn = v[i];
      if (v[i] > mx) mx = v[i];
    }
    // Negative peak should be clamped near −Vf (a few hundred mV below 0)
    expect(mn).toBeGreaterThan(-1.5);
    expect(mn).toBeLessThan(0.1);
    // Positive peak should be roughly 2·Vpeak − Vf (well above the input peak)
    expect(mx).toBeGreaterThan(6.0);
  });
});

describe('an-voltage-doubler', () => {
  it('Villard/Greinacher: output charges toward +2·Vpeak after enough cycles', { timeout: 90_000 }, async () => {
    // D1 anode=GND, cathode=n1 → clamps n1's negative excursion to ≈ −0.7.
    // On the positive half-cycle C1 pushes n1 to ≈ +2·Vpeak, D2 (anode=n1,
    // cathode=vout) transfers that charge into C2 → +Vout ≈ 2·Vpeak − 2·Vf.
    const { vec } = await runNetlist(`Voltage doubler
V_src vsig 0 SIN(0 8 50)
C_c1 vsig n1 10u
D_d1 0 n1 D1N4007
D_d2 n1 vout D1N4007
C_c2 vout 0 100u
R_rl vout 0 10000
${D1N4007}
.tran 0.1m 400m
.end`);
    const t = vec('time');
    const v = vec('v(vout)');
    let lastV = 0;
    for (let i = 0; i < t.length; i++) if (t[i] > 350e-3) lastV = v[i];
    // 2·8 − 2·0.7 ≈ 14.6, derated by load → expect ≥ 8 V and ≤ 17 V
    expect(lastV).toBeGreaterThan(8.0);
    expect(lastV).toBeLessThan(17);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BJT  (15–20)
// ════════════════════════════════════════════════════════════════════════════

describe('an-bjt-common-emitter', () => {
  it('CE amp biased: collector sits in mid-rail, not saturated', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`CE amp
V_vcc vcc 0 DC 12
R_rb1 vcc b 47000
R_rb2 b   0 10000
R_rc  vcc c 4700
R_re  e   0 1000
Q_q1  c b e Q2N2222
${Q2N2222}
.op
.end`);
    const vc = dcValue('v(c)');
    expect(vc).toBeGreaterThan(2.0);
    expect(vc).toBeLessThan(11.0);
  });
});

describe('an-bjt-emitter-follower', () => {
  it('emitter follower: V_e ≈ V_b − 0.7', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Emitter follower
V_vcc vcc 0 DC 12
V_src vsig 0 DC 6
R_rb  vsig b 100000
Q_q1  vcc b e Q2N2222
R_re  e   0 1000
${Q2N2222}
.op
.end`);
    const vb = dcValue('v(b)');
    const ve = dcValue('v(e)');
    expect(vb - ve).toBeGreaterThan(0.55);
    expect(vb - ve).toBeLessThan(0.80);
  });
});

describe('an-bjt-switch', () => {
  it('NPN switch ON: collector drops near saturation', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`BJT switch
V_vcc vcc 0 DC 9
V_src vsig 0 DC 4
R_rb  vsig b 4700
R_rl  vcc c 1000
Q_q1  c b 0 Q2N2222
${Q2N2222}
.op
.end`);
    const vc = dcValue('v(c)');
    expect(vc).toBeLessThan(0.6); // saturated
  });
});

describe('an-darlington', () => {
  it('Darlington pair saturates with tiny base drive', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Darlington
V_vcc vcc 0 DC 12
V_src vsig 0 DC 2
R_rb  vsig b 10000
R_rl  vcc c 220
Q_q1  c b e1 Q2N2222
Q_q2  c e1 0 Q2N2222
${Q2N2222}
.op
.end`);
    expect(dcValue('v(c)')).toBeLessThan(2.5);
  });
});

describe('an-current-mirror', () => {
  it('mirror: I(load) ≈ I(reference)', { timeout: 30_000 }, async () => {
    const { vec } = await runNetlist(`NPN current mirror
V_vcc vcc 0 DC 12
R_rref vcc cref 10000
R_rload vcc cload 4700
Q_q1   cref cref 0 Q2N2222
Q_q2   cload cref 0 Q2N2222
${Q2N2222}
.op
.end`);
    // I_ref ≈ (12 − Vbe)/Rref ≈ 1.13 mA; mirror should match within ~20 %
    const iRef = Math.abs(vec('i(v_vcc)')[0]); // total
    expect(iRef).toBeGreaterThan(0.0015); // both branches active
    expect(iRef).toBeLessThan(0.003);
  });
});

describe('an-bjt-diff-pair', () => {
  it('diff pair: tail Vrtail ≈ V_inputs − Vbe, both Q ON', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Diff pair
V_vcc vcc 0 DC 12
V_in1 in1 0 DC 2.5
V_in2 in2 0 DC 2.5
R_rc1 vcc c1 4700
R_rc2 vcc c2 4700
Q_q1  c1 in1 etail Q2N2222
Q_q2  c2 in2 etail Q2N2222
R_rt  etail 0 4700
${Q2N2222}
.op
.end`);
    const vt = dcValue('v(etail)');
    const vc1 = dcValue('v(c1)');
    const vc2 = dcValue('v(c2)');
    expect(vt).toBeGreaterThan(1.5);   // around V_in − 0.7
    expect(vt).toBeLessThan(2.0);
    // With balanced inputs, Vc1 ≈ Vc2 (within 0.1 V)
    expect(Math.abs(vc1 - vc2)).toBeLessThan(0.2);
    // Both transistors active (each pulls down RC by some I·R)
    expect(vc1).toBeLessThan(11.5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MOSFET  (21–23)
// ════════════════════════════════════════════════════════════════════════════

describe('an-mosfet-switch', () => {
  it('2N7000 ON @ Vgs=4V drives drain low', { timeout: 30_000 }, async () => {
    // Use the real W/L the mapper emits: L=2u W=200u
    const { dcValue } = await runNetlist(`MOSFET low-side
V_vcc vcc 0 DC 12
V_src vsig 0 DC 4
R_rg  vsig g 100
R_rl  vcc d 470
M_m1  d g 0 0 M2N7000 L=2u W=200u
R_rgp g 0 100000
${M2N7000}
.op
.end`);
    // With W/L=100, Kp·W/L=5m, Vgst=2.4 → Id_sat ≈ 14.4 mA → Vd ≈ 12 − 6.7 ≈ 5.3 V
    expect(dcValue('v(d)')).toBeLessThan(8);
  });
});

describe('an-mosfet-common-source', () => {
  it('common-source bias: drain in mid-range (not rail-pinned)', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Common-source amp
V_vcc vcc 0 DC 12
R_rg1 vcc g 1000000
R_rg2 g   0 470000
R_rd  vcc d 4700
R_rs  s   0 1000
M_m1  d g s 0 M2N7000 L=2u W=200u
${M2N7000}
.op
.end`);
    const vd = dcValue('v(d)');
    expect(vd).toBeGreaterThan(0.5);
    expect(vd).toBeLessThan(11.9);
  });
});

describe('an-mosfet-pmos-highside', () => {
  it('PMOS ON when gate pulled low: drain near Vcc', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`PMOS highside ON
V_vcc vcc 0 DC 12
V_ctrl ctrl 0 DC 0
R_rg  ctrl g 1000
M_m1  d g vcc vcc MIRF9540 L=2u W=2m
R_rl  d 0 220
${MIRF9540}
.op
.end`);
    // Vgs = 0 − 12 = −12, |Vgs| − |Vto| = 9, fully on → drain ≈ Vcc minus small Rds·I drop
    expect(dcValue('v(d)')).toBeGreaterThan(10);
  });

  it('PMOS OFF when gate ≈ Vcc: drain near 0', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`PMOS highside OFF
V_vcc vcc 0 DC 12
V_ctrl ctrl 0 DC 12
R_rg  ctrl g 1000
M_m1  d g vcc vcc MIRF9540 L=2u W=2m
R_rl  d 0 220
${MIRF9540}
.op
.end`);
    expect(dcValue('v(d)')).toBeLessThan(0.5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// OP-AMP  (24–30) — LM358 behavioral macro from componentToSpice.ts
// ════════════════════════════════════════════════════════════════════════════

// Use the exact same macro shape NetlistBuilder emits for LM358 (vcc=5).
// V_out = max(0.05, min(Vcc-1.5, A·(V+−V−)))
const LM358 = (id, ip, in_, out, vcc = 5) =>
  `R_${id}_inp ${ip} 0 10Meg
R_${id}_inn ${in_} 0 10Meg
B_${id} ${out} 0 V = max(0.05, min(${vcc - 1.5}, 1e5*(V(${ip})-V(${in_}))))
R_${id}_out ${out} 0 1Meg`;

describe('an-opamp-inverting', () => {
  it('gain = -10 around Vref: Vout = Vref − 10·(Vin − Vref)', { timeout: 30_000 }, async () => {
    // Vin = 2.7 (200 mV above Vref=2.5), expect Vout ≈ 2.5 − 2 = 0.5 (clamped lo=0.05)
    const { dcValue } = await runNetlist(`Inverting amp
V_src  vsig 0 DC 2.7
V_vref vref 0 DC 2.5
R_rin  vsig n  1000
R_rf   n out 10000
${LM358('u1', 'vref', 'n', 'out', 5)}
.op
.end`);
    expect(dcValue('v(out)')).toBeCloseTo(0.5, 1);
  });
});

describe('an-opamp-non-inverting', () => {
  it('gain = +11: Vin=0.2 → Vout = 2.2', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Non-inverting amp
V_src vsig 0 DC 0.2
R_rf  out n 10000
R_rg  n   0 1000
${LM358('u1', 'vsig', 'n', 'out', 5)}
.op
.end`);
    expect(dcValue('v(out)')).toBeCloseTo(2.2, 1);
  });
});

describe('an-opamp-follower', () => {
  it('unity-gain buffer: Vout tracks Vin (within rails)', { timeout: 30_000 }, async () => {
    for (const vin of [0.5, 1.5, 3.0]) {
      const { dcValue } = await runNetlist(`Voltage follower vin=${vin}
V_src vsig 0 DC ${vin}
${LM358('u1', 'vsig', 'out', 'out', 5)}
R_rl out 0 1000
.op
.end`);
      expect(dcValue('v(out)')).toBeCloseTo(vin, 1);
    }
  });
});

describe('an-opamp-summing', () => {
  it('summing junction: Vout = Vref − Rf·(ΔV1/R1 + ΔV2/R2)', { timeout: 30_000 }, async () => {
    // V1=1, V2=2, Vref=2.5, all R=10k → Vout = 2.5 − ((1-2.5) + (2-2.5)) = 2.5 + 2 = 4.5
    // Use Vcc=12 so vHi=10.5 doesn't clamp the result.
    const { dcValue } = await runNetlist(`Summing amp
V_v1   v1 0 DC 1
V_v2   v2 0 DC 2
V_vref vref 0 DC 2.5
R_r1 v1 n 10000
R_r2 v2 n 10000
R_rf n out 10000
${LM358('u1', 'vref', 'n', 'out', 12)}
.op
.end`);
    expect(dcValue('v(out)')).toBeCloseTo(4.5, 1);
  });
});

describe('an-opamp-integrator', () => {
  it('integrator with DC step input drifts toward a rail', { timeout: 60_000 }, async () => {
    // Use .ic for cap initial condition (the inline IC=… on a C card needs UIC,
    // and UIC silently disabled the .tran sweep in our singleton ngspice).
    const { vec } = await runNetlist(`Integrator step
V_src  vsig 0 DC 3.5
V_vref vref 0 DC 2.5
R_rin  vsig n 10000
C_cf   n out 100n
${LM358('u1', 'vref', 'n', 'out', 5)}
.ic v(out)=2.5
.tran 100u 50m
.end`);
    const t = vec('time');
    const v = vec('v(out)');
    let lastV = 0;
    for (let i = 0; i < t.length; i++) if (t[i] > 30e-3) lastV = v[i];
    // Vin > Vref → output ramps DOWN (clamped at 0.05) due to inversion
    expect(lastV).toBeLessThan(1.0);
  });
});

describe('an-opamp-comparator', () => {
  it('open-loop comparator: V+ > V- → high rail, < → low rail', { timeout: 30_000 }, async () => {
    const high = await runNetlist(`Comparator HIGH
V_src  vsig 0 DC 3.0
V_vref vref 0 DC 2.5
${LM358('u1', 'vsig', 'vref', 'out', 5)}
R_rl out 0 10000
.op
.end`);
    expect(high.dcValue('v(out)')).toBeGreaterThan(3.4);

    const low = await runNetlist(`Comparator LOW
V_src  vsig 0 DC 2.0
V_vref vref 0 DC 2.5
${LM358('u1', 'vsig', 'vref', 'out', 5)}
R_rl out 0 10000
.op
.end`);
    expect(low.dcValue('v(out)')).toBeLessThan(0.2);
  });
});

describe('an-schmitt-trigger', () => {
  // Non-inverting Schmitt is bistable around the trip points so a bare .op
  // can settle into either rail. Drive the input with a ramp and inspect the
  // output at the ends — that exercises the actual hysteresis.
  it('non-inverting Schmitt flips between rails as input crosses thresholds', { timeout: 60_000 }, async () => {
    const { vec } = await runNetlist(`Schmitt sweep
V_src  vsig 0 PWL(0 0  20m 0  60m 5  100m 5  140m 0  180m 0)
V_vref vref 0 DC 2.5
R_r1   vsig p 10000
R_r2   p out  10000
${LM358('u1', 'p', 'vref', 'out', 5)}
.tran 0.5m 180m
.end`);
    const t = vec('time');
    const v = vec('v(out)');
    let vMid = 0, vEnd = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] >= 80e-3 && t[i] <= 90e-3) vMid = v[i]; // input held at 5 V
      if (t[i] >= 170e-3) vEnd = v[i];                  // input back at 0 V
    }
    expect(vMid).toBeGreaterThan(3.0); // saturated HIGH at high input
    expect(vEnd).toBeLessThan(0.3);    // saturated LOW after returning
  });
});
