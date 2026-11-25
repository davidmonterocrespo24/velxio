/**
 * The pads a board INSTANCE actually has, and the pin number each one carries.
 *
 * The oscilloscope's channel picker used to answer this from a switch over
 * BoardKind. A table like that is wrong the day a board is added, and silently
 * wrong for every family it does not list: they all fell through to the Uno's
 * D0-D13 / A0-A5, so an STM32's PA0, an RP2350's GP15 and a XIAO's pads were
 * never offered at all — and the "D2" it did offer on a XIAO keyed the channel
 * on Arduino pin 2 while that pad is chip pin 10, which draws a flat line on a
 * pin that is moving. A wrong trace is worse than no trace.
 *
 * Both halves of the answer already exist in the app, so this asks them rather
 * than restating them:
 *
 *   - WHICH pads: the board's custom element publishes `pinInfo` — the same
 *     list the canvas mounts its pin overlays from and wires connect through.
 *   - WHAT NUMBER each pad carries: `pinNameToArduinoPin`, the one mapping the
 *     netlist, the MCU-edge listeners and the wire probe already key on, and
 *     therefore the number a simulator reports through `onPinChangeWithTime`.
 *
 * A board an overlay registers tomorrow is listed correctly with nothing to
 * update here.
 */
import type { BoardKind } from '../types/board';
import { pinNameToArduinoPin } from './spice/collectPinStates';

export interface BoardPad {
  /** Pin number, as PinManager and onPinChangeWithTime report it. */
  pin: number;
  /** What the board's silkscreen calls that pad. */
  label: string;
}

/** A pinInfo entry, as @wokwi/elements and the Velxio board elements publish it. */
interface PinInfoEntry {
  name?: unknown;
  x?: unknown;
  y?: unknown;
}

/**
 * A pad can be published under more than one name: a XIAO lists both its chip
 * pin and its silkscreen name for the same hole ("10" and "D2"), at the SAME
 * coordinates. Position is what makes them one pad, so that is what groups
 * them — names alone cannot say it.
 */
function padKey(entry: PinInfoEntry): string {
  return `${entry.x},${entry.y}`;
}

/** Between two names for one pad, the one a human reads off the board wins. */
function friendlier(candidate: string, held: string): boolean {
  const silkscreen = (s: string) => (/[A-Za-z]/.test(s) ? 1 : 0);
  return silkscreen(candidate) > silkscreen(held);
}

/**
 * Between two pads that carry the same pin, likewise. An element tells a
 * repeated name apart with a '.N' suffix (the Uno's SDA/SCL pads beside AREF
 * are 'A4.2' and 'A5.2', listed before the analog header's A4 and A5), and
 * nobody reads 'A4.2' off a board: a name without that suffix wins.
 * Otherwise the pad the element lists first keeps the label.
 */
function friendlierPad(candidate: string, held: string): boolean {
  const copy = (s: string) => (/\.\d+$/.test(s) ? 1 : 0);
  return copy(candidate) < copy(held);
}

/**
 * Monitorable pads of the board rendered as `boardId`, or an empty list when
 * its element is not mounted (the caller then falls back to whatever it knows).
 * Power and ground pads are left out: `pinNameToArduinoPin` reports them as -1.
 */
export function boardPads(boardId: string, boardKind: BoardKind): BoardPad[] {
  if (typeof document === 'undefined') return [];
  const el = document.getElementById(boardId) as
    | (HTMLElement & { pinInfo?: PinInfoEntry[] })
    | null;
  const info = el?.pinInfo;
  if (!Array.isArray(info)) return [];

  const pads = new Map<string, { pin: number; label: string }>();
  for (const entry of info) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    const key = padKey(entry);
    const held = pads.get(key);
    const pin = pinNameToArduinoPin(name, boardKind);
    // One alias of a pad may resolve while the other does not (a XIAO's "10"
    // resolves, its "D2" does not); keep the number from whichever answers and
    // the label from whichever reads best.
    if (held) {
      if (held.pin < 0 && pin >= 0) held.pin = pin;
      if (friendlier(name, held.label)) held.label = name;
      continue;
    }
    pads.set(key, { pin, label: name });
  }

  // One entry per pin: a pin broken out on two pads is one channel.
  const byPin = new Map<number, string>();
  for (const { pin, label } of pads.values()) {
    if (pin < 0) continue; // a rail, or a pad this family does not number
    const held = byPin.get(pin);
    if (held === undefined || friendlierPad(label, held)) byPin.set(pin, label);
  }
  return [...byPin].map(([pin, label]) => ({ pin, label })).sort(bySilkscreen);
}

/**
 * Read in the order the board is printed in, not in pin-number order: a XIAO's
 * pads run D0..D10 while its pin numbers jump around, and a user looking for
 * D5 scans the silkscreen. Same rule keeps an Uno's 0..13 ahead of its A0..A5
 * and groups an STM32 by port.
 */
function bySilkscreen(a: BoardPad, b: BoardPad): number {
  const parse = (label: string) => {
    const m = label.match(/^(\D*)(\d+)/);
    return m ? { prefix: m[1], index: Number(m[2]) } : { prefix: label, index: Number.NaN };
  };
  const pa = parse(a.label);
  const pb = parse(b.label);
  if (pa.prefix !== pb.prefix) return pa.prefix.localeCompare(pb.prefix);
  if (Number.isNaN(pa.index) || Number.isNaN(pb.index)) return a.label.localeCompare(b.label);
  return pa.index - pb.index || a.pin - b.pin;
}
