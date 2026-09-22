/**
 * Raspberry Pi 40-pin header boards. Board pins are BCM GPIO numbers.
 *
 * Three GPIO blocks sit behind the same header: the BCM2835 one (Pi Zero, 1B+,
 * 2B and 3B; the BCM2836/7 kept it unchanged), the BCM2711 (Pi 4, four more
 * SPI, I2C and UART instances on ALT3-ALT5) and the RP1 south bridge (Pi 5).
 * Each pin lists every serial alternate its ALTn / funcsel offers.
 *
 * Units are the SoC's instance numbers, which are also the Linux bus numbers
 * the guest sees: /dev/i2c-1 is I2C1 (BSC1), /dev/spidev0.N is SPI0 with CE N,
 * and velxio's /dev/serial0 is the PL011 on GPIO14/15 (UART0). Only those
 * three are enabled without an overlay, so only they carry default pins.
 *
 * GPIO0/1 are header pins 27/28 (ID_SD/ID_SC), reserved for the HAT EEPROM.
 * They are listed because the silicon routes buses there, but velxio's pad map
 * resolves them to -1, so no wire reaches them today. The BSC/SPI slave
 * (BCM2835 GPIO18-21 ALT3, BCM2711 GPIO8-11 ALT3) and RP1's slave-only SPI4 are
 * not controllers a sketch drives and are left out.
 */
import type { BoardPinFunctions, ControllerDef } from '../pinFunctions';
import { staticTable, type PinRow } from './build';

/** The three buses Raspberry Pi OS enables from raspi-config, as the guest names them. */
const LINUX_DEFAULTS: Record<string, ControllerDef['defaultPins']> = {
  'i2c/1': { sda: 2, scl: 3 },
  'spi/0': { sck: 11, miso: 9, mosi: 10, cs: [8, 7] },
  'uart/0': { tx: 14, rx: 15 },
};

function piController(bus: ControllerDef['bus'], unit: number, name: string): ControllerDef {
  return { bus, unit, name, defaultPins: LINUX_DEFAULTS[`${bus}/${unit}`] ?? {} };
}

// ── BCM2835 (Pi Zero, 1B+, 2B, 3B) ────────────────────────────────────────────

const BCM2835_ROWS: readonly PinRow[] = [
  [0, 'i2c', 0, 'sda'], // ALT0 SDA0
  [1, 'i2c', 0, 'scl'], // ALT0 SCL0
  [2, 'i2c', 1, 'sda'], // ALT0 SDA1
  [3, 'i2c', 1, 'scl'], // ALT0 SCL1
  [7, 'spi', 0, 'cs', 1], // ALT0 SPI0_CE1_N
  [8, 'spi', 0, 'cs', 0], // ALT0 SPI0_CE0_N
  [9, 'spi', 0, 'miso'], // ALT0 SPI0_MISO
  [10, 'spi', 0, 'mosi'], // ALT0 SPI0_MOSI
  [11, 'spi', 0, 'sck'], // ALT0 SPI0_SCLK
  [14, 'uart', 0, 'tx'], // ALT0 TXD0
  [15, 'uart', 0, 'rx'], // ALT0 RXD0
  [16, 'uart', 0, 'cts'], // ALT3 CTS0
  [17, 'uart', 0, 'rts'], // ALT3 RTS0
  [14, 'uart', 1, 'tx'], // ALT5 TXD1
  [15, 'uart', 1, 'rx'], // ALT5 RXD1
  [16, 'uart', 1, 'cts'], // ALT5 CTS1
  [17, 'uart', 1, 'rts'], // ALT5 RTS1
  [16, 'spi', 1, 'cs', 2], // ALT4 SPI1_CE2_N
  [17, 'spi', 1, 'cs', 1], // ALT4 SPI1_CE1_N
  [18, 'spi', 1, 'cs', 0], // ALT4 SPI1_CE0_N
  [19, 'spi', 1, 'miso'], // ALT4 SPI1_MISO
  [20, 'spi', 1, 'mosi'], // ALT4 SPI1_MOSI
  [21, 'spi', 1, 'sck'], // ALT4 SPI1_SCLK
];

export const BCM2835_TABLE: BoardPinFunctions = staticTable({
  routing: 'mux',
  controllers: [
    piController('i2c', 0, 'BSC0'),
    piController('i2c', 1, 'BSC1'),
    piController('spi', 0, 'SPI0'),
    piController('spi', 1, 'SPI1 (auxiliary)'),
    piController('uart', 0, 'UART0 (PL011)'),
    piController('uart', 1, 'UART1 (mini UART)'),
  ],
  rows: BCM2835_ROWS,
  source:
    'BCM2835 ARM Peripherals, section 6.2 table 6-31 (GPIO alternate function assignment); ' +
    'the BCM2836/BCM2837 of the Pi 2B/3B keep the same GPIO block. On a real Pi 3B/Zero W ' +
    'serial0 is the mini UART; velxio routes serial0 through a PL011 (pi_uart_bridge.py).',
});

