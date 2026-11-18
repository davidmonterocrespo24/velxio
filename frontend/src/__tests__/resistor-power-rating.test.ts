/**
 * A resistor's power rating is a property the inspector shows and both power
 * checks read (velxio/velxio-prod#104).
 *
 * The circuit check (Rule 3) and the runtime burnout model read
 * `properties.power`, the rating in watts, 1/4 W when absent. But no resistor
 * in the catalog declared it, so the inspector could not show or change it,
 * and the burnout message's advice ("use a higher-wattage resistor") could
 * not be followed; only a hand-written example (the MCP4725 load's 5 W shunt)
 * carried one. Both readers also took the rating only as a number, while the
 * inspector stores a select's choice as text, and Rule 3 looked at the custom
 * resistor alone: the picker's presets (Resistor 220 Ω, ...) were never
 * power-checked, though they burned at runtime.
 *
 * Ordinary through-hole resistors come in 1/8, 1/4, 1/2, 1, 2 and 5 W
 * (Yageo CFR: 1/6 to 3 W in one series).
 */
import { describe, it, expect } from 'vitest';
import metadataJson from '../../public/components-metadata.json' with { type: 'json' };
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { componentStress } from '../simulation/parts/runtimeBurnout';
import { PASSIVE_PRESETS } from '../simulation/spice/componentToSpice';
import type { BuildNetlistInput } from '../simulation/spice/types';

type Entry = {
  id: string;
  properties: Array<{ name: string; control?: string; options?: string[]; defaultValue?: unknown }>;
  defaultValues: Record<string, unknown>;
};
const entries = (metadataJson as unknown as { components: Entry[] }).components;
const RESISTOR_IDS = ['resistor', ...Object.keys(PASSIVE_PRESETS).filter((id) => PASSIVE_PRESETS[id] === 'resistor')];

/** 12 V straight across one resistor of the given part and properties. */
function acrossSupply(metadataId: string, properties: Record<string, unknown>): BuildNetlistInput {
  return {
    components: [
      { id: 'ps1', metadataId: 'power-supply', properties: { mode: 'dc', voltage: 12, currentLimit: 1 } },
      { id: 'r1', metadataId, properties },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'ps1', pinName: 'SIG' }, end: { componentId: 'r1', pinName: '1' } },
      { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'ps1', pinName: 'GND' } },
    ],
    boards: [],
    analysis: { kind: 'op' },
  };
}

const overpower = async (input: BuildNetlistInput) =>
  (await verifyCircuit(input)).warnings.filter((w) => w.code === 'resistor-overpower');

describe('the inspector offers the power rating (#104)', () => {
  it('on the custom resistor and on every preset', () => {
    expect(RESISTOR_IDS).toHaveLength(12);
    for (const id of RESISTOR_IDS) {
      const entry = entries.find((e) => e.id === id);
      expect(entry, id).toBeDefined();
      const power = entry!.properties.find((p) => p.name === 'power');
      expect(power, `${id} has no power property`).toBeDefined();
      expect(power!.control, id).toBe('select');
      expect(power!.options, id).toEqual(['0.125', '0.25', '0.5', '1', '2', '5']);
      expect(power!.defaultValue, id).toBe('0.25');
      expect(entry!.defaultValues.power, id).toBe('0.25');
    }
  });
});

describe('the circuit check reads the rating (#104)', () => {
  it('checks a preset resistor like the custom one', { timeout: 30_000 }, async () => {
    // 12 V across 220 ohm: 0.65 W, over the 1/4 W default.
    const preset = await overpower(acrossSupply('resistor-220', { value: '220' }));
    expect(preset.map((w) => w.componentId)).toEqual(['r1']);
    expect(preset[0]!.metric).toBeCloseTo(144 / 220, 2);
  });

  it('takes the rating the inspector stores, as text', { timeout: 30_000 }, async () => {
    expect(await overpower(acrossSupply('resistor', { value: '220', power: '1' }))).toEqual([]);
    expect(await overpower(acrossSupply('resistor-220', { value: '220', power: '1' }))).toEqual([]);
    const half = await overpower(acrossSupply('resistor', { value: '220', power: '0.5' }));
    expect(half).toHaveLength(1);
    expect(half[0]!.message).toContain('500 mW');
  });

  it('keeps 1/4 W for a resistor that says nothing, or something that is not a rating', { timeout: 30_000 }, async () => {
    for (const power of [undefined, '', 'abc', '0', -1]) {
      const found = await overpower(acrossSupply('resistor', { value: '220', ...(power === undefined ? {} : { power }) }));
      expect(found, String(power)).toHaveLength(1);
      expect(found[0]!.message, String(power)).toContain('250 mW');
    }
  });

  it('tells the user which field raises the rating', { timeout: 30_000 }, async () => {
    const [w] = await overpower(acrossSupply('resistor', { value: '220' }));
    expect(w!.message).toMatch(/power rating/i);
  });
});

describe('the burnout model reads the rating (#104)', () => {
  const pinNetMap = new Map([
    ['r1:1', 'n0'],
    ['r1:2', '0'],
  ]);
  const ratio = (metadataId: string, properties: Record<string, unknown>) =>
    componentStress({ id: 'r1', metadataId, properties }, { n0: 12, '0': 0 }, pinNetMap)!.ratio;

  it('takes the rating the inspector stores, as text', () => {
    // 0.6545 W against 2 x the rating.
    expect(ratio('resistor', { value: '220', power: '2' })).toBeCloseTo(0.6545 / 4, 3);
    expect(ratio('resistor-220', { value: '220', power: '0.5' })).toBeCloseTo(0.6545 / 1, 3);
    expect(ratio('resistor', { value: '220', power: 5 })).toBeCloseTo(0.6545 / 10, 3);
    expect(ratio('resistor', { value: '220', power: 'abc' })).toBeCloseTo(0.6545 / 0.5, 3);
  });

  it('says where the rating is set', () => {
    const s = componentStress({ id: 'r1', metadataId: 'resistor', properties: { value: '22' } }, { n0: 12, '0': 0 }, pinNetMap);
    expect(s!.message).toMatch(/power rating/i);
  });
});
