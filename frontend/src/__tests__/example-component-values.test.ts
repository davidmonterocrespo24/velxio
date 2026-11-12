/**
 * Audit every component value shipped in the gallery examples.
 *
 * Component values go through `parseValueWithUnits` (valueParser.ts). Its old
 * SPICE rules used to trip up whoever authored an example, because both
 * produced a *silently* wrong circuit rather than an error:
 *
 *   - `M` was MILLI. 100d-auto-night-light shipped `dark: "1M"` for a
 *     photoresistor: the 0.001 ohm "dark resistance" shorted the ADC node to
 *     VCC, so the sketch read 4095 forever and its lux control did nothing.
 *   - `"10uF"` ended in an f and was read as `10 * 1e-15`.
 *
 * Since velxio/velxio-prod#101 and #105 an upper-case M is mega (a lower-case
 * m is still milli) and the unit letters after the scale factor are ignored,
 * so both now mean what they say. A lower-case `"1m"` meant as a megaohm, or
 * a value in the wrong unit, is still invisible: the netlist builds, ngspice
 * converges, the part renders, and the example just quietly misbehaves. So
 * assert the parsed numbers land inside physically sane ranges for their
 * component class.
 */
import { describe, it, expect } from 'vitest';
import { exampleProjects } from '../data/examples';
import { parseValueWithUnits } from '../simulation/spice/valueParser';

/** Physically plausible ranges, per (metadataId prefix, property). */
const RANGES: Array<{
  match: (metaId: string) => boolean;
  prop: string;
  min: number;
  max: number;
  what: string;
}> = [
  // A resistor below an ohm is a wire; above 100 M it's an open.
  { match: (m) => m === 'resistor' || m.startsWith('resistor-'), prop: 'value', min: 1, max: 1e8, what: 'resistance (ohm)' },
  { match: (m) => m === 'potentiometer', prop: 'value', min: 10, max: 1e7, what: 'pot resistance (ohm)' },
  // LDR dark resistance: real parts sit between ~10k and ~20M.
  { match: (m) => m === 'photoresistor' || m === 'photoresistor-sensor', prop: 'dark', min: 1e3, max: 1e8, what: 'LDR dark resistance (ohm)' },
  { match: (m) => m === 'photoresistor' || m === 'photoresistor-sensor', prop: 'pullup', min: 100, max: 1e7, what: 'LDR module pull-up (ohm)' },
  // Capacitors: 1 pF .. 1 F covers everything from RF trimmers to supercaps.
  { match: (m) => m === 'capacitor' || m === 'capacitor-electrolytic' || m.startsWith('capacitor-'), prop: 'value', min: 1e-12, max: 1, what: 'capacitance (F)' },
  // Inductors: 1 nH .. 10 H.
  { match: (m) => m === 'inductor' || m.startsWith('inductor-'), prop: 'value', min: 1e-9, max: 10, what: 'inductance (H)' },
];

interface Offender {
  example: string;
  componentId: string;
  metadataId: string;
  prop: string;
  raw: unknown;
  parsed: number;
  what: string;
}

function audit(): Offender[] {
  const out: Offender[] = [];
  for (const ex of exampleProjects) {
    for (const comp of ex.components ?? []) {
      // Example components carry the branded tag (`wokwi-resistor`); the
      // mapper sees the stripped metadata id. Compare on both.
      const raw = String((comp as { type?: string }).type ?? '');
      const metaId = raw.replace(/^(wokwi|velxio|chip)-/, '');
      const props = (comp as { properties?: Record<string, unknown> }).properties ?? {};
      for (const rule of RANGES) {
        if (!rule.match(metaId)) continue;
        if (!(rule.prop in props)) continue;
        const rawVal = props[rule.prop];
        const parsed = parseValueWithUnits(rawVal, NaN);
        if (!Number.isFinite(parsed) || parsed < rule.min || parsed > rule.max) {
          out.push({
            example: ex.id,
            componentId: String((comp as { id?: string }).id ?? '?'),
            metadataId: metaId,
            prop: rule.prop,
            raw: rawVal,
            parsed,
            what: rule.what,
          });
        }
      }
    }
  }
  return out;
}

describe('gallery example component values', () => {
  it('parse into physically sane ranges', () => {
    const offenders = audit();
    const report = offenders
      .map(
        (o) =>
          `${o.example} / ${o.componentId} (${o.metadataId}).${o.prop} = ` +
          `${JSON.stringify(o.raw)} -> ${o.parsed} — ${o.what} out of range. ` +
          `Remember: an upper-case M is mega and a lower-case m is milli.`,
      )
      .join('\n');
    expect(report).toBe('');
  });

  it('covers a meaningful number of components (guard against a silent no-op)', () => {
    let checked = 0;
    for (const ex of exampleProjects) {
      for (const comp of ex.components ?? []) {
        const metaId = String((comp as { type?: string }).type ?? '').replace(
          /^(wokwi|velxio|chip)-/,
          '',
        );
        const props = (comp as { properties?: Record<string, unknown> }).properties ?? {};
        for (const rule of RANGES) {
          if (rule.match(metaId) && rule.prop in props) checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});
