/**
 * The RGB LED as the circuit sees it: three LED dies joined at one common pin
 * (velxio/velxio-prod#174). Shared by its SPICE card (componentToSpice), the
 * Run check (circuitVerifier) and the part that lights the element
 * (ComplexParts), so the three agree on the names.
 */

export interface RgbLedChannel {
  /** The part's pin. */
  pin: 'R' | 'G' | 'B';
  /** How a message names the colour. */
  colour: 'red' | 'green' | 'blue';
  /** The wokwi-rgb-led property that draws it, a 0-1 brightness. */
  prop: 'ledRed' | 'ledGreen' | 'ledBlue';
}

export const RGB_LED_CHANNELS: readonly RgbLedChannel[] = [
  { pin: 'R', colour: 'red', prop: 'ledRed' },
  { pin: 'G', colour: 'green', prop: 'ledGreen' },
  { pin: 'B', colour: 'blue', prop: 'ledBlue' },
];

/** The 0 V source in series with a colour's die (its current is the colour's). */
export function rgbLedSenseSource(componentId: string, pin: RgbLedChannel['pin']): string {
  return `V_${componentId}_${pin.toLowerCase()}_sense`;
}

/** The key the solve publishes that source's current under. */
export function rgbLedSenseKey(componentId: string, pin: RgbLedChannel['pin']): string {
  return rgbLedSenseSource(componentId, pin).toLowerCase();
}

/**
 * Which end of the dies COM is. 'auto' (the default, and what a project saved
 * before the property existed carries) reads the wiring: COM on a supply rail is
 * a common anode, the type Wokwi's part defaults to; anywhere else (ground, as
 * every gallery example wires it, or a pin) it is a common cathode, which is how
 * Velxio's part always lit. 'anode' and 'cathode' say it outright, for a COM
 * driven by a pin or by a supply the wiring cannot name.
 */
export type RgbLedCommon = 'auto' | 'anode' | 'cathode';

export function rgbLedCommon(properties: Record<string, unknown> | undefined): RgbLedCommon {
  const v = String(properties?.common ?? 'auto').trim().toLowerCase();
  return v === 'anode' || v === 'cathode' ? v : 'auto';
}
