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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/CustomChipPart';
import { ChipInstance } from '../simulation/customChips';
import type { ChipInstanceOptions } from '../simulation/customChips/ChipRuntime';
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
    let unwired: ReadonlySet<string> | undefined;
    vi.spyOn(ChipInstance, 'create').mockImplementation(async (opts: ChipInstanceOptions) => {
      captured = opts.wires ?? null;
      unwired = opts.unwired;
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
    // A key is no wire: the runtime is told which pads nothing reaches, so
    // vx_pin_wired keeps answering 0 for DS. The rail pad IS wired.
    expect([...(unwired ?? [])]).toEqual(['DS']);
    detach?.();
  });
});

describe('vx_pin_wired on a pad that only has its synthetic key', () => {
  const WASM = new Uint8Array(
    readFileSync(
      fileURLToPath(
        new URL('./board-buses/fixtures/chips-abi-parity/abi-probe.wasm', import.meta.url),
      ),
    ),
  );
  /** The probe's pin index for AIN (abi-probe.c: P_AIN). */
  const P_AIN = 5;

  async function probe(unwired?: ReadonlySet<string>): Promise<number> {
    const chip = await ChipInstance.create({
      wasm: WASM,
      componentId: 'probe-wired',
      pinManager: new PinManager(),
      wires: new Map([['AIN', syntheticChipPin('probe-wired', 'AIN')]]),
      unwired,
      attrs: new Map(),
      strAttrs: new Map(),
      log: () => {},
    });
    chip.start();
    const fn = (chip as unknown as { exports: Record<string, (n: number) => number> }).exports
      .pin_wired;
    const wired = fn(P_AIN);
    chip.dispose();
    return wired;
  }

  // Since every pad got a key (the rail fix above), the key alone answered 1
  // for a pad in the air, and a model whose UI control stands in for a
  // missing wire never let the control take over.
  it('answers 0 for a pad no wire reaches, 1 once it is on a net', async () => {
    expect(await probe(new Set(['AIN']))).toBe(0);
    expect(await probe()).toBe(1);
  });
});
