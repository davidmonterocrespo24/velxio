import { getProBoard } from '../lib/proBoardRegistry';
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
 * Pad names that are a supply, ground or reset — never a GPIO.
 *
 * Several boards silkscreen their 3.3 V rail as "3V" and their reset as "RST",
 * and the numeric fallback below is `parseInt(pinName, 10)`: parseInt('3V', 10)
 * is 3, so the Wemos Lolin32 Lite's supply pad resolved to GPIO3 and the XIAO's
 * 3V3/5V pads to GPIO3/GPIO5. A wire to the supply drove a real pin. Matching
 * these first also turns them into -1 rather than null, which is what tells
 * WirePin (and the ground check in SimulatorCanvas) to skip them silently.
 */
const POWER_PAD_RE =
  /^(gnd|vss|vee|3v3|3v|3\.3v|5v|vcc|vdd|vin|vbus|vbat|bat|en|rst|reset|chip_pu)([._]?\d+)?$/i;

/**
 * ESP32 DevKit-C GPIO pin names → GPIO numbers, classic ESP32 only.
 * Pin names are GPIO numbers directly (GPIO0–GPIO39).
 * Special aliases: the UART pads (TX/RX = UART0, RX0/TX0 the same pads under
 * their DevKit V1 silkscreen names, RX2/TX2 = UART2 on GPIO16/17). The S3 and
 * C3 put UART0 elsewhere, so the branches below resolve TX/RX through
 * esp32Uart0Pad before they reach this map.
 */