// ── BCM2711 (Pi 4) ────────────────────────────────────────────────────────────

const BCM2711_ROWS: readonly PinRow[] = [
  ...BCM2835_ROWS,
  // ALT3: SPI3-6, each with CE0 in the block and CE1 on GPIO24-27.
  [0, 'spi', 3, 'cs', 0],
  [1, 'spi', 3, 'miso'],
  [2, 'spi', 3, 'mosi'],
  [3, 'spi', 3, 'sck'],
  [24, 'spi', 3, 'cs', 1], // ALT5
  [4, 'spi', 4, 'cs', 0],
  [5, 'spi', 4, 'miso'],
  [6, 'spi', 4, 'mosi'],
  [7, 'spi', 4, 'sck'],
  [25, 'spi', 4, 'cs', 1], // ALT5
  [12, 'spi', 5, 'cs', 0],
  [13, 'spi', 5, 'miso'],
  [14, 'spi', 5, 'mosi'],
  [15, 'spi', 5, 'sck'],
  [26, 'spi', 5, 'cs', 1], // ALT5
  [18, 'spi', 6, 'cs', 0],
  [19, 'spi', 6, 'miso'],
  [20, 'spi', 6, 'mosi'],
  [21, 'spi', 6, 'sck'],
  [27, 'spi', 6, 'cs', 1], // ALT5
  // ALT4: UART2-5 (TXD, RXD, CTS, RTS in blocks of four).
  [0, 'uart', 2, 'tx'],
  [1, 'uart', 2, 'rx'],
  [2, 'uart', 2, 'cts'],
  [3, 'uart', 2, 'rts'],
  [4, 'uart', 3, 'tx'],
  [5, 'uart', 3, 'rx'],
  [6, 'uart', 3, 'cts'],
  [7, 'uart', 3, 'rts'],
  [8, 'uart', 4, 'tx'],
  [9, 'uart', 4, 'rx'],
  [10, 'uart', 4, 'cts'],
  [11, 'uart', 4, 'rts'],
  [12, 'uart', 5, 'tx'],
  [13, 'uart', 5, 'rx'],
  [14, 'uart', 5, 'cts'],
  [15, 'uart', 5, 'rts'],
  // ALT5: I2C3-6, two pin pairs each.
  [0, 'i2c', 6, 'sda'],
  [1, 'i2c', 6, 'scl'],
  [2, 'i2c', 3, 'sda'],
  [3, 'i2c', 3, 'scl'],
  [4, 'i2c', 3, 'sda'],
  [5, 'i2c', 3, 'scl'],
  [6, 'i2c', 4, 'sda'],
  [7, 'i2c', 4, 'scl'],
  [8, 'i2c', 4, 'sda'],
  [9, 'i2c', 4, 'scl'],
  [10, 'i2c', 5, 'sda'],
  [11, 'i2c', 5, 'scl'],
  [12, 'i2c', 5, 'sda'],
  [13, 'i2c', 5, 'scl'],
  [22, 'i2c', 6, 'sda'],
  [23, 'i2c', 6, 'scl'],
];

export const BCM2711_TABLE: BoardPinFunctions = staticTable({
  routing: 'mux',
  controllers: [
    piController('i2c', 0, 'BSC0'),
    piController('i2c', 1, 'BSC1'),
    piController('i2c', 3, 'BSC3'),
    piController('i2c', 4, 'BSC4'),
    piController('i2c', 5, 'BSC5'),
    piController('i2c', 6, 'BSC6'),
    piController('spi', 0, 'SPI0'),
    piController('spi', 1, 'SPI1 (auxiliary)'),
    piController('spi', 3, 'SPI3'),
    piController('spi', 4, 'SPI4'),
    piController('spi', 5, 'SPI5'),
    piController('spi', 6, 'SPI6'),
    piController('uart', 0, 'UART0 (PL011)'),
    piController('uart', 1, 'UART1 (mini UART)'),
    piController('uart', 2, 'UART2 (PL011)'),
    piController('uart', 3, 'UART3 (PL011)'),
    piController('uart', 4, 'UART4 (PL011)'),
    piController('uart', 5, 'UART5 (PL011)'),
  ],
  rows: BCM2711_ROWS,
  source:
    'BCM2711 ARM Peripherals, section 5.3 table 94 (GPIO alternate function assignment). ' +
    'BSC2 and BSC7 (HDMI) and SPI2 are not on the header. On a real Pi 4 serial0 is the ' +
    'mini UART; velxio routes serial0 through a PL011 (pi_uart_bridge.py).',
});

// ── RP1 (Pi 5) ────────────────────────────────────────────────────────────────

