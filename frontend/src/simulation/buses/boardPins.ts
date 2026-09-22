/**
 * The BoardPins every engine adapter hands the fabric, built from the board's
 * PinManager so all of them read a chip select the same way (level channel,
 * pad drive state, and the host path for driving an input).
 */

import type { PinManager } from '../PinManager';
import type { BoardPins } from './types';

export function boardPinsFromPinManager(
  pm: PinManager,
  driveInput?: (pin: number, level: boolean) => void,
): BoardPins {
  return {
    onPinChange: (pin, cb) => pm.onPinChange(pin, cb),
    peekPinState: (pin) => pm.peekPinState(pin),
    peekPad: (pin) => {
      const p = pm.peekPad(pin);
      return p ? { drive: p.drive, pull: p.pull } : undefined;
    },
    onPadChange: (pin, cb) => pm.onPadChange(pin, () => cb()),
    ...(driveInput ? { driveInput } : {}),
  };
}
