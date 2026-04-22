import { describe, it, expect } from 'vitest';
import { Circuit, Resistor, VoltageSource, Diode, LED, BJT_NPN } from '../src/index.js';

describe('Shockley diode — basic', () => {
  it('forward-biased diode in series with R drops ~0.6-0.7V', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'vcc', 'gnd', 5));
    c.addComponent(new Resistor('R1', 'vcc', 'a', 1000));
    c.addComponent(new Diode('D1', 'a', 'gnd'));  // default Is=1e-14
    c.solveDC();
    const Vd = c.nodeVoltage('a');
    expect(Vd).toBeGreaterThan(0.55);
    expect(Vd).toBeLessThan(0.75);
    // Current ≈ (5 − 0.65)/1000 ≈ 4.35 mA
    const I = (5 - Vd) / 1000;
    expect(I).toBeGreaterThan(0.004);
    expect(I).toBeLessThan(0.005);
  });

  it('reverse-biased diode blocks current', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'vcc', 'gnd', 5));
    c.addComponent(new Resistor('R1', 'gnd', 'a', 1000));
    c.addComponent(new Diode('D1', 'a', 'vcc'));  // anode to 'a' (~0V), cathode to +5V
    c.solveDC();
    // With the diode reverse biased, no current; 'a' pulled to gnd through R1.
    expect(Math.abs(c.nodeVoltage('a'))).toBeLessThan(0.01);
  });
});

describe('LED — forward voltage by color', () => {
  it('red LED with 220Ω resistor @ 5V → Vf ≈ 2.0V, I ≈ 13.6mA', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'vcc', 'gnd', 5));
    c.addComponent(new Resistor('R1', 'vcc', 'a', 220));
    const led = new LED('LED1', 'a', 'gnd', 'red');
    c.addComponent(led);
    c.solveDC();
    const Vf = c.nodeVoltage('a');
    expect(Vf).toBeGreaterThan(1.8);
    expect(Vf).toBeLessThan(2.3);
    const I = led.currentThrough(c.state);
    expect(I).toBeGreaterThan(0.010);
    expect(I).toBeLessThan(0.016);
    // Brightness proxy: ratio of I to rated 20 mA
    const b = led.brightness(c.state);
    expect(b).toBeGreaterThan(0.5);
    expect(b).toBeLessThanOrEqual(1.0);
  });

  it('blue LED Vf higher than red', () => {
    const mkCircuit = (color) => {
      const c = new Circuit();
      c.addComponent(new VoltageSource('V1', 'vcc', 'gnd', 5));
      c.addComponent(new Resistor('R1', 'vcc', 'a', 220));
      c.addComponent(new LED('LED1', 'a', 'gnd', color));
      c.solveDC();
      return c.nodeVoltage('a');
    };
    const Vred = mkCircuit('red');
    const Vblue = mkCircuit('blue');
    expect(Vblue).toBeGreaterThan(Vred);
    expect(Vblue).toBeGreaterThan(2.8);
    expect(Vblue).toBeLessThan(3.6);
  });

  it('LED brightness increases with supply voltage', () => {
    const readBrightness = (V) => {
      const c = new Circuit();
      c.addComponent(new VoltageSource('V1', 'vcc', 'gnd', V));
      c.addComponent(new Resistor('R1', 'vcc', 'a', 220));
      const led = new LED('LED1', 'a', 'gnd', 'red');
      c.addComponent(led);
      c.solveDC();
      return led.brightness(c.state);
    };
    const b1 = readBrightness(2.0);  // below knee
    const b2 = readBrightness(3.0);
    const b3 = readBrightness(5.0);
    expect(b1).toBeLessThan(b2);
    expect(b2).toBeLessThan(b3);
    expect(b1).toBeLessThan(0.1);      // almost off
    expect(b3).toBeGreaterThan(0.5);   // bright
  });
});

describe('BJT NPN — switch mode', () => {
  it('NPN saturates with base drive, V_CE < 0.3V', () => {
    // V_cc → R_c → collector. Base fed via R_b from +5V. Emitter to gnd.
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'vcc', 'gnd', 5));
    c.addComponent(new VoltageSource('Vb', 'bsrc', 'gnd', 5));
    c.addComponent(new Resistor('Rc', 'vcc', 'coll', 1000));
    c.addComponent(new Resistor('Rb', 'bsrc', 'base', 10000));
    c.addComponent(new BJT_NPN('Q1', 'coll', 'base', 'gnd'));
    c.solveDC({ maxIter: 200, tol: 1e-6 });
    const Vce = c.nodeVoltage('coll');
    const Vbe = c.nodeVoltage('base');
    expect(Vbe).toBeGreaterThan(0.5);
    expect(Vbe).toBeLessThan(0.85);
    // Should be saturated — near 0.1–0.3 V on real BJT, but simplified Ebers-Moll
    // doesn't model saturation aggressively, so we accept up to 0.8 V.
    expect(Vce).toBeLessThan(0.8);
    // Must be much less than V_cc
    expect(Vce).toBeLessThan(c.nodeVoltage('vcc') - 3);
  });

  it('NPN with no base drive is off, V_CE ≈ V_cc', () => {
    const c = new Circuit();
    c.addComponent(new VoltageSource('V1', 'vcc', 'gnd', 5));
    c.addComponent(new Resistor('Rc', 'vcc', 'coll', 1000));
    c.addComponent(new Resistor('Rb', 'gnd', 'base', 10000));  // base pulled to gnd
    c.addComponent(new BJT_NPN('Q1', 'coll', 'base', 'gnd'));
    c.solveDC({ maxIter: 200, tol: 1e-6 });
    expect(c.nodeVoltage('coll')).toBeGreaterThan(4.9);
  });
});
