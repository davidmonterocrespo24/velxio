/**
 * ldrModel — the resistance of a CdS photoresistor (LDR) against light.
 *
 * Datasheets give an LDR as a power law: R = R10 · (10 / lux)^γ, where R10 is
 * the resistance at 10 lux and γ = lg(R10 / R100) is the slope of the log-log
 * curve (Senba GL55 series manual), down to a dark resistance it never
 * exceeds. The defaults are a GL5528, the LDR of the common breakout module:
 * 10-20 kΩ at 10 lux (15 kΩ here), γ = 0.6, at least 1 MΩ dark. Across the
 * GL55 series the dark resistance is about 67 times R10 (0.5 MΩ for the
 * 5-10 kΩ GL5516, 10 MΩ for the 100-200 kΩ GL5549), so a part given only its
 * `rl10` gets the matching dark resistance.
 *
 * The model used before was R = Rdark / (1 + k · lux / 1000) with Rdark 1 MΩ
 * and k = 5: 952 kΩ at 10 lux and 167 kΩ at 1000 lux, 50 to 270 times a real
 * part, so the module's AO only moved between 0.05 and 0.28 V
 * (velxio/velxio-prod#103). `k` means nothing any more.
 *
 * The properties take Wokwi's names for the same element, so an imported
 * project keeps its values: `rl10` (kΩ at 10 lux) and `gamma`. `dark` is the
 * dark resistance in ohms with SPICE suffixes ("1Meg").
 */
import { parseValueWithUnits } from './valueParser';

/** GL5528 (Senba GL55 series manual): R10 10-20 kΩ, γ 0.6, dark ≥ 1 MΩ. */
export const LDR_DEFAULTS = { rl10: 15, gamma: 0.6, darkOhms: 1_000_000 } as const;

export interface LdrParams {
  /** Resistance at 10 lux, kΩ. */
  rl10: number;
  /** Slope of log(R) against log(lux). */
  gamma: number;
  /** Dark resistance, ohms: the most the LDR ever reads. */
  darkOhms: number;
}

/** A positive finite number from a property, or the fallback. */
function positive(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The LDR parameters a part's properties ask for, with the GL5528 defaults.
 * `onBadDark` hears about a dark value too small to be one (see below).
 */
export function ldrParams(
  properties: Record<string, unknown>,
  onBadDark?: (raw: unknown, parsed: number) => void,
): LdrParams {
  const rl10 = positive(properties.rl10, LDR_DEFAULTS.rl10);
  // The dark resistance scales with R10 across the GL55 series (1 MΩ at 15 kΩ).
  let darkOhms = LDR_DEFAULTS.darkOhms * (rl10 / LDR_DEFAULTS.rl10);
  // `dark` goes through the SPICE suffix convention, where M is MILLI and
  // mega is `Meg`. A dark resistance below 1k is not a photoresistor: it is
  // almost always "1M" written meaning 1 megaohm, which parses to 0.001 ohm
  // and shorts the LDR whatever the light. Keep the default and say so.
  if (properties.dark !== undefined) {
    const parsed = parseValueWithUnits(properties.dark, darkOhms);
    if (parsed >= 1_000) darkOhms = parsed;
    else onBadDark?.(properties.dark, parsed);
  }
  return { rl10, gamma: positive(properties.gamma, LDR_DEFAULTS.gamma), darkOhms };
}

/** The LDR's resistance in ohms at `lux`. */
export function ldrResistance(lux: number, p: LdrParams = LDR_DEFAULTS): number {
  if (!(lux > 0)) return p.darkOhms;
  return Math.min(p.darkOhms, p.rl10 * 1000 * Math.pow(10 / lux, p.gamma));
}
