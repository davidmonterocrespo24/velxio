import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Sanity check for the exact transistor models emitted by
 * `frontend/src/simulation/spice/componentToSpice.ts` (fase 9.2).
 *
 * The refactor switched NMOS models from Level=3 + W=0.1 (which caused
 * convergence hangs — see autosearch/06_ngspice_convergence.md) to Level=1
 * with realistic W/L. This suite locks in that the new models still work.
 */

const MODELS_BJT = `
.model Q2N2222 NPN(Is=14.34f Bf=200 Vaf=74 Rb=10 Rc=1)
.model QBC547  NPN(Is=7.05f Bf=378 Vaf=85 Rb=10 Rc=1.32)
.model Q2N3055 NPN(Is=974f Bf=70 Vaf=100 Rb=0.5 Rc=0.05)
.model Q2N3906 PNP(Is=1.41f Bf=180 Vaf=18.7 Rb=10)
.model QBC557  PNP(Is=6.73f Bf=250 Vaf=80 Rb=10)
`;

const MODELS_MOS = `
.model M2N7000  NMOS(Level=1 Vto=1.6 Kp=50u Lambda=0.01)
.model MIRF540  NMOS(Level=1 Vto=3   Kp=20u Lambda=0.01)
.model MIRF9540 PMOS(Level=1 Vto=-3   Kp=20u Lambda=0.01)
.model MFQP27P06 PMOS(Level=1 Vto=-2.5 Kp=50u Lambda=0.01)
`;

describe('componentToSpice — NPN (unchanged behaviour)', () => {
  it('2N2222 switch saturates the load with base driven HIGH', { timeout: 30_000 }, async () => {
    const netlist = `NPN switch
Vcc vcc 0 DC 5
Vb bdrv 0 DC 5
RB bdrv b 1k
RC vcc c 220
Q1 c b 0 Q2N2222
${MODELS_BJT}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(c)')).toBeLessThan(0.5);
  });
});

describe('componentToSpice — PNP (new mappers)', () => {
  it('2N3906 high-side switch: base LOW turns ON the load', { timeout: 30_000 }, async () => {
    const netlist = `PNP 2N3906 high-side
Vcc vcc 0 DC 5
Vb bdrv 0 DC 0
RB bdrv b 1k
Q1 c b vcc Q2N3906
RL c 0 220
${MODELS_BJT}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(c)')).toBeGreaterThan(4.0);
  });

  it('2N3906 off: base tied to Vcc keeps V(c) near 0', { timeout: 30_000 }, async () => {
    const netlist = `PNP off
Vcc vcc 0 DC 5
Q1 c vcc vcc Q2N3906
RL c 0 220
${MODELS_BJT}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(c)')).toBeLessThan(0.1);
  });

  it('BC557 (complement of BC547) also works as a high-side switch', { timeout: 30_000 }, async () => {
    const netlist = `BC557 high-side
Vcc vcc 0 DC 5
Vb bdrv 0 DC 0
RB bdrv b 4.7k
Q1 c b vcc QBC557
RL c 0 1k
${MODELS_BJT}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(c)')).toBeGreaterThan(3.0);
  });
});

describe('componentToSpice — NMOS refactored (Level=1)', () => {
  it('2N7000 with 3.3V gate pulls drain near 0 (logic-level)', { timeout: 30_000 }, async () => {
    const netlist = `2N7000 at 3.3V gate
Vcc vcc 0 DC 5
Vg gate 0 DC 3.3
RL vcc drain 1k
M1 drain gate 0 0 M2N7000 L=2u W=200u
${MODELS_MOS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(drain)')).toBeLessThan(1.0);
  });

  it('IRF540 with 10V gate saturates 12V load', { timeout: 30_000 }, async () => {
    const netlist = `IRF540 full-on
Vsys vsys 0 DC 12
Vg gate 0 DC 10
RL vsys drain 100
M1 drain gate 0 0 MIRF540 L=2u W=2m
${MODELS_MOS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(drain)')).toBeLessThan(1.0);
  });
});

describe('componentToSpice — P-MOSFET (new mappers)', () => {
  it('IRF9540 high-side load switch: gate LOW turns ON', { timeout: 30_000 }, async () => {
    // PMOS with source at Vcc, gate pulled low → V_GS = -Vcc → fully on
    const netlist = `IRF9540 high-side ON
Vcc vcc 0 DC 12
Vg gate 0 DC 0
M1 load gate vcc vcc MIRF9540 L=2u W=2m
RL load 0 100
${MODELS_MOS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // Load should be pulled close to Vcc
    expect(dcValue('v(load)')).toBeGreaterThan(10);
  });

  it('IRF9540 off: gate tied to source keeps load near 0', { timeout: 30_000 }, async () => {
    const netlist = `IRF9540 off
Vcc vcc 0 DC 12
M1 load vcc vcc vcc MIRF9540 L=2u W=2m
RL load 0 100
${MODELS_MOS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(load)')).toBeLessThan(0.5);
  });

  it('FQP27P06 logic-level PMOS switches 5V load from a 3.3V MCU (gate LOW = ON)', { timeout: 30_000 }, async () => {
    // V_GS = 0 - 5 = -5V → well past Vto=-2.5 → fully on
    const netlist = `FQP27P06 logic-level
Vcc vcc 0 DC 5
Vg gate 0 DC 0
M1 load gate vcc vcc MFQP27P06 L=2u W=500u
RL load 0 1k
${MODELS_MOS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(load)')).toBeGreaterThan(3.5);
  });
});
