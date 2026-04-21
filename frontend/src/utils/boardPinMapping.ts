/**
 * Board Pin Mapping Utility
 *
 * Maps wokwi-element pin names to simulator GPIO/pin numbers
 * for both Arduino Uno (AVR) and Nano RP2040 Connect (RP2040).
 *
 * The wokwi board elements expose pin names like 'D2', 'A0', 'TX', etc.
 * The simulators need numeric GPIO/pin numbers.
 */

/**
 * Nano RP2040 Connect element pin names → RP2040 GPIO numbers.
 * Derived from wokwi-nano-rp2040-connect-element.ts pinInfo descriptions.
 */
const NANO_RP2040_PIN_MAP: Record<string, number> = {
  D2: 25, // GPIO25 — LED_BUILTIN
  D3: 15, // GPIO15
  D4: 16, // GPIO16 — SPI0 MISO
  D5: 17, // GPIO17 — SPI0 CS
  D6: 18, // GPIO18 — SPI0 SCK
  D7: 19, // GPIO19 — SPI0 MOSI
  D8: 20, // GPIO20
  D9: 21, // GPIO21
  D10: 5, // GPIO05
  D11: 7, // GPIO07
  D12: 4, // GPIO04 — I2C0 SDA
  D13: 6, // GPIO06 — SPI0 SCK (alternate)
  TX: 0, // GPIO0 — UART0 TX
  RX: 1, // GPIO1 — UART0 RX
  A0: 26, // GPIO26 — ADC channel 0
  A1: 27, // GPIO27 — ADC channel 1
  A2: 28, // GPIO28 — ADC channel 2
  A3: 29, // GPIO29 — ADC channel 3
  A4: 12, // GPIO12
  A5: 13, // GPIO13
};

/**
 * Arduino Uno analog pin names → AVR pin numbers.
 * Digital pins D0-D13 are parsed numerically; only analog names need mapping.
 */
const ARDUINO_UNO_ANALOG_MAP: Record<string, number> = {
  A0: 14,
  A1: 15,
  A2: 16,
  A3: 17,
  A4: 18,
  A5: 19,
  A6: 20,
  A7: 21,
};

/**
 * Arduino Mega analog pin names → AVR pin numbers.
 * A0–A15 map to physical pins 54–69 on the ATmega2560.
 */
const ARDUINO_MEGA_ANALOG_MAP: Record<string, number> = {
  A0: 54,
  A1: 55,
  A2: 56,
  A3: 57,
  A4: 58,
  A5: 59,
  A6: 60,
  A7: 61,
  A8: 62,
  A9: 63,
  A10: 64,
  A11: 65,
  A12: 66,
  A13: 67,
  A14: 68,
  A15: 69,
};

/**
 * Raspberry Pi 3B physical pin number → BCM GPIO number.
 * Power / GND / special-function pins are mapped to -1 (not a GPIO).
 * Source: https://pinout.xyz
 */
export const PI3_PHYSICAL_TO_BCM: Record<number, number> = {
  1: -1, // 3.3V
  2: -1, // 5V
  3: 2, // BCM2 (SDA1)
  4: -1, // 5V
  5: 3, // BCM3 (SCL1)
  6: -1, // GND
  7: 4, // BCM4 (GPCLK0)
  8: 14, // BCM14 (TXD0 / ttyAMA0)
  9: -1, // GND
  10: 15, // BCM15 (RXD0 / ttyAMA0)
  11: 17, // BCM17
  12: 18, // BCM18 (PWM0)
  13: 27, // BCM27
  14: -1, // GND
  15: 22, // BCM22
  16: 23, // BCM23
  17: -1, // 3.3V
  18: 24, // BCM24
  19: 10, // BCM10 (MOSI)
  20: -1, // GND
  21: 9, // BCM9 (MISO)
  22: 25, // BCM25
  23: 11, // BCM11 (SCLK)
  24: 8, // BCM8 (CE0)
  25: -1, // GND
  26: 7, // BCM7 (CE1)
  27: -1, // ID_SD (reserved)
  28: -1, // ID_SC (reserved)
  29: 5, // BCM5
  30: -1, // GND
  31: 6, // BCM6
  32: 12, // BCM12 (PWM0)
  33: 13, // BCM13 (PWM1)
  34: -1, // GND
  35: 19, // BCM19 (MISO1)
  36: 16, // BCM16 (CE2)
  37: 26, // BCM26
  38: 20, // BCM20 (MOSI1)
  39: -1, // GND
  40: 21, // BCM21 (SCLK1)
};

