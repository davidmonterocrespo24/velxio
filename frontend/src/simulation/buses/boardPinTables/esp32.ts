/**
 * Classic ESP32 boards: DevKit V1, DevKit C V4, ESP32-CAM, Wemos Lolin32 Lite.
 * Board pins are GPIO numbers.
 *
 * The ESP32 routes every peripheral signal through the GPIO matrix, so these
 * tables are the direct IO_MUX pins plus the pins arduino-esp32 uses when a
 * begin() call names none; the live routing always comes from the engine.
 * Units are the SoC's: UART0-2, GP-SPI2 (HSPI) = 2 and GP-SPI3 (VSPI) = 3
 * (esp32js soc.spi2/spi3, QEMU s->spi[2]/[3]), I2C0-1. QEMU's picsimlab_spi
 * events carry their own id instead, 0 and 1 in attach order (HSPI = 0,
 * VSPI = 1: esp32_picsimlab.c attaches spi[2] first), so its adapter adds 2.
 *
 * GPIO6-11 (SPI flash) are never listed: the DevKit C breaks them out, but
 * they carry the module's flash and the UART1 / UART2 RTS-CTS IO_MUX pins that
 * live there are unusable.
 */
import type { BoardPinFunctions, ControllerDef } from '../pinFunctions';
import { matrixTable, type PinRow } from './build';

/** ESP-IDF components/soc/esp32/include/soc/{uart_pins.h, spi_pins.h}. */
const ESP32_IO_MUX: readonly PinRow[] = [
  [1, 'uart', 0, 'tx'], // U0TXD
  [3, 'uart', 0, 'rx'], // U0RXD
  [19, 'uart', 0, 'cts'], // U0CTS
  [22, 'uart', 0, 'rts'], // U0RTS
  [16, 'uart', 2, 'rx'], // U2RXD
  [17, 'uart', 2, 'tx'], // U2TXD
  [12, 'spi', 2, 'miso'], // HSPIQ
  [13, 'spi', 2, 'mosi'], // HSPID
  [14, 'spi', 2, 'sck'], // HSPICLK
  [15, 'spi', 2, 'cs', 0], // HSPICS0
  [19, 'spi', 3, 'miso'], // VSPIQ
  [23, 'spi', 3, 'mosi'], // VSPID
  [18, 'spi', 3, 'sck'], // VSPICLK
  [5, 'spi', 3, 'cs', 0], // VSPICS0
];

/**
 * arduino-esp32 3.3.10: HardwareSerial.h RX1/TX1 = 26/27 and RX2/TX2 = 4/25
 * (not the 16/17 that 2.x used and that the DevKit silkscreens as RX2/TX2),
 * SPI = VSPI on the variant's SCK/MISO/MOSI/SS, an HSPI SPIClass defaults to
 * 14/12/13/15 (SPI.cpp begin), Wire on the variant's SDA/SCL, and Wire1 has
 * no default pins (Wire.cpp initPins).
 */
function esp32Controllers(v: {
  sda: number;
  scl: number;
  sck: number;
  miso: number;
  mosi: number;
  ss: number;
}): ControllerDef[] {
  return [
    {
      bus: 'uart',
      unit: 0,
      name: 'UART0',
      arduino: ['Serial', 'Serial0'],
      defaultPins: { tx: 1, rx: 3 },
    },
    { bus: 'uart', unit: 1, name: 'UART1', arduino: ['Serial1'], defaultPins: { tx: 27, rx: 26 } },
    { bus: 'uart', unit: 2, name: 'UART2', arduino: ['Serial2'], defaultPins: { tx: 25, rx: 4 } },
    { bus: 'spi', unit: 2, name: 'HSPI', defaultPins: { sck: 14, miso: 12, mosi: 13, cs: 15 } },
    {
      bus: 'spi',
      unit: 3,
      name: 'VSPI',
      arduino: ['SPI'],
      defaultPins: { sck: v.sck, miso: v.miso, mosi: v.mosi, cs: v.ss },
    },
    {
      bus: 'i2c',
      unit: 0,
      name: 'I2C0',
      arduino: ['Wire'],
      defaultPins: { sda: v.sda, scl: v.scl },
    },
    { bus: 'i2c', unit: 1, name: 'I2C1', arduino: ['Wire1'], defaultPins: {} },
  ];
}

const VARIANT_ESP32 = { sda: 21, scl: 22, sck: 18, miso: 19, mosi: 23, ss: 5 };
/** variants/lolin32-lite: I2C shares 19/23 with MISO/MOSI. */
const VARIANT_LOLIN32_LITE = { sda: 19, scl: 23, sck: 18, miso: 19, mosi: 23, ss: 5 };

const SOURCE =
  'ESP32 TRM, IO_MUX and GPIO matrix; ESP-IDF soc/esp32 uart_pins.h and spi_pins.h; ' +
  'arduino-esp32 3.3.10 cores/esp32/HardwareSerial.h, libraries/SPI/src/SPI.cpp, ' +
  'libraries/Wire/src/Wire.cpp';

export const ESP32_DEVKIT_V1_TABLE: BoardPinFunctions = matrixTable({
  controllers: esp32Controllers(VARIANT_ESP32),
  ioMux: ESP32_IO_MUX,
  // Esp32Element PINS_ESP32 (30-pin DevKit V1: no GPIO0 on the header).
  boardPins: [
    1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39,
  ],
  source: `${SOURCE}, variants/esp32/pins_arduino.h (FQBN esp32:esp32:esp32).`,
});

export const ESP32_DEVKIT_C_V4_TABLE: BoardPinFunctions = matrixTable({
  controllers: esp32Controllers(VARIANT_ESP32),
  ioMux: ESP32_IO_MUX,
  boardPins: [
    0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36,
    39,
  ],
  source: `${SOURCE}, variants/esp32/pins_arduino.h (FQBN esp32:esp32:esp32).`,
});

/**
 * AI-Thinker ESP32-CAM. The header only carries GPIO 0-4 and 12-16; the core
 * defaults for SPI (18/19/23/5) and Wire (21/22) are camera data lines inside
 * the module, so a sketch must name its pins. 2/4/12-15 are also the onboard
 * microSD (SDMMC), 4 the flash LED, 16 the PSRAM chip select.
 */
export const ESP32_CAM_TABLE: BoardPinFunctions = matrixTable({
  controllers: esp32Controllers(VARIANT_ESP32),
  ioMux: ESP32_IO_MUX,
  boardPins: [0, 1, 2, 3, 4, 12, 13, 14, 15, 16],
  source: `${SOURCE}, variants/esp32/pins_arduino.h (FQBN esp32:esp32:esp32cam builds the esp32 variant).`,
});

/** Wemos Lolin32 Lite: no GPIO1/3/21 on the header. */
export const LOLIN32_LITE_TABLE: BoardPinFunctions = matrixTable({
  controllers: esp32Controllers(VARIANT_LOLIN32_LITE),
  ioMux: ESP32_IO_MUX,
  boardPins: [
    0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39,
  ],
  source: `${SOURCE}, variants/lolin32-lite/pins_arduino.h (FQBN esp32:esp32:lolin32-lite).`,
});
