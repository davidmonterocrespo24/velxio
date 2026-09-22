/**
 * STM32 boards (QEMU backend): Blue Pill F103C8/CB, Black Pill F411CE/F401CE,
 * STM32F4 Discovery (F407VG), Olimex STM32-H405 and Netduino Plus 2 (F405RG),
 * Netduino 2 (F205RG).
 *
 * Board pins are port * 16 + bit (PA0 = 0, PB0 = 16, PC13 = 45), the linear
 * index boardPinMapping.ts and the QEMU machine share. The rows are every
 * alternate function STM32duino's PeripheralPins.c lists for the package
 * (generated from ST's pin database, one line per pin and peripheral), so a
 * pin carries all of its AF choices; which one is live is the firmware's
 * GPIO AFR setting.
 *
 * Units are the QEMU machine's 0-based indices, which is also how its events
 * name them: usart[0] = USART1, usart[3] = UART4, usart[5] = USART6, spi[0] =
 * SPI1, i2c[0] = I2C1 (stm32f100_soc.c, stm32f205_soc.c, stm32f405_soc.c).
 * The datasheet name stays in ControllerDef.name.
 */
import type { BoardPinFunctions, BusKind, BusSignal, ControllerDef } from '../pinFunctions';
import { staticTable, type PinRow } from './build';

/** One PeripheralPins.c line: [pin, peripheral instance, signal]. */
type Stm32Row = readonly [string, string, BusSignal];

/** 'PA9' -> 9, 'PC13' -> 45. */
export function stm32PinNumber(name: string): number {
  const m = /^P([A-K])(\d{1,2})$/.exec(name);
  if (!m) throw new Error(`not an STM32 pin name: ${name}`);
  return (m[1].charCodeAt(0) - 65) * 16 + Number(m[2]);
}

/** 'USART1' -> uart unit 0, 'UART4' -> uart 3, 'SPI3' -> spi 2, 'I2C2' -> i2c 1. */
export function stm32Controller(instance: string): { bus: BusKind; unit: number } {
  const m = /^(USART|UART|SPI|I2C)(\d)$/.exec(instance);
  if (!m) throw new Error(`not an STM32 serial instance: ${instance}`);
  const bus: BusKind = m[1] === 'SPI' ? 'spi' : m[1] === 'I2C' ? 'i2c' : 'uart';
  return { bus, unit: Number(m[2]) - 1 };
}

function toPinRows(rows: readonly Stm32Row[]): PinRow[] {
  return rows.map(([pin, instance, signal]) => {
    const { bus, unit } = stm32Controller(instance);
    const n = stm32PinNumber(pin);
    // STM32 SPI has one NSS line per instance.
    return signal === 'cs' ? [n, bus, unit, signal, 0] : [n, bus, unit, signal];
  });
}

/** Every instance the rows mention, in datasheet order, with the core bindings folded in. */
function controllersOf(
  rows: readonly Stm32Row[],
  bound: Record<string, Pick<ControllerDef, 'arduino' | 'defaultPins'>>,
): ControllerDef[] {
  const names = Array.from(new Set(rows.map((r) => r[1])));
  names.sort((a, b) => {
    const ca = stm32Controller(a);
    const cb = stm32Controller(b);
    return ca.bus === cb.bus ? ca.unit - cb.unit : ca.bus.localeCompare(cb.bus);
  });
  return names.map((name) => {
    const { bus, unit } = stm32Controller(name);
    const core = bound[name];
    const def: ControllerDef = { bus, unit, name, defaultPins: core?.defaultPins ?? {} };
    if (core?.arduino) def.arduino = core.arduino;
    return def;
  });
}

const P = stm32PinNumber;

// ── PeripheralPins.c, STMicroelectronics:stm32 3.0.0 ────────────────────────

