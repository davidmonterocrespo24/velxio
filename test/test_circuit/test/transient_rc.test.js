import { describe, it, expect } from 'vitest';
import { Circuit, Resistor, VoltageSource, Capacitor } from '../src/index.js';

describe('RC transient — charging curve', () => {
  it('V(τ) ≈ 63.2% of V_source  (R=10k, C=100µF, V=5V)', () => {
    const R = 10000;
    const C = 100e-6;
    const V = 5;
    const tau = R * C; // 1s

    const circuit = new Circuit();
    circuit.addComponent(new VoltageSource('V1', 'vcc', 'gnd', V));
    circuit.addComponent(new Resistor('R1', 'vcc', 'out', R));
    circuit.addComponent(new Capacitor('C1', 'out', 'gnd', C, 0));

    const dt = 0.005;        // 5 ms
    const samples = circuit.runTransient(tau * 3, dt, 10);

    // Find sample nearest t = τ
    const target = samples.find(s => Math.abs(s.t - tau) < dt);
    expect(target).toBeDefined();
    const Vt = target.nodeVoltages.out;
    const expected = V * (1 - 1 / Math.E);
    expect(Vt).toBeGreaterThan(expected * 0.95);
    expect(Vt).toBeLessThan(expected * 1.05);

    // Final value ≈ V
    const last = samples[samples.length - 1];
    expect(last.nodeVoltages.out).toBeGreaterThan(V * 0.90);
  });

  it('5τ reaches > 99% of V_source', () => {
    const R = 1000;
    const C = 1e-6;
    const V = 3.3;
    const tau = R * C; // 1 ms

    const circuit = new Circuit();
    circuit.addComponent(new VoltageSource('V1', 'vcc', 'gnd', V));
    circuit.addComponent(new Resistor('R1', 'vcc', 'out', R));
    circuit.addComponent(new Capacitor('C1', 'out', 'gnd', C, 0));

    circuit.runTransient(5 * tau, tau / 200);
    expect(circuit.nodeVoltage('out')).toBeGreaterThan(V * 0.99);
  });
});

describe('RC transient — discharge', () => {
  it('capacitor pre-charged to 5V discharges through R', () => {
    const R = 10000;
    const C = 10e-6;
    const tau = R * C; // 0.1 s

    const circuit = new Circuit();
    circuit.addComponent(new Resistor('R1', 'out', 'gnd', R));
    circuit.addComponent(new Capacitor('C1', 'out', 'gnd', C, 5));  // pre-charged

    const samples = circuit.runTransient(3 * tau, tau / 100, 10);
    // V(τ) ≈ 5 · 1/e = 1.84 V
    const atTau = samples.find(s => Math.abs(s.t - tau) < 0.002);
    expect(atTau.nodeVoltages.out).toBeGreaterThan(1.5);
    expect(atTau.nodeVoltages.out).toBeLessThan(2.2);
  });
});
