/**
 * Integration tests for the SDK contract `SpiceMapperContext.internalNode`.
 *
 * The host plumbs `internalNode(suffix)` through `NetlistBuilder` →
 * `componentToSpice` → mapper. These tests verify the four properties the
 * SDK promises plugin authors:
 *
 *   1. Per-component scoping — two instances of the same metadataId mint
 *      distinct nets, even when they pass the same suffix.
 *   2. Idempotency within one invocation — same suffix → same string.
 *   3. Stability across rebuilds — `n_<id>_<suffix>` is fully deterministic.
 *   4. Floating internal nodes get the same auto pull-down treatment as
 *      any other floating net (otherwise the parser silently misses them).
 *
 * Plus the negative paths: empty / non-string suffix throws, component IDs
 * with characters ngspice doesn't tokenize get sanitized.
 *
 * Strategy: register an ad-hoc mapper for a synthetic metadataId, then
 * inspect the resulting netlist string (no ngspice solve needed — these
 * tests are about the netlist shape).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { getSpiceMapperRegistry } from '../simulation/spice/SpiceMapperRegistry';
import type { HostSpiceMapper } from '../simulation/spice/SpiceMapperRegistry';

const FAKE_METADATA = 'test-internal-node-mapper';

/**
 * Mapper that ties pin '1' to an internal node (default suffix "tap")
 * via a 1k resistor, and pin '2' to ground via another 1k resistor from
 * that same internal node. So the topology is:
 *   pin1 ──R(1k)── n_<comp.id>_tap ──R(1k)── pin2
 */
function makeTapMapper(suffix = 'tap'): HostSpiceMapper {
  return (comp, netLookup, ctx) => {
    const a = netLookup('1');
    const b = netLookup('2');
    if (!a || !b) return null;
    const tap = ctx.internalNode(suffix);
    return {
      cards: [
        `R_${comp.id}_in ${a} ${tap} 1k`,
        `R_${comp.id}_out ${tap} ${b} 1k`,
      ],
      modelsUsed: new Set(),
    };
  };
}

