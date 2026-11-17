/**
 * A GPIO of a 3.3 V ESP32 that the circuit takes above what its pad takes
 * (velxio/velxio-prod#175).
 *
 * An ESP32 input takes at most VDD + 0.3 V (ESP32 datasheet v5.3, Table 5-3,
 * VIH max; the ESP32-S3 and ESP32-C3 datasheets give the same), 3.6 V on a
 * 3.3 V board. The pre-flight's own solve cannot show what reaches a GPIO: it
 * forces every wired GPIO HIGH at the board's 3.3 V (the worst case for an LED),
 * so a 5 V supply through 1 kOhm into GPIO4 solves at 3.3 V there. This check
 * reads the canvas twice over:
 *
 *  - the WIRING: a supply pin above the limit on the pad's own wire group (another
 *    board's 5V, the ESP32's own VIN / 5V, a battery's or a bench supply's +),
 *    or a GPIO of a board whose logic is above the limit (an Uno's pin, which puts
 *    5 V there whenever it drives HIGH, the pre-flight's own worst case);
 *  - a SOLVE of the canvas with no board pad driven at all, so only the supplies
 *    and the parts set each net: a 5 V supply behind a resistor, a pot or a
 *    divider across VIN, a 5 V-powered part's output.
 *
 * The solve is skipped on a canvas whose boards run at different voltages: the
 * netlist puts every board's main supply pins on one rail at the first board's
 * voltage, so there an ESP32's 3V3 can solve at 5 V and a pull-up to it would
 * read as an over-voltage. The wiring is still read there.
 */
import type { BuildNetlistInput } from '../spice/types';
import { buildNetlist } from '../spice/NetlistBuilder';
import { pinNameToArduinoPin } from '../spice/collectPinStates';
import { UnionFind } from '../spice/unionFind';
import { breadboardGroupKey, hasInternalNets } from '../../utils/breadboardNets';
import { esp32ChipOf } from '../../types/boardOptions';
import { isInputOnlyPad } from '../../utils/boardPinMapping';
import type { BoardKind } from '../../types/board';

type Board = BuildNetlistInput['boards'][number];
type Component = BuildNetlistInput['components'][number];

/** One finding, in the verifier's terms (circuitVerifier.CircuitWarning). */
export interface GpioOverVoltage {
  boardId: string;
  pinName: string;
  /** The voltage that reaches (or would reach) the pad. */
  volts: number;
  message: string;
}

const CHIP_LABEL: Record<string, string> = {
  esp32: 'ESP32',
  'esp32-s3': 'ESP32-S3',
  'esp32-c3': 'ESP32-C3',
  'esp32-c6': 'ESP32-C6',
  'esp32-c5': 'ESP32-C5',
  'esp32-p4': 'ESP32-P4',
};

/** Above this an ESP32 GPIO is past its rating; null for a board not checked this way. */
export function gpioInputLimit(board: Board): { volts: number; label: string } | null {
  if (!board.boardKind) return null;
  const chip = esp32ChipOf(board.boardKind as BoardKind);
  if (!chip) return null;
  return { volts: board.vcc + 0.3, label: CHIP_LABEL[chip] ?? 'ESP32' };
}

const volts = (v: number) => `${v.toFixed(1)} V`;
const padName = (pin: string) => (/^\d+$/.test(pin) ? `GPIO${pin}` : pin);
const isGpio = (board: Board, pin: string) =>
  !!board.boardKind && pinNameToArduinoPin(pin, board.boardKind as BoardKind) >= 0;
/** A pad the pre-flight would drive HIGH: not one picked by its analog name (an
 *  Uno's A0, wired to read) and not one the chip can only read. */
const canDrive = (board: Board, pin: string) =>
  !/^A\d+$/.test(pin) && !isInputOnlyPad(board.boardKind ?? '', pin);

/** Everything a pin is joined to by wires and breadboard strips, never through a part. */
function wireGroups(input: BuildNetlistInput): (key: string) => string {
  const uf = new UnionFind();
  const meta = new Map(input.components.map((c) => [c.id, c.metadataId] as const));
  for (const wire of input.wires) {
    const a = `${wire.start.componentId}:${wire.start.pinName}`;
    const b = `${wire.end.componentId}:${wire.end.pinName}`;
    uf.union(a, b);
    for (const [key, end] of [
      [a, wire.start],
      [b, wire.end],
    ] as const) {
      const m = meta.get(end.componentId);
      const group = m && hasInternalNets(m) ? breadboardGroupKey(m, end.pinName) : null;
      if (group) uf.union(key, `group|${end.componentId}|${group}`);
    }
  }
  return (key) => uf.find(key);
}

/** The pins wires reference, per component or board id. */
function wiredPins(input: BuildNetlistInput): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const wire of input.wires) {
    for (const end of [wire.start, wire.end]) {
      let set = out.get(end.componentId);
      if (!set) out.set(end.componentId, (set = new Set()));
      set.add(end.pinName);
    }
  }
  return out;
}

interface Drive {
  volts: number;
  /** "5V of uno", "the + of psu" ... */
  what: string;
  /** A board's GPIO: it reaches the pad only while it drives HIGH. */
  link: boolean;
}

/**
 * The checks. `sourceVolts` is the verifier's reading of a source part's
 * positive terminals and nominal voltage; `solve` runs a netlist and returns
 * its node voltages (null when it cannot).
 */
