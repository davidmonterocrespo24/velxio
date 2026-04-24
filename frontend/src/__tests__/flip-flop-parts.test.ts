/**
 * flip-flop-parts.test.ts
 *
 * Tests edge-triggered flip-flop simulation logic (fase 10.4):
 *   flip-flop-d   — Q ← D on rising CLK
 *   flip-flop-t   — Q ← Q ⊕ T on rising CLK
 *   flip-flop-jk  — JK truth table (hold / set / reset / toggle)
 *
 * These components are digital-sim only (no SPICE mapper) because edge
 * detection is not representable in ngspice .op analysis.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Barrel import seeds built-in parts into PartSimulationRegistry via
// `registerCoreParts()` (see CORE-002c-step2). Direct imports from
// `./PartSimulationRegistry` would see an empty registry.
import { PartSimulationRegistry } from '../simulation/parts';

beforeEach(() => {
  let raf = 0;
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => ++raf);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function makeElement(): HTMLElement {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLElement;
}

function makeSimulator() {
  const pinManager = {
    onPinChange: vi.fn().mockReturnValue(() => {}),
    triggerPinChange: vi.fn(),
  };
  return {
    pinManager,
    setPinState: vi.fn(),
    cpu: { data: new Uint8Array(512).fill(0), cycles: 0 },
  };
}

const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

/**
 * Drive the callback for the pin registered at `onPinChange.mock.calls[callIndex]`.
 */
function firePin(sim: ReturnType<typeof makeSimulator>, callIndex: number, state: boolean) {
  const [pin, cb] = sim.pinManager.onPinChange.mock.calls[callIndex];
  (cb as (p: number, s: boolean) => void)(pin as number, state);
}

describe('flip-flop parts — registration', () => {
  it('registers D, T, JK flip-flops', () => {
    for (const id of ['flip-flop-d', 'flip-flop-t', 'flip-flop-jk']) {
      expect(PartSimulationRegistry.get(id), `missing: ${id}`).toBeDefined();
    }
  });
});

describe('flip-flop-d', () => {
  it('initial state: Q = 0, Qbar = 1', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('flip-flop-d')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ CLK: 1, D: 2, Q: 3, Qbar: 4 }), 'ff1');
    expect(sim.setPinState).toHaveBeenCalledWith(3, false);
    expect(sim.setPinState).toHaveBeenCalledWith(4, true);
  });

  it('Q samples D on rising CLK edge (D=1 → Q=1)', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('flip-flop-d')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ CLK: 1, D: 2, Q: 3, Qbar: 4 }), 'ff1');
    // onPinChange calls: 0=CLK, 1=D
    firePin(sim, 1, true); // D goes HIGH (no clock edge yet)
    // Q should not have changed — only setPinState calls are initial ones
    const callCountBeforeEdge = sim.setPinState.mock.calls.length;
    firePin(sim, 0, true); // CLK rising edge
    // Now Q should be sampled to D=1
    expect(sim.setPinState.mock.calls.length).toBeGreaterThan(callCountBeforeEdge);
    expect(sim.setPinState).toHaveBeenLastCalledWith(4, false); // Qbar = NOT Q = 0
  });

  it('ignores falling CLK edge', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('flip-flop-d')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ CLK: 1, D: 2, Q: 3, Qbar: 4 }), 'ff1');
    firePin(sim, 0, true); // CLK rises (initial rising edge)
    firePin(sim, 1, true); // D goes HIGH after rising
    const callCountAfterRise = sim.setPinState.mock.calls.length;
    firePin(sim, 0, false); // CLK falls — must NOT latch
    expect(sim.setPinState.mock.calls.length).toBe(callCountAfterRise);
  });
});

describe('flip-flop-t', () => {
  it('toggles Q on rising CLK when T=1', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('flip-flop-t')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ CLK: 1, T: 2, Q: 3, Qbar: 4 }), 'ff1');
    firePin(sim, 1, true); // T = HIGH
    firePin(sim, 0, true); // Rising CLK → Q toggles to 1
    expect(sim.setPinState).toHaveBeenCalledWith(3, true);
    firePin(sim, 0, false); // Falling — ignored
    firePin(sim, 0, true); // Next rising CLK → Q toggles to 0
    expect(sim.setPinState).toHaveBeenLastCalledWith(4, true); // Qbar = 1
  });

  it('holds Q on rising CLK when T=0', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('flip-flop-t')!;
    logic.attachEvents!(makeElement(), sim as any, pinMap({ CLK: 1, T: 2, Q: 3, Qbar: 4 }), 'ff1');
    // T defaults false
    firePin(sim, 0, true); // Rising CLK
    // Q should still be false (no toggle)
    expect(sim.setPinState).toHaveBeenLastCalledWith(4, true); // Qbar = 1 still
  });
});

describe('flip-flop-jk', () => {
  it('J=1, K=0 sets Q=1 on rising CLK', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('flip-flop-jk')!;
    logic.attachEvents!(
      makeElement(),
      sim as any,
      pinMap({ CLK: 1, J: 2, K: 3, Q: 4, Qbar: 5 }),
      'ff1',
    );
    // onPinChange calls: 0=CLK, 1=J, 2=K
    firePin(sim, 1, true); // J=1
    firePin(sim, 0, true); // Rising CLK
    expect(sim.setPinState).toHaveBeenCalledWith(4, true);
  });

  it('J=0, K=1 resets Q=0', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('flip-flop-jk')!;
    logic.attachEvents!(
      makeElement(),
      sim as any,
      pinMap({ CLK: 1, J: 2, K: 3, Q: 4, Qbar: 5 }),
      'ff1',
    );
    // First set Q=1 via J
    firePin(sim, 1, true);
    firePin(sim, 0, true);
    // Now reset
    firePin(sim, 1, false);
    firePin(sim, 2, true);
    firePin(sim, 0, false);
    firePin(sim, 0, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(5, true); // Qbar=1 → Q=0
  });

  it('J=1, K=1 toggles Q', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('flip-flop-jk')!;
    logic.attachEvents!(
      makeElement(),
      sim as any,
      pinMap({ CLK: 1, J: 2, K: 3, Q: 4, Qbar: 5 }),
      'ff1',
    );
    firePin(sim, 1, true); // J=1
    firePin(sim, 2, true); // K=1
    firePin(sim, 0, true); // Rising CLK → toggle 0→1
    expect(sim.setPinState).toHaveBeenCalledWith(4, true);
    firePin(sim, 0, false);
    firePin(sim, 0, true); // Next rising → toggle 1→0
    expect(sim.setPinState).toHaveBeenLastCalledWith(5, true); // Qbar=1
  });

  it('J=0, K=0 holds state', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('flip-flop-jk')!;
    logic.attachEvents!(
      makeElement(),
      sim as any,
      pinMap({ CLK: 1, J: 2, K: 3, Q: 4, Qbar: 5 }),
      'ff1',
    );
    // Set Q=1 first
    firePin(sim, 1, true);
    firePin(sim, 0, true);
    // Clear J
    firePin(sim, 1, false);
    const callsBeforeSecondClk = sim.setPinState.mock.calls.length;
    firePin(sim, 0, false);
    firePin(sim, 0, true); // Rising with J=0, K=0
    // Q should still be 1; the FF still emits the (unchanged) state → one
    // extra setPinState pair. Accept either no-op or unchanged re-emit.
    const lastQ = sim.setPinState.mock.calls
      .slice(callsBeforeSecondClk)
      .filter((c: unknown[]) => c[0] === 4)
      .pop();
    if (lastQ) expect(lastQ[1]).toBe(true);
  });
});
