/**
 * arduino-pwm-dac-opamp's second-pass "PWM 0" line reads the 0 V the circuit
 * holds (velxio/velxio-prod#141, its second half).
 *
 * After analogWrite(9, 255) the Arduino core clears COM1A and drives pin 9
 * HIGH; after analogWrite(9, 0) it drives it LOW. The example's deck holds a
 * capacitor, so the 255 state was solved as a transient, and the service used
 * to republish that 4.03 V capture after the LOW edge's operating point: the
 * AVR ADC hook samples a published capture before the scalar node voltage,
 * so the "PWM 0" line of every pass after the first read about 4.03 V. Fixed
 * by OSS 0a6be1cd (#153's stale-capture half, release 7); this pins it on the
 * gallery example's own circuit. Real service, scheduler and ngspice.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  CircuitSimulationService,
  type ElectricalSnapshot,
  type MixedModeSchedulerPort,
  type SimulatorStorePort,
} from '../simulation/spice/CircuitSimulationService';
import {
  getMixedModeScheduler,
  __resetMixedModeScheduler,
  __setSchedulerSolverFactoryForTests,
} from '../simulation/spice/MixedModeScheduler';
import { NgSpiceNodeAdapter } from '../simulation/spice/adapters/NgSpiceNodeAdapter';
import type { PinSourceState } from '../simulation/spice/types';
import { analogProjectExamples } from '../data/examples-analog-projects';
import { stripBrandPrefix, isBoardComponentType } from '../utils/exampleToBuildNetlistInput';
import { interpolateAt } from '../simulation/spice/waveformStats';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let service: CircuitSimulationService | null = null;
afterEach(() => {
  service?.stop();
  service = null;
  __resetMixedModeScheduler();
});

/** What the AVR ADC hook reads on A0 `atS` seconds after the state was
 *  published: a capture the snapshot carries comes first (held at its last
 *  sample past its end), else the node voltage. */
function a0Reading(s: ElectricalSnapshot, atS: number): number {
  const net = s.pinNetMap.get('arduino-uno:A0')!;
  const capture = s.timeWaveforms?.nodes.get(net);
  if (capture && capture.length > 0) {
    return interpolateAt(s.timeWaveforms!.time, capture, Math.min(atS, s.timeWaveforms!.time.at(-1)!));
  }
  return s.nodeVoltages[net] ?? NaN;
}

describe('arduino-pwm-dac-opamp: the PWM 0 line after a 255 step', () => {
  it('reads the filter discharged through the follower, not the 255 capture', { timeout: 60_000 }, async () => {
    __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
    const ex = analogProjectExamples.find((e) => e.id === 'arduino-pwm-dac-opamp')!;
    const components = ex.components
      .filter((c) => !isBoardComponentType(c.type))
      .map((c) => ({ id: c.id, metadataId: stripBrandPrefix(c.type), properties: c.properties ?? {} }));
    const wires = ex.wires.map((w) => ({ id: w.id, start: w.start, end: w.end }));
    // analogWrite(9, 255): COM1A cleared, pin 9 a plain output at HIGH.
    let pins: Record<string, PinSourceState> = { '9': { type: 'digital', v: 5 } };
    const published: ElectricalSnapshot[] = [];
    const simStore: SimulatorStorePort = {
      getState: () => ({ components, wires, boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', running: true }] }),
      subscribe: () => () => {},
    };
    service = new CircuitSimulationService(
      simStore,
      { publish: (s) => published.push(s) },
      getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
      { collectBoardPinStates: () => pins },
    );
    await service.tick();
    const at255 = published.at(-1)!;
    expect(at255.analysisMode).toBe('tran');
    // The LM358 follower tops out near 4 V on a 5 V supply.
    expect(at255.nodeVoltages[at255.pinNetMap.get('arduino-uno:A0')!]).toBeGreaterThan(3.8);

    // analogWrite(9, 0): digitalWrite(9, LOW).
    pins = { '9': { type: 'digital', v: 0 } };
    await service.handleMcuEdge('arduino-uno', '9', false, 5, null);
    await sleep(150);
    // The sketch reads A0 2.5 s after the write (delay(2500)): 25 RC.
    expect(a0Reading(published.at(-1)!, 2.5)).toBeLessThan(0.1);
  });
});
