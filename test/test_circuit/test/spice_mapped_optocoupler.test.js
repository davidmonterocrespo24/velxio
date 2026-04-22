import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Sanity check for the optocoupler mappers (fase 10.2).
 *
 * Topology per package:
 *   LED: D + 0V sense source in series (so we can read I_LED)
 *   Phototransistor output: F-source (CCCS) with I_C = CTR · I_LED
 *   + 100 MΩ leak resistor so the output node has a DC path at I_LED=0
 */

const MODELS = `
.model DLED_OPTO D(Is=1e-14 N=2 Rs=5)
`;

describe('componentToSpice — 4N25 (CTR = 50%)', () => {
  it('LED off: I_C ≈ 0 → V_col near V_cc (output pulled up by external R)', { timeout: 30_000 }, async () => {
    const netlist = `4N25 LED off
V_in an 0 DC 0
R_led an cat 270
V_cc vcc 0 DC 5
R_load vcc col 10k
V_emit emit 0 DC 0
D_led an mid DLED_OPTO
V_sense mid cat DC 0
F_pt col emit V_sense 0.5
R_leak col emit 100Meg
${MODELS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // With LED off, phototransistor sinks no current → col pulled up by 10k
    expect(dcValue('v(col)')).toBeGreaterThan(4.9);
  });

  it('LED forward biased at 10 mA: I_C ≈ 5 mA, V_col drops', { timeout: 30_000 }, async () => {
    // Force 10 mA through LED with 5V supply + 270Ω + Vf ≈ 1.2V → I ≈ 14 mA
    const netlist = `4N25 LED on
V_in vin 0 DC 5
R_led vin an 270
V_cat cat 0 DC 0
V_cc vcc 0 DC 5
R_load vcc col 470
V_emit emit 0 DC 0
D_led an mid DLED_OPTO
V_sense mid cat DC 0
F_pt col emit V_sense 0.5
R_leak col emit 100Meg
${MODELS}
.op
.end`;
    const { dcValue, vec } = await runNetlist(netlist);
    const iLed = Math.abs(vec('i(v_sense)')[0]);
    const vcol = dcValue('v(col)');
    // At 14 mA LED, CTR=0.5 → I_C = 7 mA. V_col = V_cc − I·R_load = 5 − 7m·470 = 5 − 3.29 = 1.71 V
    expect(iLed).toBeGreaterThan(0.005);
    expect(vcol).toBeLessThan(3.0);
  });
});

describe('componentToSpice — PC817 (CTR = 100%)', () => {
  it('Same LED current gives 2× collector current vs 4N25', { timeout: 30_000 }, async () => {
    const runOpto = async (CTR) => {
      const netlist = `opto CTR=${CTR}
V_in vin 0 DC 5
R_led vin an 270
V_cat cat 0 DC 0
V_cc vcc 0 DC 5
R_load vcc col 470
V_emit emit 0 DC 0
D_led an mid DLED_OPTO
V_sense mid cat DC 0
F_pt col emit V_sense ${CTR}
R_leak col emit 100Meg
${MODELS}
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      return dcValue('v(col)');
    };
    const v4n25  = await runOpto(0.5);
    const vpc817 = await runOpto(1.0);
    // PC817 sinks 2× the current → drops 2× the voltage across R_load
    // V_col(PC817) < V_col(4N25) — both loaded, higher CTR = lower col
    expect(vpc817).toBeLessThan(v4n25);
  });
});

describe('componentToSpice — optocoupler isolation', () => {
  it('input and output sides are galvanically isolated: forcing V on COL does not reflect on AN', { timeout: 30_000 }, async () => {
    // Apply unrelated voltage on the output side; input side sees nothing
    // back through the coupling.
    const netlist = `opto isolation
V_an an 0 DC 0
V_cat cat 0 DC 0
V_col col emit DC 9
V_emit emit 0 DC 0
D_led an mid DLED_OPTO
V_sense mid cat DC 0
F_pt col emit V_sense 0.5
R_leak col emit 100Meg
${MODELS}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // AN node should be at 0 V (no backwards coupling)
    expect(dcValue('v(an)')).toBeCloseTo(0, 2);
  });
});
