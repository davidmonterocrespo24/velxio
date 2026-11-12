/**
 * The fields of a part that the simulator reads as a number, with their unit
 * and the number it uses when the field is missing or unreadable.
 *
 * The mappers in componentToSpice read these properties through the shared
 * parser (valueParser.ts) with the same defaults; this table is what the
 * other readers of the same fields consult, so they agree with the netlist:
 *
 *   - the circuit check reports a field whose text is not a value, naming the
 *     part, the field and the number the simulation uses instead
 *     (circuitVerifier, invalid-value);
 *   - the part inspector shows the interpreted value next to the field
 *     ("= 4.7 kΩ"), or why the text is not one;
 *   - the transient window (storeAdapter) and the source checks read the
 *     frequency, voltage and current limit the netlist was built with.
 *
 * A spec builds every part with each field missing, at its fallback and
 * unreadable, and requires the three netlists to agree, so a default changed
 * in one place and not the other fails there (value-fields.test.ts).
 */
import { PASSIVE_PRESETS } from './componentToSpice';
import { parseValue, formatQuantity } from './valueParser';

export type ValueUnit = 'Ω' | 'F' | 'H' | 'V' | 'A' | 'Hz';

export interface ValueField {
  /** The component property that holds the text. */
  prop: string;
  /** How messages name the field. */
  label: string;
  unit: ValueUnit;
  /** What the simulator uses when the property is missing or unreadable. */
  fallback: number;
  /**
   * The field is read only in some modes of the part: a supply's frequency
   * only in AC, a generator's frequency and amplitude on any waveform but DC.
   * `prop` is the property that picks the mode, `default` the mode the mapper
   * takes when it is missing; the field is read when the mode (lower case) is
   * in `in`, or is not in `notIn`. Absent: the field is always read.
   */
  readIn?: { prop: string; default: string; in?: readonly string[]; notIn?: readonly string[] };
}

const field = (
  prop: string,
  label: string,
  unit: ValueUnit,
  fallback: number,
  readIn?: ValueField['readIn'],
): ValueField => ({
  prop,
  label,
  unit,
  fallback,
  ...(readIn ? { readIn } : {}),
});

/** The power supply's modes, as its mapper reads them (componentToSpice). */
const SUPPLY_AC_ONLY = { prop: 'mode', default: 'dc', in: ['ac'] } as const;
/** The generator's waveforms: DC emits only the offset. */
const GENERATOR_NOT_DC = { prop: 'waveform', default: 'sine', notIn: ['dc'] } as const;

const RESISTOR = [field('value', 'resistance', 'Ω', 1000)];
const CAPACITOR = [field('value', 'capacitance', 'F', 1e-6)];
const INDUCTOR = [field('value', 'inductance', 'H', 1e-3)];

const FIELDS: Readonly<Record<string, readonly ValueField[]>> = {
  resistor: RESISTOR,
  'resistor-us': RESISTOR,
  'analog-resistor': RESISTOR,
  capacitor: CAPACITOR,
  'capacitor-electrolytic': CAPACITOR,
  'analog-capacitor': CAPACITOR,
  inductor: INDUCTOR,
  'analog-inductor': INDUCTOR,
  potentiometer: [
    field('total', 'track resistance', 'Ω', 10_000),
    field('resistance', 'track resistance', 'Ω', 10_000),
  ],
  'ntc-temperature-sensor': [
    field('R0', 'resistance at 25 °C', 'Ω', 10_000),
    field('pullup', 'pull-up resistance', 'Ω', 10_000),
  ],
  photoresistor: [
    field('dark', 'dark resistance', 'Ω', 1_000_000),
    field('pullup', 'pull-down resistance', 'Ω', 10_000),
  ],
  'power-supply': [
    field('voltage', 'voltage', 'V', 5),
    field('frequency', 'frequency', 'Hz', 50, SUPPLY_AC_ONLY),
    field('currentLimit', 'current limit', 'A', 1),
  ],
  'signal-generator': [
    field('frequency', 'frequency', 'Hz', 1000, GENERATOR_NOT_DC),
    field('amplitude', 'amplitude', 'V', 1, GENERATOR_NOT_DC),
    field('offset', 'offset', 'V', 0),
  ],
  relay: [field('coil_resistance', 'coil resistance', 'Ω', 70), field('coil_voltage', 'coil voltage', 'V', 5)],
};