describe('NetlistBuilder — internalNode contract', () => {
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    const handle = getSpiceMapperRegistry().register(FAKE_METADATA, makeTapMapper());
    dispose = () => handle.dispose();
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('mints per-component nets — two instances of same metadataId do NOT collide', () => {
    const { netlist } = buildNetlist({
      components: [
        { id: 'u1', metadataId: FAKE_METADATA, properties: {} },
        { id: 'u2', metadataId: FAKE_METADATA, properties: {} },
      ],
      wires: [
        // u1 between vcc and gnd
        {
          id: 'w1',
          start: { componentId: 'board', pinName: 'VCC' },
          end: { componentId: 'u1', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'u1', pinName: '2' },
          end: { componentId: 'board', pinName: 'GND' },
        },
        // u2 between vcc and gnd
        {
          id: 'w3',
          start: { componentId: 'board', pinName: 'VCC' },
          end: { componentId: 'u2', pinName: '1' },
        },
        {
          id: 'w4',
          start: { componentId: 'u2', pinName: '2' },
          end: { componentId: 'board', pinName: 'GND' },
        },
      ],
      boards: [
        {
          id: 'board',
          vcc: 5,
          pins: {},
          groundPinNames: ['GND'],
          vccPinNames: ['VCC'],
        },
      ],
      analysis: { kind: 'op' },
    });

    expect(netlist).toContain('n_u1_tap');
    expect(netlist).toContain('n_u2_tap');
    // u1's tap must NOT appear on u2's resistor cards.
    expect(netlist).toMatch(/R_u1_in \S+ n_u1_tap 1k/);
    expect(netlist).toMatch(/R_u2_in \S+ n_u2_tap 1k/);
    expect(netlist).not.toMatch(/R_u1_\S+ \S+ n_u2_tap/);
    expect(netlist).not.toMatch(/R_u2_\S+ \S+ n_u1_tap/);
  });

  it('idempotent within one invocation — same suffix returns the same string', () => {
    let firstCall: string | null = null;
    let secondCall: string | null = null;
    const handle = getSpiceMapperRegistry().register(FAKE_METADATA, (comp, netLookup, ctx) => {
      const a = netLookup('1');
      const b = netLookup('2');
      if (!a || !b) return null;
      firstCall = ctx.internalNode('shared');
      secondCall = ctx.internalNode('shared');
      return {
        cards: [`R_${comp.id} ${a} ${firstCall} 1k`, `R_${comp.id}_x ${secondCall} ${b} 1k`],
        modelsUsed: new Set(),
      };
    });
    try {
      buildNetlist({
        components: [{ id: 'u1', metadataId: FAKE_METADATA, properties: {} }],
        wires: [
          {
            id: 'w1',
            start: { componentId: 'board', pinName: 'VCC' },
            end: { componentId: 'u1', pinName: '1' },
          },
          {
            id: 'w2',
            start: { componentId: 'u1', pinName: '2' },
            end: { componentId: 'board', pinName: 'GND' },
          },
        ],
        boards: [
          {
            id: 'board',
            vcc: 5,
            pins: {},
            groundPinNames: ['GND'],
            vccPinNames: ['VCC'],
          },
        ],
        analysis: { kind: 'op' },
      });
      expect(firstCall).toBe('n_u1_shared');
      expect(secondCall).toBe('n_u1_shared');
    } finally {
      handle.dispose();
    }
  });

  it('stable across rebuilds — same inputs produce the same internal-node names', () => {
    const inputs = {
      components: [{ id: 'u1', metadataId: FAKE_METADATA, properties: {} }],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'board', pinName: 'VCC' },
          end: { componentId: 'u1', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'u1', pinName: '2' },
          end: { componentId: 'board', pinName: 'GND' },
        },
      ],
      boards: [
        {
          id: 'board',
          vcc: 5,
          pins: {},
          groundPinNames: ['GND'],
          vccPinNames: ['VCC'],
        },
      ],
      analysis: { kind: 'op' as const },
    };
    const a = buildNetlist(inputs).netlist;
    const b = buildNetlist(inputs).netlist;
    // Compare just the lines containing the internal node — timestamps differ.
    const internalA = a.match(/n_u1_tap/g);
    const internalB = b.match(/n_u1_tap/g);
    expect(internalA).not.toBeNull();
    expect(internalA).toEqual(internalB);
  });

  it('floating internal node receives the auto pull-down', () => {
    // Mapper that mints an internal node connected to vcc ONLY through a
    // capacitor. Caps are open at DC, so the DC-path walk must classify
    // the internal node as floating and emit a 100 MΩ pull-down. This is
    // the canonical case the `mintedInternalNodes` plumbing exists to
    // catch — without it, the detector's parser would stop at the first
    // unknown token (the internal node name) and silently miss the card.
    const handle = getSpiceMapperRegistry().register(FAKE_METADATA, (comp, netLookup, ctx) => {
      const a = netLookup('1');
      if (!a) return null;
      const tap = ctx.internalNode('dangling');
      return {
        cards: [`C_${comp.id} ${a} ${tap} 1u IC=0`],
        modelsUsed: new Set(),
      };
    });
    try {
      const { netlist } = buildNetlist({
        components: [{ id: 'u1', metadataId: FAKE_METADATA, properties: {} }],
        wires: [
          {
            id: 'w1',
            start: { componentId: 'board', pinName: 'VCC' },
            end: { componentId: 'u1', pinName: '1' },
          },
        ],
        boards: [
          {
            id: 'board',
            vcc: 5,
            pins: {},
            groundPinNames: ['GND'],
            vccPinNames: ['VCC'],
          },
        ],
        analysis: { kind: 'op' },
      });
      // The detector should have recognised n_u1_dangling as a floating
      // net and emitted a pull-down resistor to ground.
      expect(netlist).toMatch(/R_autopull_n_u1_dangling n_u1_dangling 0 100Meg/);
    } finally {
      handle.dispose();
    }
  });

  it('throws on empty suffix', () => {
    const handle = getSpiceMapperRegistry().register(FAKE_METADATA, (_, netLookup, ctx) => {
      const a = netLookup('1');
      const b = netLookup('2');
      if (!a || !b) return null;
      // The mint() call below MUST throw — bubbles out of buildNetlist().
      ctx.internalNode('');
      return { cards: [], modelsUsed: new Set() };
    });
    try {
      expect(() =>
        buildNetlist({
          components: [{ id: 'u1', metadataId: FAKE_METADATA, properties: {} }],
          wires: [
            {
              id: 'w1',
              start: { componentId: 'board', pinName: 'VCC' },
              end: { componentId: 'u1', pinName: '1' },
            },
            {
              id: 'w2',
              start: { componentId: 'u1', pinName: '2' },
              end: { componentId: 'board', pinName: 'GND' },
            },
          ],
          boards: [
            {
              id: 'board',
              vcc: 5,
              pins: {},
              groundPinNames: ['GND'],
              vccPinNames: ['VCC'],
            },
          ],
          analysis: { kind: 'op' },
        }),
      ).toThrow(/non-empty string/);
    } finally {
      handle.dispose();
    }
  });

  it('throws on non-string suffix', () => {
    const handle = getSpiceMapperRegistry().register(FAKE_METADATA, (_, netLookup, ctx) => {
      const a = netLookup('1');
      const b = netLookup('2');
      if (!a || !b) return null;
      // Plugins authored in plain JS could pass garbage through; the host
      // contract says throw rather than silently mint a name like
      // "n_u1_undefined" that is hard to debug later.
      (ctx.internalNode as unknown as (s: unknown) => string)(123);
      return { cards: [], modelsUsed: new Set() };
    });
    try {
      expect(() =>
        buildNetlist({
          components: [{ id: 'u1', metadataId: FAKE_METADATA, properties: {} }],
          wires: [
            {
              id: 'w1',
              start: { componentId: 'board', pinName: 'VCC' },
              end: { componentId: 'u1', pinName: '1' },
            },
            {
              id: 'w2',
              start: { componentId: 'u1', pinName: '2' },
              end: { componentId: 'board', pinName: 'GND' },
            },
          ],
          boards: [
            {
              id: 'board',
              vcc: 5,
              pins: {},
              groundPinNames: ['GND'],
              vccPinNames: ['VCC'],
            },
          ],
          analysis: { kind: 'op' },
        }),
      ).toThrow(/non-empty string/);
    } finally {
      handle.dispose();
    }
  });

  it('sanitizes component IDs and suffixes that contain ngspice-hostile characters', () => {
    // Component IDs in the editor can contain hyphens (`comp-12345-abc`).
    // Suffixes a plugin author types could contain dots (`vbe.tap`) or
    // colons. Both must be flattened to underscores before the net is
    // emitted, otherwise ngspice would mis-tokenize the card.
    const handle = getSpiceMapperRegistry().register(FAKE_METADATA, (comp, netLookup, ctx) => {
      const a = netLookup('1');
      const b = netLookup('2');
      if (!a || !b) return null;
      const tap = ctx.internalNode('vbe.tap');
      return {
        cards: [`R_in ${a} ${tap} 1k`, `R_out ${tap} ${b} 1k`],
        modelsUsed: new Set(),
      };
    });
    try {
      const { netlist } = buildNetlist({
        components: [
          { id: 'comp-12345-abc', metadataId: FAKE_METADATA, properties: {} },
        ],
        wires: [
          {
            id: 'w1',
            start: { componentId: 'board', pinName: 'VCC' },
            end: { componentId: 'comp-12345-abc', pinName: '1' },
          },
          {
            id: 'w2',
            start: { componentId: 'comp-12345-abc', pinName: '2' },
            end: { componentId: 'board', pinName: 'GND' },
          },
        ],
        boards: [
          {
            id: 'board',
            vcc: 5,
            pins: {},
            groundPinNames: ['GND'],
            vccPinNames: ['VCC'],
          },
        ],
        analysis: { kind: 'op' },
      });
      expect(netlist).toContain('n_comp_12345_abc_vbe_tap');
      // No raw hyphens or dots survived in the net name.
      expect(netlist).not.toContain('comp-12345-abc_vbe.tap');
      expect(netlist).not.toContain('comp-12345-abc_vbe_tap');
    } finally {
      handle.dispose();
    }
  });

  it('different suffixes inside one mapper invocation produce different nets', () => {
    let nodeA: string | null = null;
    let nodeB: string | null = null;
    const handle = getSpiceMapperRegistry().register(FAKE_METADATA, (comp, netLookup, ctx) => {
      const a = netLookup('1');
      const b = netLookup('2');
      if (!a || !b) return null;
      nodeA = ctx.internalNode('alpha');
      nodeB = ctx.internalNode('beta');
      return {
        cards: [
          `R_${comp.id}_in ${a} ${nodeA} 1k`,
          `R_${comp.id}_mid ${nodeA} ${nodeB} 1k`,
          `R_${comp.id}_out ${nodeB} ${b} 1k`,
        ],
        modelsUsed: new Set(),
      };
    });
    try {
      buildNetlist({
        components: [{ id: 'u1', metadataId: FAKE_METADATA, properties: {} }],
        wires: [
          {
            id: 'w1',
            start: { componentId: 'board', pinName: 'VCC' },
            end: { componentId: 'u1', pinName: '1' },
          },
          {
            id: 'w2',
            start: { componentId: 'u1', pinName: '2' },
            end: { componentId: 'board', pinName: 'GND' },
          },
        ],
        boards: [
          {
            id: 'board',
            vcc: 5,
            pins: {},
            groundPinNames: ['GND'],
            vccPinNames: ['VCC'],
          },
        ],
        analysis: { kind: 'op' },
      });
      expect(nodeA).toBe('n_u1_alpha');
      expect(nodeB).toBe('n_u1_beta');
      expect(nodeA).not.toBe(nodeB);
    } finally {
      handle.dispose();
    }
  });
});
