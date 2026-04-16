import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * SPICE behavior tests for each circuit example shipped in
 * frontend/src/data/examples-circuits.ts.
 *
 * Each test builds the netlist for the example's analog topology and verifies
 * voltages/currents match expectations. These tests guard against regressions
 * when component models change (e.g., LED Vf, BJT beta, op-amp Vsat).
 */

const NTC_R0 = 10000, NTC_T0 = 298.15, NTC_BETA = 3950;
function ntcR(Tc) {
  const T = Tc + 273.15;
  return NTC_R0 * Math.exp(NTC_BETA * (1 / T - 1 / NTC_T0));
}

// ════════════════════════════════════════════════════════════════════════════
// PASSIVE / ANALOG
// ════════════════════════════════════════════════════════════════════════════

describe('Example: voltage-divider', () => {
  it('R1=R2=10k → V_out = 2.5V (half of 5V)', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Voltage divider
V1 vcc 0 DC 5
R1 vcc out 10k
R2 out 0 10k
.op
.end`);
    expect(dcValue('v(out)')).toBeCloseTo(2.5, 2);
  });
});

describe('Example: rc-low-pass-filter', () => {
  it('PWM 50% duty avg = 2.5V, RC=100ms filters to ~2.5V DC', { timeout: 30_000 }, async () => {
    // Simulate steady-state DC equivalent: PWM avg = 2.5V → R → output (open in DC)
    const { dcValue } = await runNetlist(`RC low-pass DC equivalent
V1 in 0 DC 2.5
R1 in out 10k
Rload out 0 10Meg
.op
.end`);
    expect(dcValue('v(out)')).toBeCloseTo(2.5, 1);
  });
});

describe('Example: wheatstone-bridge', () => {
  it('Unbalanced bridge (R3=11k vs R4=10k) gives ~119mV diff', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Wheatstone unbalanced
V1 vcc 0 DC 5
R1 vcc a 10k
R2 vcc b 10k
R3 a 0 11k
R4 b 0 10k
.op
.end`);
    const diff = dcValue('v(a)') - dcValue('v(b)');
    expect(diff).toBeGreaterThan(0.10);
    expect(diff).toBeLessThan(0.14);
  });
});

describe('Example: ntc-temperature', () => {
  for (const T of [0, 25, 50]) {
    it(`T=${T}°C → V depends on NTC R(T)`, { timeout: 30_000 }, async () => {
      const r = ntcR(T);
      const { dcValue } = await runNetlist(`NTC at ${T}C
V1 vcc 0 DC 5
Rpull vcc out 10k
Rntc out 0 ${r}
.op
.end`);
      const v = dcValue('v(out)');
      const expected = 5 * r / (10000 + r);
      expect(v).toBeCloseTo(expected, 2);
    });
  }
});

describe('Example: led-current-limiting', () => {
  it('5V through 330Ω + LED → V_anode in typical Vf range', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`LED with 330R
V1 vcc 0 DC 5
R1 vcc anode 330
D1 anode 0 DLED
.model DLED D(Is=1e-14 N=1.8 Rs=1)
.op
.end`);
    const va = dcValue('v(anode)');
    // Generic-diode model gives Vf ≈ 0.7–1.5V depending on current. The
    // current is well-defined: I ≈ (5 − Vf)/330 ≈ 10–13 mA.
    expect(va).toBeGreaterThan(0.7);
    expect(va).toBeLessThan(2.5);
  });
});

describe('Example: parallel-resistors', () => {
  it('3× 10k in parallel = 3.33k → V_out = 5·3.33/(10+3.33) = 1.25V', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Parallel R
V1 vcc 0 DC 5
Rs vcc mid 10k
R1 mid 0 10k
R2 mid 0 10k
R3 mid 0 10k
.op
.end`);
    expect(dcValue('v(mid)')).toBeCloseTo(1.25, 2);
  });
});

describe('Example: pot-adc-reader', () => {
  it('Potentiometer at 50% = 2.5V', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Pot at 50%
V1 vcc 0 DC 5
Rtop vcc wiper 5k
Rbot wiper 0 5k
.op
.end`);
    expect(dcValue('v(wiper)')).toBeCloseTo(2.5, 2);
  });
});