/** variants/STM32F1xx/F103C8T_F103CB(T-U)/PeripheralPins.c (LQFP48; remaps via AFIO). */
const F103CX_ROWS: readonly Stm32Row[] = [
  ['PA0', 'USART2', 'cts'],
  ['PA1', 'USART2', 'rts'],
  ['PA2', 'USART2', 'tx'],
  ['PA3', 'USART2', 'rx'],
  ['PA4', 'SPI1', 'cs'],
  ['PA5', 'SPI1', 'sck'],
  ['PA6', 'SPI1', 'miso'],
  ['PA7', 'SPI1', 'mosi'],
  ['PA9', 'USART1', 'tx'],
  ['PA10', 'USART1', 'rx'],
  ['PA11', 'USART1', 'cts'],
  ['PA12', 'USART1', 'rts'],
  ['PA15', 'SPI1', 'cs'],
  ['PB3', 'SPI1', 'sck'],
  ['PB4', 'SPI1', 'miso'],
  ['PB5', 'SPI1', 'mosi'],
  ['PB6', 'I2C1', 'scl'],
  ['PB6', 'USART1', 'tx'],
  ['PB7', 'I2C1', 'sda'],
  ['PB7', 'USART1', 'rx'],
  ['PB8', 'I2C1', 'scl'],
  ['PB9', 'I2C1', 'sda'],
  ['PB10', 'I2C2', 'scl'],
  ['PB10', 'USART3', 'tx'],
  ['PB11', 'I2C2', 'sda'],
  ['PB11', 'USART3', 'rx'],
  ['PB12', 'SPI2', 'cs'],
  ['PB13', 'SPI2', 'sck'],
  ['PB13', 'USART3', 'cts'],
  ['PB14', 'SPI2', 'miso'],
  ['PB14', 'USART3', 'rts'],
  ['PB15', 'SPI2', 'mosi'],
];

/** variants/STM32F4xx/F411C(C-E)(U-Y)/PeripheralPins.c (UFQFPN48). */
const F411CX_ROWS: readonly Stm32Row[] = [
  ['PA0', 'USART2', 'cts'],
  ['PA1', 'SPI4', 'mosi'],
  ['PA1', 'USART2', 'rts'],
  ['PA2', 'USART2', 'tx'],
  ['PA3', 'USART2', 'rx'],
  ['PA4', 'SPI1', 'cs'],
  ['PA4', 'SPI3', 'cs'],
  ['PA5', 'SPI1', 'sck'],
  ['PA6', 'SPI1', 'miso'],
  ['PA7', 'SPI1', 'mosi'],
  ['PA8', 'I2C3', 'scl'],
  ['PA9', 'USART1', 'tx'],
  ['PA10', 'SPI5', 'mosi'],
  ['PA10', 'USART1', 'rx'],
  ['PA11', 'SPI4', 'miso'],
  ['PA11', 'USART1', 'cts'],
  ['PA11', 'USART6', 'tx'],
  ['PA12', 'SPI5', 'miso'],
  ['PA12', 'USART1', 'rts'],
  ['PA12', 'USART6', 'rx'],
  ['PA15', 'SPI1', 'cs'],
  ['PA15', 'SPI3', 'cs'],
  ['PA15', 'USART1', 'tx'],
  ['PB0', 'SPI5', 'sck'],
  ['PB1', 'SPI5', 'cs'],
  ['PB3', 'I2C2', 'sda'],
  ['PB3', 'SPI1', 'sck'],
  ['PB3', 'SPI3', 'sck'],
  ['PB3', 'USART1', 'rx'],
  ['PB4', 'I2C3', 'sda'],
  ['PB4', 'SPI1', 'miso'],
  ['PB4', 'SPI3', 'miso'],
  ['PB5', 'SPI1', 'mosi'],
  ['PB5', 'SPI3', 'mosi'],
  ['PB6', 'I2C1', 'scl'],
  ['PB6', 'USART1', 'tx'],
  ['PB7', 'I2C1', 'sda'],
  ['PB7', 'USART1', 'rx'],
  ['PB8', 'I2C1', 'scl'],
  ['PB8', 'I2C3', 'sda'],
  ['PB8', 'SPI5', 'mosi'],
  ['PB9', 'I2C1', 'sda'],
  ['PB9', 'I2C2', 'sda'],
  ['PB9', 'SPI2', 'cs'],
  ['PB10', 'I2C2', 'scl'],
  ['PB10', 'SPI2', 'sck'],
  ['PB12', 'SPI2', 'cs'],
  ['PB12', 'SPI3', 'sck'],
  ['PB12', 'SPI4', 'cs'],
  ['PB13', 'SPI2', 'sck'],
  ['PB13', 'SPI4', 'sck'],
  ['PB14', 'SPI2', 'miso'],
  ['PB15', 'SPI2', 'mosi'],
];

