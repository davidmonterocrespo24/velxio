/**
 * ledcWrite(pin, 0) on an ESP32 must put 0 V into the circuit.
 *
 * collectPinStates stamps a PWM pad as its duty while the duty is above 0 and
 * falls back to the pad's GPIO latch when it is 0. On the ESP32 that latch is
 * not what drives an LEDC pad, and it was HIGH (the solver's input feedback had
 * set it before the sketch attached the channel), so the duty-0 step of a PWM
 * DAC put 3.3 V on its RC filter: an LM358 with a gain of 3.7 behind it showed
 * 12.2 V for a target of 0 V (velxio.dev example esp32-pwm-dac-lm358-12v,
 * 2026-11). applyPinPwm now drives the pad LOW on a duty of 0.
 */
import { describe, it, expect } from 'vitest';
import { collectPinStates } from '../simulation/spice/collectPinStates';
import { useSimulatorStore, getBoardPinManager, applyPinPwm } from '../store/useSimulatorStore';
import type { BoardKind } from '../types/board';

const WIRES = [{ start: { componentId: 'esp', pinName: '25' }, end: { componentId: 'r1', pinName: '1' } }];

describe('ESP32 LEDC duty 0', () => {
  it('stamps 0 V, not the stale HIGH latch, and a later digitalWrite still wins', () => {
    useSimulatorStore.getState().addBoard('esp32' as BoardKind, 0, 0, 'esp');
    try {
      const pm = getBoardPinManager('esp')!;
      const collect = () => collectPinStates('esp', 'esp32' as BoardKind, WIRES)['25'];

      // The latch is HIGH from the circuit before the sketch attached LEDC.
      pm.triggerPinChange(25, true, 'external');

      applyPinPwm(pm, 25, 50, 5000);
      expect(collect()).toEqual({ type: 'pwm', duty: 0.5 });

      applyPinPwm(pm, 25, 0, 5000);
      expect(collect()).toEqual({ type: 'digital', v: 0 });

      // ledcAttach then ledcWrite(pin, 0) straight away: never above 0.
      pm.triggerPinChange(25, true, 'external');
      applyPinPwm(pm, 25, 0, 5000);
      expect(collect()).toEqual({ type: 'digital', v: 0 });

      // ledcDetach + digitalWrite(HIGH): the GPIO drives the pad again.
      pm.triggerPinChange(25, true, 'mcu');
      expect(collect()).toEqual({ type: 'digital', v: 3.3 });
    } finally {
      useSimulatorStore.getState().removeBoard('esp');
    }
  });
});
