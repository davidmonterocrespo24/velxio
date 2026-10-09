/**
 * start.ts — production wiring for the mixed-mode simulator.
 *
 * The single function `startSimulation()` mounts everything the
 * editor needs to run circuits end-to-end against the WASM ngspice:
 *
 *   1. CircuitSimulationService — orchestrates solves, publishes to
 *      useElectricalStore.
 *   2. connectAnalogInputsToMcu — subscribes to useElectricalStore
 *      and pushes voltages into MCU ADCs.
 *   3. connectMcuEdgesToService — MCU pin transitions trigger
 *      scheduler.alterSource + republish via the service.
 *
 * Replaces the old EditorPage useEffect that chained the legacy
 * wireElectricalSolver + connectLegacySolverToMixedMode +
 * connectMixedModeSchedulerToStore + connectAnalogInputsToMcu.
 *
 * Phase 1c step G1 of the mixed-mode migration.
 */
import { useSimulatorStore, getBoardPinManager } from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import {
  getMixedModeScheduler,
} from './MixedModeScheduler';
import {
  CircuitSimulationService,
  type SimulatorStorePort,
  type ElectricalStorePort,
  type MixedModeSchedulerPort,
  type ElectricalSnapshot,
} from './CircuitSimulationService';
import { connectAnalogInputsToMcu } from './connectAnalogInputsToMcu';
import { connectDigitalInputsToMcu } from './connectDigitalInputsToMcu';
import { connectChipInputsToSolve } from './connectChipInputsToSolve';
import { connectMcuEdgesToService } from './connectMcuEdgesToService';
import { setElectricalResolveHook } from './electricalResolveHook';
import { startAnalogScopeFeed } from './analogScopeFeed';
import { pickSolverError, startSolverFaultReporter } from './solverFaultReporter';
import { collectPinStates } from './collectPinStates';

/** Adapt useElectricalStore to the ElectricalStorePort. */
function createElectricalStorePort(): ElectricalStorePort {
  return {
    publish(snapshot: ElectricalSnapshot): void {
      useElectricalStore.getState().setSolveResult({
        nodeVoltages: snapshot.nodeVoltages,
        branchCurrents: snapshot.branchCurrents,
        pinNetMap: snapshot.pinNetMap,
        analysisMode: snapshot.analysisMode,
        timeWaveforms: snapshot.timeWaveforms,
        converged: snapshot.warnings.length === 0,
        error: pickSolverError(snapshot.warnings),
        lastSolveMs: 0,
        submittedNetlist: '',
        sourcedNets: snapshot.sourcedNets,
      });
    },
  };
}

/**
 * Mount the simulation loop.  Returns an unsubscribe handle for
 * editor cleanup.
 */
