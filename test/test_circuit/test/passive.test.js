import { describe, it, expect } from 'vitest';
import { Circuit, Resistor, VoltageSource, CurrentSource, Potentiometer, NTCThermistor, Switch } from '../src/index.js';

describe('Passive DC — voltage divider', () => {
  it('R1=1k, R2=2k, V=9V → Vout = 6V', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'vcc', 'gnd', 9));
    c.addComponent(new Resistor('R1', 'vcc', 'out', 1000));
    c.addComponent(new Resistor('R2', 'out', 'gnd', 2000));
    c.solveDC();
    expect(c.nodeVoltage('out')).toBeCloseTo(6.0, 3);
  });
  it('equal resistors → Vout = V/2', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'a', 'gnd', 5));
    c.addComponent(new Resistor('R1', 'a', 'b', 1000));
    c.addComponent(new Resistor('R2', 'b', 'gnd', 1000));
    c.solveDC();
    expect(c.nodeVoltage('b')).toBeCloseTo(2.5, 3);
  });
});

describe('Passive DC — Ohm and loop current', () => {
  it('V=5V, R=220Ω → I = 22.7 mA through V1 (negative = sourcing)', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'a', 'gnd', 5));
    c.addComponent(new Resistor('R1', 'a', 'gnd', 220));
    c.solveDC();
    // Branch current convention: positive current flows from + into source.
    // For a source supplying a load, the internal current is negative.
    expect(Math.abs(c.branchCurrent('V1'))).toBeCloseTo(5 / 220, 5);
  });
});

describe('Passive DC — parallel resistors', () => {
  it('three 3kΩ resistors in parallel = 1kΩ equivalent', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'a', 'gnd', 3));
    c.addComponent(new Resistor('R_series', 'a', 'p', 1000));  // Makes divider
    c.addComponent(new Resistor('R1', 'p', 'gnd', 3000));
    c.addComponent(new Resistor('R2', 'p', 'gnd', 3000));
    c.addComponent(new Resistor('R3', 'p', 'gnd', 3000));
    c.solveDC();
    // R_eq = 1k, divider 1k+1k → Vp = 1.5 V
    expect(c.nodeVoltage('p')).toBeCloseTo(1.5, 3);
  });
});

describe('Current source', () => {
  it('1 mA through 2.2kΩ to ground → 2.2V', () => {
    const c = new Circuit();
    c.addComponent(new CurrentSource('I1', 'gnd', 'a', 0.001));
    c.addComponent(new Resistor('R1', 'a', 'gnd', 2200));
    c.solveDC();
    expect(c.nodeVoltage('a')).toBeCloseTo(2.2, 3);
  });
});

describe('Potentiometer', () => {
  it('wiper at 50% of 10k across 5V → wiper = 2.5V', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'top', 'gnd', 5));
    const pot = new Potentiometer('P1', 'top', 'wiper', 'gnd', 10000, 0.5);
    c.addComponent(pot);
    // Load on wiper: 10 MΩ to prevent free-floating (ADC input impedance)
    c.addComponent(new Resistor('R_load', 'wiper', 'gnd', 10e6));
    c.solveDC();
    expect(c.nodeVoltage('wiper')).toBeCloseTo(2.5, 2);
  });
  it('wiper sweeps 0 → 1 monotonically', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'top', 'gnd', 5));
    const pot = new Potentiometer('P1', 'top', 'wiper', 'gnd', 10000, 0);
    c.addComponent(pot);
    c.addComponent(new Resistor('R_load', 'wiper', 'gnd', 10e6));
    const readings = [];
    for (let p = 0; p <= 1.0001; p += 0.25) {
      pot.setWiper(p);
      c.solveDC();
      readings.push(c.nodeVoltage('wiper'));
    }
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeGreaterThan(readings[i - 1] - 0.01);
    }
    expect(readings[0]).toBeLessThan(0.05);
    expect(readings[readings.length - 1]).toBeGreaterThan(4.9);
  });
});

describe('NTC Thermistor', () => {
  it('R at 25°C matches nominal', () => {
    const ntc = new NTCThermistor('NTC', 'a', 'b', { R0: 10000, T0: 298.15, beta: 3950 });
    ntc.setTemperatureC(25);
    expect(ntc.resistance()).toBeCloseTo(10000, 0);
  });
  it('R decreases with temperature', () => {
    const ntc = new NTCThermistor('NTC', 'a', 'b', { R0: 10000, T0: 298.15, beta: 3950 });
    ntc.setTemperatureC(0);
    const r0 = ntc.resistance();
    ntc.setTemperatureC(25);
    const r25 = ntc.resistance();
    ntc.setTemperatureC(50);
    const r50 = ntc.resistance();
    expect(r0).toBeGreaterThan(r25);
    expect(r25).toBeGreaterThan(r50);
    // Textbook ranges
    expect(r0).toBeGreaterThan(25000);
    expect(r0).toBeLessThan(35000);
    expect(r50).toBeGreaterThan(3000);
    expect(r50).toBeLessThan(5000);
  });
  it('NTC in divider produces expected ADC voltages', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'vcc', 'gnd', 5));
    c.addComponent(new Resistor('Rpull', 'vcc', 'a0', 10000));
    const ntc = new NTCThermistor('NTC', 'a0', 'gnd', { R0: 10000, beta: 3950 });
    c.addComponent(ntc);
    // Expected from R(T) = 10k·exp(3950·(1/T − 1/298.15)):
    //   R(0°C)  ≈ 33.6 kΩ → V = 5·33.6/(33.6+10) = 3.85 V
    //   R(25°C) = 10.0 kΩ → V = 2.50 V
    //   R(50°C) ≈ 3.6 kΩ  → V = 5·3.6/(3.6+10) = 1.32 V
    const tests = [
      { T: 0,  expectedV: 3.85, tol: 0.05 },
      { T: 25, expectedV: 2.50, tol: 0.05 },
      { T: 50, expectedV: 1.32, tol: 0.10 },
    ];
    for (const t of tests) {
      ntc.setTemperatureC(t.T);
      c.solveDC();
      expect(c.nodeVoltage('a0')).toBeGreaterThan(t.expectedV - t.tol);
      expect(c.nodeVoltage('a0')).toBeLessThan(t.expectedV + t.tol);
    }
  });
});

describe('Switch', () => {
  it('closed = conductive, open = isolated', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'vcc', 'gnd', 5));
    c.addComponent(new Resistor('R1', 'vcc', 'out', 1000));
    const sw = new Switch('SW', 'out', 'gnd', false);
    c.addComponent(sw);
    c.solveDC();
    // Open: Vout ≈ 5 V (no current through R1)
    expect(c.nodeVoltage('out')).toBeGreaterThan(4.9);
    sw.set(true);
    c.solveDC();
    // Closed: Vout ≈ 0 V
    expect(c.nodeVoltage('out')).toBeLessThan(0.05);
  });
});
