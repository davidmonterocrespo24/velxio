/**
 * Integration test for the Half-Wave Rectifier example.
 *
 * Exercises the full pipeline:
 *   storeAdapter  → picks `.tran` because `signal-generator` is non-DC
 *   NetlistBuilder → emits SIN source + diode + load
 *   ngspice       → returns v(out) waveform with clipped negative half
 *   CircuitScheduler → populates timeWaveforms in the result
 *
 * Bug this test guards: before the Phase 1-2 fix, `.op` evaluated SIN at t=0
 * and returned 0 V, so `analogRead(A0)` read 0 in a loop — the user symptom.
 */
import { describe, it, expect } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { circuitScheduler } from '../simulation/spice/CircuitScheduler';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';

function rectifierSnapshot() {
  return {
    components: [
      {
        id: 'sg1',
        metadataId: 'signal-generator',
        properties: { waveform: 'sine', frequency: 50, amplitude: 5, offset: 0 },
      },
      { id: 'd1', metadataId: 'diode-1n4007', properties: {} },
      { id: 'rl', metadataId: 'resistor', properties: { value: '1000' } },
    ],
    wires: [
      {
        id: 'w1',
        start: { componentId: 'sg1', pinName: 'SIG' },
        end: { componentId: 'd1', pinName: 'A' },
      },
      {
        id: 'w2',
        start: { componentId: 'd1', pinName: 'C' },
        end: { componentId: 'rl', pinName: '1' },
      },
      {
        id: 'w3',
        start: { componentId: 'rl', pinName: '2' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
      },
      {
        id: 'w4',
        start: { componentId: 'sg1', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
      },
      {
        id: 'w5',
        start: { componentId: 'd1', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'A0' },
      },
    ],
    boards: [
      {
        id: 'arduino-uno',
        boardKind: 'arduino-uno' as const,
        pinStates: {},
      },
    ],
  };
}

describe('half-wave rectifier — end-to-end pipeline', () => {
  it('storeAdapter picks .tran and the netlist contains SIN + .tran cards', () => {
    const input = buildInputFromStore(rectifierSnapshot());
    expect(input.analysis.kind).toBe('tran');

    const { netlist } = buildNetlist(input);
    expect(netlist).toMatch(/SIN\(/);
    expect(netlist).toMatch(/\.tran\s/);
  });

  it('CircuitScheduler returns a v(A0-net) waveform with positive peaks and clipped trough', async () => {
    const input = buildInputFromStore(rectifierSnapshot());
    const result = await circuitScheduler.solveNow(input);

    expect(result.converged).toBe(true);
    expect(result.analysisMode).toBe('tran');
    expect(result.timeWaveforms).toBeDefined();
    const { timeWaveforms, pinNetMap } = result;
    if (!timeWaveforms) return;

    // The A0 pin maps to the diode cathode / resistor 1 net (through the
    // Union-Find). Look it up through pinNetMap rather than guessing.
    const a0Net = pinNetMap.get('arduino-uno:A0');
    expect(a0Net).toBeDefined();
    if (!a0Net) return;

    const samples = timeWaveforms.nodes.get(a0Net);
    expect(samples).toBeDefined();
    if (!samples) return;

    // Drop the first period so the RC/decoupling transient doesn't bias the
    // statistics — we want steady-state behavior.
    const periodSamples = Math.floor(samples.length / 4); // ≈ one 50 Hz period
    const steady = samples.slice(periodSamples);

    const vMax = Math.max(...steady);
    const vMin = Math.min(...steady);
    // A real 1N4007 drops ~0.7-0.9 V, so the peak is around 5 − 0.8 ≈ 4.2 V.
    // SPICE's default D model may give slightly different Vf; allow a loose
    // range but demand we see a real positive swing.
    expect(vMax).toBeGreaterThan(3.0);
    // Reverse bias: the diode blocks, so the load voltage stays at/near 0.
    expect(vMin).toBeGreaterThan(-0.2);

    // The rectified waveform must have *both* positive excursions and near-
    // zero valleys within one steady-state window — otherwise we're back to
    // the `.op` bug where everything sits at one DC value.
    const highs = steady.filter((v) => v > 1.5).length;
    const lows = steady.filter((v) => v < 0.2).length;
    expect(highs).toBeGreaterThanOrEqual(5);
    expect(lows).toBeGreaterThanOrEqual(5);
  }, 30_000);

  it('all-DC circuit → .op, no timeWaveforms (regression guard for the >20 DC examples)', async () => {
    const input = buildInputFromStore({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '1000' } },
        { id: 'led', metadataId: 'led', properties: { color: 'red' } },
      ],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'arduino-uno', pinName: '13' },
          end: { componentId: 'r1', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'r1', pinName: '2' },
          end: { componentId: 'led', pinName: 'A' },
        },
        {
          id: 'w3',
          start: { componentId: 'led', pinName: 'C' },
          end: { componentId: 'arduino-uno', pinName: 'GND' },
        },
      ],
      boards: [
        {
          id: 'arduino-uno',
          boardKind: 'arduino-uno' as const,
          pinStates: { '13': { type: 'digital', v: 5 } },
        },
      ],
    });

    expect(input.analysis.kind).toBe('op');
    const result = await circuitScheduler.solveNow(input);
    expect(result.analysisMode).toBe('op');
    expect(result.timeWaveforms).toBeUndefined();
  }, 30_000);
});
