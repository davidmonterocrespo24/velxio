/**
 * Hooks up the electrical solver to the main simulator store:
 *   - subscribe to components, wires, pin changes
 *   - on change, build the input and request a solve
 *   - inject node voltages back into ADC channels
 *
 * Called once at app startup (typically from EditorPage or main.tsx).
 * Returns an `unsubscribe()` for cleanup.
 */
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { buildInputFromStore } from './storeAdapter';
import type { PinSourceState } from './types';
import type { BoardKind } from '../../types/board';

// Which Arduino-style pin name maps to which ADC channel, per board.
// (Keep narrow for Phase 8.3 — extend as boards are added.)
const ADC_PIN_MAP: Partial<Record<BoardKind, Array<{ pinName: string; channel: number }>>> = {
  'arduino-uno': [
    { pinName: 'A0', channel: 0 },
    { pinName: 'A1', channel: 1 },
    { pinName: 'A2', channel: 2 },
    { pinName: 'A3', channel: 3 },
    { pinName: 'A4', channel: 4 },
    { pinName: 'A5', channel: 5 },
  ],
  'arduino-nano': [
    { pinName: 'A0', channel: 0 }, { pinName: 'A1', channel: 1 }, { pinName: 'A2', channel: 2 },
    { pinName: 'A3', channel: 3 }, { pinName: 'A4', channel: 4 }, { pinName: 'A5', channel: 5 },
    { pinName: 'A6', channel: 6 }, { pinName: 'A7', channel: 7 },
  ],
};

export function wireElectricalSolver(): () => void {
  let lastPinStates: Record<string, Record<string, PinSourceState>> = {};

  function collectPinStates(): Record<string, Record<string, PinSourceState>> {
    const boards = useSimulatorStore.getState().boards;
    const out: Record<string, Record<string, PinSourceState>> = {};
    for (const board of boards) {
      const simulator = board.simulator as unknown as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pinManager?: any;
      } | null;
      const entries: Record<string, PinSourceState> = {};
      // NOTE: Velxio's PinManager tracks state per pin number. Translating
      // number → pin name depends on board-specific maps. For Phase 8.3 we
      // emit pin states only when `pinManager.getPinState(pin)` is readable;
      // boards without that accessor simply contribute no GPIO sources
      // (their wires still participate via canonicalized ground/vcc).
      if (simulator?.pinManager?.getPinState) {
        // Best-effort: we don't yet have a canonical pin-number → pin-name
        // map for all boards here. Future work (Phase 8.4) will enrich this.
      }
      out[board.id] = entries;
    }
    return out;
  }

  function maybeSolve() {
    const { mode } = useElectricalStore.getState();
    if (mode === 'off') return;
    const storeState = useSimulatorStore.getState();
    const pinStates = collectPinStates();
    lastPinStates = pinStates;
    const snap = {
      components: storeState.components,
      wires: storeState.wires,
      boards: storeState.boards.map((b) => ({
        id: b.id,
        boardKind: b.boardKind,
        pinStates: pinStates[b.id] ?? {},
      })),
    };
    const input = buildInputFromStore(snap);
    useElectricalStore.getState().triggerSolve(input);
  }

  function injectVoltagesIntoADC() {
    const { nodeVoltages } = useElectricalStore.getState();
    const { boards } = useSimulatorStore.getState();
    for (const board of boards) {
      const map = ADC_PIN_MAP[board.boardKind];
      if (!map) continue;
      const simulator = board.simulator as unknown as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getADC?: () => { channelValues: number[] } | null;
      } | null;
      const adc = simulator?.getADC?.();
      if (!adc) continue;
      // Try to find a net matching "<boardId>_<pinName>" by string lookup
      for (const { pinName, channel } of map) {
        const probeKey = `${board.id}:${pinName}`;
        // ngspice result keys are net names from NetlistBuilder — we don't
        // yet have a direct pin→net lookup here. This is a forward-looking
        // scaffold; Phase 8.4 will add the map via storeAdapter.
        void probeKey;
        // For now: if any net name literally equals the pin label, use it.
        const v = nodeVoltages[pinName] ?? nodeVoltages[probeKey] ?? null;
        if (v != null) {
          adc.channelValues[channel] = Math.max(0, Math.min(board.boardKind.startsWith('esp32') ? 3.3 : 5, v));
        }
      }
    }
  }

  // Re-solve on components / wires / mode changes.
  const unsubSim = useSimulatorStore.subscribe((state, prev) => {
    if (state.components !== prev.components || state.wires !== prev.wires) {
      maybeSolve();
    }
  });

  const unsubMode = useElectricalStore.subscribe((state, prev) => {
    if (state.mode !== prev.mode && state.mode !== 'off') {
      maybeSolve();
    }
  });

  // On every solve result, re-inject ADC voltages.
  const unsubResult = useElectricalStore.subscribe((state, prev) => {
    if (state.nodeVoltages !== prev.nodeVoltages) {
      injectVoltagesIntoADC();
    }
  });

  return () => {
    unsubSim();
    unsubMode();
    unsubResult();
    void lastPinStates;
  };
}