/** variants/STM32F4xx/F401CC(F-U-Y)_F401C(B-D-E)(U-Y)/PeripheralPins.c (UFQFPN48). */
const F401CX_ROWS: readonly Stm32Row[] = [
  ['PA0', 'USART2', 'cts'],
  ['PA1', 'USART2', 'rts'],
  ['PA2', 'USART2', 'tx'],
  ['PA3', 'USART2', 'rx'],
  ['PA4', 'SPI1', 'cs'],
  ['PA4', 'SPI3', 'cs'],
  ['PA5', 'SPI1', 'sck'],
  ['PA6', 'SPI1', 'miso'],
  ['PA7', 'SPI1', 'mosi'],
  ['PA8', 'I2C3', 'scl'],
  ['PA9', 'USART1', 'tx'],
  ['PA10', 'USART1', 'rx'],
  ['PA11', 'USART1', 'cts'],
  ['PA11', 'USART6', 'tx'],
  ['PA12', 'USART1', 'rts'],
  ['PA12', 'USART6', 'rx'],
  ['PA15', 'SPI1', 'cs'],
  ['PA15', 'SPI3', 'cs'],
  ['PB3', 'I2C2', 'sda'],
  ['PB3', 'SPI1', 'sck'],
  ['PB3', 'SPI3', 'sck'],
  ['PB4', 'I2C3', 'sda'],
  ['PB4', 'SPI1', 'miso'],
  ['PB4', 'SPI3', 'miso'],
  ['PB5', 'SPI1', 'mosi'],
  ['PB5', 'SPI3', 'mosi'],
  ['PB6', 'I2C1', 'scl'],
  ['PB6', 'USART1', 'tx'],
  ['PB7', 'I2C1', 'sda'],
  ['PB7', 'USART1', 'rx'],
  ['PB8', 'I2C1', 'scl'],
  ['PB9', 'I2C1', 'sda'],
  ['PB9', 'SPI2', 'cs'],
  ['PB10', 'I2C2', 'scl'],
  ['PB10', 'SPI2', 'sck'],
  ['PB12', 'SPI2', 'cs'],
  ['PB13', 'SPI2', 'sck'],
  ['PB14', 'SPI2', 'miso'],
  ['PB15', 'SPI2', 'mosi'],
];

