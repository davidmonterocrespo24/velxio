/**
 * partUtils.ts — Shared simulation helpers
 *
 * Provides ADC voltage injection utilities used by both ComplexParts and
 * SensorParts, supporting both AVR (ATmega328p) and RP2040 boards.
 */

import type { AnySimulator } from './PartSimulationRegistry';
import { RP2040Simulator } from '../RP2040Simulator';

/** Read the ADC instance from the simulator (returns null if not initialized) */
export function getADC(avrSimulator: AnySimulator): any | null {
    return (avrSimulator as any).getADC?.() ?? null;
}

/**
 * Write an analog voltage to an ADC channel, supporting both AVR and RP2040.
 *
 * AVR:    pins 14-19 → ADC channels 0-5, voltage stored directly (0-5V)
 * RP2040: GPIO 26-29 → ADC channels 0-3, converted to 12-bit value (0-4095)
 *
 * Returns true if the voltage was successfully injected.
 */
export function setAdcVoltage(simulator: AnySimulator, pin: number, voltage: number): boolean {
    // RP2040: GPIO26-29 → ADC channels 0-3
    if (simulator instanceof RP2040Simulator) {
        if (pin >= 26 && pin <= 29) {
            const channel = pin - 26;
            // RP2040 ADC: 12-bit, 3.3V reference
            const adcValue = Math.round((voltage / 3.3) * 4095);
            console.log(`[setAdcVoltage] RP2040 ch${channel} = ${adcValue} (${voltage.toFixed(3)}V)`);
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
