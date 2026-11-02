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

/**
 * A numeric value the canvas copied onto an element (a number, or the numeric
 * string the property dialog and older saves store), or `fallback` when the
 * project leaves it unset or it is not a number.
 */
export function elementNumber(raw: unknown, fallback: number): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : fallback;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** Read the ADC instance from the simulator (returns null if not initialized) */
export function getADC(avrSimulator: AnySimulator): any | null {
  return (avrSimulator as any).getADC?.() ?? null;
}

/**
 * Elapsed GUEST time in milliseconds, or null when this simulator cannot say.
 *
 * A part that generates a time-varying signal (a pulse waveform, a tone, any
 * periodic source) must advance it on the clock the SKETCH sees, not on the
 * browser's. The two are not the same rate: an emulated board runs slower than
 * real time under load, so a signal stepped by `performance.now()` sweeps past
 * a guest that is only managing a couple of loop iterations a second. The
 * sketch then aliases it — samples land at effectively random phases and a
 * beat / period measured from `millis()` comes out nowhere near what the part
 * was asked to produce.
 *
 * Sources, in order:
 *  - `getGuestMicros()` — engines that carry their own virtual clock but no
 *    CPU cycle counter the host can read (the in-browser ESP32 engines).
 *  - `getCurrentCycles()` + `getClockHz()` — AVR and RP2040.
 *
 * NOTE the cycle path is deliberately NOT reached through a "does this board
 * have cycles?" test: several parts use `getCurrentCycles() >= 0` to tell an
 * AVR from an ESP32 bridge, so that predicate must keep meaning what it does.
 *
 * Returns null for a backend-QEMU board, whose clock lives in another process;
 * callers fall back to wall time.
 */
export function guestMillis(simulator: AnySimulator): number | null {
  const sim = simulator as unknown as {
    getGuestMicros?: () => number;
    getCurrentCycles?: () => number;
    getClockHz?: () => number;
  };
  if (typeof sim.getGuestMicros === 'function') {
    const us = sim.getGuestMicros();
    if (Number.isFinite(us) && us >= 0) return us / 1000;
  }
  if (typeof sim.getCurrentCycles === 'function' && typeof sim.getClockHz === 'function') {
    const cycles = sim.getCurrentCycles();
    const hz = sim.getClockHz();
    if (Number.isFinite(cycles) && cycles >= 0 && Number.isFinite(hz) && hz > 0) {
      return (cycles / hz) * 1000;
    }
  }
  return null;
}

/** A part's one-shot timer: run `cb` once `ms` have passed; the result cancels it. */
export type PartTimeout = (simulator: AnySimulator, cb: () => void, ms: number) => () => void;

const wallTimeout: PartTimeout = (_simulator, cb, ms) => {
  const t = setTimeout(cb, ms);
  return () => clearTimeout(t);
};

let partTimeoutImpl: PartTimeout = wallTimeout;

/**
 * Overlay seam: the clock a part's timed output counts on. The default is the
 * wall clock (setTimeout, what every part used); an overlay can install one
 * that counts the board's guest time, so a pulse lasts what the sketch sees
 * whatever speed the board is emulated at (velxio/velxio-prod#23). Pass null
 * to restore the default.
 */
export function installPartTimeout(fn: PartTimeout | null): void {
  partTimeoutImpl = fn ?? wallTimeout;
}

/** Run `cb` once `ms` have passed on `simulator`'s board, by the installed clock; returns what cancels it. */
export function partTimeout(simulator: AnySimulator, cb: () => void, ms: number): () => void {
  return partTimeoutImpl(simulator, cb, ms);
}

/**
 * Supply rail the analog front end of THIS board runs on, in volts.
 *
 * A part that builds a resistive divider has to use the rail it is actually
 * wired to. Assuming 5 V everywhere is not a small error on a 3.3 V board: it
 * pushes the computed node voltage above the ADC's full scale, so the reading
 * saturates and a whole stretch of the control slider reports the same value.
 * (An NTC divider assumed at 5 V reads 1.4 C on an ESP32 when the slider says
 * 25 C, and pins at full scale for everything below ~11 C — issue #233.)
 *
 * The split matches setAdcVoltage's own branches: AVR converts against a 5 V
 * reference, RP2040 and the ESP32 bridge against 3.3 V.
 */
export function analogRailVolts(simulator: AnySimulator): number {
  if (typeof (simulator as any).setAdcVoltage === 'function') return 3.3; // ESP32 bridge
  if (simulator instanceof RP2040Simulator) return 3.3;
  return 5.0; // AVR
}

/**
 * Write an analog voltage to an ADC channel, supporting AVR, RP2040, and ESP32.
 *
 * AVR:    pins 14-21 → channels 0-7 (Uno / Nano), 54-69 → channels 0-15
 *         (Mega). Voltage stored directly (0-5V)
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
  // AVR. Two families, two pad ranges, and both were wrong before:
  //
  //   14-21  A0-A7 on the ATmega328P. The DIP Uno has no A6/A7 and its
  //          element draws none, but the Nano's TQFP part does have ADC6
  //          and ADC7 and the Nano element breaks both out — a knob wired
  //          there fed nothing.
  //   54-69  A0-A15 on the ATmega2560. Every one of them was out of range,
  //          so analog input on a Mega did nothing at all.
  //
  // Silently, in both cases: this returns false and no caller checks it, so
  // the sketch reads a steady zero from a knob it can see turning.
  const channel = pin >= 54 && pin <= 69 ? pin - 54 : pin >= 14 && pin <= 21 ? pin - 14 : -1;
  if (channel < 0) return false;
  const adc = getADC(simulator);
  if (!adc) return false;
  adc.channelValues[channel] = voltage;
  return true;
}

/**
 * The board pin a two-terminal input part drives: the first of `names` that is
 * wired to a REAL pin.
 *
 * A button or a switch has no signal leg and no ground leg, only legs, and the
 * user decides which goes where. `getArduinoPin(a) ?? getArduinoPin(b)` reads
 * as "the first one that is wired", but a leg on GND or on a supply rail does
 * not resolve to null: it resolves to -1 (PinTrace's RAIL). So with GND on the
 * first leg tried, the part kept -1 for good and drove a pin nobody reads.
 *
 * Invisible on the boards whose inputs come from the SPICE solve, because
 * there the part never pushes a level at all. It bit the boards that do take
 * the push: a Raspberry Pi's pushbutton wired GND-first sent
 * `{"type":"gpio_in","data":{"pin":-1,...}}` to the guest, and the gallery
 * example wired exactly that way never saw its button.
 */
export function firstBoardPin(
  getArduinoPin: (pinName: string) => number | null,
  names: readonly string[],
): number | null {
  for (const name of names) {
    const pin = getArduinoPin(name);
    if (pin !== null && pin >= 0) return pin;
  }
  return null;
}
