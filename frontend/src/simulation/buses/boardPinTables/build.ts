/**
 * Helpers to write pin function tables as rows, the way the datasheets and
 * the core variant files list them: one line per (pin, controller, signal).
 */
import type {
  BoardPinFunctions,
  BusKind,
  BusSignal,
  ControllerDef,
  PinFunction,
} from '../pinFunctions';

/** [board pin, bus, unit, signal, hardware chip-select index for a 'cs' row]. */
export type PinRow = readonly [number, BusKind, number, BusSignal, number?];

function sameFunction(a: PinFunction, b: PinFunction): boolean {
  return a.bus === b.bus && a.unit === b.unit && a.signal === b.signal && a.csIndex === b.csIndex;
}

function addFunction(pins: Record<number, PinFunction[]>, pin: number, fn: PinFunction): void {
  const list = (pins[pin] ??= []);
  if (!list.some((f) => sameFunction(f, fn))) list.push(fn);
}

function rowFunction(row: PinRow): PinFunction {
  const [, bus, unit, signal, csIndex] = row;
  return csIndex === undefined ? { bus, unit, signal } : { bus, unit, signal, csIndex };
}

/** Pin map from rows; a row that repeats an existing (pin, function) is dropped. */
export function pinsFromRows(rows: readonly PinRow[]): Record<number, PinFunction[]> {
  const pins: Record<number, PinFunction[]> = {};
  for (const row of rows) addFunction(pins, row[0], rowFunction(row));
  return pins;
}

/** The default pins of every controller, as rows (a cs list becomes CS0, CS1...). */
export function defaultPinRows(controllers: readonly ControllerDef[]): PinRow[] {
  const rows: PinRow[] = [];
  for (const c of controllers) {
    for (const [signal, value] of Object.entries(c.defaultPins) as Array<
      [BusSignal, number | number[] | undefined]
    >) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        value.forEach((pin, i) => rows.push([pin, c.bus, c.unit, signal, i]));
      } else if (signal === 'cs') {
        rows.push([value, c.bus, c.unit, signal, 0]);
      } else {
        rows.push([value, c.bus, c.unit, signal]);
      }
    }
  }
  return rows;
}

/**
 * A table for a SoC whose functions sit on fixed pins or on a short mux list.
 * The rows are the whole truth: the default pins must already be among them
 * (the coverage test checks it), because a core default the silicon cannot
 * route would be a wrong table, not a missing row.
 */
export function staticTable(opts: {
  routing: 'fixed' | 'mux';
  controllers: ControllerDef[];
  rows: readonly PinRow[];
  source: string;
}): BoardPinFunctions {
  return {
    routing: opts.routing,
    controllers: opts.controllers,
    pins: pinsFromRows(opts.rows),
    source: opts.source,
  };
}

/**
 * A table for a SoC with a GPIO matrix (ESP32 family). Any GPIO can carry any
 * signal, so the table lists the direct IO_MUX pins plus the pins the core
 * picks when begin() gets none, restricted to the pins the board breaks out.
 */
export function matrixTable(opts: {
  controllers: ControllerDef[];
  ioMux: readonly PinRow[];
  boardPins: readonly number[];
  source: string;
}): BoardPinFunctions {
  const onBoard = new Set(opts.boardPins);
  const rows = [...opts.ioMux, ...defaultPinRows(opts.controllers)].filter((r) =>
    onBoard.has(r[0]),
  );
  return {
    routing: 'matrix',
    controllers: opts.controllers,
    pins: pinsFromRows(rows),
    source: opts.source,
  };
}
