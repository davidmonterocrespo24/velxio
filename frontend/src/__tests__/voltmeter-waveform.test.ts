/**
 * End-to-end test for the `readVoltmeter(..., timeWaveforms)` AC path.
 *
 * Sets up a 50 Hz, 5 Vpk sine source driving a 1 kΩ load with a voltmeter
 * across it. Solves through CircuitScheduler (full `.tran` path), then
 * invokes readVoltmeter with both the scalar solve result and the time-domain
 * waveforms. The returned reading MUST contain `ac` stats with:
 *   - rms   ≈ 5 / √2 ≈ 3.536 V
 *   - peak  ≈ 5 V
 *   - dc    ≈ 0 V
 */
import { describe, it, expect } from 'vitest';
import { buildPinNetLookup, readVoltmeter } from '../simulation/spice/probes';
import type { ComponentForSpice } from '../simulation/spice/types';
import type { Wire } from '../types/wire';

describe('readVoltmeter with .tran timeWaveforms', () => {
  it(
    'reports RMS ≈ Vpk/√2, peak ≈ Vpk, DC ≈ 0 for a centered sine',
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
        { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
      ];
      const wires: Wire[] = [
        // SIG → R → GND
        {
          id: 'w1',
          start: { componentId: 'sg1', pinName: 'SIG' },
          end: { componentId: 'r1', pinName: '1' },
        } as Wire,
        {
          id: 'w2',
          start: { componentId: 'r1', pinName: '2' },
          end: { componentId: 'sg1', pinName: 'GND' },
        } as Wire,
        // Voltmeter V+ across the hot net, V− to signal-generator GND
        {
          id: 'w3',
          start: { componentId: 'vm', pinName: 'V+' },
          end: { componentId: 'r1', pinName: '1' },
        } as Wire,
        {
          id: 'w4',
          start: { componentId: 'vm', pinName: 'V-' },
          end: { componentId: 'sg1', pinName: 'GND' },
        } as Wire,
      ];

      const solve = await circuitScheduler.solveNow({
        components,
        wires,
        boards: [],
        analysis: { kind: 'tran', step: '1e-3', stop: '8e-2' },
      });

      expect(solve.analysisMode).toBe('tran');
      expect(solve.timeWaveforms).toBeDefined();

      // Build the same Union-Find-based net lookup the store uses so readVoltmeter
      // can find the probed nets. signal-generator's GND is the canonical ground.
      const netLookup = buildPinNetLookup(
        wires.map((w) => ({ id: w.id, start: w.start, end: w.end })),
        [{ componentId: 'sg1', pinName: 'GND' }],
        [],
      );

      const vm = components.find((c) => c.id === 'vm')!;
      const reading = readVoltmeter(vm, netLookup, solve, solve.timeWaveforms);

      expect(reading.kind).toBe('voltmeter');
      expect(reading.stale).toBe(false);
      expect(reading.ac).toBeDefined();
      if (!reading.ac) return;

      // Classical AC relations for a centered sine of amplitude 5 V.
      // ngspice uses adaptive time-stepping, so sample-based RMS has a small
      // bias from non-uniform sampling — ±15 % window is plenty for a sanity check.
      const idealRms = 5 / Math.sqrt(2);
      expect(reading.ac.rms).toBeGreaterThan(idealRms * 0.85);
      expect(reading.ac.rms).toBeLessThan(idealRms * 1.15);
      expect(reading.ac.peak).toBeGreaterThan(4.5);
      expect(reading.ac.peak).toBeLessThan(5.1);
      expect(Math.abs(reading.ac.dc)).toBeLessThan(0.5);

      // Display strings should lead with the RMS formatted value.
      expect(reading.ac.rmsDisplay).toMatch(/^RMS /);
      expect(reading.ac.peakDisplay).toMatch(/^pk /);
      expect(reading.ac.dcDisplay).toMatch(/^DC /);
      // The top-line `display` field should now be the RMS string (not the scalar).
      expect(reading.display).toBe(reading.ac.rmsDisplay);
    },
  );

  it('leaves `ac` undefined for a pure DC circuit (.op path)', { timeout: 30_000 }, async () => {
    const { circuitScheduler } = await import('../simulation/spice/CircuitScheduler');

    const components: ComponentForSpice[] = [
      { id: 'r1', metadataId: 'resistor', properties: { value: '1k' } },
      { id: 'r2', metadataId: 'resistor', properties: { value: '2k' } },
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
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
        end: { componentId: 'r2', pinName: '1' },
      } as Wire,
      {
        id: 'w3',
        start: { componentId: 'r2', pinName: '2' },
        end: { componentId: 'uno', pinName: 'GND' },
      } as Wire,
      {
        id: 'w4',
        start: { componentId: 'vm', pinName: 'V+' },
        end: { componentId: 'r1', pinName: '2' },
      } as Wire,
      {
        id: 'w5',
        start: { componentId: 'vm', pinName: 'V-' },
        end: { componentId: 'uno', pinName: 'GND' },
      } as Wire,
    ];

    const solve = await circuitScheduler.solveNow({
      components,
      wires,
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

    const netLookup = buildPinNetLookup(
      wires.map((w) => ({ id: w.id, start: w.start, end: w.end })),
      [{ componentId: 'uno', pinName: 'GND' }],
      [{ componentId: 'uno', pinName: '5V' }],
    );

    const vm = components.find((c) => c.id === 'vm')!;
    const reading = readVoltmeter(vm, netLookup, solve, solve.timeWaveforms);

    expect(reading.ac).toBeUndefined();
    // Midpoint divider: 5 V · 2k/(1k+2k) = 3.33 V. Display is the scalar.
    expect(Math.abs(reading.value) + 0).toBeGreaterThan(0);
    expect(reading.display).toMatch(/3\.3\d+ V/);
  });
});