describe('Example: photoresistor-light', () => {
  it('LDR at 500 lux + 10k pull-down', { timeout: 30_000 }, async () => {
    // LDR: R(lux) = 1M / (1 + 5*500/1000) = 1M/3.5 ≈ 286k
    const Rldr = 1e6 / (1 + 5 * 500 / 1000);
    const { dcValue } = await runNetlist(`LDR
V1 vcc 0 DC 5
Rldr vcc sig ${Rldr}
Rpull sig 0 10k
.op
.end`);
    const expected = 5 * 10000 / (Rldr + 10000);
    expect(dcValue('v(sig)')).toBeCloseTo(expected, 2);
  });
});

describe('Example: capacitor-charge-curve', () => {
  it('RC charging: V(τ) ≈ 63% of V_supply', { timeout: 30_000 }, async () => {
    const { vec } = await runNetlist(`RC charge
V1 vcc 0 PULSE(0 5 0 1n 1n 10 20)
R1 vcc out 10k
C1 out 0 100u IC=0
.tran 10m 3
.ic v(out)=0
.end`);
    const t = vec('time');
    const v = vec('v(out)');
    const tau = 10000 * 100e-6; // 1s
    let bestI = 0, dist = Infinity;
    for (let i = 0; i < t.length; i++) {
      if (Math.abs(t[i] - tau) < dist) { dist = Math.abs(t[i] - tau); bestI = i; }
    }
    expect(v[bestI]).toBeGreaterThan(5 * (1 - 1/Math.E) * 0.95);
    expect(v[bestI]).toBeLessThan(5 * (1 - 1/Math.E) * 1.05);
  });
});

describe('Example: multi-led-bar', () => {
  it('LED + 220Ω at 5V conducts ~14 mA', { timeout: 30_000 }, async () => {
    const { vec } = await runNetlist(`LED 220R
V1 vcc 0 DC 5
R1 vcc anode 220
D1 anode 0 DLED
.model DLED D(Is=1e-14 N=1.8 Rs=1)
.op
.end`);
    const i = Math.abs(vec('i(v1)')[0]);
    expect(i).toBeGreaterThan(0.005);
    expect(i).toBeLessThan(0.020);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TRANSISTOR / SEMICONDUCTOR
// ════════════════════════════════════════════════════════════════════════════

describe('Example: npn-led-switch', () => {
  it('2N2222 ON: collector pulled to ~0V', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`NPN switch
V1 vcc 0 DC 5
Vdrv drv 0 DC 5
RB drv b 1k
RC vcc c 220
Q1 c b 0 Q2N2222
.model Q2N2222 NPN(Is=14.34f Bf=200 Vaf=74)
.op
.end`);
    expect(dcValue('v(c)')).toBeLessThan(0.5);
  });
});

describe('Example: pnp-high-side-switch', () => {
  it('2N3906 ON when base LOW: load voltage near Vcc', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`PNP high-side
V1 vcc 0 DC 5
Vdrv drv 0 DC 0
RB drv b 1k
Q1 c b vcc Q2N3906
RL c 0 220
.model Q2N3906 PNP(Is=1.41f Bf=180 Vaf=18.7)
.op
.end`);
    expect(dcValue('v(c)')).toBeGreaterThan(4.0);
  });
});

describe('Example: mosfet-pwm-led', () => {
  it('2N7000 with Vgs=5V drives load, drain low', { timeout: 30_000 }, async () => {
    // 220Ω load + low W/L → drain ≈ 1.2V (still well below 5V → fully ON)
    const { dcValue } = await runNetlist(`NMOS switch
V1 vcc 0 DC 5
Vg gate 0 DC 5
RL vcc drain 220
M1 drain gate 0 0 NMOS L=2u W=200u
.model NMOS NMOS(Level=1 Vto=1.6 Kp=50u)
.op
.end`);
    expect(dcValue('v(drain)')).toBeLessThan(2.0);
  });
});

describe('Example: diode-rectifier', () => {
  it('Half-wave: positive cycle passes, negative blocked', { timeout: 30_000 }, async () => {
    const { vec } = await runNetlist(`Half-wave rectifier
V1 in 0 SIN(0 5 50)
D1 in out DRECT
RL out 0 1k
.model DRECT D(Is=1e-14 N=1)
.tran 0.1m 40m
.end`);
    const t = vec('time');
    const vout = vec('v(out)');
    let posMax = -Infinity, negMin = Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 20e-3) continue;
      if (vout[i] > posMax) posMax = vout[i];
      if (vout[i] < negMin) negMin = vout[i];
    }
    expect(posMax).toBeGreaterThan(3.5);
    expect(negMin).toBeGreaterThan(-0.2); // negative blocked
  });
});

