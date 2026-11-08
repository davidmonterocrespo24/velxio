/**
 * Read the value a user types into a part's field: "4.7k", "4k7", "100nF",
 * "1M", "1Meg", "50Hz", "9V", "500mA", "10 µF".
 *
 * Every value field reads through this one parser, so the same text means
 * the same number everywhere. The rules follow ngspice where that cannot
 * surprise anybody, and the SI
 * convention of schematic editors (KiCad's SI notation, Falstad) where
 * SPICE's would:
 *
 *   - A number, then at most ONE scale factor, then unit letters, which are
 *     ignored: "100nF" is 100n and "1kHz" is 1k (ngspice manual 2.1.3.3).
 *     The old parser looked at the LAST letter instead, so "100nF" ended in
 *     an f and was 100 femtofarads, and "1kHz" was 1 (velxio/velxio-prod#105).
 *   - Upper-case M is mega and lower-case m is milli; "meg" is mega in any
 *     case. SPICE reads both M and m as milli, which turned a "1M" resistor
 *     into a 1 mΩ short (velxio/velxio-prod#101).
 *   - Upper-case F is the farad and lower-case f is femto, the same SI rule:
 *     "1F" is one farad (ngspice would read femto) and "1fF" one femtofarad.
 *   - "a" is NOT atto (ngspice's 1e-18), so "1A" is one ampere.
 *   - RKM codes put the scale factor where the decimal point goes: "4k7" is
 *     4.7k, "2M2" is 2.2 mega, "4n7" is 4.7n and "0R47" (or "R47") is 0.47.
 *   - Spelled-out prefixes work ("10 microfarads", "2 kilohms"), and so does
 *     "farad", which ngspice would read as femto + "arad".
 *
 * A text that follows none of this is NOT turned into some number: parseValue
 * says why, and parseValueWithUnits hands back the caller's default. Before,
 * "1,5k" was silently 1k.
 */

/** Why a text is not a value. */
export type ValueParseFailure = 'empty' | 'comma' | 'syntax' | 'range';

export type ValueParse =
  | { ok: true; value: number }
  | { ok: false; reason: ValueParseFailure; message: string };

/** Scale factors spelled out; checked before the one-letter ones ("micro" is not milli). */
const PREFIX_WORDS: ReadonlyArray<readonly [string, number]> = [
  ['tera', 1e12],
  ['giga', 1e9],
  ['mega', 1e6],
  ['kilo', 1e3],
  ['milli', 1e-3],
  ['micro', 1e-6],
  ['nano', 1e-9],
  ['pico', 1e-12],
  ['femto', 1e-15],
];

/**
 * One-letter scale factors. Case matters for M/m and F/f only (SI); the
 * others keep SPICE's case-insensitive reading ("10K", "10U", "22P").
 * The multipliers are the old parser's, so an unchanged value emits the
 * same number into the netlist.
 */
const PREFIX_LETTERS: Readonly<Record<string, number>> = {
  T: 1e12,
  t: 1e12,
  G: 1e9,
  g: 1e9,
  M: 1e6,
  k: 1e3,
  K: 1e3,
  m: 1e-3,
  u: 1e-6,
  U: 1e-6,
  'µ': 1e-6, // U+00B5 MICRO SIGN
  'μ': 1e-6, // U+03BC GREEK SMALL LETTER MU
  n: 1e-9,
  N: 1e-9,
  p: 1e-12,
  P: 1e-12,
  f: 1e-15,
};

/** RKM decimal markers: a scale factor, or R for "no scale" (4R7 = 4.7). */
const RKM_MARKERS: Readonly<Record<string, number>> = { ...PREFIX_LETTERS, R: 1, r: 1 };

const NUMBER_RE = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?/;
/** What may follow the scale factor: one unit word, letters only ("F", "Hz", "Ω", "ohms"). */
const UNIT_TAIL_RE = /^\s*\p{L}*\s*$/u;

const HOW_TO = 'write a number with an optional scale factor, like 4.7k, 4k7, 100n, 1M or 50';

function fail(reason: ValueParseFailure, message: string): ValueParse {
  return { ok: false, reason, message };
}

function done(value: number, tail: string, text: string): ValueParse {
  if (!UNIT_TAIL_RE.test(tail)) return notAValue(text, tail);
  if (!Number.isFinite(value)) return fail('range', `"${text}" is too large a number`);
  return { ok: true, value };
}

function notAValue(text: string, tail: string | null): ValueParse {
  if (text.includes(',')) {
    return fail(
      'comma',
      `"${text}" has a comma: write the decimal point as a dot and no thousands separator (4.7k, not 4,7k; 1000 or 1k, not 1,000)`,
    );
  }
  if (tail === null) return fail('syntax', `"${text}" does not start with a number; ${HOW_TO}`);
  return fail('syntax', `"${text}" has "${tail.trim()}" after the number; ${HOW_TO}`);
}

