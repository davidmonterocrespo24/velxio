/**
 * partUtils.ts — Shared simulation helpers
 *
 * Provides ADC voltage injection utilities used by both ComplexParts and
 * SensorParts, supporting both AVR (ATmega328p) and RP2040 boards.
 */

import type { AnySimulator } from './PartSimulationRegistry';
import { RP2040Simulator } from '../RP2040Simulator';

/** DOM event fired when a runtime part mutates a user-facing property. */
export const PROPERTY_CHANGE_EVENT = 'velxio:property-change';

export interface PropertyChangeDetail {
  componentId: string;
  propName: string;
  value: unknown;
}

/**
 * Dispatch a property change so the canvas can route it through
 * `updateComponent()`. Parts call this whenever a DOM / sensor-panel value
 * mutates so the SPICE netlist memo invalidates and the next `maybeSolve()`
 * picks up the change. Parts stay decoupled from Zustand — `SimulatorCanvas`
 * is the single listener that applies the update.
 */
export function emitPropertyChange(componentId: string, propName: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
  const detail: PropertyChangeDetail = { componentId, propName, value };
  window.dispatchEvent(new CustomEvent(PROPERTY_CHANGE_EVENT, { detail }));
}

/** Read the ADC instance from the simulator (returns null if not initialized) */
export function getADC(avrSimulator: AnySimulator): any | null {
  return (avrSimulator as any).getADC?.() ?? null;
}

/**
 * Write an analog voltage to an ADC channel, supporting AVR, RP2040, and ESP32.
 *
 * AVR:    pins 14-19 → ADC channels 0-5, voltage stored directly (0-5V)
 * RP2040: GPIO 26-29 → ADC channels 0-3, converted to 12-bit value (0-4095)
 * ESP32:  GPIO 32-39 → ADC1 channels 4-11, sent via WebSocket bridge
 *
 * Returns true if the voltage was successfully injected.
 */
export function setAdcVoltage(simulator: AnySimulator, pin: number, voltage: number): boolean {
  // ESP32 BridgeShim: delegate to bridge via WebSocket
  if (typeof (simulator as any).setAdcVoltage === 'function') {
    return (simulator as any).setAdcVoltage(pin, voltage);
  }
  // RP2040: GPIO26-29 → ADC channels 0-3
  if (simulator instanceof RP2040Simulator) {
    if (pin >= 26 && pin <= 29) {
      const channel = pin - 26;
      // RP2040 ADC: 12-bit, 3.3V reference
      const adcValue = Math.round((voltage / 3.3) * 4095);
      simulator.setADCValue(channel, adcValue);
      return true;
    }
    console.warn(`[setAdcVoltage] RP2040 pin ${pin} is not an ADC pin (26-29)`);
    return false;
  }
  // AVR: pins 14-19 → ADC channels 0-5
  if (pin < 14 || pin > 19) return false;
  const channel = pin - 14;
  const adc = getADC(simulator);
  if (!adc) return false;
  adc.channelValues[channel] = voltage;
  return true;
}