const ESP32_PIN_MAP: Record<string, number> = {
  TX: 1,
  RX: 3,
  // UART pads on the DevKit V1 silkscreen. Without these the four pads
  // resolved to null: RX2/TX2 have numeric twins at the same coordinate
  // ('16'/'17'), but RX0/TX0 do not, so they were the only route to GPIO3
  // and GPIO1 and a wire to them did nothing at all.
  RX0: 3,
  TX0: 1,
  RX2: 16,
  TX2: 17,
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

/**
 * U0TXD / U0RXD per chip: the UART0 IO_MUX pads, which every dev board silks
 * TX / RX (ESP-IDF components/soc/<chip>/include/soc/uart_pins.h). The S3 and
 * C3 DevKits and the C3 SuperMini used to fall through to ESP32_PIN_MAP's
 * classic 1/3, so a wire to the console pads joined the net of GPIO1/3, which
 * on those chips are ordinary pads of their own elsewhere on the header.
 * Overlay boards on other chips resolve their own TX/RX; one that does not
 * gets null here rather than another chip's pads.
 */
const ESP32_UART0_PADS: Record<string, { TX: number; RX: number }> = {
  esp32: { TX: 1, RX: 3 },
  'esp32-s3': { TX: 43, RX: 44 },
  'esp32-c3': { TX: 21, RX: 20 },
};

function esp32Uart0Pad(boardId: string, pad: 'TX' | 'RX'): number | null {
  const family =
    getProBoard(boardId)?.esp32Family ??
    (boardId.startsWith('esp32-s3')
      ? 'esp32-s3'
      : boardId.startsWith('esp32-c3') || boardId === 'aitewinrobot-esp32c3-supermini'
        ? 'esp32-c3'
        : 'esp32');
  return ESP32_UART0_PADS[family]?.[pad] ?? null;
}

/**
 * The DevKitC V4 breaks out the module's SPI-flash block, silked by the flash
 * signal rather than the GPIO: CLK = GPIO6, D0 = GPIO7, D1 = GPIO8, D2 = GPIO9,
 * D3 = GPIO10, CMD = GPIO11 (Espressif ESP32-DevKitC V4 pin layout; SD_CLK,
 * SD_DATA0-3 and SD_CMD in the ESP32 IO_MUX). 'D2' fell through to
 * ESP32_PIN_MAP's DevKit V1 alias for GPIO2, so a wire to the flash pad joined
 * GPIO2's net. The pads resolve to the lines they are; the pin function table
 * lists no function on them, so nothing routes a bus there.
 */
const DEVKIT_C_V4_FLASH_PADS: Record<string, number> = {
  CLK: 6,
  D0: 7,
  D1: 8,
  D2: 9,
  D3: 10,
  CMD: 11,
};

/** All known board component IDs in the simulator */
export const BOARD_COMPONENT_IDS = [
  'arduino-uno',
  'arduino-nano',
  'arduino-mega',
  'nano-rp2040',
  'raspberry-pi-3',
  'raspberry-pi-4',
  'raspberry-pi-5',
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
  'stm32-bluepill',
  'stm32-blackpill',
  'stm32-bluepill-f103cb',
  'stm32-blackpill-f401',
  'stm32-f4-discovery',
  'stm32-olimex-h405',
  'stm32-netduino-plus2',
  'stm32-netduino2',
  'attiny85',
];

/**
 * Check whether a componentId represents a board (not an external component).
 */
export function isBoardComponent(componentId: string): boolean {
  if (BOARD_COMPONENT_IDS.some((id) => componentId === id || componentId.startsWith(id))) {
    return true;
  }
  // Overlay-registered boards (proBoardRegistry) are boards too — recognized
  // without listing their closed names in the OSS array. This is what lets a
  // wire to a pro board's Dx pad resolve through boardPinToNumber (which also
  // consults the pro def), fixing the "wire to D2 does nothing" case.
  return getProBoard(componentId) !== undefined;
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
  // Overlay-registered boards resolve through their own mapping first.
  const proDef = getProBoard(boardId);
  if (proDef?.pinToNumber) {
    const n = proDef.pinToNumber(pinName);
    if (n !== null) return n;
  }
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
    // Analog naming. A '.N' suffix is the element's name for a second pad on
    // the same line: the Uno R3's SDA/SCL pads beside AREF are 'A4.2'/'A5.2',
    // wired to A4/A5 on the board, and resolved to nothing without this.
    return ARDUINO_UNO_ANALOG_MAP[pinName.replace(/\.\d+$/, '')] ?? null;
  }

  if (boardId === 'arduino-mega') {
    // Supply pads BEFORE the numeric parse, or '5V' reads as D5 and '3.3V' as
    // D3 — a wire to the supply would drive a real pin, and a walk looking for
    // "what drives this net" would stop at a rail believing it found a GPIO.
    // IOREF and AREF are the same reference pads the Uno branch treats as rails.
    if (POWER_PAD_RE.test(pinName) || pinName === 'IOREF' || pinName === 'AREF') return -1;
    // The R3 header's dedicated SDA/SCL pads beside AREF are wired to D20/D21
    // (PD1/PD0, the TWI pins). Only labelled, so without this they were null.
    if (pinName === 'SDA') return 20;
    if (pinName === 'SCL') return 21;
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

  // Raspberry Pi 3 / 4 / 5 (and any future 40-pin Pi) all share the same
  // physical pin layout and BCM GPIO assignment, so the same lookup
  // table works.  `pinName` may be either the physical pin number
  // ("1" … "40") OR a BCM-style name ("GPIO14") emitted by the Pi
  // element's pinInfo — power / GND pins return -1.
  // The whole QEMU-Linux Pi family shares the 40-pin header (the Zero,
  // 1B+ and 2B render the same element as the 3) — matching only 3/4/5
  // left the small boards without any pin mapping at all.
  if (boardId.startsWith('raspberry-pi-') && boardId !== 'raspberry-pi-pico') {
    if (/^(GND|VCC|3V3|5V|ID_S[DC])/.test(pinName)) return -1;
    if (pinName.startsWith('GPIO')) {
      const n = parseInt(pinName.substring(4), 10);
      if (!isNaN(n)) return n;
    }
    const physical = parseInt(pinName, 10);
    if (!isNaN(physical)) return PI3_PHYSICAL_TO_BCM[physical] ?? null;
    return null;
  }

  // Pi Pico W — same GPIO mapping as Raspberry Pi Pico (GP0-GP28 → 0-28)
  if (boardId === 'pi-pico-w') {
    // Same trap as the Mega below/above: '3V3' would parse as 3 and '5V' as 5.
    // POWER_PAD_RE does not cover the regulator enable '3V3_EN', which parsed
    // as GP3, nor 'VSYS'; the Pico branch above already returns -1 for both.
    if (POWER_PAD_RE.test(pinName) || pinName === '3V3_EN' || pinName === 'VSYS') return -1;
    if (pinName.startsWith('GP')) {
      const n = parseInt(pinName.substring(2), 10);
      if (!isNaN(n)) return n;
    }
    // The element's A0-A2 alias pads sit on GP26-GP28 (ADC0-ADC2).
    if (/^A[0-2]$/.test(pinName)) return 26 + Number(pinName[1]);
    const num = parseInt(pinName, 10);
    if (!isNaN(num)) return num;
    return null;
  }

  // Overlay S3 boards whose pads are bare GPIO numbers but whose kind does not
  // start with 'esp32' — the M5 Cardputer's EXT header and Grove Port A. Its
  // pads go up to G40, above the classic ESP32's 39, so the shared branch below
  // would reject the two highest ones even if the kind matched.
  if (boardId === 'cardputer-adv') {
    if (pinName.startsWith('GND') || pinName.startsWith('3V3') || pinName.startsWith('5V'))
      return -1;
    const num = parseInt(pinName, 10);
    if (!isNaN(num) && num >= 0 && num <= 48) return num; // S3 has 48 GPIOs
    return null;
  }

  // M5Stack Core: same bare-GPIO-number pads, classic ESP32 range. Without
  // this branch the kind fell through every one below — the shared ESP32
  // branch requires boardId.startsWith('esp32') — and every wire from the
  // M-Bus header resolved to null: a part wired to the header never saw a
  // signal, with nothing anywhere saying why. BAT joins the power names.
  if (boardId === 'm5stack-core') {
    if (
      pinName.startsWith('GND') ||
      pinName.startsWith('3V3') ||
      pinName.startsWith('5V') ||
      pinName === 'BAT'
    )
      return -1;
    const num = parseInt(pinName, 10);
    if (!isNaN(num) && num >= 0 && num <= 39) return num;
    return null;
  }

  // ESP32 / ESP32-S3 / ESP32-C3 — GPIO numbers used directly
  if (boardId === 'esp32' || boardId.startsWith('esp32')) {
    // Power / GND / reset pads (GND, GND.1, 3V3, 5V, EN, RST, ...)
    if (POWER_PAD_RE.test(pinName)) return -1;
    // Try bare number first ("13" → 13). The ceiling is per family: the
    // classic ESP32 tops out at GPIO39, the S3 at GPIO48. A shared 39
    // rejected the S3 DevKitC's 40/41/42/45/46/47/48 pads, so seven pads
    // on that board resolved to null and a wire to them did nothing.
    const maxGpio = boardId.startsWith('esp32-s3') ? 48 : 39;
    const num = parseInt(pinName, 10);
    if (!isNaN(num) && num >= 0 && num <= maxGpio) return num;
    if (pinName === 'TX' || pinName === 'RX') return esp32Uart0Pad(boardId, pinName);
    if (boardId === 'esp32-devkit-c-v4' && pinName in DEVKIT_C_V4_FLASH_PADS)
      return DEVKIT_C_V4_FLASH_PADS[pinName];
    return ESP32_PIN_MAP[pinName] ?? null;
  }

  // ESP32 variants not starting with 'esp32'
  if (boardId === 'wemos-lolin32-lite') {
    // Supply pads first — this board silkscreens its rail "3V", not "3V3".
    if (POWER_PAD_RE.test(pinName)) return -1;
    // Pins named "GPIO34", "GPIO32" etc → strip prefix
    if (pinName.startsWith('GPIO')) return parseInt(pinName.substring(4), 10);
    const num = parseInt(pinName, 10);
    if (!isNaN(num)) return num;
    return ESP32_PIN_MAP[pinName] ?? null;
  }

  if (boardId === 'xiao-esp32-s3' || boardId === 'arduino-nano-esp32') {
    if (POWER_PAD_RE.test(pinName)) return -1;
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
      // The D0/D1 positions are silkscreened RX0/TX1, so the D-names above
      // were unreachable: GPIO44 and GPIO43 had no pad that resolved to them.
      RX0: 44,
      TX1: 43,
      B0: 46,
      B1: 0,
    };
    const map = boardId === 'arduino-nano-esp32' ? NANO_ESP32_MAP : XIAO_S3_MAP;
    if (pinName in map) return map[pinName];
    const num = parseInt(pinName, 10);
    if (!isNaN(num)) return num;
    return null;
  }

  if (boardId === 'xiao-esp32-c3') {
    if (POWER_PAD_RE.test(pinName)) return -1;
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
    if (POWER_PAD_RE.test(pinName)) return -1;
    const num = parseInt(pinName, 10);
    if (!isNaN(num)) return num;
    if (pinName === 'TX' || pinName === 'RX') return esp32Uart0Pad(boardId, pinName);
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

  // STM32 Blue Pill (and family) — linear pin = port*16 + pin, matching the
  // backend (hw/arm/stm32_picsimlab.c) and Stm32Bridge.stm32PinNameToLinear.
  // PA0..PA15=0..15, PB0..PB15=16..31, PC13..PC15=44..47.
  if (boardId === 'stm32-bluepill' || boardId.startsWith('stm32-')) {
    // Power / reset pins — not GPIOs.
    if (
      pinName.startsWith('GND') || pinName.startsWith('3V3') ||
      pinName.startsWith('3.3V') || pinName.startsWith('5V') ||
      pinName === 'VBAT' || pinName === 'VB' || pinName === 'NRST' ||
      pinName === 'RST'
    ) {
      return -1;
    }
    const m = /^P([A-G])(\d{1,2})$/.exec(pinName);
    if (m) {
      const port = m[1].charCodeAt(0) - 'A'.charCodeAt(0); // A=0,B=1,C=2,...
      const pin = parseInt(m[2], 10);
      if (pin >= 0 && pin <= 15) return port * 16 + pin;
    }
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
