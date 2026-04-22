import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AVRHarness } from '../src/avr/AVRHarness.js';
import { Circuit, VoltageSource, Resistor, LED } from '../src/index.js';

const HEX = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/blink.hex'),
  'utf8',
);

describe('avr8js integration — blink sketch', () => {
  it('loads Intel HEX and toggles pin 13 (built-in LED)', () => {
    const avr = new AVRHarness();
    avr.load(HEX);

    const states = [];
    avr.onPinChange(13, (s) => states.push({ cycle: avr.cpu.cycles, state: s }));

    // Run ~2 seconds of CPU time (16 MHz) — at least several blinks
    avr.runCycles(16_000_000 * 2);
    // Expect at least a few transitions (default Arduino blink = 1Hz toggle)
    expect(states.length).toBeGreaterThan(2);
    // Both states should appear
    const saw0 = states.some(s => s.state === 0);
    const saw1 = states.some(s => s.state === 1);
    expect(saw0).toBe(true);
    expect(saw1).toBe(true);
  });

  it('drives a simulated LED through a 220Ω resistor when pin 13 is HIGH', () => {
    const avr = new AVRHarness();
    avr.load(HEX);

    // Build the external circuit:
    //   pin13 → R=220 → LED anode, cathode → GND
    const circuit = new Circuit();
    const pin13 = new VoltageSource('V_PIN13', 'pin13', 'gnd', 0);
    circuit.addComponent(pin13);
    circuit.addComponent(new Resistor('R1', 'pin13', 'anode', 220));
    const led = new LED('LED1', 'anode', 'gnd', 'red');
    circuit.addComponent(led);

    // Bridge: whenever pin13 changes, update the voltage source, resolve circuit
    const brightnessSamples = [];
    avr.onPinChange(13, (s) => {
      pin13.setVoltage(s ? 5.0 : 0.0);
      circuit.solveDC();
      brightnessSamples.push(led.brightness(circuit.state));
    });

    avr.runCycles(16_000_000 * 2);  // 2 s

    // Should have sampled multiple states
    expect(brightnessSamples.length).toBeGreaterThan(1);
    // On/off brightness must bracket 0 and significant
    const max = Math.max(...brightnessSamples);
    const min = Math.min(...brightnessSamples);
    expect(min).toBeLessThan(0.01);
    expect(max).toBeGreaterThan(0.5);
  });
});
