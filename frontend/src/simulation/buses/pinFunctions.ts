/**
 * Pin function tables: which serial-bus signal every board pin can carry.
 *
 * The bus fabric (project board-buses-2026-09, DESIGN section 5.2) decides
 * which controller a device sits on from the NETS its pins land on. For that it
 * needs, per board, the pins each SPI / I2C / UART controller can be routed to.
 * This module is that data, one table per board kind, registered by whoever
 * defines the board (OSS here, the pro overlay for its own boards).
 *
 * `routing` says how much the static table can be trusted:
 *  - 'fixed':  the functions live on exactly the listed pins (ATmega328P).
 *  - 'mux':    each pin has a short list of alternates chosen by a function
 *              select register (RP2040 funcsel, SAMD21 PMUX). Every alternate
 *              is listed; which one is live comes from the engine at run time.
 *  - 'matrix': any GPIO can carry any signal (ESP32 GPIO matrix, nRF PSEL).
 *              The listed pins are the direct IO_MUX pins and the Arduino
 *              defaults; the live routing always comes from the engine.
 *
 * Pin numbers are the board pin numbers the rest of the simulator uses, the
 * PinManager keys that boardPinToNumber / ProBoardDef.pinToNumber return. Not
 * package pins, not port bits.
 */

export type BusKind = 'spi' | 'i2c' | 'uart';

export type SpiSignal = 'sck' | 'mosi' | 'miso' | 'cs';
export type I2cSignal = 'sda' | 'scl';
export type UartSignal = 'tx' | 'rx' | 'rts' | 'cts';
export type BusSignal = SpiSignal | I2cSignal | UartSignal;

export interface ControllerDef {
  bus: BusKind;
  /** The SoC's own index for this peripheral (SPI0 = 0, SPI1 = 1; GPSPI2 = 2). */
  unit: number;
  /** Datasheet name: 'SPI0', 'VSPI', 'GPSPI2', 'SERCOM0', 'SPIM3', 'USART1'. */
  name: string;
  /** Arduino objects bound to it by the board's core: ['SPI'], ['Wire1'], ['Serial2']. */
  arduino?: string[];
  /** Pins the core uses when begin() is called without pins. */
  defaultPins: Partial<Record<BusSignal, number | number[]>>;
}

export interface PinFunction {
  bus: BusKind;
  unit: number;
  signal: BusSignal;
  /** Hardware chip-select index for a 'cs' signal (CS0, CS1...). */
  csIndex?: number;
}

export interface BoardPinFunctions {
  routing: 'fixed' | 'mux' | 'matrix';
  controllers: ControllerDef[];
  /** Board pin number -> every serial-bus function that pin can take. */
  pins: Record<number, PinFunction[]>;
  /** Where the data comes from: datasheet section, core variant file, pinout. */
  source: string;
}

const TABLES = new Map<string, BoardPinFunctions>();

/** Register one table for every board kind that shares the same pinout. */
export function registerBoardPinFunctions(boardKinds: string[], table: BoardPinFunctions): void {
  for (const kind of boardKinds) TABLES.set(kind, table);
}

export function getBoardPinFunctions(boardKind: string): BoardPinFunctions | undefined {
  return TABLES.get(boardKind);
}

export function listBoardPinFunctionKinds(): string[] {
  return Array.from(TABLES.keys()).sort();
}

/** Every function a board pin can carry, or [] when the table does not list it. */
export function functionsOfPin(boardKind: string, pin: number): PinFunction[] {
  return TABLES.get(boardKind)?.pins[pin] ?? [];
}

/** The controller definition for (bus, unit) on a board, if the table has it. */
export function controllerOf(
  boardKind: string,
  bus: BusKind,
  unit: number,
): ControllerDef | undefined {
  return TABLES.get(boardKind)?.controllers.find((c) => c.bus === bus && c.unit === unit);
}
