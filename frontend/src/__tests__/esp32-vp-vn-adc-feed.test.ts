/**
 * The solved circuit reaches the ADC on the classic ESP32's VP and VN pads
 * (velxio/velxio-prod#171).
 *
 * SENSOR_VP is GPIO36, ADC1 channel 0, and the arduino-esp32 core's A0;
 * SENSOR_VN is GPIO39, ADC1 channel 3 (ESP32 datasheet, ESP32-DevKitC header
 * J2). The SPICE-to-ADC feed looks a pad up by the name the wire carries, and
 * its table listed the classic boards' ADC1 pads by GPIO number only ('32' to
 * '39'), while on the DevKit V1, the DevKitC V4 and the LOLIN32 Lite those two
 * pads are named 'VP' and 'VN'. A divider, an LDR, an NTC or an op-amp wired
 * there solved fine and never reached analogRead; the scope took a probe on
 * them for a digital pin.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useSimulatorStore, getBoardSimulator } from '../store/useSimulatorStore';
import { useElectricalStore } from '../store/useElectricalStore';
import { connectAnalogInputsToMcu, ADC_PIN_MAP } from '../simulation/spice/connectAnalogInputsToMcu';
import { resolveProbe } from '../simulation/probeResolve';

const boards: string[] = [];
afterEach(() => {
  for (const id of boards.splice(0)) useSimulatorStore.getState().removeBoard?.(id);
  useElectricalStore.getState().reset();
});

/** Publish a solve with these pad voltages and record what the ADC is handed. */
function feed(kind: string, pads: Record<string, number>): Array<[number, number]> {
  const id = useSimulatorStore.getState().addBoard(kind as never, 0, 0);
  boards.push(id);
  const sim = getBoardSimulator(id) as unknown as Record<string, unknown>;
  const calls: Array<[number, number]> = [];
  sim.setAdcVoltage = (pin: number, v: number) => {
    calls.push([pin, v]);
    return true;
  };
  const pinNetMap = new Map<string, string>();
  const nodeVoltages: Record<string, number> = {};
  Object.entries(pads).forEach(([pad, v], i) => {
    pinNetMap.set(`${id}:${pad}`, `n${i}`);
    nodeVoltages[`n${i}`] = v;
  });
  useElectricalStore.setState({ pinNetMap, nodeVoltages, sourcedNets: new Set(Object.keys(nodeVoltages)) } as never);
  connectAnalogInputsToMcu()();
  return calls;
}

describe('VP and VN reach the ADC (velxio/velxio-prod#171)', () => {
  for (const kind of ['esp32', 'esp32-devkit-c-v4'] as const) {
    it(`${kind}: a voltage solved on VP and VN is what analogRead converts`, () => {
      const calls = feed(kind, { VP: 0.5, VN: 1.0, '34': 1.5 });
      expect(calls).toEqual(expect.arrayContaining([[36, 0.5], [39, 1.0], [34, 1.5]]));
    });
  }

  it('wemos-lolin32-lite: its VP and VN pads too', () => {
    const calls = feed('wemos-lolin32-lite', { VP: 0.5, VN: 1.0, GPIO34: 1.5 });
    expect(calls).toEqual(expect.arrayContaining([[36, 0.5], [39, 1.0], [34, 1.5]]));
  });

  it('the classic table numbers ADC1 as the chip does: GPIO36-39 are channels 0-3, GPIO32-35 are 4-7', () => {
    const ch = (pad: string) => ADC_PIN_MAP.esp32!.find((e) => e.pinName === pad)?.channel;
    expect([ch('36'), ch('37'), ch('38'), ch('39'), ch('32'), ch('33'), ch('34'), ch('35')]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([ch('VP'), ch('VN')]).toEqual([0, 3]);
  });

  it('the scope plots a probe on VP as the voltage it is, not as a logic pin', () => {
    const esp = { id: 'esp32', boardKind: 'esp32' as const, x: 0, y: 0 };
    const target = resolveProbe(
      {
        id: 'w1', color: '#0f0', waypoints: [],
        start: { componentId: 'esp32', pinName: 'VP', x: 0, y: 0 },
        end: { componentId: 'r1', pinName: '2', x: 10, y: 0 },
      },
      { state: { wires: [], components: [], boards: [esp] }, pinNetMap: new Map([['esp32:VP', 'n3']]) } as never,
    );
    expect(target).toEqual({ kind: 'analog', netName: 'n3', label: 'n3' });
  });
});
