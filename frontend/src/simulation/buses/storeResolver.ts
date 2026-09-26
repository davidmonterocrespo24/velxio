/**
 * The NetResolver the app uses: the circuit as the store holds it, walked with
 * the same trace every part already uses (PinTrace), so the fabric and the
 * parts can never disagree about where a wire goes.
 */

import { traceBoardGpio, traceDetailed, type TraceState } from '../PinTrace';
import { SYNTHETIC_CHIP_PIN_BASE } from '../customChips/syntheticPins';
import { boardPinToNumber } from '../../utils/boardPinMapping';
import type { NetResolver, PinRef, ResolvedPin } from './types';

/** Ground or supply, from a board pad name. Anything else (RESET, EN) is neither. */
export function railOf(padName: string | undefined): 'gnd' | 'vcc' | null {
  if (!padName) return null;
  const n = padName.toUpperCase().replace(/[\s_.-]/g, '');
  if (/^(GND|VSS|AGND|DGND|PGND|G)\d*$/.test(n) || n.includes('GND')) return 'gnd';
  if (/(VCC|VDD|3V3|33V|5V|VIN|VBUS|VUSB|VSYS|VBAT|IOREF|VREF|AREF|3V|VDDIO)/.test(n)) return 'vcc';
  return null;
}

/** The far endpoint of every wire that lands on board pad `pin` of `boardId`. */
function padEndpoints(
  state: TraceState,
  boardId: string,
  pin: number,
): Array<{ componentId: string; pinName: string }> {
  const kind = state.boards.find((b) => b.id === boardId)?.boardKind;
  if (!kind) return [];
  const out: Array<{ componentId: string; pinName: string }> = [];
  for (const w of state.wires) {
    for (const [self, other] of [
      [w.start, w.end],
      [w.end, w.start],
    ] as const) {
      if (self.componentId !== boardId || boardPinToNumber(kind, self.pinName) !== pin) continue;
      out.push({ componentId: other.componentId, pinName: other.pinName });
    }
  }
  return out;
}

export function createStoreNetResolver(getState: () => TraceState): NetResolver {
  return {
    resolve(ref: PinRef): ResolvedPin {
      if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
      const state = getState();
      const hit = traceDetailed(state, ref.componentId, ref.pinName, 0);
      const pin = hit.arduinoPin;
      if (pin === null) return { kind: 'floating' };
      if (pin < 0) {
        const rail = railOf(hit.railName);
        return rail ? { kind: 'rail', rail } : { kind: 'floating' };
      }
      if (pin >= SYNTHETIC_CHIP_PIN_BASE) return { kind: 'chip', boardId: hit.boardId ?? null, pin };
      if (!hit.boardId) return { kind: 'floating' };
      return { kind: 'board', boardId: hit.boardId, pin };
    },
    resolveAll(ref: PinRef): ResolvedPin[] {
      if (ref.kind === 'board') return [{ kind: 'board', boardId: ref.boardId, pin: ref.pin }];
      const state = getState();
      const found = new Map<string, number>();
      const queue: Array<{ boardId: string; pin: number }> = [];
      const add = (boardId: string, pin: number): void => {
        if (found.has(boardId)) return;
        found.set(boardId, pin);
        queue.push({ boardId, pin });
      };
      // The trace answers for ONE board per walk and prefers the one it is
      // asked about, so a net that reaches two boards' pads is asked once per
      // board. A net that reaches none of them is floating, a rail or a chip
      // net: `resolve` says which, and there is nothing to place on.
      for (const b of state.boards) {
        const pin = traceBoardGpio(state, ref.componentId, ref.pinName, b.id);
        if (pin !== null) add(b.id, pin);
      }
      // A board pad ends a trace (the pad is what drives the node), so a wire
      // from that pad to ANOTHER board's pad, directly or through a breadboard
      // or a passive, is walked from here: that wire is the same net on the
      // bench, and it is how two boards share an I2C bus.
      while (queue.length) {
        const from = queue.shift()!;
        for (const ep of padEndpoints(state, from.boardId, from.pin)) {
          const board = state.boards.find((b) => b.id === ep.componentId);
          if (board) {
            const pin = boardPinToNumber(board.boardKind, ep.pinName);
            if (pin !== null && pin >= 0 && pin < SYNTHETIC_CHIP_PIN_BASE) add(board.id, pin);
            continue;
          }
          for (const b of state.boards) {
            if (found.has(b.id)) continue;
            const pin = traceBoardGpio(state, ep.componentId, ep.pinName, b.id);
            if (pin !== null) add(b.id, pin);
          }
        }
      }
      return Array.from(found, ([boardId, pin]) => ({ kind: 'board', boardId, pin }));
    },
    boardKind(boardId: string): string | undefined {
      return getState().boards.find((b) => b.id === boardId)?.boardKind;
    },
    boards(): string[] {
      return getState().boards.map((b) => b.id);
    },
  };
}
