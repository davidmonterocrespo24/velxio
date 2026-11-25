/**
 * Every transistor in the catalogue declares its datasheet ratings in its
 * metadata (velxio/velxio-prod#138): V_CEO or V_DSS, I_C or I_D (and the
 * pulsed current when the datasheet gives one) and P_D in free air at 25 °C,
 * with the document they come from; a TO-220 or TO-3 part also its P_D at a
 * 25 °C case, which holds when its `heatsink` property says it is mounted on
 * one. The circuit check before Run and the runtime monitor hold the part to
 * them.
 *
 * They live in scripts/component-overrides.json, from which the metadata
 * generator writes public/components-metadata.json, the file the app loads:
 * both must say the same. And the rated voltage is the one the part's model
 * breaks down at (#110 for the MOSFETs, bjtBreakdownSubckt for the bipolar
 * ones), so a coil's kick clamps just past the rating the check compares to.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import metadataJson from '../../public/components-metadata.json' with { type: 'json' };
import { componentToSpice, mappedMetadataIds } from '../simulation/spice/componentToSpice';
import type { ComponentMetadata, PartRatings } from '../types/component-metadata';

const overrides = JSON.parse(
  readFileSync(new URL('../../../scripts/component-overrides.json', import.meta.url), 'utf8'),
) as { _customComponents: ComponentMetadata[] };

/** The datasheet figures (absolute maximum ratings; P_D in free air at 25 °C). */
const DATASHEET: Record<string, Omit<PartRatings, 'source'> & { cite: RegExp }> = {
  'bjt-2n2222': { kind: 'npn', vMax: 40, iMax: 0.6, pMax: 0.625, cite: /onsemi P2N2222A\/D, Rev\. 7/ },
  'bjt-bc547': { kind: 'npn', vMax: 45, iMax: 0.1, pMax: 0.625, cite: /onsemi BC546\/D .*Rev\. 8/ },
  'bjt-2n3055': { kind: 'npn', vMax: 60, iMax: 15, pMax: 6, pMaxHeatsink: 115, cite: /onsemi 2N3055\/D, Rev\. 7.*TT Electronics/ },
  'bjt-2n3906': { kind: 'pnp', vMax: 40, iMax: 0.2, pMax: 0.625, cite: /onsemi 2N3906\/D, Rev\. 4/ },
  'bjt-bc557': { kind: 'pnp', vMax: 45, iMax: 0.1, iPulse: 0.2, pMax: 0.625, cite: /onsemi BC556B\/D .*Rev\. 3/ },
  'mosfet-2n7000': { kind: 'nmos', vMax: 60, iMax: 0.2, iPulse: 0.5, pMax: 0.4, cite: /onsemi NDS7002A\/D .*Rev\. 11/ },
  'mosfet-irf540': { kind: 'nmos', vMax: 100, iMax: 28, iPulse: 110, pMax: 2.4, pMaxHeatsink: 150, cite: /Vishay IRF540 \(document 91021\), Rev\. C/ },
  'mosfet-irf9540': { kind: 'pmos', vMax: 100, iMax: 19, iPulse: 72, pMax: 2.4, pMaxHeatsink: 150, cite: /Vishay IRF9540 \(document 91078\), Rev\. B/ },
  'mosfet-fqp27p06': { kind: 'pmos', vMax: 60, iMax: 27, iPulse: 108, pMax: 2.4, pMaxHeatsink: 120, cite: /onsemi FQP27P06\/D, Rev\. 4/ },
};

/** The part's netlist cards and model lines on dummy nets. */
function emitted(metadataId: string): { cards: string[]; models: string[] } | null {
  const em = componentToSpice({ id: 'q1', metadataId, properties: {} }, (pin) => `n_${pin}`, { vcc: 5 });
  return em ? { cards: em.cards, models: [...em.modelsUsed] } : null;
}

const parts = Object.keys(DATASHEET);
const overrideOf = (id: string) => overrides._customComponents.find((c) => c.id === id);
const generatedOf = (id: string) =>
  (metadataJson as unknown as { components: ComponentMetadata[] }).components.find((c) => c.id === id);

describe('transistor ratings in the metadata (velxio/velxio-prod#138)', () => {
  it('lists every part the netlist maps as a transistor', () => {
    // A part that IS a transistor: its own Q or M card. (An optocoupler's
    // phototransistor, `Q_<id>_pt`, is one inside another part.)
    const transistors = mappedMetadataIds()
      .filter((id) => emitted(id)?.cards.some((c) => /^[QM]_q1\s/.test(c)))
      .sort();
    expect(transistors).toEqual([...parts].sort());
  });

  it.each(parts)('%s declares its datasheet ratings in component-overrides.json', (id) => {
    const { cite, ...figures } = DATASHEET[id]!;
    const ratings = overrideOf(id)?.ratings;
    expect(ratings, `${id} has no ratings`).toBeDefined();
    const { source, ...rest } = ratings!;
    expect(rest).toEqual(figures);
    expect(source).toMatch(cite);
  });

  it.each(parts)('%s: the generated metadata the app loads carries the same ratings', (id) => {
    expect(generatedOf(id)?.ratings).toEqual(overrideOf(id)?.ratings);
  });

  it.each(parts)('%s offers a heatsink exactly when its datasheet rates it on one', (id) => {
    // A TO-220 or TO-3 part is made for a heatsink: P_D at a 25 °C case is its
    // datasheet's figure. A TO-92 part is not, and has no such property.
    const rated = DATASHEET[id]!.pMaxHeatsink !== undefined;
    for (const meta of [overrideOf(id)!, generatedOf(id)!]) {
      const prop = meta.properties.find((p) => p.name === 'heatsink');
      if (rated) {
        expect(prop).toMatchObject({ type: 'boolean', control: 'boolean', defaultValue: false });
        expect(meta.defaultValues).toMatchObject({ heatsink: false });
      } else {
        expect(prop).toBeUndefined();
      }
    }
  });

  it.each(parts)('%s: its model breaks down at the rated voltage', (id) => {
    const { vMax, kind } = DATASHEET[id]!;
    const models = emitted(id)!.models.join('\n');
    if (kind === 'npn' || kind === 'pnp') {
      expect(models).toMatch(new RegExp(`\\.subckt BJT_CEO_BV_${vMax} `));
      expect(models).toMatch(new RegExp(`\\bBV=${vMax}\\b`));
    } else {
      expect(models).toMatch(/VDMOS\(/);
      expect(models).toMatch(new RegExp(`\\bBV=${vMax}\\b`));
    }
  });
});
