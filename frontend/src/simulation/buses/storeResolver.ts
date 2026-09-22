/**
 * The NetResolver the app uses: the circuit as the store holds it, walked with
 * the same trace every part already uses (PinTrace), so the fabric and the
 * parts can never disagree about where a wire goes.
 */

import { traceDetailed, type TraceState } from '../PinTrace';
import { SYNTHETIC_CHIP_PIN_BASE } from '../customChips/syntheticPins';
import type { NetResolver, PinRef, ResolvedPin } from './types';

/** Ground or supply, from a board pad name. Anything else (RESET, EN) is neither. */
export function railOf(padName: string | undefined): 'gnd' | 'vcc' | null {
  if (!padName) return null;
  const n = padName.toUpperCase().replace(/[\s_.-]/g, '');
  if (/^(GND|VSS|AGND|DGND|PGND|G)\d*$/.test(n) || n.includes('GND')) return 'gnd';
  if (/(VCC|VDD|3V3|33V|5V|VIN|VBUS|VUSB|VSYS|VBAT|IOREF|VREF|AREF|3V|VDDIO)/.test(n)) return 'vcc';
  return null;
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
    boardKind(boardId: string): string | undefined {
      return getState().boards.find((b) => b.id === boardId)?.boardKind;
    },
    boards(): string[] {
      return getState().boards.map((b) => b.id);
    },
  };
}
