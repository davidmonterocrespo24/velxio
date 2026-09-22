/**
 * ESP32-S3 boards: ESP32-S3 DevKitC-1, Seeed XIAO ESP32-S3, Arduino Nano ESP32.
 * Board pins are GPIO numbers.
 *
 * GPIO matrix SoC: the tables are the direct IO_MUX pins plus the pins
 * arduino-esp32 uses when begin() names none. Units are the SoC's: UART0-2,
 * GP-SPI2 (FSPI) = 2 and GP-SPI3 = 3 (esp32s3js soc.spi2/spi3, QEMU GPSPI2),
 * I2C0-1.
 */
import type { BoardPinFunctions, ControllerDef } from '../pinFunctions';
import { matrixTable, type PinRow } from './build';

/** ESP-IDF components/soc/esp32s3/include/soc/{uart_pins.h, spi_pins.h}. UART2 has none. */
const ESP32S3_IO_MUX: readonly PinRow[] = [
  [43, 'uart', 0, 'tx'], // U0TXD
  [44, 'uart', 0, 'rx'], // U0RXD
  [15, 'uart', 0, 'rts'], // U0RTS
  [16, 'uart', 0, 'cts'], // U0CTS
  [17, 'uart', 1, 'tx'], // U1TXD
  [18, 'uart', 1, 'rx'], // U1RXD
  [19, 'uart', 1, 'rts'], // U1RTS
  [20, 'uart', 1, 'cts'], // U1CTS
  [10, 'spi', 2, 'cs', 0], // FSPICS0
  [11, 'spi', 2, 'mosi'], // FSPID
  [12, 'spi', 2, 'sck'], // FSPICLK
  [13, 'spi', 2, 'miso'], // FSPIQ
  // The second FSPI IO_MUX set (SPI2_IOMUX_PIN_NUM_*_OCT). On modules with
  // octal PSRAM (R8) GPIO35-37 belong to the PSRAM.
  [34, 'spi', 2, 'cs', 0],
  [35, 'spi', 2, 'mosi'],
  [36, 'spi', 2, 'sck'],
  [37, 'spi', 2, 'miso'],
];

/**
 * arduino-esp32 3.3.10: HardwareSerial.h RX1/TX1 = 15/16 and RX2/TX2 = 19/20,
 * SPI = FSPI on the variant's SCK/MISO/MOSI/SS, the second SPI (HSPI = GP-SPI3)
 * has no default pins on the S3 (SPI.cpp begin), Wire on the variant's
 * SDA/SCL, Wire1 has none. With USB CDC on boot (XIAO, Nano ESP32) Serial is
 * the USB port and UART0 is only Serial0.
 */
function esp32s3Controllers(
  v: { sda: number; scl: number; sck: number; miso: number; mosi: number; ss: number },
  cdcOnBoot: boolean,
): ControllerDef[] {
  return [
    {
      bus: 'uart',
      unit: 0,
      name: 'UART0',
      arduino: cdcOnBoot ? ['Serial0'] : ['Serial', 'Serial0'],
      defaultPins: { tx: 43, rx: 44 },
    },
    { bus: 'uart', unit: 1, name: 'UART1', arduino: ['Serial1'], defaultPins: { tx: 16, rx: 15 } },
    { bus: 'uart', unit: 2, name: 'UART2', arduino: ['Serial2'], defaultPins: { tx: 20, rx: 19 } },
    {
      bus: 'spi',
      unit: 2,
      name: 'GPSPI2',
      arduino: ['SPI'],
      defaultPins: { sck: v.sck, miso: v.miso, mosi: v.mosi, cs: v.ss },
    },
    { bus: 'spi', unit: 3, name: 'GPSPI3', defaultPins: {} },
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

const SOURCE =
  'ESP32-S3 TRM, IO_MUX and GPIO matrix; ESP-IDF soc/esp32s3 uart_pins.h and spi_pins.h; ' +
  'arduino-esp32 3.3.10 cores/esp32/HardwareSerial.h, libraries/SPI/src/SPI.cpp, ' +
  'libraries/Wire/src/Wire.cpp, boards.txt cdc_on_boot';

/** DevKitC-1: every GPIO the module frees, TX/RX pads = GPIO43/44. */
export const ESP32S3_DEVKITC_TABLE: BoardPinFunctions = matrixTable({
  controllers: esp32s3Controllers({ sda: 8, scl: 9, sck: 12, miso: 13, mosi: 11, ss: 10 }, false),
  ioMux: ESP32S3_IO_MUX,
  boardPins: [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 35, 36, 37, 38,
    39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
  ],
  source: `${SOURCE}, variants/esp32s3/pins_arduino.h (FQBN esp32:esp32:esp32s3, CDC off).`,
});

/** XIAO ESP32-S3: D0-D10 = GPIO1-6, 43, 44, 7-9. SS = 44 is the variant's (D7). */
export const XIAO_ESP32S3_TABLE: BoardPinFunctions = matrixTable({
  controllers: esp32s3Controllers({ sda: 5, scl: 6, sck: 7, miso: 8, mosi: 9, ss: 44 }, true),
  ioMux: ESP32S3_IO_MUX,
  boardPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 43, 44],
  source: `${SOURCE}, variants/XIAO_ESP32S3/pins_arduino.h (FQBN esp32:esp32:XIAO_ESP32S3, CDC on).`,
});

/**
 * Arduino Nano ESP32, in GPIO numbers (the core's pin remap turns D13 into
 * GPIO48 and so on): D0/RX = 44, D1/TX = 43, D10-D13 = 21/38/47/48, A4/A5 = 11/12.
 */
export const NANO_ESP32_TABLE: BoardPinFunctions = matrixTable({
  controllers: esp32s3Controllers({ sda: 11, scl: 12, sck: 48, miso: 47, mosi: 38, ss: 21 }, true),
  ioMux: ESP32S3_IO_MUX,
  boardPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18, 21, 38, 43, 44, 46, 47, 48],
  source: `${SOURCE}, variants/arduino_nano_nora/pins_arduino.h (FQBN esp32:esp32:nano_nora, CDC on).`,
});
