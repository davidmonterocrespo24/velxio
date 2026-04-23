/**
 * SPICE hot-path benchmarks.
 *
 * Two layers are measured separately because they have different cost
 * profiles and different regression sources:
 *
 *   - BENCH-SPICE-01..02 → NetlistBuilder (pure JS, Union-Find + string
 *     emission). Regressions here are caused by us.
 *
 *   - BENCH-SPICE-03   → ngspice solve (`.op` divider). Regressions here
 *     come from eecircuit-engine / ngspice-WASM, not our code. We track
 *     it anyway so an unexpected upstream slowdown trips the gate.
 *
 * The async ngspice bench is registered conditionally — tinybench v6
 * supports async fns natively. The engine boots once (singleton) so the
 * per-iteration cost is just netlist submission + solve.
 */

import type { Bench } from 'tinybench';
import { buildNetlist } from '../src/simulation/spice/NetlistBuilder';
import type {
  BuildNetlistInput,
  ComponentForSpice,
  WireForSpice,
  BoardForSpice,
} from '../src/simulation/spice/types';
import { runNetlist, getEngine } from '../src/simulation/spice/SpiceEngine';

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Voltage divider: 9V → 1k → out → 2k → GND.
 * Smallest non-trivial circuit. Builder cost is dominated by per-component
 * overhead (UF init, canonicalization, card emission).
 */
function dividerInput(): BuildNetlistInput {
  const components: ComponentForSpice[] = [
    { id: 'r1', metadataId: 'wokwi-resistor', properties: { value: '1k' } },
    { id: 'r2', metadataId: 'wokwi-resistor', properties: { value: '2k' } },
  ];
  const wires: WireForSpice[] = [
    { id: 'w1', start: { componentId: 'src', pinName: 'vcc' }, end: { componentId: 'r1', pinName: '1' } },
    { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'r2', pinName: '1' } },
    { id: 'w3', start: { componentId: 'r2', pinName: '2' }, end: { componentId: 'src', pinName: 'gnd' } },
  ];
  const boards: BoardForSpice[] = [
    {
      id: 'src',
      vcc: 9,
      pins: { vcc: { type: 'digital', v: 9 }, gnd: { type: 'digital', v: 0 } },
      groundPinNames: ['gnd'],
      vccPinNames: ['vcc'],
    },
  ];
  return { components, wires, boards, analysis: { kind: 'op' } };
}

/**
 * Wider mesh: 30 resistors in a regular grid. Stresses Union-Find merge
 * and net-name canonicalization, which are the hot inner loops.
 */
function meshInput(rows: number, cols: number): BuildNetlistInput {
  const components: ComponentForSpice[] = [];
  const wires: WireForSpice[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = `r_${r}_${c}`;
      components.push({ id, metadataId: 'wokwi-resistor', properties: { value: '1k' } });
      // Connect into the previous column / row.
      if (c > 0) {
        wires.push({
          id: `wcol_${r}_${c}`,
          start: { componentId: `r_${r}_${c - 1}`, pinName: '2' },
          end: { componentId: id, pinName: '1' },
        });
      } else {
        // Leftmost column ties to vcc.
        wires.push({
          id: `wsrc_${r}`,
          start: { componentId: 'src', pinName: 'vcc' },
          end: { componentId: id, pinName: '1' },
        });
      }
      if (r > 0) {
        wires.push({
          id: `wrow_${r}_${c}`,
          start: { componentId: `r_${r - 1}_${c}`, pinName: '2' },
          end: { componentId: id, pinName: '2' },
        });
      }
    }
  }
  // Rightmost column to gnd.
  for (let r = 0; r < rows; r++) {
    wires.push({
      id: `wgnd_${r}`,
      start: { componentId: `r_${r}_${cols - 1}`, pinName: '2' },
      end: { componentId: 'src', pinName: 'gnd' },
    });
  }
  const boards: BoardForSpice[] = [
    {
      id: 'src',
      vcc: 5,
      pins: { vcc: { type: 'digital', v: 5 }, gnd: { type: 'digital', v: 0 } },
      groundPinNames: ['gnd'],
      vccPinNames: ['vcc'],
    },
  ];
  return { components, wires, boards, analysis: { kind: 'op' } };
}

const DIVIDER_NETLIST = `VDIV
V1 vcc 0 DC 9
R1 vcc out 1k
R2 out 0 2k
.op
.end`;

// ── Registration ────────────────────────────────────────────────────────────

export function registerSpiceBenches(bench: Bench): void {
  bench.add('BENCH-SPICE-01 NetlistBuilder voltage divider (2 R)', () => {
    buildNetlist(dividerInput());
  });

  // 6×5 = 30 resistors. Bigger than any real Velxio circuit users build.
  const meshFixture = meshInput(6, 5);
  bench.add('BENCH-SPICE-02 NetlistBuilder 30-resistor mesh', () => {
    buildNetlist(meshFixture);
  });

  // ngspice solve. Async — boot the engine once outside the timed loop
  // via the bench setup option (tinybench runs `setup` once per task).
  bench.add(
    'BENCH-SPICE-03 ngspice .op voltage divider',
    async () => {
      await runNetlist(DIVIDER_NETLIST);
    },
    {
      beforeAll: async () => {
        // Force the singleton WASM boot before warmup so the first sample
        // doesn't include the 200–500 ms cold start.
        await getEngine();
      },
    },
  );
}

export const SPICE_BENCH_METADATA = {
  /** Identifier prefix used by the comparator to apply tolerance rules. */
  prefix: 'BENCH-SPICE',
};