/** BCM GPIO number → physical pin number (reverse map) */
export const PI3_BCM_TO_PHYSICAL: Record<number, number> = Object.fromEntries(
  Object.entries(PI3_PHYSICAL_TO_BCM)
    .filter(([, bcm]) => bcm >= 0)
    .map(([physical, bcm]) => [bcm, Number(physical)]),
);

/**
 * ESP32 DevKit-C GPIO pin names → GPIO numbers.
 * Pin names are GPIO numbers directly (GPIO0–GPIO39).
 * Special aliases: TX=1, RX=3.
 */
const ESP32_PIN_MAP: Record<string, number> = {
  TX: 1,
  RX: 3,
  GPIO0: 0,
  GPIO1: 1,
  GPIO2: 2,
  GPIO3: 3,
  GPIO4: 4,
  GPIO5: 5,
  GPIO6: 6,
  GPIO7: 7,
  GPIO8: 8,
  GPIO9: 9,
  GPIO10: 10,
  GPIO11: 11,
  GPIO12: 12,
  GPIO13: 13,
  GPIO14: 14,
  GPIO15: 15,
  GPIO16: 16,
  GPIO17: 17,
  GPIO18: 18,
  GPIO19: 19,
  GPIO20: 20,
  GPIO21: 21,
  GPIO22: 22,
  GPIO23: 23,
  GPIO25: 25,
  GPIO26: 26,
  GPIO27: 27,
  GPIO32: 32,
  GPIO33: 33,
  GPIO34: 34,
  GPIO35: 35,
  GPIO36: 36,
  GPIO39: 39,
  // Wokwi element "D" prefix aliases (esp32-devkit-v1-element pin names)
  D2: 2,
  D4: 4,
  D5: 5,
  D12: 12,
  D13: 13,
  D14: 14,
  D15: 15,
  D16: 16,
  D17: 17,
  D18: 18,
  D19: 19,
  D21: 21,
  D22: 22,
  D23: 23,
  D25: 25,
  D26: 26,
  D27: 27,
  D32: 32,
  D33: 33,
  D34: 34,
  D35: 35,
  // ADC aliases
  VP: 36,
  VN: 39,
  // Power / GND — not real GPIOs; mapped to -1 so WirePin skips silently
  GND: -1,
  GND1: -1,
  GND2: -1,
  VCC: -1,
  '3V3': -1,
  '3V3_OUT': -1,
  '5V': -1,
  VIN: -1,
  EN: -1,
};

/** All known board component IDs in the simulator */
export const BOARD_COMPONENT_IDS = [
  'arduino-uno',
  'arduino-nano',
  'arduino-mega',
  'nano-rp2040',
  'raspberry-pi-3',
  'raspberry-pi-pico',
  'pi-pico-w',
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
  'attiny85',
];

/**
 * Check whether a componentId represents a board (not an external component).
 */
export function isBoardComponent(componentId: string): boolean {
  return BOARD_COMPONENT_IDS.some((id) => componentId === id || componentId.startsWith(id));
}

/**
 * Convert a board element pin name to a simulator-usable pin/GPIO number.
 *
 * For Arduino Uno: 'D0'-'D13' / '0'-'13' → 0-13, 'A0'-'A7' → 14-21
 * For Nano RP2040: 'D2'-'D13' / 'A0'-'A5' / 'TX' / 'RX' → GPIO number
 *
 * @returns Numeric pin/GPIO number, or null if unmapped
 */
