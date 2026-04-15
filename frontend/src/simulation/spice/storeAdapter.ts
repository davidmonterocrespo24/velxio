/**
 * Bridge between Velxio's simulator store (components, wires, boards) and
 * the NetlistBuilder inputs. Kept separate so the SPICE engine never has
 * to import the full Zustand store or its types.
 *
 * Callers construct a `BuildNetlistInput` by calling
 *   `buildInputFromStore(storeSnapshot)`
 */
import type { BuildNetlistInput, BoardForSpice, ComponentForSpice, WireForSpice, PinSourceState } from './types';
import type { Wire } from '../../types/wire';
import type { BoardKind } from '../../types/board';
import { BOARD_PIN_GROUPS } from './boardPinGroups';

export interface StoreSnapshot {
  components: Array<{
    id: string;
    metadataId: string;
    properties: Record<string, unknown>;
  }>;
  wires: Wire[];
  boards: Array<{
    id: string;
    boardKind: BoardKind;
    pinStates: Record<string, PinSourceState>; // caller pre-populates from PinManager + PWM
  }>;
}

/**
 * Convert a Velxio store snapshot into the `BuildNetlistInput` consumed
 * by the NetlistBuilder.
 */
export function buildInputFromStore(snap: StoreSnapshot): BuildNetlistInput {
  const components: ComponentForSpice[] = snap.components.map((c) => ({
    id: c.id,
    metadataId: c.metadataId,
    properties: c.properties,
  }));

  const wires: WireForSpice[] = snap.wires.map((w) => ({
    id: w.id,
    start: { componentId: w.start.componentId, pinName: w.start.pinName },
    end: { componentId: w.end.componentId, pinName: w.end.pinName },
  }));

  const boards: BoardForSpice[] = snap.boards.map((b) => {
    const group = BOARD_PIN_GROUPS[b.boardKind] ?? BOARD_PIN_GROUPS.default;
    return {
      id: b.id,
      vcc: group.vcc,
      pins: b.pinStates,
      groundPinNames: group.gnd,
      vccPinNames: group.vcc_pins,
    };
  });

  return {
    components,
    wires,
    boards,
    analysis: { kind: 'op' },
  };
}
