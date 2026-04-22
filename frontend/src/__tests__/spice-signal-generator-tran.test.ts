/**
 * Phase 1-2 coverage:
 *   - `storeAdapter.buildInputFromStore` auto-switches to `.tran` when the
 *     circuit contains a non-DC `signal-generator`.
 *   - `CircuitScheduler` exposes `timeWaveforms` for `.tran` results and
 *     keeps `.op` results scalar-only.
 */
import { describe, it, expect } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from '../simulation/spice/SpiceEngine';
import type { StoreSnapshot } from '../simulation/spice/storeAdapter';
import type { PinSourceState } from '../simulation/spice/types';

function emptyArduino(): StoreSnapshot['boards'][number] {
  return {
    id: 'arduino-uno',
    boardKind: 'arduino-uno',
    pinStates: {} as Record<string, PinSourceState>,
  };
}

describe('storeAdapter — AC source detection', () => {
  it('all-DC circuit → .op analysis', () => {
    const input = buildInputFromStore({
      components: [{ id: 'r1', metadataId: 'resistor', properties: { value: '1k' } }],
      wires: [],
      boards: [emptyArduino()],
    });
    expect(input.analysis.kind).toBe('op');
  });

  it('signal-generator sine → .tran with step=1/(f*20), stop ≥ 4/f', () => {
    const input = buildInputFromStore({
      components: [
        {
          id: 'sg1',
          metadataId: 'signal-generator',
          properties: { waveform: 'sine', frequency: 50, amplitude: 5, offset: 0 },
        },
      ],
      wires: [],
      boards: [emptyArduino()],
    });
    expect(input.analysis.kind).toBe('tran');
    if (input.analysis.kind !== 'tran') return;
    // step ≈ 1 / (50 * 20) = 1e-3
    expect(parseFloat(input.analysis.step)).toBeCloseTo(1e-3, 10);
    // stop ≥ 4/50 = 80 ms (capped at 400 ms)
    const stop = parseFloat(input.analysis.stop);
    expect(stop).toBeGreaterThanOrEqual(80e-3);
    expect(stop).toBeLessThanOrEqual(0.4);
  });

  it('signal-generator with waveform=dc → .op', () => {
    const input = buildInputFromStore({
      components: [
        {
          id: 'sg1',
          metadataId: 'signal-generator',
          properties: { waveform: 'dc', offset: 2.5 },
        },
      ],
      wires: [],
      boards: [emptyArduino()],
    });
    expect(input.analysis.kind).toBe('op');
  });

  it('multiple AC sources → step resolves the highest freq, stop covers the lowest', () => {
    const input = buildInputFromStore({
      components: [
        {
          id: 'sgA',
          metadataId: 'signal-generator',
          properties: { waveform: 'sine', frequency: 50 },
        },
        {
          id: 'sgB',
          metadataId: 'signal-generator',
          properties: { waveform: 'square', frequency: 1000 },
        },
      ],
      wires: [],
      boards: [emptyArduino()],
    });
    expect(input.analysis.kind).toBe('tran');
    if (input.analysis.kind !== 'tran') return;
    // step set by the 1 kHz source: 1/(1000*20) = 5e-5
    expect(parseFloat(input.analysis.step)).toBeCloseTo(5e-5, 10);
    // stop set by the 50 Hz source: 4/50 = 80 ms
    expect(parseFloat(input.analysis.stop)).toBeGreaterThanOrEqual(80e-3);
  });
});

describe('end-to-end — half-wave rectifier produces valid sine + rectified output', () => {
  it('SIN source alone yields a ≥80-sample sinusoid through ngspice', async () => {
    const netlist = [
      '* sine test',
      'V1 in 0 SIN(0 5 50)',
      'R1 in 0 1k',
      '.tran 1e-3 8e-2',
      '.end',
    ].join('\n');

    const cooked = await runNetlist(netlist);
    const time = cooked.vec('time') as number[];
    const vIn = cooked.vec('v(in)') as number[];

    expect(time.length).toBeGreaterThanOrEqual(80);
    expect(vIn.length).toBe(time.length);

    // Expect at least one positive peak close to +5 V and one negative trough near -5 V.
    const vMax = Math.max(...vIn);
    const vMin = Math.min(...vIn);
    expect(vMax).toBeGreaterThan(4.5);
    expect(vMin).toBeLessThan(-4.5);
  }, 30_000);

  it('half-wave rectifier clips the negative half-cycle to ~-0.7 V (diode drop)', async () => {
    const netlist = [
      '* half-wave rectifier',
      'V1 in 0 SIN(0 5 50)',
      'D1 in out DMOD',
      'R1 out 0 1k',
      '.model DMOD D(Is=1e-14 N=1.0)',
      '.tran 1e-3 8e-2',
      '.end',
    ].join('\n');

    const cooked = await runNetlist(netlist);
    const vOut = cooked.vec('v(out)') as number[];

    // After settling, the load should see mostly positive voltage with peaks
    // ≈ 5 − 0.7 V. Negative excursions are clipped by the diode.
    const vMax = Math.max(...vOut);
    const vMin = Math.min(...vOut);
    expect(vMax).toBeGreaterThan(3.5);
    // Diode reverse-bias: load stays close to 0 (tiny leakage current).
    expect(vMin).toBeGreaterThan(-0.5);
  }, 30_000);

  it('CircuitScheduler.solveNow populates timeWaveforms for .tran and leaves it undefined for .op', async () => {
    const { circuitScheduler } = await import('../simulation/spice/CircuitScheduler');

    const tranResult = await circuitScheduler.solveNow({
      components: [
        {
          id: 'sg1',
          metadataId: 'signal-generator',
          properties: { waveform: 'sine', frequency: 50, amplitude: 5, offset: 0 },
        },
        { id: 'r1', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'sg1', pinName: 'SIG' },
          end: { componentId: 'r1', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'r1', pinName: '2' },
          end: { componentId: 'sg1', pinName: 'GND' },
        },
      ],
      boards: [],
      analysis: { kind: 'tran', step: '1e-3', stop: '8e-2' },
    });

    expect(tranResult.analysisMode).toBe('tran');
    expect(tranResult.timeWaveforms).toBeDefined();
    expect(tranResult.timeWaveforms!.time.length).toBeGreaterThanOrEqual(40);

    const opResult = await circuitScheduler.solveNow({
      components: [{ id: 'r1', metadataId: 'resistor', properties: { value: '1k' } }],
      wires: [],
      boards: [],
      analysis: { kind: 'op' },
    });

    expect(opResult.analysisMode).toBe('op');
    expect(opResult.timeWaveforms).toBeUndefined();
  }, 30_000);

  it('CircuitScheduler keeps scalar nodeVoltages for .tran (last sample)', async () => {
    // Use a DC-driven resistor and force `.tran` — the steady-state voltage
    // at the last sample must equal the DC analysis value (5 V).
    const { circuitScheduler } = await import('../simulation/spice/CircuitScheduler');

    const result = await circuitScheduler.solveNow({
      components: [],
      wires: [],
      boards: [],
      extraCards: ['V1 probe 0 DC 5', 'R1 probe 0 1k'],
      analysis: { kind: 'tran', step: '1e-4', stop: '1e-3' },
    });

    expect(result.nodeVoltages['probe']).toBeCloseTo(5, 2);
  }, 30_000);
});
