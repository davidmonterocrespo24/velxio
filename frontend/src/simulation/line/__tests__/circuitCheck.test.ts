/**
 * A refused line sensor reaches the circuit check at Run, attached to its
 * component, and a refusal for a component no longer on the canvas does not.
 * The input carries an analysis, as buildInputFromStore's always does: the
 * check reads it to decide whether to solve a transient (#117).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyCircuit } from '../../verify/circuitVerifier';
import { clearLineGaps, requestLine } from '../requestLine';

describe('circuit check: unsupported line sensors', () => {
  beforeEach(() => {
    clearLineGaps();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('surfaces a recorded refusal as a non-blocking warning on the component', async () => {
    requestLine(null, { sensor_type: 'dht22', pin: 4 }, { componentId: 'dht22-1' });
    const result = await verifyCircuit({
      components: [{ id: 'dht22-1', metadataId: 'dht22', properties: {} }],
      boards: [],
      wires: [],
      analysis: { kind: 'op' },
    } as never);
    const w = result.warnings.find((x) => x.code === 'unsupported-sensor');
    expect(w).toBeDefined();
    expect(w!.componentId).toBe('dht22-1');
    expect(w!.severity).toBe('warning');
    expect(w!.message).toContain('dht22 on GPIO 4');
    expect(result.errors.some((x) => x.code === 'unsupported-sensor')).toBe(false);
  });

  it('drops a refusal whose component is no longer on the canvas', async () => {
    requestLine(null, { sensor_type: 'dht22', pin: 4 }, { componentId: 'gone' });
    const result = await verifyCircuit({ components: [], boards: [], wires: [], analysis: { kind: 'op' } } as never);
    expect(result.warnings.some((x) => x.code === 'unsupported-sensor')).toBe(false);
  });
});
