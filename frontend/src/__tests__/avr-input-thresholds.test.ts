// @vitest-environment jsdom
/**
 * A 5 V ATmega reads its inputs at its own thresholds (velxio/velxio-prod#150).
 *
 * Every board turned a solved node into digitalRead()'s answer at 2.0 V and
 * 0.8 V, holding the previous level in between. Those are the RP2040's input
 * limits at 3.3 V (RP2040 datasheet, Table 625), and wrong for an ATmega328P
 * at 5 V: it guarantees LOW up to 0.3 VCC = 1.5 V and HIGH from 0.6 VCC =
 * 3.0 V (DS40002061B, Table 30-1), and a typical part switches near 2.6 V
 * rising and 2.1 V falling, a Schmitt trigger with about 0.5 V of hysteresis
 * (Figures 31-356 to 31-358). So 0.8-1.5 V, a guaranteed LOW, was held at the
 * previous level: INPUT_PULLUP and a button with 10 kOhm in series to GND
 * sits at 0.91 V pressed, and the press was lost. And 2.0-2.6 V switched an
 * AVR input that a real one leaves LOW.
 *
 * The AVR boards now switch at their typical points; the 3.3 V boards keep
 * 2.0 / 0.8 V.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sims: Record<string, { setPinState: ReturnType<typeof vi.fn>; spiceDrivenInputs: boolean; ownsPin: () => boolean }> = {
  uno: { setPinState: vi.fn(), spiceDrivenInputs: true, ownsPin: () => false },
  pico: { setPinState: vi.fn(), spiceDrivenInputs: true, ownsPin: () => false },
};
const pinManager = { getOutputPins: () => new Set<number>() };

vi.mock('../store/useSimulatorStore', async () => {
  const boards = [
    { id: 'uno', boardKind: 'arduino-uno', vcc: 5 },
    { id: 'pico', boardKind: 'raspberry-pi-pico', vcc: 3.3 },
  ];
  return {
    useSimulatorStore: {
      getState: () => ({ boards }),
      subscribe: () => () => {},
    },
    getBoardSimulator: (id: string) => sims[id],
    getBoardPinManager: () => pinManager,
  };
});

type Listener = (state: unknown, prev: unknown) => void;
const listeners: Listener[] = [];
let electrical = {
  nodeVoltages: {} as Record<string, number>,
  pinNetMap: new Map<string, string>([
    ['uno:2', 'n_uno'],
    ['pico:GP2', 'n_pico'],
  ]),
  sourcedNets: new Set<string>(['n_uno', 'n_pico']),
};
vi.mock('../store/useElectricalStore', () => ({
  useElectricalStore: {
    getState: () => electrical,
    subscribe: (fn: Listener) => {
      listeners.push(fn);
      return () => {};
    },
  },
}));

const { connectDigitalInputsToMcu } = await import('../simulation/spice/connectDigitalInputsToMcu');

/** One connector for the whole test, so the hysteresis band can hold a level. */
function mount(): (volts: number, board?: 'uno' | 'pico') => boolean | undefined {
  listeners.length = 0;
  // The connector reads the store once as it mounts: start from no solve.
  electrical = { ...electrical, nodeVoltages: {} };
  connectDigitalInputsToMcu();
  return (volts, board = 'uno') => {
    const sim = sims[board];
    sim.setPinState.mockClear();
    const prev = electrical;
    electrical = { ...electrical, nodeVoltages: { [`n_${board}`]: volts } };
    for (const l of listeners) l(electrical, prev);
    const calls = sim.setPinState.mock.calls as Array<[number, boolean]>;
    return calls.length ? calls[calls.length - 1]![1] : undefined;
  };
}

describe('ATmega input thresholds (velxio/velxio-prod#150)', () => {
  beforeEach(() => {
    sims.uno.setPinState.mockClear();
    sims.pico.setPinState.mockClear();
  });

  it('a pressed button through 10 kOhm on INPUT_PULLUP (0.91 V) reads LOW', () => {
    const solve = mount();
    expect(solve(5)).toBe(true);
    expect(solve(0.91), '0.91 V is a guaranteed LOW at 5 V').toBe(false);
  });

  it('anything up to 1.5 V reads LOW from HIGH', () => {
    const solve = mount();
    solve(5);
    expect(solve(1.45)).toBe(false);
  });

  it('2.0-2.6 V does not lift a LOW input: it switches near 2.6 V rising', () => {
    const solve = mount();
    expect(solve(0)).toBe(false);
    expect(solve(2.3), 'inside the hysteresis band: held LOW').toBeUndefined();
    expect(solve(2.7)).toBe(true);
  });

  it('and a HIGH input holds down to about 2.1 V', () => {
    const solve = mount();
    expect(solve(5)).toBe(true);
    expect(solve(2.3), 'held HIGH').toBeUndefined();
    expect(solve(2.0)).toBe(false);
  });

  it('the 3.3 V Pico keeps its own 2.0 V / 0.8 V', () => {
    const solve = mount();
    expect(solve(3.3, 'pico')).toBe(true);
    expect(solve(1.4, 'pico'), 'held HIGH in its band').toBeUndefined();
    expect(solve(0.7, 'pico')).toBe(false);
    expect(solve(2.0, 'pico')).toBe(true);
  });
});
