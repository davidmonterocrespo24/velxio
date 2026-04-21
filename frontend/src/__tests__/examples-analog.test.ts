/**
 * Analog examples — SPICE netlist validation.
 *
 * For each board-less analog example:
 *   1. It's exported as boardFilter:'analog' (so the gallery groups it).
 *   2. Its wires reference only components that actually exist.
 *   3. buildNetlist produces a non-empty netlist with a ground node.
 *   4. Every component metadataId used is actually mapped to SPICE.
 *
 * We deliberately do NOT run ngspice against every circuit here — that's
 * ~30 × ~500 ms of WASM work per CI run. A handful of representative
 * topologies are spot-checked for solver convergence; the rest rely on
 * componentToSpice smoke-tests and NetlistBuilder unit tests for correctness.
 */
import { describe, it, expect } from 'vitest';
import { analogExamples } from '../data/examples-analog';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { mappedMetadataIds } from '../simulation/spice/componentToSpice';

function toSpiceComponents(example: (typeof analogExamples)[number]) {
  return example.components.map((c) => ({
    id: c.id,
    metadataId: c.type.replace(/^(wokwi|velxio)-/, ''),
    properties: c.properties ?? {},
  }));
}

function toSpiceWires(example: (typeof analogExamples)[number]) {
  return example.wires.map((w) => ({
    id: w.id,
    start: { componentId: w.start.componentId, pinName: w.start.pinName },
    end: { componentId: w.end.componentId, pinName: w.end.pinName },
  }));
}

describe('analogExamples — shape', () => {
  it('exports exactly 30 board-less analog circuits', () => {
    expect(analogExamples.length).toBe(30);
  });

  it('every example uses boardFilter: "analog" and category: "circuits"', () => {
    for (const ex of analogExamples) {
      expect(ex.boardFilter, `${ex.id} boardFilter`).toBe('analog');
      expect(ex.category, `${ex.id} category`).toBe('circuits');
    }
  });

  it('no example lists a board in its components[]', () => {
    const BOARD_PREFIXES = [
      'wokwi-arduino-',
      'wokwi-esp32',
      'wokwi-raspberry-',
      'wokwi-nano-rp',
      'velxio-esp32',
      'velxio-raspberry-',
      'velxio-pi-pico-w',
    ];
    for (const ex of analogExamples) {
      const boards = ex.components.filter((c) => BOARD_PREFIXES.some((p) => c.type.startsWith(p)));
      expect(
        boards.map((b) => b.id),
        `${ex.id}`,
      ).toEqual([]);
    }
  });

  it('no example sets a boardType (analog circuits are board-less)', () => {
    for (const ex of analogExamples) {
      expect(ex.boardType, `${ex.id}`).toBeUndefined();
    }
  });

  it('every component type has a SPICE mapping', () => {
    const mapped = new Set(mappedMetadataIds());
    const unmapped = new Set<string>();
    for (const ex of analogExamples) {
      for (const c of ex.components) {
        const id = c.type.replace(/^(wokwi|velxio)-/, '');
        if (!mapped.has(id)) unmapped.add(`${ex.id}:${c.id}(${id})`);
      }
    }
    expect(Array.from(unmapped)).toEqual([]);
  });

  it('every wire endpoint references a component that exists', () => {
    for (const ex of analogExamples) {
      const ids = new Set(ex.components.map((c) => c.id));
      for (const w of ex.wires) {
        expect(ids.has(w.start.componentId), `${ex.id}:${w.id}.start(${w.start.componentId})`).toBe(
          true,
        );
        expect(ids.has(w.end.componentId), `${ex.id}:${w.id}.end(${w.end.componentId})`).toBe(true);
      }
    }
  });

  it('every example has at least one signal-generator to seed ground', () => {
    for (const ex of analogExamples) {
      const hasSig = ex.components.some((c) => c.type === 'wokwi-signal-generator');
      expect(hasSig, `${ex.id} has no signal-generator (no ground reference)`).toBe(true);
    }
  });
});

describe('analogExamples — netlist generation', () => {
  it('each example produces a non-empty netlist with ground net', () => {
    for (const ex of analogExamples) {
      const { netlist } = buildNetlist({
        components: toSpiceComponents(ex),
        wires: toSpiceWires(ex),
        boards: [],
        analysis: { kind: 'op' },
      });
      expect(netlist.length, `${ex.id} netlist empty`).toBeGreaterThan(20);
      expect(netlist, `${ex.id} missing .end`).toContain('.end');
      // Every signal-generator must drop a V-source whose second node is 0
      // (the GND pin is canonicalised). That's how we know ground is wired.
      const sigs = ex.components.filter((c) => c.type === 'wokwi-signal-generator');
      for (const sig of sigs) {
        const re = new RegExp(`^V_${sig.id}\\s+\\S+\\s+0\\b`, 'm');
        expect(netlist, `${ex.id}: ${sig.id} GND not canonicalised to 0`).toMatch(re);
      }
    }
  });

  it('each example emits at least one card referencing every component id', () => {
    for (const ex of analogExamples) {
      const { netlist } = buildNetlist({
        components: toSpiceComponents(ex),
        wires: toSpiceWires(ex),
        boards: [],
        analysis: { kind: 'op' },
      });
      for (const c of ex.components) {
        // Cards begin with an element prefix (R/C/L/D/Q/M/E/S/V/B) followed by
        // "_<id>" somewhere. The voltmeter e.g. emits "R_vm_vmR ...", so the
        // id may be followed by any non-word-boundary character.
        const re = new RegExp(`^[RCLDQMESVB]_${c.id}(?:_|\\b)`, 'm');
        expect(netlist, `${ex.id} missing card for ${c.id} (${c.type})`).toMatch(re);
      }
    }
  });
});
