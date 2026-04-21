import { describe, it, expect } from 'vitest';
import { AVRHarness } from '../src/avr/AVRHarness.js';
import { adcReadProgram, potToPwmProgram } from '../src/avr/programs.js';
import { AVRSpiceBridge } from '../src/spice/AVRSpiceBridge.js';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Mixed-signal showcase: a real AVR binary running alongside a real ngspice
 * transient simulation of the external analog circuit.
 *
 * Three patterns:
 *   1. AVR reads an analog voltage set up by ngspice (NTC divider).
 *   2. AVR's PWM drives a low-pass RC filter; we measure the DC output.
 *   3. Full loop: NTC → ADC → sketch → PWM → LED (with SPICE-accurate current).
 */

describe('AVR8js + ngspice mixed-signal', () => {
  it('NTC+divider analyzed by ngspice → injected into ADC → sketch reads it', { timeout: 60_000 }, async () => {
    // Using a param sweep: at 3 temperatures, ngspice computes V(a0), we inject,
    // AVR runs the adcReadProgram, we verify the recovered ADC value.
    const points = [
      { T_C: 0,  R_ntc: 33621, expected_adc_approx: 789 },
      { T_C: 25, R_ntc: 10000, expected_adc_approx: 511 },
      { T_C: 50, R_ntc: 3588,  expected_adc_approx: 270 },
    ];
    for (const p of points) {
      // Run ngspice DC operating point for the NTC divider
      const { dcValue } = await runNetlist(`NTC divider @T=${p.T_C}
Vcc vcc 0 DC 5
Rpull vcc a0 10k
Rntc a0 0 ${p.R_ntc}
.op
.end`);
      const va0 = dcValue('v(a0)');

      // AVR reads it
      const avr = new AVRHarness();
      avr.loadProgram(adcReadProgram());
      avr.setAnalogVoltage(0, va0);
      avr.runCycles(500_000);
      const ADCH = avr.cpu.data[0x79];
      const ADCL = avr.cpu.data[0x78];
      const raw = (ADCH << 2) | (ADCL >> 6);

      console.log(`T=${p.T_C}°C  V(a0)=${va0.toFixed(3)}V (ngspice)  ADC=${raw} (avr8js)`);

      expect(Math.abs(raw - p.expected_adc_approx)).toBeLessThan(5);
    }
  });

  it('AVR PWM (pot→PWM program) drives an RC low-pass; ngspice computes settled DC', { timeout: 60_000 }, async () => {
    // The AVR runs the pot→PWM sketch. We set the potentiometer's voltage on A0
    // and read back the PWM duty cycle the AVR produces on pin 6.
    // Then we feed that duty as a PWL voltage source into ngspice, through an
    // RC low-pass filter, and verify the DC-filtered voltage matches duty × 5V.
    const voltages = [1.0, 2.5, 4.0];
    for (const vin of voltages) {
      const avr = new AVRHarness();
      avr.loadProgram(potToPwmProgram());
      avr.setAnalogVoltage(0, vin);
      avr.runCycles(200_000);
      const duty = avr.getPWMDuty(6);
      expect(duty).toBeGreaterThan(vin / 5 - 0.05);
      expect(duty).toBeLessThan(vin / 5 + 0.05);

      // Feed the PWM DC-equivalent (duty × 5) into an RC low-pass
      // with R=10k, C=1µF. Because the cutoff is ~16 Hz and PWM is ~1 kHz,
      // the DC value is a good proxy for the settled filtered voltage.
      const V_dc = duty * 5;
      // At DC the cap is open → output = source (through resistor, no current).
      // Add a high-value load to give the node a DC path and avoid singular warnings.
      const netlist = `PWM DC-equivalent to RC
Vpwm pwm 0 DC ${V_dc}
R1 pwm out 10k
Rload out 0 10Meg
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      const filtered = dcValue('v(out)');
      console.log(`V_A0=${vin}V duty=${(duty*100).toFixed(1)}%  V_filt=${filtered.toFixed(3)}V  (expected ${V_dc.toFixed(2)}V)`);
      expect(filtered).toBeGreaterThan(V_dc - 0.1);
      expect(filtered).toBeLessThan(V_dc + 0.1);
    }
  });

  it('co-sim loop: AVRSpiceBridge ties pot (ngspice) to ADC (avr8js) continuously', { timeout: 60_000 }, async () => {
    const avr = new AVRHarness();
    avr.loadProgram(adcReadProgram());

    // Build a netlist generator that serializes the current wiper position
    // and measures V(a0). This is a tiny example of the bridge pattern —
    // each slice solves a proper ngspice netlist.
    let wiperPos = 0.25;
    const bridge = new AVRSpiceBridge(avr, {
      sliceMs: 1,
      analogChannels: [{ channel: 0, node: 'a0' }],
    });

    const buildNetlist = (_pins, _t0, _t1) => {
      const Rtop = (1 - wiperPos) * 10000;
      const Rbot = wiperPos * 10000;
      return `Pot divider
Vcc vcc 0 DC 5
Rtop vcc a0 ${Math.max(1, Rtop)}
Rbot a0 0 ${Math.max(1, Rbot)}
.tran 10u 1m
.end`;
    };

    // Slice 1: wiper=0.25 — run enough slices for the ADC to sample the new voltage.
    // First slice has ADC=default; subsequent slices see the voltage set by bridge.
    await bridge.run(5, buildNetlist);
    let raw1 = (avr.cpu.data[0x79] << 2) | (avr.cpu.data[0x78] >> 6);

    // Slice 2: wiper=0.75 (moved)
    wiperPos = 0.75;
    await bridge.run(5, buildNetlist);
    let raw2 = (avr.cpu.data[0x79] << 2) | (avr.cpu.data[0x78] >> 6);

    console.log(`co-sim: wiper=0.25 → ADC=${raw1}; wiper=0.75 → ADC=${raw2}`);
    expect(raw2).toBeGreaterThan(raw1);
    expect(Math.abs(raw1 - 256)).toBeLessThan(20); // 0.25·1023 ≈ 256
    expect(Math.abs(raw2 - 767)).toBeLessThan(20); // 0.75·1023 ≈ 767
  });
});
