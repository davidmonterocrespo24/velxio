/**
 * RP2040 boards: Raspberry Pi Pico and Pico W. Board pins are GPIO numbers
 * (GP0-GP22 and GP26-GP28 on the header).
 *
 * Every GPIO has one SPI, one UART and one I2C alternate (funcsel F1, F2, F3),
 * repeating with period 4 / 2 along the bank (RP2040 datasheet, GPIO function
 * table). Units are rp2040js's spi[0]/spi[1], uart[0]/uart[1], i2c[0]/i2c[1].
 */
import type { BoardPinFunctions, SpiSignal, UartSignal } from '../pinFunctions';
import { staticTable, type PinRow } from './build';

const SPI_SIGNAL: readonly SpiSignal[] = ['miso', 'cs', 'sck', 'mosi']; // RX, CSn, SCK, TX
const UART_SIGNAL: readonly UartSignal[] = ['tx', 'rx', 'cts', 'rts'];

/** F1/F2/F3 rows for one RP2040 GPIO. */
export function rp2040GpioRows(gpio: number): PinRow[] {
  const spiSignal = SPI_SIGNAL[gpio % 4];
  return [
    // F1: SPI0 on GPIO 0-7 and 16-23, SPI1 on 8-15 and 24-29.
    spiSignal === 'cs'
      ? [gpio, 'spi', (gpio >> 3) & 1, 'cs', 0]
      : [gpio, 'spi', (gpio >> 3) & 1, spiSignal],
    // F2: UART0 on 0-3, 12-19, 28-29; UART1 on 4-11 and 20-27.
    [gpio, 'uart', ((gpio + 4) >> 3) & 1, UART_SIGNAL[gpio % 4]],
    // F3: I2C0 on GPIO 0-1, 4-5, 8-9...; I2C1 on 2-3, 6-7, 10-11...
    [gpio, 'i2c', (gpio >> 1) & 1, gpio % 2 === 0 ? 'sda' : 'scl'],
  ];
}

/** The GPIOs the Pico and Pico W bring to the header (GP23-25 and GP29 stay on board). */
export const PICO_HEADER_GPIOS: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 26, 27, 28,
];

export const PICO_TABLE: BoardPinFunctions = staticTable({
  routing: 'mux',
  controllers: [
    // velxio's compile prepends `#define Serial Serial1` to the sketch
    // (backend arduino_cli.py), so a sketch's Serial is UART0 too.
    {
      bus: 'uart',
      unit: 0,
      name: 'UART0',
      arduino: ['Serial1', 'Serial'],
      defaultPins: { tx: 0, rx: 1 },
    },
    { bus: 'uart', unit: 1, name: 'UART1', arduino: ['Serial2'], defaultPins: { tx: 8, rx: 9 } },
    {
      bus: 'spi',
      unit: 0,
      name: 'SPI0',
      arduino: ['SPI'],
      defaultPins: { miso: 16, cs: 17, sck: 18, mosi: 19 },
    },
    {
      bus: 'spi',
      unit: 1,
      name: 'SPI1',
      arduino: ['SPI1'],
      defaultPins: { miso: 12, cs: 13, sck: 14, mosi: 15 },
    },
    { bus: 'i2c', unit: 0, name: 'I2C0', arduino: ['Wire'], defaultPins: { sda: 4, scl: 5 } },
    { bus: 'i2c', unit: 1, name: 'I2C1', arduino: ['Wire1'], defaultPins: { sda: 26, scl: 27 } },
  ],
  rows: PICO_HEADER_GPIOS.flatMap(rp2040GpioRows),
  source:
    'RP2040 datasheet, GPIO function select table (F1 SPI, F2 UART, F3 I2C); arduino-pico ' +
    '(rp2040:rp2040) 6.1.1 variants/rpipico and rpipicow pins_arduino.h (PIN_SERIAL1/2, ' +
    'PIN_SPI0/1, PIN_WIRE0/1). The core binds Serial to USB CDC; velxio rewrites it to ' +
    'Serial1. MicroPython uses its own defaults, which the engine reports through funcsel.',
});