export function startSimulation(): () => void {
  const service = new CircuitSimulationService(
    useSimulatorStore as unknown as SimulatorStorePort,
    createElectricalStorePort(),
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    {
      collectBoardPinStates: (boardId, boardKind, wires) =>
        collectPinStates(
          boardId,
          boardKind as Parameters<typeof collectPinStates>[1],
          wires as Parameters<typeof collectPinStates>[2],
        ),
    },
  );
  // Phase 1d #3 — pre-boot the WASM engine the moment the editor
  // mounts.  Without this, the first solve (typically the user's
  // first canvas edit) pays the full WASM init cost (~2-5 s) and the
  // canvas appears frozen.  By kicking init now, the Worker boots
  // while the user looks at the empty canvas; by the time they wire
  // anything, the engine is warm.
  void getMixedModeScheduler().start();

  const unsubService = service.start();
  const unsubAdc = connectAnalogInputsToMcu();
  const unsubDigitalIn = connectDigitalInputsToMcu();
  const unsubChipIn = connectChipInputsToSolve();
  const unsubEdges = connectMcuEdgesToService(service);
  // Bridge transient captures into the oscilloscope's analog channels. Costs
  // nothing until the user actually probes a wire: with no analog channel it
  // forces no transient and runs no timer.
  const unsubAnalogScope = startAnalogScopeFeed();
  // A rejected deck (singular matrix) used to leave every meter at 0 V with
  // no message anywhere; this puts the ngspice error in the output console.
  const unsubFault = startSolverFaultReporter();

  // Let custom chips / WS boards request a re-solve when they toggle an
  // output pin. Trailing-throttled: callers of this hook are PER-EDGE sites
  // (PinManager, RP2040Simulator, ChipRuntime) that can fire thousands of
  // times per second under fast toggling (multiplexed displays, bit-banged
  // protocols). The service's own inFlight coalescing only merges OVERLAPPING
  // ticks — under a sustained edge stream it still runs back-to-back full
  // rebuild+solve cycles with no idle gap, which starves the main thread.
  // One trailing tick per window keeps the last state without the storm.
  const RESOLVE_THROTTLE_MS = 33;
  let lastResolveAt = 0;
  let trailingResolve: ReturnType<typeof setTimeout> | null = null;
  setElectricalResolveHook(() => {
    const now = Date.now();
    if (now - lastResolveAt >= RESOLVE_THROTTLE_MS) {
      lastResolveAt = now;
      void service.tick();
      return;
    }
    if (trailingResolve !== null) return;
    trailingResolve = setTimeout(() => {
      trailingResolve = null;
      lastResolveAt = Date.now();
      void service.tick();
    }, RESOLVE_THROTTLE_MS - (now - lastResolveAt));
  });

  // Phase 1d #16 — debug helper. Call `__spiceDebug()` from DevTools
  // to get a snapshot of the simulation state (analysis mode, voltage
  // count, pin map, last solve time, etc.).  Useful for diagnosing
  // "why is my circuit not solving?" reports from users.
  (window as unknown as { __spiceDebug?: () => unknown }).__spiceDebug = () => {
    const electrical = useElectricalStore.getState();
    // Probe: collect every board's outputPins set so we can verify the
    // MCU-direction-tracking fix from the harness.
    const outputPinsByBoard: Record<string, number[]> = {};
    // What the deck would collect for each board right now: the pad states
    // the netlist stamps as V-sources. A board whose outputs are listed
    // above but whose collection is empty is the symptom of a pin name the
    // collector cannot map.
    const collectedByBoard: Record<string, unknown> = {};
    try {
      const { boards, wires } = useSimulatorStore.getState();
      for (const b of boards) {
        const pm = getBoardPinManager(b.id);
        if (pm && typeof pm.getOutputPins === 'function') {
          outputPinsByBoard[b.id] = [...pm.getOutputPins()];
        }
        try {
          collectedByBoard[b.id] = {
            kind: b.boardKind,
            states: collectPinStates(b.id, b.boardKind as never, wires as never),
          };
        } catch (err) {
          collectedByBoard[b.id] = { kind: b.boardKind, error: String(err) };
        }
      }
    } catch {
      // ignore — fallback already covered by snapshot fields below
    }
    const snapshot = {
      analysisMode: electrical.analysisMode,
      converged: electrical.converged,
      error: electrical.error,
      lastSolveMs: electrical.lastSolveMs,
      nodeVoltageCount: Object.keys(electrical.nodeVoltages).length,
      branchCurrentCount: Object.keys(electrical.branchCurrents).length,
      branchCurrentNames: Object.keys(electrical.branchCurrents),
      pinNetMapSize: electrical.pinNetMap.size,
      pinNetMapEntries: [...electrical.pinNetMap.entries()],
      nodeVoltages: { ...electrical.nodeVoltages },
      hasTimeWaveforms: !!electrical.timeWaveforms,
      paused: electrical.paused,
      outputPinsByBoard,
      collectedByBoard,
      rebuildCount: service.rebuildCount,
      edgeCount: service.edgeCount,
      stateSolveCount: service.stateSolveCount,
      cacheHitCount: service.cacheHitCount,
      windowCount: service.windowCount,
      lastRebuildAt: service.lastRebuildAt,
      windowStates: electrical.window?.states.map((st) => ({ weight: st.weight, ms: st.ms, levels: st.levels })),
      edgePath: service.debugState(),
    };
    (window as unknown as { __lastSpice?: unknown }).__lastSpice = snapshot;
    // eslint-disable-next-line no-console
    console.log('[__spiceDebug]', snapshot);
    return snapshot;
  };

  return () => {
    setElectricalResolveHook(null);
    unsubAnalogScope();
    unsubFault();
    if (trailingResolve !== null) {
      clearTimeout(trailingResolve);
      trailingResolve = null;
    }
    unsubService();
    unsubAdc();
    unsubDigitalIn();
    unsubChipIn();
    unsubEdges();
  };
}