/** variants/STM32F4xx/F407V(E-G)T_F417V(E-G)T/PeripheralPins.c (LQFP100). */
const F407VX_ROWS: readonly Stm32Row[] = [
  ['PA0', 'UART4', 'tx'],
  ['PA0', 'USART2', 'cts'],
  ['PA1', 'UART4', 'rx'],
  ['PA1', 'USART2', 'rts'],
  ['PA2', 'USART2', 'tx'],
  ['PA3', 'USART2', 'rx'],
  ['PA4', 'SPI1', 'cs'],
  ['PA4', 'SPI3', 'cs'],
  ['PA5', 'SPI1', 'sck'],
  ['PA6', 'SPI1', 'miso'],
  ['PA7', 'SPI1', 'mosi'],
  ['PA8', 'I2C3', 'scl'],
  ['PA9', 'USART1', 'tx'],
  ['PA10', 'USART1', 'rx'],
  ['PA11', 'USART1', 'cts'],
  ['PA12', 'USART1', 'rts'],
  ['PA15', 'SPI1', 'cs'],
  ['PA15', 'SPI3', 'cs'],
  ['PB3', 'SPI1', 'sck'],
  ['PB3', 'SPI3', 'sck'],
  ['PB4', 'SPI1', 'miso'],
  ['PB4', 'SPI3', 'miso'],
  ['PB5', 'SPI1', 'mosi'],
  ['PB5', 'SPI3', 'mosi'],
  ['PB6', 'I2C1', 'scl'],
  ['PB6', 'USART1', 'tx'],
  ['PB7', 'I2C1', 'sda'],
  ['PB7', 'USART1', 'rx'],
  ['PB8', 'I2C1', 'scl'],
  ['PB9', 'I2C1', 'sda'],
  ['PB9', 'SPI2', 'cs'],
  ['PB10', 'I2C2', 'scl'],
  ['PB10', 'SPI2', 'sck'],
  ['PB10', 'USART3', 'tx'],
  ['PB11', 'I2C2', 'sda'],
  ['PB11', 'USART3', 'rx'],
  ['PB12', 'SPI2', 'cs'],
  ['PB13', 'SPI2', 'sck'],
  ['PB13', 'USART3', 'cts'],
  ['PB14', 'SPI2', 'miso'],
  ['PB14', 'USART3', 'rts'],
  ['PB15', 'SPI2', 'mosi'],
  ['PC2', 'SPI2', 'miso'],
  ['PC3', 'SPI2', 'mosi'],
  ['PC6', 'USART6', 'tx'],
  ['PC7', 'USART6', 'rx'],
  ['PC9', 'I2C3', 'sda'],
  ['PC10', 'SPI3', 'sck'],
  ['PC10', 'UART4', 'tx'],
  ['PC10', 'USART3', 'tx'],
  ['PC11', 'SPI3', 'miso'],
  ['PC11', 'UART4', 'rx'],
  ['PC11', 'USART3', 'rx'],
  ['PC12', 'SPI3', 'mosi'],
  ['PC12', 'UART5', 'tx'],
  ['PD2', 'UART5', 'rx'],
  ['PD3', 'USART2', 'cts'],
  ['PD4', 'USART2', 'rts'],
  ['PD5', 'USART2', 'tx'],
  ['PD6', 'USART2', 'rx'],
  ['PD8', 'USART3', 'tx'],
  ['PD9', 'USART3', 'rx'],
  ['PD11', 'USART3', 'cts'],
  ['PD12', 'USART3', 'rts'],
];

/**
 * variants/STM32F4xx/F405RGT_F415RGT/PeripheralPins.c (LQFP64). The F205RG
 * variant (variants/STM32F2xx/F205RE(T-Y)_F205R(B-C-F)T_F205RG(E-T-Y)_F215R(E-G)T)
 * lists exactly the same serial rows.
 */
