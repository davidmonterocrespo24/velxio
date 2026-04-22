/**
 * Wire Colors Utility
 *
 * Automatically determines wire colors based on signal types.
 * Follows Wokwi color conventions for electrical connections.
 */

import type { WireSignalType, WireColorMap } from '../types/wire';

/**
 * Color mapping for different signal types
 */
export const WIRE_COLORS: WireColorMap = {
  'power-vcc': '#ff0000', // Red - Power positive
  'power-gnd': '#000000', // Black - Ground
  analog: '#4169e1', // Royal Blue - Analog signals
  digital: '#00ff00', // Green - Digital signals
  pwm: '#8b5cf6', // Purple - PWM signals
  i2c: '#ffd700', // Gold/Yellow - I2C bus
  spi: '#ff8c00', // Orange - SPI bus
  usart: '#00ced1', // Cyan - Serial UART
};

/**
 * Determines the signal type from pin signal information.
 * Returns the most specific signal type based on priority.
 *
 * Priority order: power > specialized protocols > PWM > analog > digital
 *
 * @param signals - Array of PinSignalInfo from wokwi-elements
 * @returns The determined signal type or 'digital' as default
 */
export function determineSignalType(signals: any[]): WireSignalType {
  if (!signals || signals.length === 0) {
    return 'digital'; // Default for generic pins
  }

  // Priority 1: Power signals (highest priority)
  for (const signal of signals) {
    if (signal.type === 'power') {
      return signal.signal === 'VCC' ? 'power-vcc' : 'power-gnd';
    }
  }

  // Priority 2: Specialized communication protocols
  for (const signal of signals) {
    if (signal.type === 'i2c') return 'i2c';
    if (signal.type === 'spi') return 'spi';
    if (signal.type === 'usart') return 'usart';
  }

  // Priority 3: PWM capability
  for (const signal of signals) {
    if (signal.type === 'pwm') return 'pwm';
  }

  // Priority 4: Analog signals
  for (const signal of signals) {
    if (signal.type === 'analog') return 'analog';
  }

  // Default: Digital signal
  return 'digital';
}

/**
 * Gets the wire color for a given signal type.
 *
 * @param signalType - The signal type of the wire
 * @returns Hex color code as string
 */
export function getWireColor(signalType: WireSignalType | null): string {
  if (!signalType) return WIRE_COLORS['digital']; // Default green
  return WIRE_COLORS[signalType];
}

/**
 * Gets a human-readable label for a signal type.
 * Useful for tooltips and debugging.
 *
 * @param signalType - The signal type
 * @returns Human-readable label
 */
export function getSignalTypeLabel(signalType: WireSignalType): string {
  const labels: Record<WireSignalType, string> = {
    'power-vcc': 'Power (VCC)',
    'power-gnd': 'Ground (GND)',
    analog: 'Analog Signal',
    digital: 'Digital Signal',
    pwm: 'PWM Signal',
    i2c: 'I2C Bus',
    spi: 'SPI Bus',
    usart: 'Serial UART',
  };

  return labels[signalType];
}
