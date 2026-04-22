import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Sanity check for the L293D dual H-bridge motor driver mapper (fase 10.5).
 *
 * Per output: OUT = EN · IN · V_motor
 * When EN=LOW, outputs go high-impedance → weak pull to 0 V via 10 MΩ load.
 */

const T = 2.5;

function l293dNetlist({ en1, in1, in2, vMotor = 9 }) {
  return `L293D
Vcc2 vcc2 0 DC ${vMotor}
Ven en 0 DC ${en1}
Vin1 in1 0 DC ${in1}
Vin2 in2 0 DC ${in2}
B_ch1a out1 0 V = u(V(en)-${T}) * u(V(in1)-${T}) * V(vcc2)
R_ch1a_load out1 0 10Meg
B_ch1b out2 0 V = u(V(en)-${T}) * u(V(in2)-${T}) * V(vcc2)
R_ch1b_load out2 0 10Meg
.op
.end`;
}

describe('componentToSpice — L293D basic truth table', () => {
  it('EN=0: both outputs high-Z (≈ 0 V under weak load)', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(l293dNetlist({ en1: 0, in1: 5, in2: 0 }));
    expect(dcValue('v(out1)')).toBeLessThan(0.1);
    expect(dcValue('v(out2)')).toBeLessThan(0.1);
  });

  it('EN=HIGH, IN1=HIGH, IN2=LOW: OUT1=V_motor, OUT2=0 (forward)', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(l293dNetlist({ en1: 5, in1: 5, in2: 0 }));
    expect(dcValue('v(out1)')).toBeGreaterThan(8.5);
    expect(dcValue('v(out2)')).toBeLessThan(0.1);
  });

  it('EN=HIGH, IN1=LOW, IN2=HIGH: OUT1=0, OUT2=V_motor (reverse)', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(l293dNetlist({ en1: 5, in1: 0, in2: 5 }));
    expect(dcValue('v(out1)')).toBeLessThan(0.1);
    expect(dcValue('v(out2)')).toBeGreaterThan(8.5);
  });

  it('EN=HIGH, IN1=IN2=HIGH: both OUT=V_motor (brake — no voltage across motor)', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(l293dNetlist({ en1: 5, in1: 5, in2: 5 }));
    expect(dcValue('v(out1)')).toBeGreaterThan(8.5);
    expect(dcValue('v(out2)')).toBeGreaterThan(8.5);
    // Brake: V_out1 − V_out2 ≈ 0 → no motor torque
    expect(Math.abs(dcValue('v(out1)') - dcValue('v(out2)'))).toBeLessThan(0.2);
  });
});

describe('componentToSpice — L293D with V_motor variable', () => {
  it('motor voltage parameterizes the output level', { timeout: 30_000 }, async () => {
    for (const vm of [6, 9, 12]) {
      const { dcValue } = await runNetlist(l293dNetlist({ en1: 5, in1: 5, in2: 0, vMotor: vm }));
      expect(dcValue('v(out1)')).toBeGreaterThan(vm - 0.5);
      expect(dcValue('v(out1)')).toBeLessThan(vm + 0.5);
    }
  });
});
