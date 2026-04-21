/**
 * Live ngspice check for a handful of representative analog examples.
 *
 * We don't run every one of the 30 circuits through WASM ngspice here —
 * that'd be ~15 s of CI time. Instead, four archetypes cover the main
 * element classes:
 *   - an-voltage-divider    (resistors + DC source)
 *   - an-half-wave-rectifier (diode + AC source, .tran)
 *   - an-bjt-switch         (BJT + switch waveform)
 *   - an-opamp-follower     (LM358 behavioral op-amp)
 *
 * Anything else should be covered by the per-mapper tests in
 * component-to-spice.test.ts + the shape tests in examples-analog.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { analogExamples } from '../data/examples-analog';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from '../simulation/spice/SpiceEngine';

const ARCHETYPES = [
  'an-voltage-divider',
  'an-half-wave-rectifier',
  'an-bjt-switch',
  'an-opamp-follower',
];

describe('analogExamples — representative ngspice solves', () => {
  for (const id of ARCHETYPES) {
    it(`${id} is solvable by ngspice`, { timeout: 30_000 }, async () => {
      const ex = analogExamples.find((e) => e.id === id);
      expect(ex, `${id} not found in analogExamples`).toBeDefined();

      const { netlist } = buildNetlist({
        components: ex!.components.map((c) => ({
          id: c.id,
          metadataId: c.type.replace(/^wokwi-/, ''),
          properties: c.properties ?? {},
        })),
        wires: ex!.wires.map((w) => ({
          id: w.id,
          start: { componentId: w.start.componentId, pinName: w.start.pinName },
          end: { componentId: w.end.componentId, pinName: w.end.pinName },
        })),
        boards: [],
        analysis: { kind: 'op' },
      });

      const result = await runNetlist(netlist);
      expect(result.variableNames.length).toBeGreaterThan(0);
      expect(Number.isFinite(result.dcValue(result.variableNames[0]))).toBe(true);
    });
  }
});
