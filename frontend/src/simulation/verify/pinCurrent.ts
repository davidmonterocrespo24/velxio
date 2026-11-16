/**
 * The current each driven pin of a board carries, against what its chip
 * allows (velxio/velxio-prod#140).
 *
 * A board pin that drives a load is its source behind the pin's output
 * impedance (NetlistBuilder, BoardPinGroup.pinDrive), so the solved branch
 * current of `V_<board>_<pin>` is the pin's current. Nothing read it: pin 13
 * HIGH into 120 ohm drew 41.7 mA from an ideal pin, above the ATmega328P's
 * 40 mA absolute maximum, and a pin driven HIGH into GND got no source at all.
 * A chip's datasheet gives three limits (ATmega328P section 28.1/28.2):
 *   - the current the output levels are specified at (20 mA): above it the
 *     pin is not guaranteed to hold its level, a warning;
 *   - the absolute maximum per I/O pin (40 mA): above it the pin can be
 *     damaged, an error;
 *   - the absolute maximum through the VCC and GND pins (200 mA): the sum of
 *     the pins sourcing current, and of those sinking it, an error.
 *
 * Pure: the run's monitor (parts/runtimeBurnout) feeds it each solve. The
 * pre-flight does not, because it forces every wired pin HIGH and an input
 * closed to GND through a switch would read as a short.
 */
import { boardPinGroupFor } from '../spice/boardPinGroups';
import { sanitizeSpiceId } from '../spice/NetlistBuilder';
import type { BoardKind } from '../../types/board';

export interface PinCurrentFinding {
  boardId: string;
  /** The pin, or undefined for the chip's total through VCC or GND. */
  pinName?: string;
  /** The current, A: positive out of the pin (sourcing), negative into it (sinking). */
  amps: number;
  severity: 'warning' | 'error';
  message: string;
}

const mA = (a: number) => `${(Math.abs(a) * 1000).toFixed(1)} mA`;

/**
 * What the solved currents of the boards' driven pins break.
 *
 * `branchCurrents` is keyed by lower-case source name, the shape the solver
 * publishes; SPICE counts a branch current into the source's + node, so a pin
 * that sources current into its load reads negative.
 */
export function pinCurrentFindings(
  boards: ReadonlyArray<{ id: string; boardKind: string }>,
  branchCurrents: Readonly<Record<string, number>>,
  pinNetMap: ReadonlyMap<string, string>,
): PinCurrentFinding[] {
  const out: PinCurrentFinding[] = [];
  for (const board of boards) {
    const drive = boardPinGroupFor(board.boardKind as BoardKind).pinDrive;
    if (!drive) continue;
    const prefix = `${board.id}:`;
    let sourced = 0;
    let sunk = 0;
    for (const key of pinNetMap.keys()) {
      if (!key.startsWith(prefix)) continue;
      const pinName = key.slice(prefix.length);
      const branch = branchCurrents[`v_${sanitizeSpiceId(board.id)}_${sanitizeSpiceId(pinName)}`.toLowerCase()];
      if (branch === undefined || !Number.isFinite(branch)) continue;
      const amps = -branch;
      if (amps > 0) sourced += amps;
      else sunk -= amps;
      const size = Math.abs(amps);
      if (size <= drive.ratedA) continue;
      const way = amps > 0 ? 'sourcing' : 'sinking';
      out.push(
        size > drive.absMaxA
          ? {
              boardId: board.id,
              pinName,
              amps,
              severity: 'error',
              message:
                `Pin ${pinName} of ${board.id} is ${way} ${mA(amps)}, above the ${drive.chip}'s ` +
                `${mA(drive.absMaxA)} absolute maximum per I/O pin: on a real board the pin can be ` +
                `damaged. Add a series resistor, or drive the load through a transistor.`,
            }
          : {
              boardId: board.id,
              pinName,
              amps,
              severity: 'warning',
              message:
                `Pin ${pinName} of ${board.id} is ${way} ${mA(amps)}, more than the ${mA(drive.ratedA)} ` +
                `the ${drive.chip}'s output levels are specified at: the pin sags (its output ` +
                `resistance is about ${drive.ohms} ohms) and runs above its rated current. A larger ` +
                `series resistor keeps it below ${mA(drive.ratedA)}.`,
            },
      );
    }
    for (const [total, rail] of [
      [sourced, 'VCC'],
      [sunk, 'GND'],
    ] as const) {
      if (total <= drive.supplyMaxA) continue;
      out.push({
        boardId: board.id,
        amps: rail === 'VCC' ? total : -total,
        severity: 'error',
        message:
          `The pins of ${board.id} are ${rail === 'VCC' ? 'sourcing' : 'sinking'} ${mA(total)} in total, ` +
          `above the ${mA(drive.supplyMaxA)} the ${drive.chip}'s ${rail} pins may carry. Drive some of ` +
          `the loads through transistors.`,
      });
    }
  }
  return out;
}
