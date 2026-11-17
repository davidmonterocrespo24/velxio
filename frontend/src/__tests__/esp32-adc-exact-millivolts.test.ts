/**
 * The pad voltage reaches the ESP32 engines unrounded (velxio/velxio-prod#171).
 *
 * The circuit solves a pad at a real voltage (a 10k/10k divider on 3.3 V is
 * 1.65 V, a pot at 512 of 1023 is 1.6516 V), and the shim used to round it to
 * whole millivolts before any engine saw it. That cost codes: a 12-bit ADC over
 * 3.3 V steps every 0.806 mV, so 795 of the 4096 linear codes could never come
 * out, and the in-browser engine, which takes fractional millivolts and converts
 * at the attenuation the sketch set, was handed the rounded value too.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getBoardSimulator, useSimulatorStore } from '../store/useSimulatorStore';

const boards: string[] = [];
afterEach(() => {
  for (const id of boards.splice(0)) useSimulatorStore.getState().removeBoard?.(id);
});

/** An ESP32 board whose bridge records what setAdc is handed. */
function esp32(kind = 'esp32'): { shim: { setAdcVoltage(pin: number, v: number): boolean }; calls: Array<[number, number]> } {
  const id = useSimulatorStore.getState().addBoard(kind as never, 0, 0);
  boards.push(id);
  const shim = getBoardSimulator(id) as unknown as {
    setAdcVoltage(pin: number, v: number): boolean;
    bridge: { setAdc(ch: number, mv: number): void };
  };
  const calls: Array<[number, number]> = [];
  shim.bridge.setAdc = (ch: number, mv: number) => {
    calls.push([ch, mv]);
  };
  return { shim, calls };
}

describe('the ESP32 shim hands the engines the exact pad voltage', () => {
  it('a pot at 512 of 1023 on GPIO34 arrives as 1651.6 mV, not 1652', () => {
    const { shim, calls } = esp32();
    const v = (512 / 1023) * 3.3;
    expect(shim.setAdcVoltage(34, v)).toBe(true);
    expect(calls).toHaveLength(1);
    const [ch, mv] = calls[0]!;
    expect(ch).toBe(6); // GPIO34 is ADC1 channel 6
    expect(mv).toBeCloseTo(1651.6129, 3);
  });

  it('every linear 12-bit code is reachable: the centre of each step arrives as itself', () => {
    const { shim, calls } = esp32();
    const lsbMv = 3300 / 4095;
    for (let code = 0; code < 4096; code += 1) {
      shim.setAdcVoltage(36, ((code + 0.5) * lsbMv) / 1000);
    }
    const codes = new Set(calls.map(([, mv]) => Math.floor((mv * 4095) / 3300)));
    expect(codes.size).toBe(4096);
  });

  it('a voltage below one millivolt still reaches the engine', () => {
    const { shim, calls } = esp32();
    shim.setAdcVoltage(39, 0.0004);
    expect(calls[0]![1]).toBeCloseTo(0.4, 6);
  });
});
