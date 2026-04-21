/**
 * logic-gate-parts.test.ts
 *
 * Tests simulation logic for all six logic gate components:
 *   AND, NAND, OR, NOR, XOR, NOT
 *
 * Each gate is tested against its full truth table and for no-pin fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';

// Side-effect import — registers logic gates
import '../simulation/parts/LogicGateParts';

// ─── Globals ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  let raf = 0;
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => ++raf);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

// ─── Mock factories ───────────────────────────────────────────────────────────

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

/** Pin map helper — resolves named pins to numbers */
const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

/** Simulate changing a pin by invoking the recorded onPinChange callback */
function firePin(sim: ReturnType<typeof makeSimulator>, callIndex: number, state: boolean) {
  const cb = sim.pinManager.onPinChange.mock.calls[callIndex][1] as (
    pin: number,
    state: boolean,
  ) => void;
  const pin = sim.pinManager.onPinChange.mock.calls[callIndex][0] as number;
  cb(pin, state);
}

// ─── Registration ─────────────────────────────────────────────────────────────

describe('Logic-gate parts — registration', () => {
  const GATE_IDS = [
    'logic-gate-and',
    'logic-gate-nand',
    'logic-gate-or',
    'logic-gate-nor',
    'logic-gate-xor',
    'logic-gate-not',
  ];

  it('registers all six gate types', () => {
    for (const id of GATE_IDS) {
      expect(PartSimulationRegistry.get(id), `missing: ${id}`).toBeDefined();
    }
  });
});

// ─── AND gate ─────────────────────────────────────────────────────────────────

describe('logic-gate-and — truth table', () => {
  it('starts LOW (0,0 → 0)', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-and')!;
    logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, B: 2, Y: 3 }));
    // Initial call sets Y LOW (false AND false)
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, false);
  });

  it('1,0 → 0', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-and')!;
    logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, B: 2, Y: 3 }));
    firePin(sim, 0, true); // A = 1
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, false);
  });

  it('0,1 → 0', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-and')!;
    logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, B: 2, Y: 3 }));
    firePin(sim, 1, true); // B = 1
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, false);
  });

  it('1,1 → 1', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-and')!;
    logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, B: 2, Y: 3 }));
    firePin(sim, 0, true); // A = 1
    firePin(sim, 1, true); // B = 1
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, true);
  });

  it('returns cleanup function that unsubscribes both pins', () => {
    const sim = makeSimulator();
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    sim.pinManager.onPinChange.mockReturnValueOnce(unsub1).mockReturnValueOnce(unsub2);
    const logic = PartSimulationRegistry.get('logic-gate-and')!;
    const cleanup = logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, B: 2, Y: 3 }));
    cleanup();
    expect(unsub1).toHaveBeenCalled();
    expect(unsub2).toHaveBeenCalled();
  });

  it('no-pin fallback returns no-op', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-and')!;
    const cleanup = logic.attachEvents(makeElement(), sim as any, () => null);
    expect(sim.setPinState).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });
});

// ─── NAND gate ────────────────────────────────────────────────────────────────

describe('logic-gate-nand — truth table', () => {
  function attach() {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-nand')!;
    logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, B: 2, Y: 3 }));
    return sim;
  }

  it('0,0 → 1', () => {
    const sim = attach();
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, true);
  });

  it('1,0 → 1', () => {
    const sim = attach();
    firePin(sim, 0, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, true);
  });

  it('1,1 → 0', () => {
    const sim = attach();
    firePin(sim, 0, true);
    firePin(sim, 1, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, false);
  });
});

// ─── OR gate ──────────────────────────────────────────────────────────────────

describe('logic-gate-or — truth table', () => {
  function attach() {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-or')!;
    logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, B: 2, Y: 3 }));
    return sim;
  }

  it('0,0 → 0', () => {
    const sim = attach();
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, false);
  });

  it('1,0 → 1', () => {
    const sim = attach();
    firePin(sim, 0, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, true);
  });

  it('0,1 → 1', () => {
    const sim = attach();
    firePin(sim, 1, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, true);
  });

  it('1,1 → 1', () => {
    const sim = attach();
    firePin(sim, 0, true);
    firePin(sim, 1, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, true);
  });
});

// ─── NOR gate ─────────────────────────────────────────────────────────────────

describe('logic-gate-nor — truth table', () => {
  function attach() {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-nor')!;
    logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, B: 2, Y: 3 }));
    return sim;
  }

  it('0,0 → 1', () => {
    const sim = attach();
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, true);
  });

  it('1,0 → 0', () => {
    const sim = attach();
    firePin(sim, 0, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, false);
  });

  it('1,1 → 0', () => {
    const sim = attach();
    firePin(sim, 0, true);
    firePin(sim, 1, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, false);
  });
});

// ─── XOR gate ─────────────────────────────────────────────────────────────────

describe('logic-gate-xor — truth table', () => {
  function attach() {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-xor')!;
    logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, B: 2, Y: 3 }));
    return sim;
  }

  it('0,0 → 0', () => {
    const sim = attach();
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, false);
  });

  it('1,0 → 1', () => {
    const sim = attach();
    firePin(sim, 0, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, true);
  });

  it('0,1 → 1', () => {
    const sim = attach();
    firePin(sim, 1, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, true);
  });

  it('1,1 → 0', () => {
    const sim = attach();
    firePin(sim, 0, true);
    firePin(sim, 1, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(3, false);
  });
});

// ─── NOT gate ─────────────────────────────────────────────────────────────────

describe('logic-gate-not — truth table', () => {
  it('initial state: A=0 → Y=1', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-not')!;
    logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, Y: 2 }));
    expect(sim.setPinState).toHaveBeenCalledWith(2, true);
  });

  it('A=1 → Y=0', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-not')!;
    logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, Y: 2 }));
    firePin(sim, 0, true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(2, false);
  });

  it('A=0 → Y=1 (after toggle)', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-not')!;
    logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, Y: 2 }));
    firePin(sim, 0, true);
    firePin(sim, 0, false);
    expect(sim.setPinState).toHaveBeenLastCalledWith(2, true);
  });

  it('returns cleanup that unsubscribes A pin', () => {
    const sim = makeSimulator();
    const unsub = vi.fn();
    sim.pinManager.onPinChange.mockReturnValueOnce(unsub);
    const logic = PartSimulationRegistry.get('logic-gate-not')!;
    const cleanup = logic.attachEvents(makeElement(), sim as any, pinMap({ A: 1, Y: 2 }));
    cleanup();
    expect(unsub).toHaveBeenCalled();
  });

  it('no-pin fallback returns no-op', () => {
    const sim = makeSimulator();
    const logic = PartSimulationRegistry.get('logic-gate-not')!;
    const cleanup = logic.attachEvents(makeElement(), sim as any, () => null);
    expect(sim.setPinState).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });
});
