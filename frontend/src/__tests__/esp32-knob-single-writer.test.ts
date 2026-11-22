// @vitest-environment jsdom
/**
 * The potentiometer's knob reaches an ESP32's ADC through one path, the part,
 * at the right scale (velxio/velxio-prod#175).
 *
 * The canvas kept a second, legacy listener on every wokwi-potentiometer whose
 * SIG was wired to an ESP32 pad. It read the knob's value (0..1023, the
 * element's range: docs.wokwi.com/parts/wokwi-potentiometer) as a percentage
 * and wrote value / 100 * 3300 mV straight into the bridge: about ten times too
 * high and saturated from 100 up, through the old QEMU ADC2 indices (8..17)
 * where both bridges now expect 10 + channel. Every change of the canvas tore
 * the listener down for 300 ms, so it won on the first input after a pause and
 * stuck on pads the SPICE feed does not overwrite (VP and VN, or a pot with
 * only SIG wired). The potentiometer part already writes raw / 1023 * 3.3 V.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getBoardSimulator, useSimulatorStore } from '../store/useSimulatorStore';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ComplexParts';
import * as Esp32ElementModule from '../components/velxio-components/Esp32Element';

const CANVAS = join(__dirname, '../components/simulator/SimulatorCanvas.tsx');

const boards: string[] = [];
afterEach(() => {
  for (const id of boards.splice(0)) useSimulatorStore.getState().removeBoard?.(id);
});

describe('one writer for the knob on an ESP32 (velxio/velxio-prod#175)', () => {
  it('the canvas writes no ADC value of its own', () => {
    const src = readFileSync(CANVAS, 'utf8');
    expect(src).not.toMatch(/\.setAdc\(/);
    expect(src).not.toMatch(/adcPinMapFor/);
  });

  it('the legacy QEMU-index ADC map (ADC2 at 8..17) is gone with it', () => {
    expect('adcPinMapFor' in Esp32ElementModule).toBe(false);
    expect('ESP32_ADC_PIN_MAP' in Esp32ElementModule).toBe(false);
  });

  it('the potentiometer part sends value / 1023 * 3.3 V: 1023 is 3300 mV, 512 is 1651.6 mV', () => {
    const id = useSimulatorStore.getState().addBoard('esp32' as never, 0, 0);
    boards.push(id);
    const shim = getBoardSimulator(id) as unknown as { bridge: { setAdc(ch: number, mv: number): void } };
    const calls: Array<[number, number]> = [];
    shim.bridge.setAdc = (ch, mv) => {
      calls.push([ch, mv]);
    };
    let onInput: (() => void) | null = null;
    const el = {
      value: '1023',
      addEventListener: (_e: string, cb: () => void) => {
        onInput = cb;
      },
      removeEventListener: () => {},
    } as unknown as HTMLElement & { value: string };
    PartSimulationRegistry.get('potentiometer')!.attachEvents!(
      el,
      getBoardSimulator(id) as never,
      (pin: string) => (pin === 'SIG' ? 34 : null),
      'pot1',
    );
    el.value = '512';
    onInput!();
    expect(calls.map(([ch]) => ch)).toEqual([6, 6]); // GPIO34 is ADC1 channel 6
    expect(calls[0]![1]).toBeCloseTo(3300, 6);
    expect(calls[1]![1]).toBeCloseTo((512 / 1023) * 3300, 6);
  });
});
