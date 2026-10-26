/**
 * A custom-chip pin whose node reaches a rail only through a resistor (an
 * input with a pull-down, no board pin on it) gets its own synthetic pin.
 *
 * The trace answers "a rail" (-1) for such a pad, and the browser runtime used
 * to drop it: the pin had no key, so the chip read 0 forever, while
 * connectChipInputsToSolve published the solved level on the chip's synthetic
 * pin, which nothing read. User report, 2026-10-23: a 74HC165 reading relay
 * contacts (each NO with a 10k pull-down) never saw a relay close, while its
 * twin reading push buttons worked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/CustomChipPart';
import { ChipInstance } from '../simulation/customChips';
import { syntheticChipPin } from '../simulation/customChips/syntheticPins';
import { PinManager } from '../simulation/PinManager';
import { useSimulatorStore } from '../store/useSimulatorStore';

const CHIP = 'chip-165';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('custom-chip pin keys', () => {
  it('a pin the trace resolves to a rail reads its own synthetic pin; board pins keep theirs', async () => {
    useSimulatorStore.setState({
      components: [
        {
          id: CHIP,
          metadataId: 'custom-chip',
          x: 0,
          y: 0,
          properties: {
            // Any non-empty payload: create() is stubbed, nothing decodes it.
            wasmBase64: 'AGFzbQEAAAA=',
            chipJson: JSON.stringify({ pins: ['PL', 'D7', 'DS'] }),
          },
        },
      ],
    } as never);

    let captured: Map<string, number> | null = null;
    vi.spyOn(ChipInstance, 'create').mockImplementation(async (opts: { wires: Map<string, number> }) => {
      captured = opts.wires;
      return { start() {}, dispose() {}, tickTimers() {} } as never;
    });

    // The trace's answers: PL on board GPIO 19, D7 on a pulled-down node (the
    // RAIL sentinel), DS unwired.
    const trace: Record<string, number | null> = { PL: 19, D7: -1, DS: null };
    const sim = { pinManager: new PinManager() };
    const logic = PartSimulationRegistry.get('custom-chip')!;
    const detach = logic.attachEvents!({} as HTMLElement, sim as never, (pin: string) => trace[pin] ?? null, CHIP);
    await vi.waitFor(() => expect(captured).not.toBeNull());

    expect(captured!.get('PL')).toBe(19);
    expect(captured!.get('D7')).toBe(syntheticChipPin(CHIP, 'D7'));
    // Unwired: the synthetic pin rests LOW, which is what the missing key read.
    expect(captured!.get('DS')).toBe(syntheticChipPin(CHIP, 'DS'));
    detach?.();
  });
});
