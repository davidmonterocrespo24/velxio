/**
 * Phase 4 coverage: MCU-driven capacitor step response.
 *
 * When a sketch drives a pin HIGH into an RC network, the store adapter
 * must pick `.tran` (not `.op`) so ngspice produces the exponential charging
 * curve rather than just the steady-state endpoint.
 *
 * Circuit: pin D8 (HIGH) ── 10 kΩ ── cap 10 µF ── GND, with A0 probing
 * the capacitor node. τ = R·C = 100 ms, so after 5 τ = 500 ms the cap
 * should be within 1 % of Vcc.
 */
import { describe, it, expect } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import type { StoreSnapshot } from '../simulation/spice/storeAdapter';
import type { PinSourceState } from '../simulation/spice/types';

describe('storeAdapter — MCU-driven capacitor step response', () => {
  it('plain all-DC RC with no driven pin → .op (baseline)', () => {
    const input = buildInputFromStore({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } },
        { id: 'c1', metadataId: 'capacitor', properties: { value: '10u' } },
      ],
      wires: [],
      boards: [
        {
          id: 'uno',
          boardKind: 'arduino-uno',
          pinStates: {} as Record<string, PinSourceState>,
        },
      ],
    });
    expect(input.analysis.kind).toBe('op');
  });

  it('capacitor + driven pin → .tran with 5·τ window', () => {
    const input = buildInputFromStore({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } },
        { id: 'c1', metadataId: 'capacitor', properties: { value: '10u' } },
      ],
      wires: [],
      boards: [
        {
          id: 'uno',
          boardKind: 'arduino-uno',
          pinStates: { D8: { type: 'digital', v: 5 } } as Record<string, PinSourceState>,
        },
      ],
    });
    expect(input.analysis.kind).toBe('tran');
    if (input.analysis.kind !== 'tran') return;
    // Step should be 1e-4 (resolve τ=100 ms with ~1000 samples).
    expect(parseFloat(input.analysis.step)).toBeCloseTo(1e-4, 12);
    // Stop = 5·τ = 5·(10k·10µ) = 500 ms, capped at 400 ms by MAX_TRAN_STOP_S.
    const stop = parseFloat(input.analysis.stop);
    expect(stop).toBeGreaterThanOrEqual(0.2);
    expect(stop).toBeLessThanOrEqual(0.4);
  });

  it('inductor + PWM pin → .tran (RL step)', () => {
    const input = buildInputFromStore({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '100' } },
        { id: 'l1', metadataId: 'inductor', properties: { value: '10m' } },
      ],
      wires: [],
      boards: [
        {
          id: 'uno',
          boardKind: 'arduino-uno',
          pinStates: { D9: { type: 'pwm', duty: 0.5 } } as Record<string, PinSourceState>,
        },
      ],
    });
    expect(input.analysis.kind).toBe('tran');
  });

  it('capacitor + input-only pin (HiZ) → .op (not driven)', () => {
    const input = buildInputFromStore({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } },
        { id: 'c1', metadataId: 'capacitor', properties: { value: '10u' } },
      ],
      wires: [],
      boards: [
        {
          id: 'uno',
          boardKind: 'arduino-uno',
          pinStates: { A0: { type: 'input' } } as Record<string, PinSourceState>,
        },
      ],
    });
    expect(input.analysis.kind).toBe('op');
  });
});

describe('end-to-end — RC charging produces exponential trace', () => {
  it(
    'ngspice .tran on a 10k·10µ RC from 5V shows V_c(τ) ≈ 0.632·Vcc',
    { timeout: 30_000 },
    async () => {
      const { circuitScheduler } = await import('../simulation/spice/CircuitScheduler');

      // Use extraCards so we can stamp a clean DC step source regardless of
      // board plumbing — this asserts on the physics, not the adapter.
      const result = await circuitScheduler.solveNow({
        components: [],
        wires: [],
        boards: [],
        // Step source: 0V for the first 0 s, then 5V (rise 1µs)
        extraCards: ['V1 vin 0 PULSE(0 5 0 1u 1u 10 20)', 'R1 vin vcap 10k', 'C1 vcap 0 10u IC=0'],
        analysis: { kind: 'tran', step: '1e-3', stop: '5e-1' },
      });

      expect(result.analysisMode).toBe('tran');
      expect(result.timeWaveforms).toBeDefined();
      const wf = result.timeWaveforms!;
      const vcapSamples = wf.nodes.get('vcap');
      expect(vcapSamples).toBeDefined();
      if (!vcapSamples) return;

      const t = wf.time;
      // Find the sample closest to t = τ = 0.1 s
      let idxTau = 0;
      let bestTau = Infinity;
      const idxSettle = t.length - 1;
      for (let i = 0; i < t.length; i++) {
        const dTau = Math.abs(t[i] - 0.1);
        if (dTau < bestTau) {
          bestTau = dTau;
          idxTau = i;
        }
      }
      const vAtTau = vcapSamples[idxTau];
      const vSettled = vcapSamples[idxSettle];

      // V(τ) ≈ 5 · (1 − e⁻¹) ≈ 3.16 V. Wide-ish tolerance because of sampling.
      expect(vAtTau).toBeGreaterThan(2.8);
      expect(vAtTau).toBeLessThan(3.5);
      // After 5·τ = 500 ms, cap is ≥ 0.99·Vcc.
      expect(vSettled).toBeGreaterThan(4.9);
      expect(vSettled).toBeLessThanOrEqual(5.01);
      // First sample is at (or near) 0 V — initial condition honoured.
      expect(vcapSamples[0]).toBeLessThan(0.5);
    },
  );
});
