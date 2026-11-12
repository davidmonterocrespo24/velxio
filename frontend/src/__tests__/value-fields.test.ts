/**
 * The value-field table (valueFields.ts) and the SPICE mappers agree.
 *
 * The circuit check reports an unreadable field with "it runs with <fallback>",
 * the inspector shows the same fallback, and the transient window reads the
 * generator frequency through the table. All of that is only true if the
 * mapper really emits the table's fallback. So for every part with number
 * fields, and every field: the netlist with the property missing, set to the
 * table's fallback, and set to a text that is not a value must be the same,
 * and must never contain NaN (velxio/velxio-prod#118).
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice, mappedMetadataIds } from '../simulation/spice/componentToSpice';
import { fieldIsRead, valueFieldsOf, readValueField, unreadableValues } from '../simulation/spice/valueFields';

/** Modes that make a field matter (a supply's frequency only shows in AC). */
const CONTEXTS: Record<string, Array<Record<string, unknown>>> = {
  'power-supply': [{ mode: 'dc' }, { mode: 'ac' }],
  'signal-generator': [{ waveform: 'sine' }, { waveform: 'square' }],
};

function emit(metadataId: string, properties: Record<string, unknown>): string {
  const out = componentToSpice(
    { id: 'x', metadataId, properties },
    (pin) => `n_${pin.replace(/[^A-Za-z0-9]/g, '_')}`,
    { vcc: 5 },
  );
  return out ? out.cards.join('\n') : '';
}

const parts = mappedMetadataIds().filter((id) => valueFieldsOf(id).length > 0);

describe('every number field emits the fallback the table promises', () => {
  it('covers the parts the book and the gallery set by hand', () => {
    for (const id of ['resistor', 'resistor-4k7', 'capacitor', 'cap-elec-100u', 'inductor', 'power-supply', 'signal-generator', 'photoresistor-sensor', 'relay']) {
      expect(parts, id).toContain(id);
    }
  });

  for (const id of parts) {
    it(id, () => {
      for (const context of CONTEXTS[id] ?? [{}]) {
        for (const field of valueFieldsOf(id)) {
          const missing = emit(id, { ...context });
          const atFallback = emit(id, { ...context, [field.prop]: field.fallback });
          const unreadable = emit(id, { ...context, [field.prop]: 'not a value' });
          const where = `${id} ${JSON.stringify(context)} ${field.prop}`;
          expect(missing, where).not.toMatch(/NaN|Infinity/);
          expect(atFallback, where).toBe(missing);
          expect(unreadable, where).toBe(missing);
          expect(readValueField({ metadataId: id, properties: {} }, field.prop), where).toBe(field.fallback);
          // Reported in the modes that read it, never in one that does not (a
          // DC supply's frequency): value-field-modes.test.ts.
          expect(
            unreadableValues({ metadataId: id, properties: { ...context, [field.prop]: 'not a value' } }).map(
              (u) => u.field.prop,
            ),
            where,
          ).toEqual(fieldIsRead({ metadataId: id, properties: context }, field) ? [field.prop] : []);
        }
      }
    });
  }
});