export async function gpioOverVoltages(
  input: BuildNetlistInput,
  sourceVolts: (comp: Component) => { posPins: string[]; volts: number } | null,
  solve: (netlist: string) => Promise<Record<string, number> | null>,
): Promise<GpioOverVoltage[]> {
  const limited = input.boards
    .map((board) => ({ board, limit: gpioInputLimit(board) }))
    .filter((x): x is { board: Board; limit: { volts: number; label: string } } => x.limit !== null);
  if (limited.length === 0) return [];

  const wired = wiredPins(input);
  const group = wireGroups(input);
  const found = new Map<string, GpioOverVoltage>();

  // What drives each wire group from a supply or another board's pin.
  const drives = new Map<string, Drive[]>();
  const addDrive = (key: string, d: Drive) => {
    const g = group(key);
    const list = drives.get(g);
    if (list) list.push(d);
    else drives.set(g, [d]);
  };
  for (const board of input.boards) {
    const pins = wired.get(board.id);
    if (!pins) continue;
    for (const pin of pins) {
      if (board.vccPinNames?.includes(pin)) {
        addDrive(`${board.id}:${pin}`, { volts: board.vcc, what: `${pin} of ${board.id}`, link: false });
      } else if (board.auxVolts !== undefined && board.auxPinNames?.includes(pin)) {
        addDrive(`${board.id}:${pin}`, { volts: board.auxVolts, what: `${pin} of ${board.id}`, link: false });
      } else if (gpioInputLimit(board) === null && isGpio(board, pin) && canDrive(board, pin)) {
        addDrive(`${board.id}:${pin}`, {
          volts: board.vcc,
          what: `pin ${pin} of ${board.id}, a ${volts(board.vcc)} board`,
          link: true,
        });
      }
    }
  }
  for (const comp of input.components) {
    const info = sourceVolts(comp);
    const pins = wired.get(comp.id);
    if (!info || !pins) continue;
    for (const pin of info.posPins) {
      if (pins.has(pin)) addDrive(`${comp.id}:${pin}`, { volts: info.volts, what: `the ${pin} of ${comp.id}`, link: false });
    }
  }

  // ── The wiring ──────────────────────────────────────────────────────────
  for (const { board, limit } of limited) {
    for (const pin of wired.get(board.id) ?? []) {
      if (!isGpio(board, pin)) continue;
      const over = (drives.get(group(`${board.id}:${pin}`)) ?? []).filter((d) => d.volts > limit.volts);
      if (over.length === 0) continue;
      const worst = over.reduce((a, b) => (b.volts > a.volts || (b.volts === a.volts && a.link && !b.link) ? b : a));
      const pad = padName(pin);
      found.set(`${board.id}:${pin}`, {
        boardId: board.id,
        pinName: pin,
        volts: worst.volts,
        message: worst.link
          ? `${limit.label} ${board.id}'s ${pad} is wired to ${worst.what}: when that pin drives HIGH it puts ${volts(worst.volts)} on ${pad}, above the ${volts(limit.volts)} an ${limit.label} pin takes (VDD + 0.3 V). Put a level shifter or a divider (for example 1 kΩ over 2 kΩ) between them.`
          : `${limit.label} ${board.id}'s ${pad} is wired to ${worst.what} (${volts(worst.volts)}) — above the ${volts(limit.volts)} an ${limit.label} pin takes (VDD + 0.3 V). Real hardware would likely be damaged; this voltage is not emulated accurately. Use a level shifter or a voltage divider.`,
      });
    }
  }

  // ── A solve with no pad driven ──────────────────────────────────────────
  const mixedSupplies = new Set(input.boards.map((b) => b.vcc)).size > 1;
  const lowest = Math.min(...limited.map((x) => x.limit.volts));
  const anyHighSupply = [...drives.values()].some((list) => list.some((d) => !d.link && d.volts > lowest));
  if (!mixedSupplies && anyHighSupply) {
    const quiet: BuildNetlistInput = {
      ...input,
      boards: input.boards.map((b) => ({ ...b, pins: {} })),
      analysis: { kind: 'op' },
    };
    let nodeVoltages: Record<string, number> | null = null;
    let pinNetMap: Map<string, string> | null = null;
    try {
      const built = buildNetlist(quiet);
      pinNetMap = built.pinNetMap;
      nodeVoltages = await solve(built.netlist);
    } catch {
      nodeVoltages = null;
    }
    if (nodeVoltages && pinNetMap) {
      for (const { board, limit } of limited) {
        for (const pin of wired.get(board.id) ?? []) {
          const key = `${board.id}:${pin}`;
          if (found.has(key) || !isGpio(board, pin)) continue;
          const net = pinNetMap.get(key);
          if (net === undefined || net === '0') continue;
          const v = nodeVoltages[net];
          if (v === undefined || !Number.isFinite(v) || v <= limit.volts + 0.01) continue;
          const pad = padName(pin);
          found.set(key, {
            boardId: board.id,
            pinName: pin,
            volts: v,
            message: `The circuit holds ${limit.label} ${board.id}'s ${pad} at ${volts(v)} — above the ${volts(limit.volts)} an ${limit.label} pin takes (VDD + 0.3 V). Real hardware would likely be damaged; this voltage is not emulated accurately. Use a level shifter or a voltage divider.`,
          });
        }
      }
    }
  }
  return [...found.values()];
}
