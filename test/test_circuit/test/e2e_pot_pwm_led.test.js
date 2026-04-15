import { describe, it, expect } from 'vitest';
import { AVRHarness } from '../src/avr/AVRHarness.js';
import { potToPwmProgram } from '../src/avr/programs.js';
import { Circuit, VoltageSource, Resistor, Potentiometer, LED } from '../src/index.js';

/**
 * E2E: Potentiometer → ADC → PWM → LED brightness.
 *
 *   +5V ─── pot_top ─┐
 *                    │
 *                    (10k)
 *                    │
 *                    ├── A0 (ADC)
 *                    │
 *                    (10k)
 *                    │
 *   GND ─── pot_bot ─┘
 *
 *   pin6 (PWM) ─── 220Ω ─── LED_anode, LED_cathode → GND
 */

function setupRig(wiperPos) {
  const avr = new AVRHarness();
  avr.loadProgram(potToPwmProgram());

  const circuit = new Circuit();
  // Fixed 5 V rail
  circuit.addComponent(new VoltageSource('V_CC', 'vcc', 'gnd', 5));
  // Potentiometer across vcc–gnd, wiper = 'a0'
  const pot = new Potentiometer('POT', 'vcc', 'a0', 'gnd', 10000, wiperPos);
  circuit.addComponent(pot);
  // ADC input impedance (very high) so the wiper isn't loaded
  circuit.addComponent(new Resistor('R_adc', 'a0', 'gnd', 100e6));
  // PWM pin drives an LED through a 220 Ω resistor
  const pin6 = new VoltageSource('V_PIN6', 'pin6', 'gnd', 0);
  circuit.addComponent(pin6);
  circuit.addComponent(new Resistor('R_led', 'pin6', 'led_a', 220));
  const led = new LED('LED', 'led_a', 'gnd', 'red');
  circuit.addComponent(led);

  // Bridge: recompute A0 voltage, inject into ADC
  circuit.solveDC();
  avr.setAnalogVoltage(0, circuit.nodeVoltage('a0'));

  return { avr, circuit, led, pin6, pot };
}

/**
 * Run the harness until the PWM output has stabilized, then compute the
 * average LED current over one PWM period by sampling OCR0A as the
 * instantaneous duty.
 */
function measure(avr, circuit, led, pin6, { cyclesToSettle = 200_000 } = {}) {
  avr.runCycles(cyclesToSettle);
  const duty = avr.getPWMDuty(6);   // 0..1
  // Average voltage delivered to the LED by a PWM signal:
  //   V_avg_source = duty · 5 V
  // Feed this into the circuit and compute brightness.
  pin6.setVoltage(duty * 5);
  circuit.solveDC();
  return {
    duty,
    ledCurrent: led.currentThrough(circuit.state),
    brightness: led.brightness(circuit.state),
  };
}

describe('E2E — Pot → analogRead → PWM → LED brightness', () => {
  it('produces monotonically increasing brightness as the wiper moves from 0 → 1', () => {
    const positions = [0.0, 0.25, 0.5, 0.75, 1.0];
    const results = positions.map(p => {
      const rig = setupRig(p);
      return {
        pos: p,
        a0: rig.circuit.nodeVoltage('a0'),
        ...measure(rig.avr, rig.circuit, rig.led, rig.pin6),
      };
    });

    // Log table for human inspection in test output
    for (const r of results) {
      console.log(
        `wiper=${r.pos.toFixed(2)}  V_A0=${r.a0.toFixed(3)}V  duty=${(r.duty*100).toFixed(1)}%  I_LED=${(r.ledCurrent*1000).toFixed(2)}mA  B=${r.brightness.toFixed(3)}`
      );
    }

    // Duty should track the wiper position
    expect(results[0].duty).toBeLessThan(0.05);
    expect(results[results.length - 1].duty).toBeGreaterThan(0.9);

    // Brightness monotonically increases
    for (let i = 1; i < results.length; i++) {
      expect(results[i].brightness).toBeGreaterThanOrEqual(results[i - 1].brightness - 0.01);
    }

    // End brightness > 0.5, start brightness < 0.05
    expect(results[0].brightness).toBeLessThan(0.05);
    expect(results[results.length - 1].brightness).toBeGreaterThan(0.5);
  });
});
