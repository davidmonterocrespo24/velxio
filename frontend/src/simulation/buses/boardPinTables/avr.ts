/**
 * AVR boards: Arduino Uno and Nano (ATmega328P), Mega 2560 (ATmega2560) and
 * the bare ATtiny85. Every function sits on one fixed pin.
 *
 * Board pins are Arduino digital numbers, A0 = 14 on the 328P boards and
 * A0 = 54 on the Mega (boardPinMapping.ts); the ATtiny85 uses PB0-PB5 = 0-5.
 * Units follow avr8js and the datasheets: USART0..3, SPI 0, TWI 0.
 */
import type { BoardPinFunctions } from '../pinFunctions';
import { staticTable } from './build';

/** Uno and Nano. The Nano's extra A6/A7 are ADC-only. */
export const ATMEGA328P_TABLE: BoardPinFunctions = staticTable({
  routing: 'fixed',
  controllers: [
    { bus: 'uart', unit: 0, name: 'USART0', arduino: ['Serial'], defaultPins: { rx: 0, tx: 1 } },
    {
      bus: 'spi',
      unit: 0,
      name: 'SPI',
      arduino: ['SPI'],
      defaultPins: { sck: 13, miso: 12, mosi: 11, cs: 10 },
    },
    { bus: 'i2c', unit: 0, name: 'TWI', arduino: ['Wire'], defaultPins: { sda: 18, scl: 19 } },
  ],
  rows: [
    [0, 'uart', 0, 'rx'], // PD0 RXD
    [1, 'uart', 0, 'tx'], // PD1 TXD
    [10, 'spi', 0, 'cs', 0], // PB2 SS
    [11, 'spi', 0, 'mosi'], // PB3 MOSI
    [12, 'spi', 0, 'miso'], // PB4 MISO
    [13, 'spi', 0, 'sck'], // PB5 SCK
    [18, 'i2c', 0, 'sda'], // A4 = PC4 SDA
    [19, 'i2c', 0, 'scl'], // A5 = PC5 SCL
  ],
  source:
    'ATmega328P datasheet, pin configuration and alternate port functions; arduino:avr 1.8.8 ' +
    'variants/standard/pins_arduino.h (PIN_SPI_*, PIN_WIRE_*; eightanaloginputs for the ' +
    'Nano includes it). USART0 MSPIM mode (XCK on D4) is not listed. Engine: avr8js ' +
    'AVRUSART(usart0Config), AVRSPI, AVRTWI in AVRSimulator.ts.',
});

export const ATMEGA2560_TABLE: BoardPinFunctions = staticTable({
  routing: 'fixed',
  controllers: [
    { bus: 'uart', unit: 0, name: 'USART0', arduino: ['Serial'], defaultPins: { rx: 0, tx: 1 } },
    { bus: 'uart', unit: 1, name: 'USART1', arduino: ['Serial1'], defaultPins: { rx: 19, tx: 18 } },
    { bus: 'uart', unit: 2, name: 'USART2', arduino: ['Serial2'], defaultPins: { rx: 17, tx: 16 } },
    { bus: 'uart', unit: 3, name: 'USART3', arduino: ['Serial3'], defaultPins: { rx: 15, tx: 14 } },
    {
      bus: 'spi',
      unit: 0,
      name: 'SPI',
      arduino: ['SPI'],
      defaultPins: { sck: 52, miso: 50, mosi: 51, cs: 53 },
    },
    { bus: 'i2c', unit: 0, name: 'TWI', arduino: ['Wire'], defaultPins: { sda: 20, scl: 21 } },
  ],
  rows: [
    [0, 'uart', 0, 'rx'], // PE0 RXD0
    [1, 'uart', 0, 'tx'], // PE1 TXD0
    [14, 'uart', 3, 'tx'], // PJ1 TXD3
    [15, 'uart', 3, 'rx'], // PJ0 RXD3
    [16, 'uart', 2, 'tx'], // PH1 TXD2
    [17, 'uart', 2, 'rx'], // PH0 RXD2
    [18, 'uart', 1, 'tx'], // PD3 TXD1
    [19, 'uart', 1, 'rx'], // PD2 RXD1
    [20, 'i2c', 0, 'sda'], // PD1 SDA
    [21, 'i2c', 0, 'scl'], // PD0 SCL
    [50, 'spi', 0, 'miso'], // PB3 MISO
    [51, 'spi', 0, 'mosi'], // PB2 MOSI
    [52, 'spi', 0, 'sck'], // PB1 SCK
    [53, 'spi', 0, 'cs', 0], // PB0 SS
  ],
  source:
    'ATmega2560 datasheet, pin configuration and alternate port functions; arduino:avr 1.8.8 ' +
    'variants/mega/pins_arduino.h (digital_pin_to_port_PGM, PIN_SPI_*, PIN_WIRE_*). ' +
    'USART1-3 MSPIM mode is not listed. Engine: avr8js instantiates only USART0 today ' +
    '(AVRSimulator.ts), so USART1-3 have no engine port yet (DESIGN section 4).',
});

/**
 * The ATtiny85 has one USI and no USART or TWI. ATTinyCore binds both SPI and
 * Wire to the USI; in master mode DO (PB1) is MOSI and DI (PB0) is MISO, the
 * reverse of the ISP labels printed on most pinouts.
 */
export const ATTINY85_TABLE: BoardPinFunctions = staticTable({
  routing: 'fixed',
  controllers: [
    {
      bus: 'spi',
      unit: 0,
      name: 'USI (three-wire mode)',
      arduino: ['SPI'],
      // SS = 3 is only the core's name for a GPIO: the USI has no select line.
      defaultPins: { sck: 2, miso: 0, mosi: 1, cs: 3 },
    },
    {
      bus: 'i2c',
      unit: 0,
      name: 'USI (two-wire mode)',
      arduino: ['Wire'],
      defaultPins: { sda: 0, scl: 2 },
    },
  ],
  rows: [
    [0, 'spi', 0, 'miso'], // PB0 DI
    [0, 'i2c', 0, 'sda'], // PB0 SDA
    [1, 'spi', 0, 'mosi'], // PB1 DO
    [2, 'spi', 0, 'sck'], // PB2 USCK
    [2, 'i2c', 0, 'scl'], // PB2 SCL
  ],
  source:
    'ATtiny25/45/85 datasheet, USI chapter; ATTinyCore 1.4.1 ' +
    'variants/tinyX5/pins_arduino.h (MOSI 1, MISO 0, SCK 2, SS 3, SDA 0, SCL 2) and its ' +
    'SPI and Wire (USIWire) libraries. The core Serial is a software UART on AIN0/AIN1 ' +
    '(TX PB0, RX PB1), not a controller. Engine: AVRUSI bridged to the I2C bus in ' +
    'UsiI2cBridge.ts.',
});