/** Catalog ids that are the same part as an entry above (componentToSpice's aliases). */
const ALIASES: Readonly<Record<string, string>> = {
  ...PASSIVE_PRESETS,
  'photoresistor-sensor': 'photoresistor',
};

/** The number fields of a part (none for a part the simulator reads no number from). */
export function valueFieldsOf(metadataId: string): readonly ValueField[] {
  return FIELDS[metadataId] ?? FIELDS[ALIASES[metadataId] ?? ''] ?? [];
}

/** One number field of a part, or undefined if that property is not one. */
export function valueFieldOf(metadataId: string, prop: string): ValueField | undefined {
  return valueFieldsOf(metadataId).find((f) => f.prop === prop);
}

interface PartLike {
  metadataId: string;
  properties: Record<string, unknown>;
}

/**
 * The number the netlist uses for a field: its text read by the shared
 * parser, or the field's fallback when it is missing or unreadable.
 */
export function readValueField(comp: PartLike, prop: string): number {
  const f = valueFieldOf(comp.metadataId, prop);
  const parsed = parseValue(comp.properties[prop]);
  if (parsed.ok) return parsed.value;
  return f ? f.fallback : NaN;
}

/**
 * Whether the part, in the mode its properties pick, reads this field at all.
 * A DC supply never reads its frequency, nor a DC generator its frequency or
 * amplitude: whatever those fields hold, the netlist is the same.
 */
export function fieldIsRead(comp: PartLike, f: ValueField): boolean {
  const when = f.readIn;
  if (!when) return true;
  const mode = String(comp.properties[when.prop] ?? when.default).toLowerCase();
  if (when.in && !when.in.includes(mode)) return false;
  if (when.notIn && when.notIn.includes(mode)) return false;
  return true;
}

export interface UnreadableValue {
  field: ValueField;
  /** What the property holds. */
  raw: unknown;
  /** Why it is not a value (the parser's words). */
  why: string;
  /** The field is empty: no text the simulation would contradict. */
  empty: boolean;
}

/**
 * The fields of a part that hold something the simulator cannot read. A
 * missing property is not one of them: the part simply has its default.
 * An empty one is, since it reads as a value the user removed; `empty` says
 * so. A field the part's mode does not read is never one of them: a DC
 * supply whose "AC mode only" frequency was empty blocked Run over a number
 * nothing used (velxio/velxio-prod#118).
 */
export function unreadableValues(comp: PartLike): UnreadableValue[] {
  const out: UnreadableValue[] = [];
  for (const f of valueFieldsOf(comp.metadataId)) {
    if (!fieldIsRead(comp, f)) continue;
    const raw = comp.properties[f.prop];
    if (raw === undefined || raw === null) continue;
    const parsed = parseValue(raw);
    if (!parsed.ok) out.push({ field: f, raw, why: parsed.message, empty: parsed.reason === 'empty' });
  }
  return out;
}

/** What a field's text means, for the readout next to it. */
export type ValueReadout =
  | { ok: true; text: string }
  | { ok: false; comma: boolean; fallback: string; why: string };

export function readoutOf(field: ValueField, raw: unknown): ValueReadout {
  const parsed = parseValue(raw);
  if (parsed.ok) return { ok: true, text: formatQuantity(parsed.value, field.unit) };
  return {
    ok: false,
    comma: parsed.reason === 'comma',
    fallback: formatQuantity(field.fallback, field.unit),
    why: parsed.message,
  };
}
