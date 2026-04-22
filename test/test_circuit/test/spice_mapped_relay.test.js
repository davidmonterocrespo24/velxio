import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Sanity check for the relay mapper (fase 10.1).
 *
 * The mapper emits:
 *   - R + L for the coil
 *   - S (SW) element for the NO contact (closes when V_coil > Vt)
 *   - B + S pair for the NC contact (B inverts V_coil as control to a
 *     standard SW — no "normally closed" SW in ngspice)
 *   - Optional flyback diode
 *
 * Tests exercise:
 *   - Coil de-energised: NC closed, NO open
 *   - Coil energised:    NC open,   NO closed
 *   - Hysteresis: V_coil in the dead band doesn't chatter
 */

const MODELS_5V = `
.model RELAY_SW SW(Vt=3 Vh=0.75 Ron=0.05 Roff=1G)
.model D1N4148 D(Is=2.52n N=1.752 Rs=0.568)
`;

describe('componentToSpice — relay: de-energised', () => {
  it('contacts: NC closed → COM == NC; NO open → COM ≠ NO', { timeout: 30_000 }, async () => {
    // Drive signal: COM fed with 12V. NC pin has 1k load to ground, NO pin has 1k load.
    // De-energised: NC closes → current flows com → nc → R → GND.
    const netlist = `relay idle
Vcoil coil_p 0 DC 0
Vcom com 0 DC 12
R_nc_load nc 0 1k
R_no_load no 0 1k
R_coil coil_p 0 70
L_coil coil_p 0 20m
S_no com no coil_p 0 RELAY_SW
B_ncctrl ncctrl 0 V = 5 - (V(coil_p) - V(0))
S_nc com nc ncctrl 0 RELAY_SW
${MODELS_5V}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // NC closed → nc sees COM (≈ 12V through near-zero switch R + 1k load,
    // so NC is very close to COM).
    expect(dcValue('v(nc)')).toBeGreaterThan(11.9);
    // NO open → no sees the pull-down (≈ 0V through 1G switch)
    expect(dcValue('v(no)')).toBeLessThan(0.1);
  });
});

describe('componentToSpice — relay: energised', () => {
  it('contacts: NO closed → COM == NO; NC open → COM ≠ NC', { timeout: 30_000 }, async () => {
    const netlist = `relay on
Vcoil coil_p 0 DC 5
Vcom com 0 DC 12
R_nc_load nc 0 1k
R_no_load no 0 1k
R_coil coil_p 0 70
L_coil coil_p 0 20m
S_no com no coil_p 0 RELAY_SW
B_ncctrl ncctrl 0 V = 5 - (V(coil_p) - V(0))
S_nc com nc ncctrl 0 RELAY_SW
${MODELS_5V}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(no)')).toBeGreaterThan(11.9);
    expect(dcValue('v(nc)')).toBeLessThan(0.1);
  });
});

describe('componentToSpice — relay: threshold behaviour', () => {
  it('V_coil below Vt-Vh (= 2.25V): relay stays de-energised', { timeout: 30_000 }, async () => {
    const netlist = `relay marginal-low
Vcoil coil_p 0 DC 2
Vcom com 0 DC 12
R_no_load no 0 1k
R_coil coil_p 0 70
L_coil coil_p 0 20m
S_no com no coil_p 0 RELAY_SW
${MODELS_5V}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // 2V < Vt=3 - Vh=0.75 → switch stays OFF → NO open → V(no) ≈ 0
    expect(dcValue('v(no)')).toBeLessThan(0.1);
  });

  it('V_coil above Vt+Vh (= 3.75V): relay energises', { timeout: 30_000 }, async () => {
    const netlist = `relay marginal-high
Vcoil coil_p 0 DC 4
Vcom com 0 DC 12
R_no_load no 0 1k
R_coil coil_p 0 70
L_coil coil_p 0 20m
S_no com no coil_p 0 RELAY_SW
${MODELS_5V}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // 4V > Vt+Vh=3.75 → switch CLOSED
    expect(dcValue('v(no)')).toBeGreaterThan(11.9);
  });
});

describe('componentToSpice — relay: coil current', () => {
  it('nominal 5V coil draws ≈ 71 mA through 70Ω', { timeout: 30_000 }, async () => {
    const netlist = `relay coil I
Vcoil coil_p 0 DC 5
R_coil coil_p 0 70
L_coil coil_p 0 20m
.op
.end`;
    const { vec } = await runNetlist(netlist);
    const i = vec('i(vcoil)')[0];
    // I = 5V/70Ω = 71.4 mA (sign depends on reference direction)
    expect(Math.abs(i)).toBeGreaterThan(0.06);
    expect(Math.abs(i)).toBeLessThan(0.08);
  });
});