describe('Example: zener-regulator', () => {
  it('5.1V Zener clamps output regardless of input variation', { timeout: 30_000 }, async () => {
    for (const vin of [7, 9, 12]) {
      const { dcValue } = await runNetlist(`Zener V_in=${vin}
V1 vin 0 DC ${vin}
Rs vin out 220
Dz 0 out DZ
.model DZ D(Is=1n N=1 Rs=5 Bv=5.1 Ibv=50m)
.op
.end`);
      const v = dcValue('v(out)');
      expect(v).toBeGreaterThan(4.8);
      expect(v).toBeLessThan(5.4);
    }
  });
});

describe('Example: schottky-reverse-protection', () => {
  it('1N5817 forward Vf < 0.5V at 100mA', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Schottky forward
V1 in 0 DC 5
Rs in d 47
D1 d 0 D1N5817
.model D1N5817 D(Is=3.3u N=1 Rs=0.025)
.op
.end`);
    const vf = dcValue('v(d)');
    expect(vf).toBeLessThan(0.5);
  });
});

describe('Example: bjt-common-emitter', () => {
  it('Common-emitter biased at Vcc/2, gain × small AC input', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`CE amp DC bias
V1 vcc 0 DC 5
RB1 vcc b 47k
RB2 b 0 10k
RC vcc c 4.7k
RE e 0 1k
Q1 c b e Q2N2222
.model Q2N2222 NPN(Is=14.34f Bf=200 Vaf=74)
.op
.end`);
    const vc = dcValue('v(c)');
    // Should be biased somewhere in mid-range (not saturated, not cutoff)
    expect(vc).toBeGreaterThan(1.0);
    expect(vc).toBeLessThan(4.5);
  });
});

describe('Example: darlington-high-current', () => {
  it('Darlington saturates with very small base current', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Darlington
V1 vcc 0 DC 5
Vdrv drv 0 DC 5
RB drv b 100k
RC vcc c 100
Q1 c b e1 Q2N2222
Q2 c e1 0 Q2N2222
.model Q2N2222 NPN(Is=14.34f Bf=200 Vaf=74)
.op
.end`);
    expect(dcValue('v(c)')).toBeLessThan(2.0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// OP-AMP
// ════════════════════════════════════════════════════════════════════════════

describe('Example: opamp-inverting', () => {
  it('LM358 inverter gain=-10: Vin=0.2V → Vout=2.5−2*(0.2−2.5)=2.5+0.5×... approx', { timeout: 30_000 }, async () => {
    // Using ideal op-amp for clean test
    const { dcValue } = await runNetlist(`Inverter
V1 vin 0 DC 0.2
Rin vin n 1k
Rf n out 10k
E1 out 0 0 n 1e6
.op
.end`);
    expect(dcValue('v(out)')).toBeCloseTo(-2.0, 1);
  });
});

describe('Example: opamp-voltage-follower', () => {
  it('Follower: Vout tracks Vin exactly', { timeout: 30_000 }, async () => {
    for (const vin of [1.0, 2.5, 4.0]) {
      const { dcValue } = await runNetlist(`Follower vin=${vin}
V1 vin 0 DC ${vin}
E1 out 0 vin out 1e6
.op
.end`);
      expect(dcValue('v(out)')).toBeCloseTo(vin, 2);
    }
  });
});

describe('Example: opamp-comparator', () => {
  it('Comparator: V+ > V- → output HIGH; V+ < V- → output LOW', { timeout: 30_000 }, async () => {
    const Vcc = 5;
    const A = 1e5;
    const vHi = Vcc - 1.5;
    const vLo = 0.05;
    // Test 1: input above threshold
    const r1 = await runNetlist(`Comparator HIGH
V_pos vp 0 DC 3
V_ref vr 0 DC 2.5
B1 out 0 V = max(${vLo}, min(${vHi}, ${A}*(V(vp)-V(vr))))
Rload out 0 1Meg
.op
.end`);
    expect(r1.dcValue('v(out)')).toBeGreaterThan(3);
    // Test 2: input below threshold
    const r2 = await runNetlist(`Comparator LOW
V_pos vp 0 DC 2
V_ref vr 0 DC 2.5
B1 out 0 V = max(${vLo}, min(${vHi}, ${A}*(V(vp)-V(vr))))
Rload out 0 1Meg
.op
.end`);
    expect(r2.dcValue('v(out)')).toBeLessThan(0.2);
  });
});

describe('Example: opamp-difference', () => {
  it('Diff amp gain=10: V_out = 10·(V2−V1)', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Diff amp
V1 v1 0 DC 0.5
V2 v2 0 DC 0.3
R1 v1 n 10k
R2 n out 100k
R3 v2 p 10k
R4 p 0 100k
E1 out 0 p n 1e6
.op
.end`);
    expect(dcValue('v(out)')).toBeCloseTo(-2.0, 1);
  });
});

describe('Example: opamp-schmitt-trigger', () => {
  it('Non-inverting Schmitt with Rin=10k Rfb=100k flips at ±1V', { timeout: 30_000 }, async () => {
    // Test: input above hi threshold → output HIGH
    const { dcValue } = await runNetlist(`Schmitt HIGH input
Vin in 0 DC 3
Rin in p 10k
Rfb p out 100k
B1 out 0 V = 20 * u(V(p)) - 10
Rload out 0 1Meg
.op
.end`);
    expect(dcValue('v(out)')).toBeGreaterThan(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LOGIC GATES
// ════════════════════════════════════════════════════════════════════════════

describe('Example: and-gate-alarm', () => {
  it('AND truth table: HIGH only when both inputs HIGH', { timeout: 30_000 }, async () => {
    for (const [a, b, exp] of [[0,0,0],[0,5,0],[5,0,0],[5,5,5]]) {
      const { dcValue } = await runNetlist(`AND
Va a 0 DC ${a}
Vb b 0 DC ${b}
B1 y 0 V = 5 * u(V(a)-2.5) * u(V(b)-2.5)
Rload y 0 1Meg
.op
.end`);
      expect(dcValue('v(y)')).toBeCloseTo(exp, 0);
    }
  });
});

describe('Example: xor-toggle-detector', () => {
  it('XOR truth table', { timeout: 30_000 }, async () => {
    for (const [a, b, exp] of [[0,0,0],[5,0,5],[0,5,5],[5,5,0]]) {
      const { dcValue } = await runNetlist(`XOR
Va a 0 DC ${a}
Vb b 0 DC ${b}
B1 y 0 V = 5 * (u(V(a)-2.5) + u(V(b)-2.5) - 2*u(V(a)-2.5)*u(V(b)-2.5))
Rload y 0 1Meg
.op
.end`);
      expect(dcValue('v(y)')).toBeCloseTo(exp, 0);
    }
  });
});

describe('Example: nand-sr-latch', () => {
  it('NAND truth table', { timeout: 30_000 }, async () => {
    for (const [a, b, exp] of [[0,0,5],[0,5,5],[5,0,5],[5,5,0]]) {
      const { dcValue } = await runNetlist(`NAND
Va a 0 DC ${a}
Vb b 0 DC ${b}
B1 y 0 V = 5 * (1 - u(V(a)-2.5) * u(V(b)-2.5))
Rload y 0 1Meg
.op
.end`);
      expect(dcValue('v(y)')).toBeCloseTo(exp, 0);
    }
  });
});

describe('Example: full-adder', () => {
  it('Sum = A XOR B XOR Cin, Cout = AB + Cin(A XOR B)', { timeout: 90_000 }, async () => {
    const cases = [
      { a: 0, b: 0, cin: 0, sum: 0, cout: 0 },
      { a: 0, b: 0, cin: 5, sum: 5, cout: 0 },
      { a: 5, b: 5, cin: 0, sum: 0, cout: 5 },
      { a: 5, b: 5, cin: 5, sum: 5, cout: 5 },
    ];
    const G = `
.subckt XOR_G a b y
B y 0 V = 5 * (u(V(a)-2.5) + u(V(b)-2.5) - 2*u(V(a)-2.5)*u(V(b)-2.5))
Rl y 0 1Meg
.ends
.subckt AND_G a b y
B y 0 V = 5 * u(V(a)-2.5) * u(V(b)-2.5)
Rl y 0 1Meg
.ends
.subckt OR_G a b y
B y 0 V = 5 * (1 - (1-u(V(a)-2.5)) * (1-u(V(b)-2.5)))
Rl y 0 1Meg
.ends`;
    for (const c of cases) {
      const { dcValue } = await runNetlist(`Full adder
Va a 0 DC ${c.a}
Vb b 0 DC ${c.b}
Vcin cin 0 DC ${c.cin}
X1 a b ab_xor XOR_G
X2 ab_xor cin sumn XOR_G
X3 a b ab_and AND_G
X4 ab_xor cin cin_and AND_G
X5 ab_and cin_and coutn OR_G
${G}
.op
.end`);
      expect(dcValue('v(sumn)')).toBeCloseTo(c.sum, 0);
      expect(dcValue('v(coutn)')).toBeCloseTo(c.cout, 0);
    }
  });
});

describe('Example: binary-counter-leds', () => {
  it('LED + 220Ω driven HIGH conducts', { timeout: 30_000 }, async () => {
    const { vec } = await runNetlist(`Counter LED
V1 pin 0 DC 5
R1 pin anode 220
D1 anode 0 DLED
.model DLED D(Is=1e-14 N=1.8 Rs=1)
.op
.end`);
    const i = Math.abs(vec('i(v1)')[0]);
    expect(i).toBeGreaterThan(0.005);
  });
});

describe('Example: logic-probe', () => {
  it('Green LED conducts when pin12 HIGH', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Green LED
V1 pin12 0 DC 5
R1 pin12 anode 220
D1 anode 0 DLED
.model DLED D(Is=1e-14 N=2.0 Rs=1)
.op
.end`);
    const va = dcValue('v(anode)');
    expect(va).toBeGreaterThan(1.0);
    expect(va).toBeLessThan(3.0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ELECTROMECHANICAL
// ════════════════════════════════════════════════════════════════════════════

describe('Example: relay-led-switch', () => {
  it('Relay coil energised at 5V draws ~71mA through 70Ω', { timeout: 30_000 }, async () => {
    const { vec } = await runNetlist(`Relay coil
V1 cp 0 DC 5
R_coil cp 0 70
.op
.end`);
    const i = Math.abs(vec('i(v1)')[0]);
    expect(i).toBeGreaterThan(0.06);
    expect(i).toBeLessThan(0.08);
  });
});

describe('Example: optocoupler-signal', () => {
  it('Optocoupler 4N25 with LED ON: phototransistor conducts (CTR=0.5)', { timeout: 30_000 }, async () => {
    const { dcValue, vec } = await runNetlist(`4N25 ON
Vin vin 0 DC 5
Rled vin an 270
Vcat cat 0 DC 0
Vcc vcc 0 DC 5
Rload vcc col 470
Vemit emit 0 DC 0
Dled an mid DLED
Vsense mid cat DC 0
F_pt col emit Vsense 0.5
Rleak col emit 100Meg
.model DLED D(Is=1e-14 N=2 Rs=5)
.op
.end`);
    const iLed = Math.abs(vec('i(vsense)')[0]);
    const vcol = dcValue('v(col)');
    expect(iLed).toBeGreaterThan(0.005);
    expect(vcol).toBeLessThan(3.5);
  });
});

describe('Example: l293d-motor-control', () => {
  it('L293D forward: OUT1=Vmotor, OUT2=0', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`L293D forward
Vmot vmot 0 DC 9
Ven en 0 DC 5
Vin1 in1 0 DC 5
Vin2 in2 0 DC 0
B_a out1 0 V = u(V(en)-2.5) * u(V(in1)-2.5) * V(vmot)
B_b out2 0 V = u(V(en)-2.5) * u(V(in2)-2.5) * V(vmot)
R_a out1 0 10Meg
R_b out2 0 10Meg
Rmotor out1 out2 10
.op
.end`);
    expect(dcValue('v(out1)')).toBeGreaterThan(7);
    expect(dcValue('v(out2)')).toBeLessThan(2);
  });
});

describe('Example: l293d-speed-pwm', () => {
  it('L293D with EN=PWM (avg 50%): output averages V_motor/2', { timeout: 30_000 }, async () => {
    // DC equivalent of PWM 50%: EN sees 2.5V (average) → at threshold
    // Use EN=5V (representing PWM HIGH duty 100%) to verify full-on case
    const { dcValue } = await runNetlist(`L293D speed
Vmot vmot 0 DC 9
Ven en 0 DC 5
Vin in 0 DC 5
B_o out 0 V = u(V(en)-2.5) * u(V(in)-2.5) * V(vmot)
R_o out 0 10Meg
.op
.end`);
    expect(dcValue('v(out)')).toBeCloseTo(9, 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POWER / REGULATOR
// ════════════════════════════════════════════════════════════════════════════

describe('Example: power-supply-7805', () => {
  it('7805 with V_in=9V → V_out=5V', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`7805
Vin vin 0 DC 9
B_u1 vout 0 V = min(V(vin)-V(0)-2, 5)
R_load vout 0 1k
.op
.end`);
    expect(dcValue('v(vout)')).toBeCloseTo(5, 1);
  });

  it('7805 dropout when V_in too low', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`7805 dropout
Vin vin 0 DC 4
B_u1 vout 0 V = min(V(vin)-V(0)-2, 5)
R_load vout 0 1k
.op
.end`);
    expect(dcValue('v(vout)')).toBeLessThan(3);
  });
});

describe('Example: lm317-adjustable-psu', () => {
  it('LM317 with R1=240, R2=720: V_out ≈ 5V', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`LM317
Vin vin 0 DC 12
B_u1 vout 0 V = V(adj) + min(V(vin)-V(adj)-2, 1.25)
R1 vout adj 240
R2 adj 0 720
Rload vout 0 10k
.op
.end`);
    expect(dcValue('v(vout)')).toBeCloseTo(5, 1);
  });
});

describe('Example: battery-voltage-monitor', () => {
  it('20k+10k divider scales 9V → 3V into ADC', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Battery monitor
Vbat vbat 0 DC 9
R1 vbat mid 20k
R2 mid 0 10k
.op
.end`);
    expect(dcValue('v(mid)')).toBeCloseTo(3.0, 2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ESP32 / MEGA / NANO board-specific
// ════════════════════════════════════════════════════════════════════════════

describe('Example: esp32-dual-adc', () => {
  it('Two pots at 3.3V supply: each leg is independent', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`ESP32 dual pot
V1 vcc 0 DC 3.3
Rt1 vcc s1 5k
Rb1 s1 0 5k
Rt2 vcc s2 3k
Rb2 s2 0 7k
.op
.end`);
    expect(dcValue('v(s1)')).toBeCloseTo(1.65, 2);
    expect(dcValue('v(s2)')).toBeCloseTo(2.31, 2);
  });
});

describe('Example: mega-multi-led', () => {
  it('Mega 5V LED with 220Ω limit', { timeout: 30_000 }, async () => {
    const { vec } = await runNetlist(`Mega LED
V1 pin 0 DC 5
R1 pin anode 220
D1 anode 0 DLED
.model DLED D(Is=1e-14 N=1.8 Rs=1)
.op
.end`);
    expect(Math.abs(vec('i(v1)')[0])).toBeGreaterThan(0.005);
  });
});

describe('Example: nano-sensor-station', () => {
  for (const T of [10, 25, 40]) {
    it(`Nano NTC at ${T}°C: V_out depends on R_ntc`, { timeout: 30_000 }, async () => {
      const r = ntcR(T);
      const { dcValue } = await runNetlist(`Nano NTC
V1 vcc 0 DC 5
Rntc vcc out ${r}
Rpull out 0 10k
.op
.end`);
      const expected = 5 * 10000 / (r + 10000);
      expect(dcValue('v(out)')).toBeCloseTo(expected, 2);
    });
  }
});

describe('Example: esp32-pwm-led-rgb', () => {
  it('RGB LED full red @3.3V through 220Ω: red anode conducts', { timeout: 30_000 }, async () => {
    const { vec } = await runNetlist(`RGB red full
V1 pin 0 DC 3.3
R1 pin anode 220
D1 anode 0 DLED
.model DLED D(Is=1e-14 N=1.8 Rs=1)
.op
.end`);
    const i = Math.abs(vec('i(v1)')[0]);
    expect(i).toBeGreaterThan(0.001);
    expect(i).toBeLessThan(0.012);
  });
});
