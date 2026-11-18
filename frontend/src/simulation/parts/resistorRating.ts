/**
 * A resistor's power rating, as the two power checks read it: the circuit
 * check before Run (circuitVerifier, Rule 3) and the burnout model while it
 * runs (runtimeBurnout).
 *
 * The rating is the part's `power` property, in watts. The inspector offers
 * it as a select on the custom resistor and on every preset (1/8, 1/4, 1/2,
 * 1, 2 and 5 W, component-overrides.json) and stores the choice as text,
 * "0.5"; a project or an example may hold a number, 5. Both readers took
 * only a number, and no resistor declared the property, so every resistor
 * was 1/4 W and the burnout's advice to use a higher-wattage part could not
 * be followed (velxio/velxio-prod#104).
 *
 * Pure (no store), so the verifier can use it in Node.
 */
import { PASSIVE_PRESETS } from '../spice/componentToSpice';
import { parseValue } from '../spice/valueParser';

/** What a resistor is rated for when its part says nothing: 1/4 W, the common through-hole part. */
export const RESISTOR_DEFAULT_WATTS = 0.25;

/**
 * The resistor parts the power checks cover: the custom resistor, the US
 * symbol, the generic analog one and the picker's presets (Resistor 220 Ω,
 * ...), which are the same part with another default value. The circuit
 * check used to look at the custom resistor alone, so a preset was never
 * power-checked before Run, though it burned at runtime.
 */
const RATED_RESISTORS: ReadonlySet<string> = new Set([
  'resistor',
  'resistor-us',
  'analog-resistor',
  ...Object.entries(PASSIVE_PRESETS)
    .filter(([, base]) => base === 'resistor')
    .map(([id]) => id),
]);

export function isRatedResistor(metadataId: string): boolean {
  return RATED_RESISTORS.has(metadataId);
}

/**
 * The rating in watts: the `power` property read as a value ("0.5", "500m",
 * "0.5W" or 0.5), or `fallback` when it is missing or is not a positive
 * value.
 */
export function resistorPowerRating(
  properties: Readonly<Record<string, unknown>> | undefined,
  fallback = RESISTOR_DEFAULT_WATTS,
): number {
  const parsed = parseValue(properties?.power);
  return parsed.ok && parsed.value > 0 ? parsed.value : fallback;
}

/** "0.25 W", "5 W": a rating as a person writes it. */
export function formatRating(watts: number): string {
  return `${Number(watts.toPrecision(3))} W`;
}