export function boardPinToNumber(boardId: string, pinName: string): number | null {
  if (boardId === 'arduino-uno' || boardId === 'arduino-nano') {
    // Power / GND pins — not real GPIOs, skip silently
    if (/^(GND|VCC|VIN|IOREF|AREF|RESET|3\.3V|3V3|5V|3V)/.test(pinName)) return -1;
    // Try numeric (covers '0' through '13', also legacy examples using just numbers)
    const num = parseInt(pinName, 10);
    if (!isNaN(num) && num >= 0 && num <= 21) return num;
    // Try 'Dx' style
    if (pinName.startsWith('D')) {
      const d = parseInt(pinName.substring(1), 10);
      if (!isNaN(d)) return d;
    }
    // Analog naming
    return ARDUINO_UNO_ANALOG_MAP[pinName] ?? null;
  }

  if (boardId === 'arduino-mega') {
    // Digital pins D0–D53 parsed numerically
    const num = parseInt(pinName, 10);
    if (!isNaN(num) && num >= 0 && num <= 53) return num;
    if (pinName.startsWith('D')) {
      const d = parseInt(pinName.substring(1), 10);
      if (!isNaN(d) && d <= 53) return d;
    }
    return ARDUINO_MEGA_ANALOG_MAP[pinName] ?? null;
  }

  if (boardId === 'nano-rp2040' || boardId === 'raspberry-pi-pico') {
    // Power / GND pins — return -1 so callers skip silently
    if (
      pinName.startsWith('GND') ||
      pinName.startsWith('3.3V') ||
      pinName.startsWith('3V3') ||
      pinName.startsWith('5V') ||
      pinName.startsWith('VBUS') ||
      pinName.startsWith('VSYS')
    ) {
      return -1;
    }
    // Try D-prefix map first (D2 → GPIO25 = LED_BUILTIN, etc.)
    const mapped = NANO_RP2040_PIN_MAP[pinName];
    if (mapped !== undefined) return mapped;
    // Also accept GP-prefix (GP0–GP29) and bare numbers
    if (pinName.startsWith('GP')) {
      const n = parseInt(pinName.substring(2), 10);
      if (!isNaN(n) && n <= 29) return n;
    }
    const num = parseInt(pinName, 10);
    if (!isNaN(num) && num <= 29) return num;
    return null;
  }

  // Raspberry Pi 3B — pinName is the physical pin number ("1" … "40")
  // We return the BCM GPIO number, or -1 for power/GND pins.
  if (boardId === 'raspberry-pi-3' || boardId.startsWith('raspberry-pi-3')) {
    const physical = parseInt(pinName, 10);
    if (!isNaN(physical)) return PI3_PHYSICAL_TO_BCM[physical] ?? null;
    return null;
  }

  // Pi Pico W — same GPIO mapping as Raspberry Pi Pico (GP0-GP28 → 0-28)
  if (boardId === 'pi-pico-w') {
    if (pinName.startsWith('GP')) {
      const n = parseInt(pinName.substring(2), 10);
      if (!isNaN(n)) return n;
    }
    const num = parseInt(pinName, 10);
    if (!isNaN(num)) return num;
    return null;
  }

  // ESP32 / ESP32-S3 / ESP32-C3 — GPIO numbers used directly
  if (boardId === 'esp32' || boardId.startsWith('esp32')) {
    // Power / GND pins (GND, GND.1, 3V3, 3V3.1, 5V, 5V.1, etc.)
    if (pinName.startsWith('GND') || pinName.startsWith('3V3') || pinName.startsWith('5V'))
      return -1;
    // Try bare number first ("13" → 13)
    const num = parseInt(pinName, 10);
    if (!isNaN(num) && num >= 0 && num <= 39) return num;
    return ESP32_PIN_MAP[pinName] ?? null;
  }

  // ESP32 variants not starting with 'esp32'
  if (boardId === 'wemos-lolin32-lite') {
    // Pins named "GPIO34", "GPIO32" etc → strip prefix
    if (pinName.startsWith('GPIO')) return parseInt(pinName.substring(4), 10);
    const num = parseInt(pinName, 10);
    if (!isNaN(num)) return num;
    return ESP32_PIN_MAP[pinName] ?? null;
  }

  if (boardId === 'xiao-esp32-s3' || boardId === 'arduino-nano-esp32') {
    // D0-D13, A0-A7 → ESP32-S3 GPIO numbers
    const XIAO_S3_MAP: Record<string, number> = {
      D0: 1,
      D1: 2,
      D2: 3,
      D3: 4,
      D4: 5,
      D5: 6,
      D6: 43,
      D7: 44,
      D8: 7,
      D9: 8,
      D10: 9,
    };
    const NANO_ESP32_MAP: Record<string, number> = {
      D0: 44,
      D1: 43,
      D2: 5,
      D3: 6,
      D4: 7,
      D5: 8,
      D6: 9,
      D7: 10,
      D8: 17,
      D9: 18,
      D10: 21,
      D11: 38,
      D12: 47,
      D13: 48,
      A0: 1,
      A1: 2,
      A2: 3,
      A3: 4,
      A4: 11,
      A5: 12,
      A6: 13,
      A7: 14,
    };
    const map = boardId === 'arduino-nano-esp32' ? NANO_ESP32_MAP : XIAO_S3_MAP;
    if (pinName in map) return map[pinName];
    const num = parseInt(pinName, 10);
    if (!isNaN(num)) return num;
    return null;
  }

  if (boardId === 'xiao-esp32-c3') {
    const XIAO_C3_MAP: Record<string, number> = {
      D0: 2,
      D1: 3,
      D2: 4,
      D3: 5,
      D4: 6,
      D5: 7,
      D6: 21,
      D7: 20,
      D8: 8,
      D9: 9,
      D10: 10,
    };
    if (pinName in XIAO_C3_MAP) return XIAO_C3_MAP[pinName];
    const num = parseInt(pinName, 10);
    if (!isNaN(num)) return num;
    return null;
  }

  if (boardId === 'aitewinrobot-esp32c3-supermini') {
    const num = parseInt(pinName, 10);
    if (!isNaN(num)) return num;
    return ESP32_PIN_MAP[pinName] ?? null;
  }

  // ATtiny85 — PORTB only: PB0-PB5 → pins 0-5
  if (boardId === 'attiny85' || boardId.startsWith('attiny85')) {
    // Power / GND pins — not real GPIOs, skip silently
    if (pinName === 'GND' || pinName === 'VCC') return -1;
    if (/^PB(\d+)$/.test(pinName)) {
      const n = parseInt(pinName.substring(2), 10);
      return n >= 0 && n <= 5 ? n : null; // PB6/PB7 don't exist on ATtiny85
    }
    // Numeric fallback
    const num = parseInt(pinName, 10);
    if (!isNaN(num) && num >= 0 && num <= 5) return num;
    return null;
  }

  // RISC-V generic (CH32V003 target) — PA0-PA7=0-7, PC0-PC7=8-15, PD0-PD7=16-23
  if (boardId === 'riscv-generic' || boardId.startsWith('riscv-generic')) {
    if (/^PA(\d+)$/.test(pinName)) return parseInt(pinName.substring(2), 10);
    if (/^PC(\d+)$/.test(pinName)) return 8 + parseInt(pinName.substring(2), 10);
    if (/^PD(\d+)$/.test(pinName)) return 16 + parseInt(pinName.substring(2), 10);
    // Numeric fallback
    const num = parseInt(pinName, 10);
    if (!isNaN(num) && num >= 0 && num <= 23) return num;
    return null;
  }

  return null;
}
