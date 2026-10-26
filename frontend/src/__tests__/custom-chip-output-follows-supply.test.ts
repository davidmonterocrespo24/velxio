/**
 * A custom chip's HIGH output drives its own supply voltage, as a CMOS part
 * does, not a fixed 5 V.
 *
 * User report, 2026-10-23: a 74HC595 on an ESP32-C6 (3.3 V) drove a 5 V relay
 * coil, and the circuit solve put 5 V on it because every chip output was a
 * 5 V source. On the real board the '595 runs from 3V3 and the coil stays
 * released. The chip used here is the chipbus fixture that drives 0xA5 on
 * D0..D7 at setup; its pads go on the solve through the electrical store.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PinManager } from '../simulation/PinManager';
import { ChipInstance } from '../simulation/customChips/ChipRuntime';
import { getChipDrivenPins, clearChipDrives } from '../simulation/customChips/chipPinDrives';
import { syntheticChipPin } from '../simulation/customChips/syntheticPins';
import { useElectricalStore } from '../store/useElectricalStore';

const wasmPath = fileURLToPath(new URL('./fixtures/chipbus/bus-driver.wasm', import.meta.url));
const CHIP = 'drv';
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function publish(nodeVoltages: Record<string, number>, pins: Record<string, string>) {
  useElectricalStore.setState({
    nodeVoltages,
    pinNetMap: new Map(Object.entries(pins).map(([pad, net]) => [`${CHIP}:${pad}`, net])),
  } as never);
}

/** D0 carries bit 0 of 0xA5 (HIGH), D1 bit 1 (LOW). */
const level = (pin: string) => getChipDrivenPins(CHIP).find((d) => d.pin === pin)?.voltage;

describe.skipIf(!existsSync(wasmPath))('custom-chip output level', () => {
  beforeEach(() => {
    clearChipDrives(CHIP);
    useElectricalStore.setState({ nodeVoltages: {}, pinNetMap: new Map() } as never);
  });

  async function startChip() {
    const wires = new Map<string, number>(range(8).map((i) => [`D${i}`, syntheticChipPin(CHIP, `D${i}`)]));
    const chip = await ChipInstance.create({
      wasm: new Uint8Array(readFileSync(wasmPath)),
      componentId: CHIP,
      pinManager: new PinManager(),
      wires,
    });
    chip.start();
    return chip;
  }

  it('drives the voltage the solve puts on its VCC pad', async () => {
    publish({ vcc_rail: 3.3 }, { VCC: 'vcc_rail' });
    const chip = await startChip();
    expect(level('D0')).toBe(3.3);
    expect(level('D1')).toBe(0);
    chip.dispose();
  });

  it('follows the supply when a later solve moves it', async () => {
    // Setup runs before the first solve: no supply known yet.
    const chip = await startChip();
    expect(level('D0')).toBe(5);
    publish({ vcc_rail: 3.3000000000000003 }, { VCC: 'vcc_rail' });
    expect(level('D0')).toBe(3.3);
    chip.dispose();
  });

  it('with no supply pad wired, drives the board logic rail', async () => {
    publish({ vcc_rail: 3.3 }, {});
    const chip = await startChip();
    expect(level('D0')).toBe(3.3);
    chip.dispose();
  });
});
