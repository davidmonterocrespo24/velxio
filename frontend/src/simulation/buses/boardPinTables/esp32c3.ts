/**
 * ESP32-C3 boards: ESP32-C3 DevKitM-1, Seeed XIAO ESP32-C3, ESP32-C3 SuperMini.
 * Board pins are GPIO numbers.
 *
 * GPIO matrix SoC: the tables are the direct IO_MUX pins plus the pins
 * arduino-esp32 uses when begin() names none. The C3 has UART0-1, one
 * general-purpose SPI (GP-SPI2 = unit 2, esp32c3js soc.gpspi) and one I2C.
 */
import type { BoardPinFunctions, ControllerDef } from '../pinFunctions';
import { matrixTable, type PinRow } from './build';

/** ESP-IDF components/soc/esp32c3/include/soc/{uart_pins.h, spi_pins.h}. UART1 has none. */
const ESP32C3_IO_MUX: readonly PinRow[] = [
  [21, 'uart', 0, 'tx'], // U0TXD
  [20, 'uart', 0, 'rx'], // U0RXD
  [2, 'spi', 2, 'miso'], // FSPIQ
  [6, 'spi', 2, 'sck'], // FSPICLK
  [7, 'spi', 2, 'mosi'], // FSPID
  [10, 'spi', 2, 'cs', 0], // FSPICS0
];

/**
 * arduino-esp32 3.3.10: HardwareSerial.h RX1/TX1 = 18/19 (the USB D-/D+ pads),
 * SPI = FSPI on the variant's SCK/MISO/MOSI/SS, Wire on the variant's SDA/SCL.
 * With USB CDC on boot (XIAO) Serial is the USB port and UART0 is only Serial0.
 */
function esp32c3Controllers(
  v: { sda: number; scl: number; sck: number; miso: number; mosi: number; ss: number },
  cdcOnBoot: boolean,
): ControllerDef[] {
  return [
    {
      bus: 'uart',
      unit: 0,
      name: 'UART0',
      arduino: cdcOnBoot ? ['Serial0'] : ['Serial', 'Serial0'],
      defaultPins: { tx: 21, rx: 20 },
    },
    { bus: 'uart', unit: 1, name: 'UART1', arduino: ['Serial1'], defaultPins: { tx: 19, rx: 18 } },
    {
      bus: 'spi',
      unit: 2,
      name: 'GPSPI2',
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
  ];
}

const SOURCE =
  'ESP32-C3 TRM, IO_MUX and GPIO matrix; ESP-IDF soc/esp32c3 uart_pins.h and spi_pins.h; ' +
  'arduino-esp32 3.3.10 cores/esp32/HardwareSerial.h, libraries/SPI/src/SPI.cpp, ' +
  'libraries/Wire/src/Wire.cpp, boards.txt cdc_on_boot';

const VARIANT_ESP32C3 = { sda: 8, scl: 9, sck: 4, miso: 5, mosi: 6, ss: 7 };

/** DevKitM-1: GPIO0-10 and 18-21 (the TX/RX pads are GPIO21/20). */
export const ESP32C3_DEVKITM_TABLE: BoardPinFunctions = matrixTable({
  controllers: esp32c3Controllers(VARIANT_ESP32C3, false),
  ioMux: ESP32C3_IO_MUX,
  boardPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19, 20, 21],
  source: `${SOURCE}, variants/esp32c3/pins_arduino.h (FQBN esp32:esp32:esp32c3, CDC off).`,
});

/** XIAO ESP32-C3: D0-D10 = GPIO2-7, 21, 20, 8-10. SS = 20 is the variant's (D7). */
export const XIAO_ESP32C3_TABLE: BoardPinFunctions = matrixTable({
  controllers: esp32c3Controllers({ sda: 6, scl: 7, sck: 8, miso: 9, mosi: 10, ss: 20 }, true),
  ioMux: ESP32C3_IO_MUX,
  boardPins: [2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21],
  source: `${SOURCE}, variants/XIAO_ESP32C3/pins_arduino.h (FQBN esp32:esp32:XIAO_ESP32C3, CDC on).`,
});

/**
 * ESP32-C3 SuperMini: GPIO0-10 plus RX/TX = GPIO20/21. velxio builds it with
 * the generic esp32c3 FQBN, so the defaults are the DevKit variant's: SCK 4,
 * MISO 5, MOSI 6, SS 7, SDA 8, SCL 9, the assignment SuperMini pinouts print.
 */
export const ESP32C3_SUPERMINI_TABLE: BoardPinFunctions = matrixTable({
  controllers: esp32c3Controllers(VARIANT_ESP32C3, false),
  ioMux: ESP32C3_IO_MUX,
  boardPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21],
  source: `${SOURCE}, variants/esp32c3/pins_arduino.h (FQBN esp32:esp32:esp32c3, CDC off).`,
});
