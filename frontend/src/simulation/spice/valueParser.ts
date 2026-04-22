/**
 * Parse a value string with SPICE-style SI suffixes.
 *
 *   "4.7k"   → 4700
 *   "220"    → 220
 *   "1Meg"   → 1_000_000
 *   "10u"    → 1e-5
 *   "100n"   → 1e-7
 *   "0.1u"   → 1e-7
 *   "22p"    → 2.2e-11
 *   "10mH"   → 0.01
 *   "1.5H"   → 1.5
 *
 * Recognized suffixes (case-insensitive for most; `Meg` is special):
 *   G = 1e9    T = 1e12   Meg = 1e6   K = 1e3
 *   m = 1e-3   u = 1e-6   n = 1e-9    p = 1e-12   f = 1e-15
 *
 * Trailing unit letters (Ω, F, H, V, A) are tolerated and stripped.
 * Returns `fallback` if parsing fails.
 */
const SUFFIX_MAP: Array<[string, number]> = [
  ['meg', 1e6],
  ['g', 1e9],
  ['t', 1e12],
  ['k', 1e3],
  ['m', 1e-3],
  ['u', 1e-6],
  ['µ', 1e-6],
  ['n', 1e-9],
  ['p', 1e-12],
  ['f', 1e-15],
];

export function parseValueWithUnits(input: unknown, fallback = NaN): number {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input !== 'string') return fallback;

  let s = input.trim();
  if (!s) return fallback;

  // Strip trailing physical unit words (non-SI-prefix ones)
  s = s.replace(/(ohms?|Ω|farads?|henrys?|henries|amps?|volts?|ω|watts?)\s*$/i, '');
  // Strip trailing single-letter unit (Ω, H, V, A, W). NOT F (which is femto in SPICE).
  // Only strip when preceded by a digit or SI-prefix letter, not when the whole
  // input is just the unit (so we don't turn "k" into "").
  s = s.replace(/([0-9a-zµ])[ΩHVAW]$/i, '$1');

  // Try suffix match (longest first — "meg" before "m")
  const lower = s.toLowerCase();
  for (const [suffix, mult] of SUFFIX_MAP) {
    if (lower.endsWith(suffix)) {
      const numPart = s.slice(0, s.length - suffix.length);
      const n = parseFloat(numPart);
      if (Number.isFinite(n)) return n * mult;
    }
  }

  // Plain number
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
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