const F405RX_ROWS: readonly Stm32Row[] = [
  ['PA0', 'UART4', 'tx'],
  ['PA0', 'USART2', 'cts'],
  ['PA1', 'UART4', 'rx'],
  ['PA1', 'USART2', 'rts'],
  ['PA2', 'USART2', 'tx'],
  ['PA3', 'USART2', 'rx'],
  ['PA4', 'SPI1', 'cs'],
  ['PA4', 'SPI3', 'cs'],
  ['PA5', 'SPI1', 'sck'],
  ['PA6', 'SPI1', 'miso'],
  ['PA7', 'SPI1', 'mosi'],
  ['PA8', 'I2C3', 'scl'],
  ['PA9', 'USART1', 'tx'],
  ['PA10', 'USART1', 'rx'],
  ['PA11', 'USART1', 'cts'],
  ['PA12', 'USART1', 'rts'],
  ['PA15', 'SPI1', 'cs'],
  ['PA15', 'SPI3', 'cs'],
  ['PB3', 'SPI1', 'sck'],
  ['PB3', 'SPI3', 'sck'],
  ['PB4', 'SPI1', 'miso'],
  ['PB4', 'SPI3', 'miso'],
  ['PB5', 'SPI1', 'mosi'],
  ['PB5', 'SPI3', 'mosi'],
  ['PB6', 'I2C1', 'scl'],
  ['PB6', 'USART1', 'tx'],
  ['PB7', 'I2C1', 'sda'],
  ['PB7', 'USART1', 'rx'],
  ['PB8', 'I2C1', 'scl'],
  ['PB9', 'I2C1', 'sda'],
  ['PB9', 'SPI2', 'cs'],
  ['PB10', 'I2C2', 'scl'],
  ['PB10', 'SPI2', 'sck'],
  ['PB10', 'USART3', 'tx'],
  ['PB11', 'I2C2', 'sda'],
  ['PB11', 'USART3', 'rx'],
  ['PB12', 'SPI2', 'cs'],
  ['PB13', 'SPI2', 'sck'],
  ['PB13', 'USART3', 'cts'],
  ['PB14', 'SPI2', 'miso'],
  ['PB14', 'USART3', 'rts'],
  ['PB15', 'SPI2', 'mosi'],
  ['PC2', 'SPI2', 'miso'],
  ['PC3', 'SPI2', 'mosi'],
  ['PC6', 'USART6', 'tx'],
  ['PC7', 'USART6', 'rx'],
  ['PC9', 'I2C3', 'sda'],
  ['PC10', 'SPI3', 'sck'],
  ['PC10', 'UART4', 'tx'],
  ['PC10', 'USART3', 'tx'],
  ['PC11', 'SPI3', 'miso'],
  ['PC11', 'UART4', 'rx'],
  ['PC11', 'USART3', 'rx'],
  ['PC12', 'SPI3', 'mosi'],
  ['PC12', 'UART5', 'tx'],
  ['PD2', 'UART5', 'rx'],
];

// ── Core bindings (variant header of each FQBN pnum) ──────────────────────────

/**
 * Serial is Serial<SERIAL_UART_INSTANCE> on PIN_SERIAL_RX/TX (USB support
 * defaults to None); SPI and Wire are the instances PeripheralPins resolves
 * for PIN_SPI_* and PIN_WIRE_*. PIN_SPI_SS is the SS constant, a plain GPIO:
 * STM32duino drives chip select in software unless begin() is given an NSS pin.
 */
const PILL_BINDINGS: Record<string, Pick<ControllerDef, 'arduino' | 'defaultPins'>> = {
  USART1: { arduino: ['Serial', 'Serial1'], defaultPins: { rx: P('PA10'), tx: P('PA9') } },
  SPI1: {
    arduino: ['SPI'],
    defaultPins: { sck: P('PA5'), miso: P('PA6'), mosi: P('PA7'), cs: P('PA4') },
  },
  I2C1: { arduino: ['Wire'], defaultPins: { sda: P('PB7'), scl: P('PB6') } },
};

/** variant_DISCO_F407VG.h: Serial is USART2 (ST-LINK VCP), SS is PB12, SCL is PB8. */
const DISCO_F407_BINDINGS: Record<string, Pick<ControllerDef, 'arduino' | 'defaultPins'>> = {
  USART2: { arduino: ['Serial', 'Serial2'], defaultPins: { rx: P('PA3'), tx: P('PA2') } },
  SPI1: {
    arduino: ['SPI'],
    defaultPins: { sck: P('PA5'), miso: P('PA6'), mosi: P('PA7'), cs: P('PB12') },
  },
  I2C1: { arduino: ['Wire'], defaultPins: { sda: P('PB7'), scl: P('PB8') } },
};

/** variant_generic.h of GENERIC_F405RGTX and GENERIC_F205RGTX: Serial is UART4 on PA0/PA1. */
const GENERIC_RG_BINDINGS: Record<string, Pick<ControllerDef, 'arduino' | 'defaultPins'>> = {
  UART4: { arduino: ['Serial', 'Serial4'], defaultPins: { rx: P('PA1'), tx: P('PA0') } },
  SPI1: {
    arduino: ['SPI'],
    defaultPins: { sck: P('PA5'), miso: P('PA6'), mosi: P('PA7'), cs: P('PA4') },
  },
  I2C1: { arduino: ['Wire'], defaultPins: { sda: P('PB7'), scl: P('PB6') } },
};

