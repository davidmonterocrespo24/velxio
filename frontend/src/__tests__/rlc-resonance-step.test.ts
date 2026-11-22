/**
 * A circuit with an inductor and a capacitor resonates where theory says, so
 * sweeping the generator finds f0 (velxio/velxio-prod#121).
 *
 * The transient's step was a twentieth of the generator's period. ngspice
 * integrates with the trapezoidal rule, which shifts every frequency like the
 * bilinear transform: at h = T/20 the series RLC of the book (10 Ω, 1 mH,
 * 1 µF; f0 = 1/(2π√(LC)) = 5032.9 Hz) resonated at f0·θ/tan θ with θ = π/20,
 * about 4991 Hz, and a sweep of the ammeter peaked at 4965-4995 Hz. A deck
 * with both an inductor and a capacitor now runs at a hundredth of the
 * fastest period (0.03 % of shift), within 5000 steps for the shortest window.
 * Runs the app's analysis choice (storeAdapter), netlist builder, ngspice
 * (the Node adapter) and ammeter.
 */
import { describe, it, expect } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { readAmmeter } from '../simulation/spice/probes';
import { solveInput } from './helpers/solveInput';
import type { Wire } from '../types/wire';

const wire = (id: string, a: [string, string], b: [string, string]) =>
  ({ id, start: { componentId: a[0], pinName: a[1] }, end: { componentId: b[0], pinName: b[1] } }) as Wire;

const F0 = 1 / (2 * Math.PI * Math.sqrt(1e-3 * 1e-6)); // 5032.9 Hz

/** Generator -> ammeter -> 10 Ω -> 1 mH -> 1 µF -> back, 1 V peak. With
 *  `inductor: false` the coil is left out (an RC). */
function seriesRlc(frequency: number, { inductor = true } = {}) {
  const components = [
    { id: 'sg', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency, amplitude: 1, offset: 0 } },
    { id: 'am', metadataId: 'instr-ammeter', properties: {} },
    { id: 'r1', metadataId: 'resistor', properties: { value: '10' } },
    ...(inductor ? [{ id: 'l1', metadataId: 'inductor', properties: { value: '1m' } }] : []),
    { id: 'c1', metadataId: 'capacitor', properties: { value: '1u' } },
  ];
  const wires = [
    wire('w1', ['sg', 'SIG'], ['am', 'A+']),
    wire('w2', ['am', 'A-'], ['r1', '1']),
    ...(inductor
      ? [wire('w3', ['r1', '2'], ['l1', '1']), wire('w4', ['l1', '2'], ['c1', '1'])]
      : [wire('w3', ['r1', '2'], ['c1', '1'])]),
    wire('w5', ['c1', '2'], ['sg', 'GND']),
  ];
  return { components, wires };
}

function tranOf(frequency: number, opts?: { inductor?: boolean }) {
  const { components, wires } = seriesRlc(frequency, opts);
  const input = buildInputFromStore({ components, wires, boards: [] });
  if (input.analysis.kind !== 'tran') throw new Error(`expected a transient, got ${input.analysis.kind}`);
  return { input, components, step: Number(input.analysis.step), stop: Number(input.analysis.stop) };
}

describe('a deck that can resonate runs at a finer step', () => {
  it('the series RLC at 5 kHz steps at a hundredth of its period (it was a twentieth)', () => {
    const { step } = tranOf(5000);
    expect(step).toBeLessThanOrEqual((1 / (5000 * 100)) * 1.001);
  });

  it('an RC with no inductor keeps a twentieth of the period', () => {
    const { step } = tranOf(5000, { inductor: false });
    expect(step).toBeCloseTo(1 / (5000 * 20), 12);
  });

  it('a fast resonant deck holds at most 5000 steps in its shortest window, and never runs coarser than before', () => {
    for (const f of [20e3, 50e3, 200e3]) {
      const { step, stop } = tranOf(f);
      expect(step, `${f} Hz`).toBeLessThanOrEqual((1 / (f * 20)) * 1.001);
      expect(stop / step, `${f} Hz`).toBeLessThanOrEqual(Math.max(5000, (stop * f * 20)) * 1.001);
    }
  });
});

describe('sweeping the generator finds the resonance', () => {
  it('the ammeter reads its largest RMS within 10 Hz of f0 = 5032.9 Hz (it peaked at 4990 Hz)', { timeout: 120_000 }, async () => {
    let best = { f: 0, rms: 0 };
    for (let f = 4960; f <= 5100; f += 10) {
      const { input, components } = tranOf(f);
      const solve = await solveInput(input);
      const reading = readAmmeter(components[1]!, solve, solve.timeWaveforms);
      expect(reading.ac, `${f} Hz`).toBeDefined();
      if (reading.ac!.rms > best.rms) best = { f, rms: reading.ac!.rms };
    }
    expect(Math.abs(best.f - F0), `largest RMS at ${best.f} Hz`).toBeLessThanOrEqual(10);
    // At resonance only the resistance is left: 1 V / (10 Ω + the meter's
    // 1 mΩ shunt), 70.70 mA RMS.
    expect(best.rms).toBeGreaterThan((1 / 10.001) * Math.SQRT1_2 * 0.999);
  });
});
