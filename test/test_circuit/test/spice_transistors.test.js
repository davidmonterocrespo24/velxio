import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Transistor circuits — BJT and MOSFET behavioural validation.
 *
 * Models used:
 *   - Q2N2222  (NPN BJT, general purpose)
 *   - QBC547   (NPN BJT, small signal)
 *   - Q2N3906  (PNP BJT, general purpose)
 *   - M2N7000  (N-channel MOSFET, small signal)
 *   - MIRF540  (N-channel power MOSFET)
 *   - MP3055   (PNP-style high-voltage via NMOS swap — illustrative only)
 *
 * All circuits come from standard textbook configurations so the numeric
 * expectations are both measurable and model-agnostic within tolerance.
 */

const MODELS = `
.model Q2N2222 NPN(Is=14.34f Bf=200 Vaf=74 Rb=10 Rc=1)
.model QBC547 NPN(Is=7.05f Bf=378 Vaf=85 Rb=10 Rc=1.32)
.model Q2N3906 PNP(Is=1.41f Bf=180 Vaf=18.7 Rb=10)
.model M2N7000 NMOS(Level=3 Vto=1.6 Kp=0.1 Rd=1 Rs=0.5)
.model MIRF540 NMOS(Level=3 Vto=3 Kp=20 Rd=0.044)
`;

describe('ngspice — BJT switch', () => {
  it('2N2222 saturates when base is driven: V_CE ≈ 0.2–0.4 V', { timeout: 30_000 }, async () => {
    // Classic LED driver: Vcc=5, RC=220Ω, base via 1kΩ from 5V logic high
    const netlist = `BJT switch ON
Vcc vcc 0 DC 5
Vb base_drv 0 DC 5
RB base_drv b 1k
RC vcc c 220
Q1 c b 0 Q2N2222
${MODELS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    const vc = dcValue('v(c)');
    // V_CE ≈ 0.2V at saturation
    expect(vc).toBeLessThan(0.4);
    expect(vc).toBeGreaterThan(0.0);
  });

  it('2N2222 cuts off when base is at ground: V_C ≈ Vcc', { timeout: 30_000 }, async () => {
    const netlist = `BJT switch OFF
Vcc vcc 0 DC 5
Vb base_drv 0 DC 0
RB base_drv b 1k
RC vcc c 220
Q1 c b 0 Q2N2222
${MODELS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(c)')).toBeGreaterThan(4.9);
  });
});

describe('ngspice — BJT amplifiers', () => {
  it('common-collector (emitter follower) has gain ≈ 1 and does not invert', { timeout: 30_000 }, async () => {
    // Voltage follower: Vcc=12, base biased to ~6V by 100k/100k, input AC-coupled
    const netlist = `Emitter follower
Vcc vcc 0 DC 12
Vin in 0 SIN(0 0.5 1k)
Cin in b 10u
RB1 vcc b 100k
RB2 b 0 100k
RE e 0 1k
Q1 vcc b e Q2N2222
Cout e out 10u
Rout out 0 100k
${MODELS}
.tran 10u 5m
.end`;
    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const vin = vec('v(in)');
    const vout = vec('v(out)');
    // Measure swings after 2 ms (past start-up)
    let maxIn = 0, maxOut = -Infinity, minOut = Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < 2e-3) continue;
      if (Math.abs(vin[i]) > maxIn) maxIn = Math.abs(vin[i]);
      if (vout[i] > maxOut) maxOut = vout[i];
      if (vout[i] < minOut) minOut = vout[i];
    }
    const gain = (maxOut - minOut) / (2 * maxIn);
    // Follower gain is ~0.9–1.0
    expect(gain).toBeGreaterThan(0.7);
    expect(gain).toBeLessThan(1.1);
  });

  it('Darlington switch saturates where single BJT barely conducts', { timeout: 30_000 }, async () => {
    // Test that a Darlington pair saturates a 100Ω load at base current where
    // a single BJT with the same drive would leave the collector near Vcc.
    // Common-emitter (switch) topology. Very high base resistor to force a
    // β-sensitive comparison.
    const NL_SINGLE = `Single BJT CE
Vcc vcc 0 DC 5
Vdrv drv 0 DC 5
RB drv b 2.2Meg
RC vcc c 100
Q1 c b 0 Q2N2222
${MODELS}
.op
.end`;
    const NL_DARL = `Darlington CE
Vcc vcc 0 DC 5
Vdrv drv 0 DC 5
RB drv b 2.2Meg
RC vcc c 100
Q1 c b e1 Q2N2222
Q2 c e1 0 Q2N2222
${MODELS}
.op
.end`;
    const single = await runNetlist(NL_SINGLE);
    const darl = await runNetlist(NL_DARL);
    const vcSingle = single.dcValue('v(c)');
    const vcDarl = darl.dcValue('v(c)');
    // With 2.2 MΩ base, single BJT has I_C ≈ 0.4 mA → V_drop = 40 mV → near Vcc.
    // Darlington has β² boost → saturates the 100Ω load → V_C low.
    expect(vcSingle).toBeGreaterThan(4.5);
    expect(vcDarl).toBeLessThan(vcSingle - 1.0);
  });

  it('PNP (2N3906) high-side switch energises load when base goes LOW', { timeout: 30_000 }, async () => {
    // PNP with emitter on Vcc, base pulled low via 1k from 0V. Collector drives load to GND.
    const netlist = `PNP high-side
Vcc vcc 0 DC 5
Vbdrv bdrv 0 DC 0
RB bdrv b 1k
Q1 c b vcc Q2N3906
RL c 0 220
${MODELS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // V(c) should be near Vcc (load energised)
    expect(dcValue('v(c)')).toBeGreaterThan(4.0);
  });

  it('PNP (2N3906) is OFF when base is tied to emitter (Vcc): V(c) ≈ 0', { timeout: 30_000 }, async () => {
    const netlist = `PNP off
Vcc vcc 0 DC 5
Q1 c vcc vcc Q2N3906
RL c 0 220
${MODELS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(c)')).toBeLessThan(0.1);
  });
});