const RP1_ROWS: readonly PinRow[] = [
  // a0: SPI0 (SIO0 = MOSI, SIO1 = MISO in standard mode; SIO2/3 on GPIO1/0 are quad lines).
  [2, 'spi', 0, 'cs', 3],
  [3, 'spi', 0, 'cs', 2],
  [7, 'spi', 0, 'cs', 1],
  [8, 'spi', 0, 'cs', 0],
  [9, 'spi', 0, 'miso'],
  [10, 'spi', 0, 'mosi'],
  [11, 'spi', 0, 'sck'],
  // a0: SPI1; a8: its second CSn[1] on GPIO27.
  [16, 'spi', 1, 'cs', 2],
  [17, 'spi', 1, 'cs', 1],
  [18, 'spi', 1, 'cs', 0],
  [19, 'spi', 1, 'miso'],
  [20, 'spi', 1, 'mosi'],
  [21, 'spi', 1, 'sck'],
  [27, 'spi', 1, 'cs', 1],
  // a8: SPI2, SPI3, SPI5 (SPI4 on GPIO8-11 is slave-only).
  [0, 'spi', 2, 'cs', 0],
  [1, 'spi', 2, 'miso'],
  [2, 'spi', 2, 'mosi'],
  [3, 'spi', 2, 'sck'],
  [24, 'spi', 2, 'cs', 1],
  [4, 'spi', 3, 'cs', 0],
  [5, 'spi', 3, 'miso'],
  [6, 'spi', 3, 'mosi'],
  [7, 'spi', 3, 'sck'],
  [25, 'spi', 3, 'cs', 1],
  [12, 'spi', 5, 'cs', 0],
  [13, 'spi', 5, 'miso'],
  [14, 'spi', 5, 'mosi'],
  [15, 'spi', 5, 'sck'],
  [26, 'spi', 5, 'cs', 1],
  // a2: UART1-4 (TX, RX, CTS, RTS in blocks of four); a4: UART0 on GPIO14-17.
  [0, 'uart', 1, 'tx'],
  [1, 'uart', 1, 'rx'],
  [2, 'uart', 1, 'cts'],
  [3, 'uart', 1, 'rts'],
  [4, 'uart', 2, 'tx'],
  [5, 'uart', 2, 'rx'],
  [6, 'uart', 2, 'cts'],
  [7, 'uart', 2, 'rts'],
  [8, 'uart', 3, 'tx'],
  [9, 'uart', 3, 'rx'],
  [10, 'uart', 3, 'cts'],
  [11, 'uart', 3, 'rts'],
  [12, 'uart', 4, 'tx'],
  [13, 'uart', 4, 'rx'],
  [14, 'uart', 4, 'cts'],
  [15, 'uart', 4, 'rts'],
  [14, 'uart', 0, 'tx'],
  [15, 'uart', 0, 'rx'],
  [16, 'uart', 0, 'cts'],
  [17, 'uart', 0, 'rts'],
  // a3: I2C0-3.
  [0, 'i2c', 0, 'sda'],
  [1, 'i2c', 0, 'scl'],
  [8, 'i2c', 0, 'sda'],
  [9, 'i2c', 0, 'scl'],
  [2, 'i2c', 1, 'sda'],
  [3, 'i2c', 1, 'scl'],
  [10, 'i2c', 1, 'sda'],
  [11, 'i2c', 1, 'scl'],
  [4, 'i2c', 2, 'sda'],
  [5, 'i2c', 2, 'scl'],
  [12, 'i2c', 2, 'sda'],
  [13, 'i2c', 2, 'scl'],
  [6, 'i2c', 3, 'sda'],
  [7, 'i2c', 3, 'scl'],
  [14, 'i2c', 3, 'sda'],
  [15, 'i2c', 3, 'scl'],
  [22, 'i2c', 3, 'sda'],
  [23, 'i2c', 3, 'scl'],
];

export const RP1_TABLE: BoardPinFunctions = staticTable({
  routing: 'mux',
  controllers: [
    piController('i2c', 0, 'I2C0'),
    piController('i2c', 1, 'I2C1'),
    piController('i2c', 2, 'I2C2'),
    piController('i2c', 3, 'I2C3'),
    piController('spi', 0, 'SPI0'),
    piController('spi', 1, 'SPI1'),
    piController('spi', 2, 'SPI2'),
    piController('spi', 3, 'SPI3'),
    piController('spi', 5, 'SPI5'),
    piController('uart', 0, 'UART0'),
    piController('uart', 1, 'UART1'),
    piController('uart', 2, 'UART2'),
    piController('uart', 3, 'UART3'),
    piController('uart', 4, 'UART4'),
  ],
  rows: RP1_ROWS,
  source:
    'RP1 Peripherals, section 3.1 table 4 (GPIO function selection) and section 3.6.1 ' +
    '(SPI4 and SPI7 are slave-only; SIO0 is TXD, SIO1 is RXD); linux rpi-6.6.y ' +
    'drivers/pinctrl/pinctrl-rp1.c and arch/arm64/boot/dts/broadcom/rp1.dtsi pin groups. ' +
    'On a real Pi 5 serial0 is the debug connector (ttyAMA10); velxio routes serial0 to ' +
    'GPIO14/15.',
});
