/**
 * PadBus — the pad drive-state channel, as one reusable piece.
 *
 * `PinManager` carries it for the boards whose simulator reports through the
 * manager (AVR, RP2040, RP2350). A bridge that owns an engine directly (the
 * in-browser ESP32 engines) carries its own bus, fed from the engine's
 * callbacks, and hands it to the same {@link LineSensorHub}. Same dedup, same
 * derived resting level, same event shape, one implementation.
 */

import { INITIAL_PAD, restingLevel, type PadDrive, type PadEvent, type PadPull, type PadState } from './padEvent';

export class PadBus {
  private readonly states = new Map<number, PadState>();
  private readonly listeners = new Map<number, Set<(e: PadEvent) => void>>();

  /** Subscribe to guest drive-state changes on one pad. */
  onPad(pin: number, callback: (e: PadEvent) => void): () => void {
    if (!this.listeners.has(pin)) this.listeners.set(pin, new Set());
    this.listeners.get(pin)!.add(callback);
    return () => {
      this.listeners.get(pin)?.delete(callback);
    };
  }

  /** The pad's current drive state (released with no pull until reported). */
  get(pin: number): Readonly<PadState> {
    return this.states.get(pin) ?? INITIAL_PAD;
  }

  /** The pad's drive state, or undefined when the guest never reported it. */
  peek(pin: number): Readonly<PadState> | undefined {
    return this.states.get(pin);
  }

  /**
   * Report what the guest did to a pad. Fires only on a real change of drive
   * or pull; the resting level is derived here so no reporter computes it.
   */
  report(pin: number, drive: PadDrive, pull: PadPull, cycle: number): void {
    const prev = this.states.get(pin) ?? INITIAL_PAD;
    if (prev.drive === drive && prev.pull === pull) return;
    const level = restingLevel(drive, pull, prev.level);
    const next: PadState = { drive, pull, level, cycle };
    this.states.set(pin, next);
    const callbacks = this.listeners.get(pin);
    if (!callbacks || callbacks.size === 0) return;
    const event: PadEvent = { pin, ...next, prev };
    callbacks.forEach((cb) => cb(event));
  }

  /** Every pad back to released-with-no-pull, silently: a cold boot. */
  clear(): void {
    this.states.clear();
  }
}
