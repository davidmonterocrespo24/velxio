/**
 * Netlist snapshot tests (Phase 1d-tests A).
 *
 * For every example across ALL `examples-*.ts` modules, build the
 * SPICE netlist via the production pipeline and snapshot the FULL
 * netlist string.  If a refactor changes how `componentToSpice`,
 * `NetlistBuilder`, or `storeAdapter` emit cards, the diff lands in
 * `__snapshots__/examples-netlist-snapshot.test.ts.snap` and a
 * reviewer sees exactly what changed across every example.
 *
 * To intentionally update the snapshots after a legitimate model
 * change:
 *
 *   npx vitest run -u src/__tests__/examples-netlist-snapshot.test.ts
 *
 * The PR diff of the snapshot file becomes the evidence of which
 * circuits are affected.
 *
 * Test fidelity rule (memory `feedback_tests_import_real_code`):
 * imports the example arrays directly from the source modules and
 * uses the same `exampleToBuildNetlistInput` that production
 * `loadExample.ts` uses.  Nothing is duplicated.
 */
import { describe, it, expect } from 'vitest';
import { analogExamples } from '../data/examples-analog';
import { digitalExamples } from '../data/examples-digital';
import { hundredDaysExamples } from '../data/examples-100-days';
import { epaperExamples } from '../data/examples-displays-epaper';
import { circuitExamples } from '../data/examples-circuits';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import type { ExampleProject } from '../data/examples';

/**
 * Keep 12 significant digits of any number that prints more.
 *
 * The last bit of a double from Math.pow is not the same on every
 * platform: the photoresistor's `Math.pow(10 / lux, gamma)` printed
 * 1640.0431109149174 on the machine that wrote the snapshot and
 * 1640.0431109149172 on Linux (CI and the deploy gate), so a snapshot
 * taken on one failed on the other. Twelve digits are far beyond what
 * any circuit cares about and far above that one-bit noise. Numbers
 * that already print 12 digits or fewer are left exactly as emitted.
 */
function stableDigits(netlist: string): string {
  return netlist.replace(/\d+\.\d+(?:e[+-]?\d+)?/gi, (num) => {
    const digits = num.replace(/e.*$/i, '').replace('.', '').replace(/^0+/, '');
    return digits.length > 12 ? String(Number(Number(num).toPrecision(12))) : num;
  });
}

/**
 * Normalise the netlist before snapshotting:
 *   - strip the leading `* Velxio circuit @ <ISO timestamp>` comment
 *     (timestamp would flake every run)
 *   - keep 12 significant digits (see `stableDigits`)
 *
 * Everything else is verbatim — model lines, source ordering, etc.
 */
function snapshotNetlist(netlist: string): string {
  return stableDigits(netlist.replace(/^\* Velxio circuit @[^\n]*\n/, '* Velxio circuit\n'));
}

function snapshotExample(example: ExampleProject): string {
  // Some examples have no electrical components (firmware-only).  The
  // builder still produces a minimal netlist with the analysis card +
  // `.end`; snapshot that for completeness.
  const input = exampleToBuildNetlistInput(example);
  const { netlist } = buildNetlist(input);
  return snapshotNetlist(netlist);
}

interface Bucket {
  name: string;
  examples: ExampleProject[];
}

const BUCKETS: Bucket[] = [
  { name: 'analog', examples: analogExamples },
  { name: 'digital', examples: digitalExamples },
  { name: '100-days', examples: hundredDaysExamples },
  { name: 'epaper', examples: epaperExamples },
  { name: 'circuits', examples: circuitExamples },
];

for (const bucket of BUCKETS) {
  describe(`netlist snapshot — ${bucket.name} (${bucket.examples.length} examples)`, () => {
    it.each(bucket.examples.map((ex) => [ex.id, ex] as const))(
      '%s',
      { timeout: 5_000 },
      (_id, example) => {
        const netlist = snapshotExample(example);
        expect(netlist).toMatchSnapshot();
      },
    );
  });
}
