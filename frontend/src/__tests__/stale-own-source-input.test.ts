// @vitest-environment jsdom
/**
 * A pad never reads its own source (connectDigitalInputsToMcu).
 *
 * Stop on the Grove relay example with the contact closed left the relay
 * closed and the motor at full speed, board powered off. The stop flipped
 * running:false, the service rebuilt the deck with the pad still classified
 * as an output (V-source at HIGH), the hard reset then cleared the
 * classification, and when that solve landed the connector saw an input pin
 * on a sourced net at 3.3 V and pushed the pad's own stale level back into
 * it. The deck names its sources, so the connector can tell that case from a
 * net held by a rail, a pull or another board.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sim = { setPinState: vi.fn(), spiceDrivenInputs: true, ownsPin: () => false };
const pinManager = { getOutputPins: () => new Set<number>() };

vi.mock('../store/useSimulatorStore', async () => {
  const boards = [{ id: 'xiao-esp32c6', boardKind: 'xiao-esp32c6', vcc: 3.3 }];
  return {
    useSimulatorStore: {
      getState: () => ({ boards }),
      subscribe: () => () => {},
    },
    getBoardSimulator: () => sim,
    getBoardPinManager: () => pinManager,
  };
});

const electrical = {
  nodeVoltages: {} as Record<string, number>,
  pinNetMap: new Map<string, string>([['xiao-esp32c6:2', 'n0']]),
  sourcedNets: new Set<string>(['n0']),
  voltageSources: [] as string[] | undefined,
};
vi.mock('../store/useElectricalStore', () => ({
  useElectricalStore: {
    getState: () => electrical,
    subscribe: () => () => {},
  },
}));

const { connectDigitalInputsToMcu } = await import('../simulation/spice/connectDigitalInputsToMcu');

function solve(v: number, sources: string[] | undefined): Array<[number, boolean]> {
  sim.setPinState.mockClear();
  electrical.nodeVoltages = { n0: v };
  electrical.voltageSources = sources;
  connectDigitalInputsToMcu()();
  return sim.setPinState.mock.calls as Array<[number, boolean]>;
}

describe('a pad whose net is sourced by its own stale V-source', () => {
  beforeEach(() => sim.setPinState.mockClear());

  it('is left alone: the 3.3 V on the net is what the pad itself last drove', () => {
    // The name NetlistBuilder gives a board pad's source, lower case, hyphens
    // to underscores, as the service publishes them.
    expect(solve(3.3, ['v_xiao_esp32c6_2'])).toEqual([]);
    expect(solve(0, ['v_xiao_esp32c6_2'])).toEqual([]);
  });

  it('is driven as usual once the deck was rebuilt without it', () => {
    expect(solve(3.3, ['v_vcc_rail'])).toEqual([[2, true]]);
  });

  it("is driven by another board's pad on the same net (a cross-board input)", () => {
    expect(solve(0, ['v_uno_7'])).toEqual([[2, false]]);
  });

  it('is driven when the snapshot predates the field (no source list at all)', () => {
    expect(solve(3.3, undefined)).toEqual([[2, true]]);
  });

  it('forgets the pushed level while the stale deck lasts, so the first honest solve is emitted', () => {
    solve(3.3, ['v_vcc_rail']); // pushed HIGH, remembered
    expect(solve(3.3, ['v_xiao_esp32c6_2'])).toEqual([]); // stale deck: skipped and forgotten
    // Rebuilt deck agrees with the old memory; without the forget this would
    // be deduplicated away and the guest would never hear it.
    expect(solve(3.3, ['v_vcc_rail'])).toEqual([[2, true]]);
  });
});
