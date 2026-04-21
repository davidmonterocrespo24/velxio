import { describe, it, expect } from 'vitest';
import { AVRHarness } from '../src/avr/AVRHarness.js';
import { adcReadProgram } from '../src/avr/programs.js';
import { Circuit, VoltageSource, Resistor, NTCThermistor } from '../src/index.js';

/**
 * E2E: NTC thermistor divider → ADC → temperature reading.
 *
 *   +5V ─── R_pullup (10 kΩ) ─┬── A0
 *                              │
 *                              NTC (10kΩ, β=3950)
 *                              │
 *   GND ─────────────────────── ┘
 *
 * Sketch just reads ADC and leaves the high byte in register r20
 * (and low byte in r21). The host converts back to temperature.
 */

function runAtTemperature(tempC) {
  const avr = new AVRHarness();
  avr.loadProgram(adcReadProgram());

  const c = new Circuit();
  c.addComponent(new VoltageSource('Vcc', 'vcc', 'gnd', 5));
  c.addComponent(new Resistor('Rpull', 'vcc', 'a0', 10000));
  const ntc = new NTCThermistor('NTC', 'a0', 'gnd', { R0: 10000, beta: 3950, T0: 298.15 });
  c.addComponent(ntc);
  ntc.setTemperatureC(tempC);
  c.solveDC();
  const v_a0 = c.nodeVoltage('a0');
  avr.setAnalogVoltage(0, v_a0);

  avr.runCycles(500_000); // several ADC conversions

  const ADCH = avr.cpu.data[0x79];
  const ADCL = avr.cpu.data[0x78];
  // Left-adjusted 10-bit result
  const raw = (ADCH << 2) | (ADCL >> 6);

  // Inverse Steinhart-β: given V_A0 reading from ADC, recover T
  const VccMeas = 5.0;
  const V_reading = (raw / 1023) * VccMeas;
  // R_ntc = R_pull · V / (Vcc − V)
  const R_meas = 10000 * V_reading / (VccMeas - V_reading);
  const T_meas_K = 1 / (1 / 298.15 + (1 / 3950) * Math.log(R_meas / 10000));
  const T_meas_C = T_meas_K - 273.15;

  return { v_a0, raw, R_ntc: ntc.resistance(), R_meas, T_meas_C };
}

describe('E2E — NTC thermistor → Arduino ADC → temperature', () => {
  it('recovers temperature within ±1 °C across 0–50 °C', () => {
    const tests = [0, 15, 25, 35, 50];
    const rows = tests.map(T => ({ T, ...runAtTemperature(T) }));
    for (const r of rows) {
      console.log(
        `T_set=${r.T.toFixed(0)}°C  V_A0=${r.v_a0.toFixed(3)}V  ADC=${r.raw}  ` +
        `R_ntc=${r.R_ntc.toFixed(0)}Ω  R_meas=${r.R_meas.toFixed(0)}Ω  ` +
        `T_meas=${r.T_meas_C.toFixed(2)}°C`
      );
      expect(r.T_meas_C).toBeGreaterThan(r.T - 1);
      expect(r.T_meas_C).toBeLessThan(r.T + 1);
    }
  });
});
