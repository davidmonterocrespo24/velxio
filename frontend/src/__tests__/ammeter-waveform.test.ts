/**
 * End-to-end test for the `readAmmeter(..., timeWaveforms)` AC path.
 *
 * Sine source (5 Vpk, 50 Hz) drives a 1 kΩ resistor through an inline
 * ammeter. Expected RMS current ≈ (5/√2) / 1000 ≈ 3.54 mA, peak ≈ 5 mA,
 * DC ≈ 0. The ammeter's SPICE model injects a 0 V sense source named
 * `v_<ammeterId>_sense`; `timeWaveforms.branches` reports the current
 * through that source sample-by-sample.
 */
import { describe, it, expect } from 'vitest';
import { readAmmeter } from '../simulation/spice/probes';
import type { ComponentForSpice } from '../simulation/spice/types';
import type { Wire } from '../types/wire';

describe('readAmmeter with .tran timeWaveforms', () => {
  it(
    'reports RMS ≈ Vpk/(√2·R), peak ≈ Vpk/R, DC ≈ 0 for a centered sine',
    { timeout: 30_000 },
    async () => {
      const { circuitScheduler } = await import('../simulation/spice/CircuitScheduler');

      const components: ComponentForSpice[] = [
        {
          id: 'sg1',
          metadataId: 'signal-generator',
          properties: { waveform: 'sine', frequency: 50, amplitude: 5, offset: 0 },
        },
        { id: 'r1', metadataId: 'resistor', properties: { value: '1k' } },
        { id: 'am', metadataId: 'instr-ammeter', properties: {} },
      ];
      // SIG → R → A+ [ammeter] A- → GND
      const wires: Wire[] = [
        {
          id: 'w1',
          start: { componentId: 'sg1', pinName: 'SIG' },
          end: { componentId: 'r1', pinName: '1' },
        } as Wire,
        {
          id: 'w2',
          start: { componentId: 'r1', pinName: '2' },
          end: { componentId: 'am', pinName: 'A+' },
        } as Wire,
        {
          id: 'w3',
          start: { componentId: 'am', pinName: 'A-' },
          end: { componentId: 'sg1', pinName: 'GND' },
        } as Wire,
      ];

      const solve = await circuitScheduler.solveNow({
        components,
        wires: wires.map((w) => ({ id: w.id, start: w.start, end: w.end })),
        boards: [],
        analysis: { kind: 'tran', step: '1e-3', stop: '8e-2' },
      });

      expect(solve.analysisMode).toBe('tran');
      expect(solve.timeWaveforms).toBeDefined();

      const am = components.find((c) => c.id === 'am')!;
      const reading = readAmmeter(am, solve, solve.timeWaveforms);

      expect(reading.kind).toBe('ammeter');
      expect(reading.stale).toBe(false);
      expect(reading.ac).toBeDefined();
      if (!reading.ac) return;

      // 5 V peak across 1 kΩ → 5 mA peak, 5/√2 mA RMS. Allow ±15 %.
      const idealRmsA = 5 / Math.sqrt(2) / 1000;
      const idealPeakA = 5 / 1000;
      expect(reading.ac.rms).toBeGreaterThan(idealRmsA * 0.85);
      expect(reading.ac.rms).toBeLessThan(idealRmsA * 1.15);
      expect(reading.ac.peak).toBeGreaterThan(idealPeakA * 0.9);
      expect(reading.ac.peak).toBeLessThan(idealPeakA * 1.1);
      expect(Math.abs(reading.ac.dc)).toBeLessThan(idealRmsA * 0.25);

      expect(reading.ac.rmsDisplay).toMatch(/^RMS /);
      expect(reading.ac.peakDisplay).toMatch(/^pk /);
      expect(reading.ac.dcDisplay).toMatch(/^DC /);
      // mA formatting (0.001 ≤ |i| < 1).
      expect(reading.ac.rmsDisplay).toMatch(/mA/);
      expect(reading.display).toBe(reading.ac.rmsDisplay);
    },
  );

  it('leaves `ac` undefined for a pure DC circuit (.op path)', { timeout: 30_000 }, async () => {
    const { circuitScheduler } = await import('../simulation/spice/CircuitScheduler');

    const components: ComponentForSpice[] = [
      { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
      { id: 'am', metadataId: 'instr-ammeter', properties: {} },
    ];
    const wires: Wire[] = [
      {
        id: 'w1',
        start: { componentId: 'uno', pinName: '5V' },
        end: { componentId: 'r1', pinName: '1' },
      } as Wire,
      {
        id: 'w2',
        start: { componentId: 'r1', pinName: '2' },
        end: { componentId: 'am', pinName: 'A+' },
      } as Wire,
      {
        id: 'w3',
        start: { componentId: 'am', pinName: 'A-' },
        end: { componentId: 'uno', pinName: 'GND' },
      } as Wire,
    ];

    const solve = await circuitScheduler.solveNow({
      components,
      wires: wires.map((w) => ({ id: w.id, start: w.start, end: w.end })),
      boards: [
        {
          id: 'uno',
          vcc: 5,
          pins: {},
          groundPinNames: ['GND'],
          vccPinNames: ['5V'],
        },
      ],
      analysis: { kind: 'op' },
    });

    expect(solve.analysisMode).toBe('op');
    expect(solve.timeWaveforms).toBeUndefined();

    const am = components.find((c) => c.id === 'am')!;
    const reading = readAmmeter(am, solve, solve.timeWaveforms);

    expect(reading.ac).toBeUndefined();
    // 5V / 220Ω = 22.7 mA.
    expect(Math.abs(reading.value)).toBeCloseTo(22.7, 0);
    expect(reading.display).toMatch(/mA/);
  });
});
