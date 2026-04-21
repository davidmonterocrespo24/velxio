/**
 * Mixed-signal co-simulation tests: avr8js running alongside ngspice.
 *
 * These are the flagship demonstrations that Velxio can emulate real
 * Arduino sketches interacting with real analog circuits. Ports the
 * sandbox's spice_avr_mixed.test.js directly into the Velxio frontend.
 */
import { describe, it, expect } from 'vitest';
import { runNetlist } from '../simulation/spice/SpiceEngine';
import { AVRTestHarness, adcReadProgram, potToPwmProgram } from './helpers/avrTestHarness';

describe('avr8js + ngspice mixed-signal', () => {
  it('NTC divider (ngspice) → AVR ADC read recovers the voltage', { timeout: 60_000 }, async () => {
    const points = [
      { TC: 0, Rntc: 33621, expectedADC: 789 },
      { TC: 25, Rntc: 10000, expectedADC: 511 },
      { TC: 50, Rntc: 3588, expectedADC: 270 },
    ];
    for (const p of points) {
      const { dcValue } = await runNetlist(`NTC divider @T=${p.TC}
Vcc vcc 0 DC 5
Rpull vcc a0 10k
Rntc a0 0 ${p.Rntc}
.op
.end`);
      const va0 = dcValue('v(a0)');

      const avr = new AVRTestHarness();
      avr.loadProgram(adcReadProgram());
      avr.setAnalogVoltage(0, va0);
      avr.runCycles(500_000);

      const ADCH = avr.reg(0x79);
      const ADCL = avr.reg(0x78);
      const raw = (ADCH << 2) | (ADCL >> 6);
      expect(Math.abs(raw - p.expectedADC)).toBeLessThan(5);
    }
  });

  it(
    'AVR PWM (pot→PWM program) drives ngspice RC filter; settled DC matches duty × 5V',
    { timeout: 60_000 },
    async () => {
      const voltages = [1.0, 2.5, 4.0];
      for (const vin of voltages) {
        const avr = new AVRTestHarness();
        avr.loadProgram(potToPwmProgram());
        avr.setAnalogVoltage(0, vin);
        avr.runCycles(200_000);
        const duty = avr.getPWMDuty(6);
        expect(duty).not.toBeNull();
        expect(duty!).toBeGreaterThan(vin / 5 - 0.05);
        expect(duty!).toBeLessThan(vin / 5 + 0.05);

        const Vdc = duty! * 5;
        const { dcValue } = await runNetlist(`PWM DC-equivalent to RC
Vpwm pwm 0 DC ${Vdc}
R1 pwm out 10k
Rload out 0 10Meg
.op
.end`);
        const filtered = dcValue('v(out)');
        expect(filtered).toBeGreaterThan(Vdc - 0.1);
        expect(filtered).toBeLessThan(Vdc + 0.1);
      }
    },
  );

  it(
    'co-sim loop: multiple ngspice .tran slices feed AVR ADC, pot movement is observable',
    { timeout: 60_000 },
    async () => {
      const avr = new AVRTestHarness();
      avr.loadProgram(adcReadProgram());

      async function stepBridge(wiperPos: number, sliceCount: number) {
        for (let s = 0; s < sliceCount; s++) {
          avr.runCycles(16_000); // 1 ms at 16 MHz
          const Rtop = Math.max(1, (1 - wiperPos) * 10_000);
          const Rbot = Math.max(1, wiperPos * 10_000);
          const result = await runNetlist(`Pot divider
Vcc vcc 0 DC 5
Rtop vcc a0 ${Rtop}
Rbot a0 0 ${Rbot}
.tran 10u 1m
.end`);
          const vEnd = (result.vec('v(a0)') as number[]).at(-1) ?? 0;
          avr.setAnalogVoltage(0, vEnd);
        }
      }

      await stepBridge(0.25, 5);
      const raw1 = (avr.reg(0x79) << 2) | (avr.reg(0x78) >> 6);

      await stepBridge(0.75, 5);
      const raw2 = (avr.reg(0x79) << 2) | (avr.reg(0x78) >> 6);

      expect(raw2).toBeGreaterThan(raw1);
      expect(Math.abs(raw1 - 256)).toBeLessThan(30); // 0.25·1023
      expect(Math.abs(raw2 - 767)).toBeLessThan(30); // 0.75·1023
    },
  );
});
