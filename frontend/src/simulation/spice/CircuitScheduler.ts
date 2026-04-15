/**
 * CircuitScheduler — debounces electrical solve requests coming from UI
 * interactions (wire edits, property edits, pin changes) and dispatches
 * them to the SPICE engine.
 *
 * Design notes:
 *   - Single instance per app (module-level singleton).
 *   - `requestSolve()` is safe to call frequently; solves are rate-limited.
 *   - While a solve is in flight, further requests coalesce into a single
 *     trailing solve so we never miss the latest edit.
 *   - Exposes `onResult` hooks so the store can subscribe.
 */
import type { BuildNetlistInput, ElectricalSolveResult } from './types';
import { buildNetlist } from './NetlistBuilder';
import { runNetlist } from './SpiceEngine.lazy';

type Listener = (result: ElectricalSolveResult) => void;

interface QueuedRequest {
  input: BuildNetlistInput;
}

const DEFAULT_DEBOUNCE_MS = 50;

class CircuitScheduler {
  private pending: QueuedRequest | null = null;
  private inFlight = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  private debounceMs = DEFAULT_DEBOUNCE_MS;

  setDebounceMs(ms: number): void {
    this.debounceMs = Math.max(0, ms);
  }

  onResult(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Request a solve with the given NetlistBuilder input. Coalesces and
   * debounces. The most recent request always wins.
   */
  requestSolve(input: BuildNetlistInput): void {
    this.pending = { input };
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.drain(), this.debounceMs);
  }

  /** Force an immediate solve (bypass debounce). Returns when done. */
  async solveNow(input: BuildNetlistInput): Promise<ElectricalSolveResult> {
    this.pending = { input };
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    return this.drain();
  }

  private async drain(): Promise<ElectricalSolveResult> {
    this.debounceTimer = null;
    if (this.inFlight) {
      // Will be picked up once the in-flight solve finishes
      return this.waitForNextResult();
    }
    const req = this.pending;
    if (!req) {
      return noopResult('no pending request');
    }
    this.pending = null;
    this.inFlight = true;

    const netlist = buildNetlist(req.input);
    const t0 = performance.now();
    let result: ElectricalSolveResult;
    try {
      const cooked = await runNetlist(netlist);
      const nodeVoltages: Record<string, number> = { '0': 0 };
      for (const name of cooked.variableNames) {
        if (name.startsWith('v(')) {
          const net = name.slice(2, -1);
          const v = cooked.dcValue(name);
          if (Number.isFinite(v)) nodeVoltages[net] = v;
        }
      }
      const branchCurrents: Record<string, number> = {};
      for (const name of cooked.variableNames) {
        if (name.startsWith('i(')) {
          const src = name.slice(2, -1);
          const i = cooked.dcValue(name);
          if (Number.isFinite(i)) branchCurrents[src] = i;
        }
      }
      result = {
        nodeVoltages,
        branchCurrents,
        converged: true,
        error: null,
        solveMs: performance.now() - t0,
        submittedNetlist: netlist,
      };
    } catch (err) {
      result = {
        nodeVoltages: {},
        branchCurrents: {},
        converged: false,
        error: String(err instanceof Error ? err.message : err),
        solveMs: performance.now() - t0,
        submittedNetlist: netlist,
      };
    } finally {
      this.inFlight = false;
    }

    for (const cb of this.listeners) cb(result);

    // If new requests arrived while we were solving, drain them now.
    if (this.pending) {
      // microtask: re-run so we don't recurse synchronously
      setTimeout(() => this.drain(), 0);
    }
    return result;
  }

  private waitForNextResult(): Promise<ElectricalSolveResult> {
    return new Promise((resolve) => {
      const off = this.onResult((r) => {
        off();
        resolve(r);
      });
    });
  }
}

function noopResult(reason: string): ElectricalSolveResult {
  return {
    nodeVoltages: {},
    branchCurrents: {},
    converged: true,
    error: reason,
    solveMs: 0,
    submittedNetlist: '',
  };
}

// Module-level singleton
export const circuitScheduler = new CircuitScheduler();