function stm32Table(
  rows: readonly Stm32Row[],
  bound: Record<string, Pick<ControllerDef, 'arduino' | 'defaultPins'>>,
  source: string,
): BoardPinFunctions {
  return staticTable({
    routing: 'mux',
    controllers: controllersOf(rows, bound),
    rows: toPinRows(rows),
    source,
  });
}

const CORE = 'STMicroelectronics:stm32 3.0.0';

export const BLUEPILL_F103_TABLE: BoardPinFunctions = stm32Table(
  F103CX_ROWS,
  PILL_BINDINGS,
  `${CORE} variants/STM32F1xx/F103C8T_F103CB(T-U)/PeripheralPins.c and variant_PILL_F103Cx.h ` +
    '(pnum BLUEPILL_F103C8 / BLUEPILL_F103CB). QEMU runs it on the F100 SoC (stm32vldiscovery), ' +
    'which has the same USART1-3, SPI1-2, I2C1-2.',
);

export const BLACKPILL_F411_TABLE: BoardPinFunctions = stm32Table(
  F411CX_ROWS,
  PILL_BINDINGS,
  `${CORE} variants/STM32F4xx/F411C(C-E)(U-Y)/PeripheralPins.c and variant_BLACKPILL_F411CE.h. ` +
    'The pnum builds with CUSTOM_PERIPHERAL_PINS, so the core compiles ' +
    'PeripheralPins_BLACKPILL_F411CE.c instead: same rows except PB8 I2C3_SDA (AF9), which it ' +
    'comments out; the silicon still has it, a sketch cannot pick it through Wire. ' +
    'QEMU runs it on the F405 SoC (netduinoplus2), where USART6 is usart[5] and SPI4/5 are spi[3]/[4].',
);

export const BLACKPILL_F401_TABLE: BoardPinFunctions = stm32Table(
  F401CX_ROWS,
  PILL_BINDINGS,
  `${CORE} variants/STM32F4xx/F401CC(F-U-Y)_F401C(B-D-E)(U-Y)/PeripheralPins.c and ` +
    'variant_BLACKPILL_F401Cx.h. The pnum builds with CUSTOM_PERIPHERAL_PINS ' +
    '(PeripheralPins_BLACKPILL_F401Cx.c), whose serial rows are identical. ' +
    'QEMU runs it on the F405 SoC (netduinoplus2).',
);

/**
 * STM32F4 Discovery. Its on-board parts hold some of these pins: the MEMS
 * accelerometer (LIS302DL or LIS3DSH by board revision) on SPI1 (PA5-PA7,
 * CS PE3) and the CS43L22 audio DAC on I2C1 (PB6/PB9).
 */
export const DISCO_F407_TABLE: BoardPinFunctions = stm32Table(
  F407VX_ROWS,
  DISCO_F407_BINDINGS,
  `${CORE} variants/STM32F4xx/F407V(E-G)T_F417V(E-G)T/PeripheralPins.c and ` +
    'variant_DISCO_F407VG.h. QEMU runs it on the F405 SoC (netduinoplus2).',
);

export const GENERIC_F405RG_TABLE: BoardPinFunctions = stm32Table(
  F405RX_ROWS,
  GENERIC_RG_BINDINGS,
  `${CORE} variants/STM32F4xx/F405RGT_F415RGT/PeripheralPins.c and variant_generic.h ` +
    '(pnum GENERIC_F405RGTX, the FQBN velxio builds the Olimex H405 and Netduino Plus 2 with).',
);

export const GENERIC_F205RG_TABLE: BoardPinFunctions = stm32Table(
  F405RX_ROWS,
  GENERIC_RG_BINDINGS,
  `${CORE} variants/STM32F2xx/F205RE(T-Y)_F205R(B-C-F)T_F205RG(E-T-Y)_F215R(E-G)T/` +
    'PeripheralPins.c and variant_generic.h (pnum GENERIC_F205RGTX).',
);
