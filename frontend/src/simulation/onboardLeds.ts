/**
 * On-board LEDs: from the levels and frames a board's engine reports to what
 * the board element should draw.
 *
 * The canvas used to subscribe every board to pin 13 and hand the raw level
 * to the element, which is right for an Uno and for nothing else: the ESP32
 * kinds never lit (issue #374), and a board whose LED sits between 3V3 and
 * the pin would have shown the inverse of the hardware. The table in
 * types/board.ts now says which pin, and this module applies the polarity so
 * the element only ever sees "lit" or a colour.
 *
 * Levels alone are not enough for those active-LOW boards. pinMode(pin,
 * OUTPUT) drives the pad at whatever its output latch holds, LOW after reset,
 * and the engine reports no level change for it because the level did not
 * change. A sketch that writes LOW once in setup() and never toggles (an LED
 * switched on at boot) lights the real LOLIN32 Lite, XIAO ESP32S3, SuperMini
 * or the ESP32-CAM's red LED, and left this one dark (measured on
 * velxio.dev, 2026-10-04). So a pad is also painted from its current level
 * whenever it becomes an output, which PinManager reports on the config
 * channel, and once at attach for a board already running.
 */
import { onboardLedsFor, type OnboardLedVisual } from '../types/board';

/** The feeds an on-board LED can hang off; a PinManager is the first four. */
export interface OnboardLedSources {
  /** Digital levels the engine reports on this board's pads. */
  onPinChange: (pin: number, cb: (pin: number, state: boolean) => void) => () => void;
  getPinState: (pin: number) => boolean;
  /** Pads the MCU has driven, so a channel the sketch never touched reads as off. */
  getOutputPins: () => ReadonlySet<number>;
  /**
   * Fired when the guest reconfigures a pad (direction or pull: pinMode). The
   * one channel that carries "this pad is now an output at the level it
   * already held", which moves no level and so never reaches onPinChange.
   */
  onPinConfigChange: (pin: number, cb: () => void) => () => void;
  /** Decoded WS2812 frames going out on one pin of this board. */
  observeWs2812: (
    pin: number,
    sink: (pixels: ReadonlyArray<{ r: number; g: number; b: number }>) => void,
  ) => () => void;
}

/**
 * Subscribe the LEDs of `boardKind` to `src` and report each one's visual
 * through `setLed` whenever it changes. Returns the unsubscribe.
 *
 * A board that declares no LED gets no subscription. A pad the MCU has not
 * configured leaves its LED as the caller had it (unlit): an unconfigured pad
 * floats, and on an active-LOW board "floating" is not "on".
 */
export function attachOnboardLeds(
  boardKind: string,
  src: OnboardLedSources,
  setLed: (ledId: string, visual: OnboardLedVisual) => void,
): () => void {
  const unsubs: (() => void)[] = [];
  // The level of a pad the MCU drives, undefined for one it has not configured.
  const driven = (pin: number): boolean | undefined =>
    src.getOutputPins().has(pin) ? src.getPinState(pin) : undefined;
  for (const led of onboardLedsFor(boardKind)) {
    switch (led.kind) {
      case 'gpio': {
        const lit = (state: boolean): boolean => (led.activeLow ? !state : state);
        unsubs.push(src.onPinChange(led.pin, (_pin, state) => setLed(led.id, lit(state))));
        // The boot case from the header: paint from the pad's level when it
        // becomes an output. An active-HIGH LED reads LOW as dark here, which
        // is what it already showed, so only the active-LOW boards change.
        const paintDriven = (onConfig: boolean) => {
          const state = driven(led.pin);
          if (state !== undefined) setLed(led.id, lit(state));
          // pinMode(INPUT) releases the pad: no current flows through an LED
          // hung off a floating pad, whichever leg it is on. At attach an
          // unconfigured pad says nothing, so the caller's default stands.
          else if (onConfig) setLed(led.id, false);
        };
        unsubs.push(src.onPinConfigChange(led.pin, () => paintDriven(true)));
        paintDriven(false);
        break;
      }
      case 'rgb-gpio': {
        // Each colour is its own pad. On an active-LOW LED an untouched pad
        // must not count as "low, therefore on": the Nano ESP32 boots with
        // all three channels dark until the sketch writes them, so only a pad
        // the MCU has driven contributes.
        const pins = [led.pins.r, led.pins.g, led.pins.b];
        const channelOn = (pin: number): boolean => {
          const level = driven(pin);
          if (level === undefined) return false;
          return led.activeLow ? !level : level;
        };
        const paint = () => {
          setLed(led.id, {
            r: channelOn(led.pins.r) ? 255 : 0,
            g: channelOn(led.pins.g) ? 255 : 0,
            b: channelOn(led.pins.b) ? 255 : 0,
          });
        };
        for (const pin of pins) {
          unsubs.push(src.onPinChange(pin, paint));
          // Same boot case per channel: LED_RED written LOW once in setup()
          // is a red LED on the real board.
          unsubs.push(src.onPinConfigChange(pin, paint));
        }
        if (pins.some((pin) => src.getOutputPins().has(pin))) paint();
        break;
      }
      case 'ws2812':
        unsubs.push(
          src.observeWs2812(led.pin, (pixels) => {
            // The on-board LED is the first pixel of whatever goes out on its
            // pin; on the DevKitC-1 the same GPIO also reaches the header, so
            // a strip wired there shows the rest of the frame on its own.
            const px = pixels[0];
            if (px) setLed(led.id, { r: px.r, g: px.g, b: px.b });
          }),
        );
        break;
    }
  }
  return () => unsubs.forEach((u) => u());
}

/** Two visuals that would draw the same thing. */
export function sameLedVisual(a: OnboardLedVisual | undefined, b: OnboardLedVisual): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean' || a === undefined) return a === b;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}