/**
 * Parse a field's value. A number passes through when it is finite; a string
 * must be a whole value (see the rules above). Anything else is not a value.
 */
export function parseValue(input: unknown): ValueParse {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? { ok: true, value: input } : fail('range', `${input} is not a finite number`);
  }
  if (input === undefined || input === null) return fail('empty', 'no value');
  if (typeof input !== 'string') return fail('syntax', `${String(input)} is not a number`);
  // A pasted minus sign (U+2212) is still a minus.
  const text = input.trim().replace(/^\u2212/, '-');
  if (!text) return fail('empty', 'no value');

  // "R47": RKM with nothing before the decimal marker.
  const leadingR = /^[Rr](\d+)/.exec(text);
  if (leadingR) return done(Number(`0.${leadingR[1]}`), text.slice(leadingR[0].length), text);

  const num = NUMBER_RE.exec(text);
  if (!num) return notAValue(text, null);
  const [whole, sign, mantissa, exponent] = num;
  const rest = text.slice(whole.length);

  // RKM: an integer, then the marker, then the decimals ("4k7", "2M2", "0R47").
  if (!mantissa.includes('.') && exponent === undefined) {
    const rkm = /^(.)(\d+)/u.exec(rest);
    if (rkm && rkm[1] in RKM_MARKERS) {
      const value = Number(`${sign}${mantissa}.${rkm[2]}`) * RKM_MARKERS[rkm[1]];
      return done(value, rest.slice(rkm[0].length), text);
    }
  }

  const n = Number(whole);
  const tail = rest.replace(/^\s+/, '');
  if (!tail) return done(n, '', text);
  const lower = tail.toLowerCase();

  for (const [word, mult] of PREFIX_WORDS) {
    if (lower.startsWith(word)) return done(n * mult, tail.slice(word.length), text);
  }
  // A unit word that starts like a scale factor: "farad" is not femto + "arad".
  if (lower.startsWith('farad')) return done(n, tail.slice(5), text);
  if (lower.startsWith('meg')) return done(n * 1e6, tail.slice(3), text);
  if (lower.startsWith('mil')) return done(n * 25.4e-6, tail.slice(3), text);

  const letter = String.fromCodePoint(tail.codePointAt(0)!);
  const mult = PREFIX_LETTERS[letter];
  if (mult !== undefined) return done(n * mult, tail.slice(letter.length), text);
  // No scale factor: whatever follows is the unit ("5V", "47R", "1F", "50Hz").
  return done(n, tail, text);
}

/**
 * The number a field holds, or `fallback` when it holds none (missing, empty
 * or unreadable). The circuit check reports the unreadable ones.
 */
export function parseValueWithUnits(input: unknown, fallback = NaN): number {
  const parsed = parseValue(input);
  return parsed.ok ? parsed.value : fallback;
}

/** Format a number back into a compact SPICE-style string. */
export function formatValueWithUnits(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toPrecision(3)}G`;
  if (abs >= 1e6) return `${(value / 1e6).toPrecision(3)}Meg`;
  if (abs >= 1e3) return `${(value / 1e3).toPrecision(3)}k`;
  if (abs >= 1) return `${value.toPrecision(3)}`;
  if (abs >= 1e-3) return `${(value * 1e3).toPrecision(3)}m`;
  if (abs >= 1e-6) return `${(value * 1e6).toPrecision(3)}u`;
  if (abs >= 1e-9) return `${(value * 1e9).toPrecision(3)}n`;
  if (abs >= 1e-12) return `${(value * 1e12).toPrecision(3)}p`;
  return `${(value * 1e15).toPrecision(3)}f`;
}

const DISPLAY_PREFIXES: ReadonlyArray<readonly [number, string]> = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
  [1e-15, 'f'],
];

/**
 * A quantity as a person reads it, with an SI prefix and up to four
 * significant digits: 4700 Ω is "4.7 kΩ", 1e-7 F is "100 nF", 0.001 Ω is
 * "1 mΩ". Shown next to the field so "what did it understand?" has an answer.
 */
export function formatQuantity(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `${value} ${unit}`;
  if (value === 0) return `0 ${unit}`;
  const abs = Math.abs(value);
  let i = DISPLAY_PREFIXES.findIndex(([scale]) => abs >= scale * (1 - 1e-12));
  if (i < 0) i = DISPLAY_PREFIXES.length - 1;
  let digits = Number((value / DISPLAY_PREFIXES[i]![0]).toPrecision(4));
  // 999.96 k rounds to 1000 k: say 1 M instead.
  if (Math.abs(digits) >= 1000 && i > 0) {
    i -= 1;
    digits = Number((value / DISPLAY_PREFIXES[i]![0]).toPrecision(4));
  }
  return `${digits} ${DISPLAY_PREFIXES[i]![1]}${unit}`;
}
