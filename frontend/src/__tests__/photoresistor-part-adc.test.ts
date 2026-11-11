/**
 * The light module's AO is the circuit's (velxio/velxio-prod#188).
 *
 * The photoresistor part used to write (lux / 1000) * 5 V into the ADC itself
 * on attach, on input events and on every Sensors-panel change, knowing
 * neither the module's divider nor the board's supply: 2.5 V at 500 lux on an
 * ESP32, where the circuit gives 0.41 V. The part is SPICE-mapped, so it never
 * owns the pin, and the solve wrote the circuit's value after it: the sketch
 * read the part's value in between (on staging, 9 of 48 reads while the slider
 * moved jumped to ADC=1023 instead of the solved 57).
 *
 * Now the solve owns AO as soon as it knows the pin's net. Before that (the
 * first solve has not landed, or there is no solver) the part writes what the
 * circuit will give with the module on the board's supply, from the same LDR
 * model as the SPICE card. The mapper also models a module wired by one leg:
 * with GND missing AO sits at VCC through the fixed resistor, with VCC missing
 * the LDR holds it at 0 V.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { useElectricalStore } from '../store/useElectricalStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { getSensorUpdate } from '../simulation/SensorUpdateRegistry';
import '../simulation/parts/ComplexParts';

/** An AVR-like simulator: ADC channels 0-7 behind Arduino pins 14-21, 5 V. */
function avrSim() {
  const adc = { channelValues: new Array(8).fill(-1) };
  const sim = {
    pinManager: { onPinChange: vi.fn().mockReturnValue(() => {}) },
    getADC: vi.fn().mockReturnValue(adc),
    setPinState: vi.fn(),
  };
  return { sim, adc };
}

/** An ESP32-like bridge shim: writes go through its own setAdcVoltage, 3.3 V. */
function esp32Sim() {
  const writes: Array<[number, number]> = [];
  const sim = {
    pinManager: { onPinChange: vi.fn().mockReturnValue(() => {}) },
    setAdcVoltage: (pin: number, v: number) => {
      writes.push([pin, v]);
      return true;
    },
    setPinState: vi.fn(),
  };
  return { sim, writes };
}

const element = (props: Record<string, unknown> = {}) =>
  ({ addEventListener: vi.fn(), removeEventListener: vi.fn(), ...props }) as unknown as HTMLElement;
const pins = (map: Record<string, number>) => (name: string) => (name in map ? map[name] : null);
const logic = () => PartSimulationRegistry.get('photoresistor-sensor')!;

/** The module's AO on `vcc` for a GL5528 at `lux` under its 10 kOhm. */
const moduleAo = (vcc: number, lux: number) => {
  const r = lux > 0 ? Math.min(1e6, 15_000 * Math.pow(10 / lux, 0.6)) : 1e6;
  return (vcc * r) / (r + 10_000);
};

const savedComponents = useSimulatorStore.getState().components;
beforeEach(() => {
  useElectricalStore.setState({ pinNetMap: new Map() });
});
afterEach(() => {
  useElectricalStore.setState({ pinNetMap: new Map() });
  useSimulatorStore.setState({ components: savedComponents });
});

describe('photoresistor part: AO comes from the circuit (#188)', () => {
  it("before any solve, writes the module's divider for its light on the board's supply", () => {
    const { sim, adc } = avrSim();
    const cleanup = logic().attachEvents!(element(), sim as never, pins({ AO: 14 }), 'ldr-a');
    // 500 lux by default: 5 V * 1434.6 / 11434.6 = 0.627 V, not (500 / 1000) * 5 = 2.5 V.
    expect(adc.channelValues[0]).toBeCloseTo(moduleAo(5, 500), 3);
    cleanup?.();

    const esp = esp32Sim();
    const cleanup2 = logic().attachEvents!(element({ lux: 1000 }), esp.sim as never, pins({ AO: 34 }), 'ldr-b');
    // On an ESP32 the module sits on 3.3 V: 0.285 V at 1000 lux, not 5 V.
    expect(esp.writes).toEqual([[34, expect.closeTo(moduleAo(3.3, 1000), 3)]]);
    cleanup2?.();
  });

  it('the Sensors panel moves AO the way the module does: down as the light rises', () => {
    const { sim, adc } = avrSim();
    const cleanup = logic().attachEvents!(element({ lux: 10 }), sim as never, pins({ AO: 14 }), 'ldr-c');
    const update = getSensorUpdate('ldr-c')!;
    const seen: number[] = [];
    for (const lux of [0, 10, 100, 1000]) {
      update({ lux });
      seen.push(adc.channelValues[0]);
    }
    expect(seen[0]).toBeCloseTo(moduleAo(5, 0), 3);
    expect(seen[3]).toBeCloseTo(moduleAo(5, 1000), 3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1]);
    cleanup?.();
  });

  it("reads the part's own LDR and fixed resistor, as the SPICE card does", () => {
    useSimulatorStore.setState({
      components: [
        { id: 'ldr-d', metadataId: 'photoresistor-sensor', x: 0, y: 0, properties: { lux: 100, rl10: 50, gamma: 0.7 } },
      ] as never,
    });
    const { sim, adc } = avrSim();
    const cleanup = logic().attachEvents!(element({ lux: 100 }), sim as never, pins({ AO: 14 }), 'ldr-d');
    // Wokwi's table: 2.50 V at 100 lux on 5 V with rl10 50 kOhm, gamma 0.7.
    expect(adc.channelValues[0]).toBeCloseTo(2.497, 3);
    cleanup?.();
  });

  it('once a solve knows the pin, leaves AO to the circuit: no write on attach or on a light change', () => {
    useElectricalStore.setState({ pinNetMap: new Map([['ldr-e:AO', 'n_ao'], ['arduino-uno:A0', 'n_ao']]) });
    const { sim, adc } = avrSim();
    const cleanup = logic().attachEvents!(element({ lux: 500 }), sim as never, pins({ AO: 14 }), 'ldr-e');
    expect(adc.channelValues[0]).toBe(-1);
    getSensorUpdate('ldr-e')!({ lux: 1000 });
    expect(adc.channelValues[0]).toBe(-1);
    cleanup?.();
  });

  it('the SPICE card covers a module wired by one leg', () => {
    const map = (nets: Record<string, string>) =>
      componentToSpice(
        { id: 'm', metadataId: 'photoresistor-sensor', properties: { lux: 10 } },
        (pin: string) => nets[pin] ?? null,
        { vcc: 5 },
      )?.cards ?? null;
    // GND missing: the fixed 10 kOhm pulls AO to VCC.
    expect(map({ VCC: 'vcc', AO: 'n_ao' })).toEqual(['R_m_pull vcc n_ao 10000']);
    // VCC missing: the LDR holds AO at 0 V.
    expect(map({ GND: '0', AO: 'n_ao' })).toEqual(['R_m_ldr n_ao 0 15000']);
    // Not powered at all, or AO not wired: nothing to model.
    expect(map({ AO: 'n_ao' })).toBeNull();
    expect(map({ VCC: 'vcc', GND: '0' })).toBeNull();
  });
});
