/**
 * PinManager Tests
 *
 * Covers:
 * - Digital pin change listeners (updatePort, onPinChange)
 * - PWM duty cycle (onPwmChange, updatePwm, getPwmValue)
 * - Analog voltage injection (onAnalogChange, setAnalogVoltage)
 * - Direct pin trigger (triggerPinChange) — used by RP2040Simulator
 * - Listener cleanup (unsubscribe, clearAllListeners)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PinManager } from '../simulation/PinManager';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePin() {
  const pm = new PinManager();
  return pm;
}

// ─── Digital pin API ─────────────────────────────────────────────────────────

describe('PinManager — digital pins', () => {
  let pm: PinManager;
  beforeEach(() => {
    pm = makePin();
  });

  it('starts with no listeners and all pins LOW', () => {
    expect(pm.getListenersCount()).toBe(0);
    expect(pm.getPinState(13)).toBe(false);
  });

  it('registers and unregisters listeners', () => {
    const cb = vi.fn();
    const unsub = pm.onPinChange(13, cb);
    expect(pm.getListenersCount()).toBe(1);
    unsub();
    expect(pm.getListenersCount()).toBe(0);
  });

  it('fires listeners when PORTB pin changes', () => {
    const cb = vi.fn();
    pm.onPinChange(13, cb); // pin 13 = PORTB bit 5
    pm.updatePort('PORTB', 0x20, 0x00);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(13, true);
  });

  it('fires listeners when PORTB pin goes LOW', () => {
    const cb = vi.fn();
    pm.onPinChange(13, cb);
    pm.updatePort('PORTB', 0x20, 0x00); // HIGH
    pm.updatePort('PORTB', 0x00, 0x20); // LOW
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(2, 13, false);
  });

  it('does not fire when bit does not change', () => {
    const cb = vi.fn();
    pm.onPinChange(13, cb);
    pm.updatePort('PORTB', 0x20, 0x20); // same value
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires listeners on PORTC (analog pins A0-A5 = 14-19)', () => {
    const cb = vi.fn();
    pm.onPinChange(14, cb); // A0 = PORTC bit 0
    pm.updatePort('PORTC', 0x01, 0x00);
    expect(cb).toHaveBeenCalledWith(14, true);
  });

  it('fires listeners on PORTD (digital pins 0-7)', () => {
    const cb = vi.fn();
    pm.onPinChange(0, cb); // D0 = PORTD bit 0
    pm.onPinChange(7, cb); // D7 = PORTD bit 7
    pm.updatePort('PORTD', 0x81, 0x00); // bits 0 and 7
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith(0, true);
    expect(cb).toHaveBeenCalledWith(7, true);
  });

  it('supports multiple listeners on the same pin', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    pm.onPinChange(13, cb1);
    pm.onPinChange(13, cb2);
    pm.updatePort('PORTB', 0x20, 0x00);
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it('tracks pin states correctly', () => {
    expect(pm.getPinState(13)).toBe(false);
    pm.updatePort('PORTB', 0x20, 0x00);
    expect(pm.getPinState(13)).toBe(true);
    pm.updatePort('PORTB', 0x00, 0x20);
    expect(pm.getPinState(13)).toBe(false);
  });

  it('clearAllListeners removes all subscriptions', () => {
    pm.onPinChange(13, vi.fn());
    pm.onPinChange(12, vi.fn());
    pm.clearAllListeners();
    expect(pm.getListenersCount()).toBe(0);
  });
});

// ─── PWM API ─────────────────────────────────────────────────────────────────

describe('PinManager — PWM duty cycle', () => {
  let pm: PinManager;
  beforeEach(() => {
    pm = makePin();
  });

  it('starts with PWM value 0 on all pins', () => {
    expect(pm.getPwmValue(9)).toBe(0);
    expect(pm.getPwmValue(3)).toBe(0);
  });

  it('fires PWM listeners when duty cycle changes', () => {
    const cb = vi.fn();
    pm.onPwmChange(9, cb);
    pm.updatePwm(9, 0.5);
    expect(cb).toHaveBeenCalledWith(9, 0.5);
  });

  it('stores the latest PWM value', () => {
    pm.updatePwm(9, 0.75);
    expect(pm.getPwmValue(9)).toBe(0.75);
    pm.updatePwm(9, 0.25);
    expect(pm.getPwmValue(9)).toBe(0.25);
  });

  it('unsubscribes PWM listeners', () => {
    const cb = vi.fn();
    const unsub = pm.onPwmChange(9, cb);
    unsub();
    pm.updatePwm(9, 0.5);
    expect(cb).not.toHaveBeenCalled();
  });

  it('supports PWM on all six Arduino PWM pins', () => {
    const pwmPins = [3, 5, 6, 9, 10, 11];
    const callbacks = pwmPins.map(() => vi.fn());
    pwmPins.forEach((pin, i) => pm.onPwmChange(pin, callbacks[i]));

    pwmPins.forEach((pin, i) => {
      const dc = (i + 1) / 6;
      pm.updatePwm(pin, dc);
      expect(callbacks[i]).toHaveBeenCalledWith(pin, dc);
    });
  });
});

// ─── Analog voltage API ──────────────────────────────────────────────────────

describe('PinManager — analog voltage', () => {
  let pm: PinManager;
  beforeEach(() => {
    pm = makePin();
  });

  it('fires analog listeners when voltage is set', () => {
    const cb = vi.fn();
    pm.onAnalogChange(14, cb); // A0 = pin 14
    pm.setAnalogVoltage(14, 2.5);
    expect(cb).toHaveBeenCalledWith(14, 2.5);
  });

  it('fires for multiple analog pins independently', () => {
    const cbA0 = vi.fn();
    const cbA1 = vi.fn();
    pm.onAnalogChange(14, cbA0);
    pm.onAnalogChange(15, cbA1);
    pm.setAnalogVoltage(14, 1.0);
    pm.setAnalogVoltage(15, 3.3);
    expect(cbA0).toHaveBeenCalledWith(14, 1.0);
    expect(cbA1).toHaveBeenCalledWith(15, 3.3);
    expect(cbA0).not.toHaveBeenCalledWith(15, expect.anything());
  });

  it('unsubscribes analog listeners', () => {
    const cb = vi.fn();
    const unsub = pm.onAnalogChange(14, cb);
    unsub();
    pm.setAnalogVoltage(14, 5.0);
    expect(cb).not.toHaveBeenCalled();
  });
});

// ─── Direct pin trigger (RP2040) ─────────────────────────────────────────────

describe('PinManager — triggerPinChange (RP2040)', () => {
  let pm: PinManager;
  beforeEach(() => {
    pm = makePin();
  });

  it('fires listeners directly by pin number', () => {
    const cb = vi.fn();
    pm.onPinChange(25, cb); // GPIO25 = LED on Pico
    pm.triggerPinChange(25, true);
    expect(cb).toHaveBeenCalledWith(25, true);
  });

  it('updates pin state on triggerPinChange', () => {
    expect(pm.getPinState(25)).toBe(false);
    pm.triggerPinChange(25, true);
    expect(pm.getPinState(25)).toBe(true);
    pm.triggerPinChange(25, false);
    expect(pm.getPinState(25)).toBe(false);
  });

  it('does NOT fire if state is identical (no-change optimization)', () => {
    pm.triggerPinChange(25, true); // first: fires
    const cb = vi.fn();
    pm.onPinChange(25, cb);
    pm.triggerPinChange(25, true); // same state → should NOT fire
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires when toggled HIGH then LOW', () => {
    const cb = vi.fn();
    pm.onPinChange(0, cb);
    pm.triggerPinChange(0, true);
    pm.triggerPinChange(0, false);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, 0, true);
    expect(cb).toHaveBeenNthCalledWith(2, 0, false);
  });

  it('handles all 30 RP2040 GPIO pins independently', () => {
    const callbacks: ReturnType<typeof vi.fn>[] = [];
    for (let i = 0; i < 30; i++) {
      const cb = vi.fn();
      callbacks.push(cb);
      pm.onPinChange(i, cb);
    }
    pm.triggerPinChange(7, true);
    pm.triggerPinChange(25, true);
    expect(callbacks[7]).toHaveBeenCalledWith(7, true);
    expect(callbacks[25]).toHaveBeenCalledWith(25, true);
    // Others should NOT have fired
    [0, 1, 8, 24, 26].forEach((i) => {
      expect(callbacks[i]).not.toHaveBeenCalled();
    });
  });
});