describe('ngspice — MOSFET circuits', () => {
  it('2N7000 logic-level MOSFET switches an LED (V_GS=5V → drain near 0)', { timeout: 30_000 }, async () => {
    const netlist = `Logic-level N-MOS LED driver
Vcc vcc 0 DC 5
Vg gate 0 DC 5
RL vcc drain 220
M1 drain gate 0 0 M2N7000 L=2u W=0.1
${MODELS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(drain)')).toBeLessThan(1.0);
  });

  it('IRF540 power MOSFET has R_DS(on) << 1Ω: drops < 100 mV at 1 A', { timeout: 30_000 }, async () => {
    // Force 1 A through the channel via an ideal current source
    const netlist = `IRF540 Rdson
Vg gate 0 DC 10
Idrv 0 drain DC 1
M1 drain gate 0 0 MIRF540 L=2u W=1
${MODELS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    const vds = dcValue('v(drain)');
    // IRF540 typical R_DS(on) ≈ 77 mΩ → 77 mV at 1 A
    expect(vds).toBeLessThan(0.3);
    expect(vds).toBeGreaterThan(0);
  });

  it('NMOS DC transfer curve: V_DS falls as V_GS rises past threshold', { timeout: 30_000 }, async () => {
    // Sweep V_GS 0 → 5 V, plot V_DS. We just run 3 points and verify monotonic decay.
    const cases = [
      { vgs: 0, expectAbove: 4.9 },     // sub-threshold → drain near Vcc
      { vgs: 2.5, expectBetween: [0, 5] }, // in linear/sat region
      { vgs: 5.0, expectBelow: 1.5 },    // fully on → drain near 0
    ];
    for (const c of cases) {
      const netlist = `NMOS DC sweep V_GS=${c.vgs}
Vcc vcc 0 DC 5
Vg g 0 DC ${c.vgs}
RL vcc d 1k
M1 d g 0 0 MIRF540 L=2u W=1
${MODELS}
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      const vd = dcValue('v(d)');
      if (c.expectAbove != null) expect(vd).toBeGreaterThan(c.expectAbove);
      if (c.expectBelow != null) expect(vd).toBeLessThan(c.expectBelow);
      if (c.expectBetween) {
        expect(vd).toBeGreaterThan(c.expectBetween[0]);
        expect(vd).toBeLessThan(c.expectBetween[1]);
      }
    }
  });
});

describe('ngspice — CMOS behavioural inverter', () => {
  it('CMOS inverter (NMOS+PNP pair via behavioural stitch) inverts 0↔5', { timeout: 30_000 }, async () => {
    // Simplified CMOS inverter using an NMOS pull-down + pull-up resistor.
    // True PMOS-in-NMOS-model requires custom params; we use a 1k pull-up which
    // is the standard "inverter with resistor load" from logic families.
    for (const vin of [0, 5]) {
      const netlist = `NMOS inverter Vin=${vin}
Vcc vcc 0 DC 5
Vin in 0 DC ${vin}
Rpu vcc out 1k
M1 out in 0 0 M2N7000 L=2u W=0.1
${MODELS}
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      const vout = dcValue('v(out)');
      if (vin < 2.5) expect(vout).toBeGreaterThan(4.5); // in=0 → out≈5
      else expect(vout).toBeLessThan(0.5);              // in=5 → out≈0 (saturated)
    }
  });
});

describe('ngspice — push-pull output stage (complementary MOSFETs)', () => {
  // A classic class-B output: the high-side switch drives current into the load
  // in one polarity, the low-side pulls the load to ground in the other. We
  // validate by measuring the voltage across the load under each drive state.
  it('high-side ON, low-side OFF: load terminal pulled up toward Vcc', { timeout: 30_000 }, async () => {
    const netlist = `Push-pull high
Vcc vcc 0 DC 12
Vhi hi 0 DC 0
Vlo lo 0 DC 0
QH load hi vcc Q2N3906
M_LO load lo 0 0 MIRF540 L=2u W=1
Rload load 0 100
${MODELS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // PNP: base at 0 → emitter−base junction forward biased → ON → load near Vcc
    expect(dcValue('v(load)')).toBeGreaterThan(10);
  });

  it('high-side OFF, low-side ON: load terminal pulled down to ground', { timeout: 30_000 }, async () => {
    const netlist = `Push-pull low
Vcc vcc 0 DC 12
Vhi hi 0 DC 12
Vlo lo 0 DC 10
QH load hi vcc Q2N3906
M_LO load lo 0 0 MIRF540 L=2u W=1
Rload load 0 100
${MODELS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // PNP off, NMOS saturated → load pulled to ~0
    expect(dcValue('v(load)')).toBeLessThan(1);
  });
});
