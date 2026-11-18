/**
 * The photoresistor module's DO pin is its comparator (velxio/velxio-prod#227).
 *
 * The module is the LM393 light-sensor board, Wokwi's
 * wokwi-photoresistor-sensor: "The digital output ("DO") pin goes high when
 * it's dark, and low when there's light", against a `threshold` voltage (2.5 V
 * by default) that the board's potentiometer sets, and "The bottom LED ("DO
 * LED") is connected to the digital output, and lights whenever the DO pin
 * goes low" (docs.wokwi.com/parts/wokwi-photoresistor-sensor). Since #103 its
 * AO follows the real polarity; DO was driven by nothing, so a sketch reading
 * it read whatever the board pin floated to, and the DO LED copied the board
 * pin's own level.
 *
 * Now the netlist models the comparator as the board builds it: the LM393's
 * open-collector output, which sinks DO while the divider is under the
 * threshold (in the light), and a 10 kOhm pull-up to VCC, which alone drives
 * DO in the dark. The boards that take their inputs from the solve read it,
 * and the part drives DO for any other board and lights the DO LED in the
 * light.
 *
 * The real netlist on ngspice, the real pre-run check, the real part.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { buildPreflightSnapshot, type PreflightState } from '../simulation/verify/verifyFromStore';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { valueFieldOf } from '../simulation/spice/valueFields';
import { useElectricalStore } from '../store/useElectricalStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import '../simulation/parts/ComplexParts';
import { runNetlist } from './helpers/testSolver';
import { ldrResistance } from '../simulation/spice/ldrModel';
import type { BoardKind } from '../types/board';
import type { PinSourceState } from '../simulation/spice/types';

const wire = (id: string, a: string, b: string) => {
  const [ac, ap] = a.split(':');
  const [bc, bp] = b.split(':');
  return { id, start: { componentId: ac!, pinName: ap! }, end: { componentId: bc!, pinName: bp! } };
};

/** The module on a board: VCC, GND and DO wired, AO too when asked. */
function moduleOn(
  props: Record<string, unknown>,
  board: { id: string; boardKind: string; vcc: string; gnd: string; doPin: string; aoPin?: string },
): PreflightState {
  const wires = [
    wire('wv', `ldr:VCC`, `${board.id}:${board.vcc}`),
    wire('wg', `ldr:GND`, `${board.id}:${board.gnd}`),
    wire('wd', `ldr:DO`, `${board.id}:${board.doPin}`),
  ];
  if (board.aoPin) wires.push(wire('wa', 'ldr:AO', `${board.id}:${board.aoPin}`));
  return {
    components: [{ id: 'ldr', metadataId: 'photoresistor-sensor', properties: props }],
    wires,
    boards: [{ id: board.id, boardKind: board.boardKind }],
  };
}
const UNO = { id: 'uno', boardKind: 'arduino-uno', vcc: '5V', gnd: 'GND.1', doPin: '7' };
const ESP32 = { id: 'esp32', boardKind: 'esp32', vcc: '3V3', gnd: 'GND', doPin: '27' };

/** DO's solved voltage with the board pin left an input, and whether the
 *  inputs connector would see its net (sourcedNets). */
async function doVolts(state: PreflightState): Promise<{ volts: number; sourced: boolean }> {
  const input = buildInputFromStore({
    components: state.components,
    wires: state.wires as never,
    boards: state.boards.map((b) => ({ id: b.id, boardKind: b.boardKind as BoardKind, pinStates: {} })),
  });
  const built = buildNetlist({ ...input, analysis: { kind: 'op' } });
  const net = built.pinNetMap.get('ldr:DO')!;
  const result = await runNetlist(built.netlist);
  return { volts: result.dcValue(`v(${net})`), sourced: built.sourcedNets.has(net) };
}

describe('DO is the comparator: HIGH in the dark, LOW in the light (#227)', () => {
  it('on an Uno at 5 V, with AO unwired: LOW at 500 lux, HIGH at 5 lux, the switch near 20 lux', { timeout: 60_000 }, async () => {
    // AO = 5 V x R / (R + 10k), R = 15k x (10 / lux)^0.6: 2.5 V at 19.7 lux.
    const at = (lux: number) => doVolts(moduleOn({ lux }, UNO));
    const light = await at(500);
    const dark = await at(5);
    expect(light.volts).toBeLessThan(0.1);
    expect(dark.volts).toBeGreaterThan(4.9);
    expect(light.sourced && dark.sourced).toBe(true);
    expect((await at(25)).volts).toBeLessThan(0.8);
    expect((await at(15)).volts).toBeGreaterThan(2.0);
  });

  it('the threshold moves the switch, and AO wired or not makes no difference', { timeout: 60_000 }, async () => {
    // At 100 lux AO is 1.37 V: above a 1 V threshold, under the default 2.5 V.
    expect((await doVolts(moduleOn({ lux: 100 }, UNO))).volts).toBeLessThan(0.1);
    expect((await doVolts(moduleOn({ lux: 100, threshold: 1 }, UNO))).volts).toBeGreaterThan(4.9);
    expect((await doVolts(moduleOn({ lux: 100, threshold: '1V' }, UNO))).volts).toBeGreaterThan(4.9);
    expect((await doVolts(moduleOn({ lux: 5 }, { ...UNO, aoPin: 'A0' }))).volts).toBeGreaterThan(4.9);
    expect((await doVolts(moduleOn({ lux: 500 }, { ...UNO, aoPin: 'A0' }))).volts).toBeLessThan(0.1);
  });

  it("on an ESP32's 3.3 V it swings to 3.3 V", { timeout: 60_000 }, async () => {
    expect((await doVolts(moduleOn({ lux: 0 }, ESP32))).volts).toBeCloseTo(3.3, 2);
    expect((await doVolts(moduleOn({ lux: 500 }, ESP32))).volts).toBeLessThan(0.1);
  });

  it('the threshold is a value field of the module, 2.5 V when unset', () => {
    const f = valueFieldOf('photoresistor-sensor', 'threshold');
    expect(f?.unit).toBe('V');
    expect(f?.fallback).toBe(2.5);
  });
});

/** The canvas solved on ngspice with the board's pins as given (none driven
 *  by default): a pin's voltage, and a source's current. */
async function solveCanvas(state: PreflightState, pinStates: Record<string, PinSourceState> = {}) {
  const input = buildInputFromStore({
    components: state.components,
    wires: state.wires as never,
    boards: state.boards.map((b) => ({ id: b.id, boardKind: b.boardKind as BoardKind, pinStates })),
  });
  const built = buildNetlist({ ...input, analysis: { kind: 'op' } });
  const result = await runNetlist(built.netlist);
  return {
    volts: (pin: string) => {
      const net = built.pinNetMap.get(pin)!;
      return net === '0' ? 0 : result.dcValue(`v(${net})`);
    },
    amps: (source: string) => Math.abs(result.dcValue(`i(${source})`)),
  };
}

async function preflightErrors(state: PreflightState): Promise<string[]> {
  const { snap, synthesizedPins } = buildPreflightSnapshot(state);
  const result = await verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
  return result.errors.map((e) => `${e.code}:${e.componentId ?? ''}`);
}

describe("DO is the board's output stage: the LM393's open collector and a 10 kOhm pull-up (#227)", () => {
  // On the board DO is the LM393's open-collector output with a 10 kOhm
  // pull-up to VCC: in the light the comparator sinks it (0.25 V at 4 mA,
  // about 16 mA at most, LM393 datasheet), in the dark only the pull-up drives
  // it. As an ideal source it pushed 0.41 A into a transistor base, burnt a
  // bare LED, fought a pin the sketch drives and another part's output (no
  // solve at all), and held AO at 0 V when wired onto it.
  const powered = (lux: number) => [
    { id: 'ldr', metadataId: 'photoresistor-sensor', properties: { lux } },
  ];
  const supply = [wire('wv', 'ldr:VCC', 'uno:5V'), wire('wg', 'ldr:GND', 'uno:GND.1')];
  const uno = [{ id: 'uno', boardKind: 'arduino-uno' }];

  it('into a transistor base with no resistor: the pull-up gives it about 0.4 mA in the dark', { timeout: 60_000 }, async () => {
    for (const lux of [0, 500]) {
      const state: PreflightState = {
        components: [
          ...powered(lux),
          { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
          { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
          { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
        ],
        wires: [
          ...supply,
          wire('wd', 'ldr:DO', 'q1:B'),
          wire('we', 'q1:E', 'uno:GND.2'),
          wire('w1', 'uno:5V', 'r1:1'),
          wire('w2', 'r1:2', 'led1:A'),
          wire('w3', 'led1:C', 'q1:C'),
        ],
        boards: uno,
      };
      expect(await preflightErrors(state), `${lux} lux`).toEqual([]);
      const s = await solveCanvas(state);
      if (lux === 0) {
        // The base sits a junction above ground; the pull-up carries (5 - VBE) / 10k.
        expect(s.volts('ldr:DO')).toBeLessThan(1);
        expect((5 - s.volts('ldr:DO')) / 10_000).toBeLessThan(0.5e-3);
        expect(s.amps('v_led1_sense')).toBeGreaterThan(5e-3);
      } else {
        expect(s.volts('ldr:DO')).toBeLessThan(0.1);
        expect(s.amps('v_led1_sense')).toBeLessThan(1e-4);
      }
    }
  });

  it('a bare LED on DO: lit by the pull-up with about 0.3 mA in the dark, and the Run check passes it', { timeout: 60_000 }, async () => {
    const state: PreflightState = {
      components: [...powered(0), { id: 'led1', metadataId: 'led', properties: { color: 'red' } }],
      wires: [...supply, wire('wd', 'ldr:DO', 'led1:A'), wire('wk', 'led1:C', 'uno:GND.2')],
      boards: uno,
    };
    expect(await preflightErrors(state)).toEqual([]);
    const amps = (await solveCanvas(state)).amps('v_led1_sense');
    expect(amps).toBeGreaterThan(0.2e-3);
    expect(amps).toBeLessThan(0.4e-3);
  });

  it('a sketch that drives the DO pin: the circuit still solves, and the LM393 sinks at most about 16 mA', { timeout: 60_000 }, async () => {
    const canvas = (lux: number): PreflightState => ({
      components: [
        ...powered(lux),
        { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
      ],
      wires: [
        ...supply,
        wire('wd', 'ldr:DO', 'uno:7'),
        wire('w1', 'uno:13', 'r1:1'),
        wire('w2', 'r1:2', 'led1:A'),
        wire('w3', 'led1:C', 'uno:GND.2'),
      ],
      boards: uno,
    });
    const high: PinSourceState = { type: 'digital', v: 5 };
    const low: PinSourceState = { type: 'digital', v: 0 };
    for (const lux of [0, 500]) {
      const s = await solveCanvas(canvas(lux), { '7': high, '13': high });
      // The pin holds DO HIGH; behind an ATmega pin's 25 ohm output
      // (velxio/velxio-prod#140) the sink's 16 mA pulls it 0.4 V down.
      expect(s.volts('uno:7'), `${lux} lux`).toBeGreaterThan(4.5);
      // The unrelated LED on pin 13 still solves.
      expect(s.amps('v_led1_sense'), `${lux} lux`).toBeGreaterThan(10e-3);
      // In the light the comparator sinks what the pin drives, up to its
      // short-circuit current; in the dark only the pull-up is there.
      if (lux === 500) {
        expect(s.amps('v_uno_7')).toBeGreaterThan(10e-3);
        expect(s.amps('v_uno_7')).toBeLessThan(20e-3);
      } else {
        expect(s.amps('v_uno_7')).toBeLessThan(1e-6);
      }
    }
    // Driven LOW in the dark, the pin takes the pull-up's 0.5 mA.
    const s = await solveCanvas(canvas(0), { '7': low, '13': high });
    expect(s.amps('v_uno_7')).toBeCloseTo(0.5e-3, 5);
  });

  it('DO wired onto AO (one board pin): AO follows the comparator, the divider in the dark and near 0 V in the light', { timeout: 60_000 }, async () => {
    const tied = (lux: number): PreflightState => ({
      components: powered(lux),
      wires: [...supply, wire('wa', 'ldr:AO', 'uno:A0'), wire('wd', 'ldr:DO', 'uno:A0')],
      boards: uno,
    });
    for (const lux of [0, 10]) {
      // The comparator off: AO is the divider with the DO pull-up beside its 10 kOhm.
      const r = ldrResistance(lux);
      expect((await solveCanvas(tied(lux))).volts('uno:A0'), `${lux} lux`).toBeCloseTo((5 * r) / (r + 5_000), 2);
    }
    for (const lux of [50, 100, 500]) {
      expect((await solveCanvas(tied(lux))).volts('uno:A0'), `${lux} lux`).toBeLessThan(0.2);
    }
  });

  it("another part's output on DO's net is no conflict: a NOT gate's HIGH wins over the LM393's sink", { timeout: 60_000 }, async () => {
    const state: PreflightState = {
      components: [...powered(500), { id: 'g1', metadataId: 'logic-gate-not', properties: {} }],
      wires: [...supply, wire('wd', 'ldr:DO', 'uno:7'), wire('wy', 'g1:Y', 'uno:7'), wire('wa', 'g1:A', 'uno:GND.2')],
      boards: uno,
    };
    expect(await preflightErrors(state)).toEqual([]);
    expect((await solveCanvas(state)).volts('uno:7')).toBeCloseTo(5, 2);
  });
});

describe('the pre-run check reads DO as the input it is (#227)', () => {
  it('the board pin DO is wired to is not forced HIGH, and nothing conflicts', { timeout: 60_000 }, async () => {
    for (const board of [UNO, ESP32]) {
      for (const lux of [0, 500]) {
        const { snap, synthesizedPins } = buildPreflightSnapshot(moduleOn({ lux }, board));
        expect(synthesizedPins.has(`${board.id}:${board.doPin}`), `${board.boardKind} ${lux} lux`).toBe(false);
        const result = await verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
        expect(result.errors, `${board.boardKind} ${lux} lux`).toEqual([]);
      }
    }
  });
});

describe('the part: the DO LED lights in the light, and DO reaches a board that does not read the solve (#227)', () => {
  afterEach(() => {
    useElectricalStore.getState().reset();
    useSimulatorStore.setState({ components: [] } as never);
    vi.restoreAllMocks();
  });

  function attach(sim: Record<string, unknown>, props: Record<string, unknown> = { lux: 500 }) {
    useSimulatorStore.setState({
      components: [{ id: 'ldr', metadataId: 'photoresistor-sensor', x: 0, y: 0, properties: props }],
    } as never);
    const el = { addEventListener: vi.fn(), removeEventListener: vi.fn(), lux: props.lux, ledDO: false } as unknown as HTMLElement & { ledDO: boolean };
    const pins: Record<string, number> = { DO: 4 };
    const detach = PartSimulationRegistry.get('photoresistor-sensor')!.attachEvents!(el, sim as never, (n: string) => pins[n] ?? null, 'ldr');
    return { el, detach };
  }
  const plainBoard = () => ({ setPinState: vi.fn(), getADC: () => null, pinManager: { onPinChange: vi.fn(() => () => {}) } });

  it('at 500 lux the LED is lit and DO is LOW; at 5 lux the LED is out and DO is HIGH', () => {
    const sim = plainBoard();
    const { el, detach } = attach(sim);
    expect(el.ledDO).toBe(true);
    expect(sim.setPinState).toHaveBeenLastCalledWith(4, false);
    dispatchSensorUpdate('ldr', { lux: 5 });
    expect(el.ledDO).toBe(false);
    expect(sim.setPinState).toHaveBeenLastCalledWith(4, true);
    detach?.();
  });

  it('the threshold the project sets moves it: 100 lux is light at 2.5 V and dark at 1 V', () => {
    const sim = plainBoard();
    const { el, detach } = attach(sim, { lux: 100, threshold: 1 });
    expect(el.ledDO).toBe(false);
    expect(sim.setPinState).toHaveBeenLastCalledWith(4, true);
    detach?.();
  });

  it('a board that reads the solve gets DO from the circuit, not from the part; the LED still follows', () => {
    const sim = { ...plainBoard(), spiceDrivenInputs: true };
    const { el, detach } = attach(sim);
    expect(el.ledDO).toBe(true);
    dispatchSensorUpdate('ldr', { lux: 5 });
    expect(el.ledDO).toBe(false);
    expect(sim.setPinState).not.toHaveBeenCalled();
    detach?.();
  });

  it('a module the solve finds unpowered has its LED out and DO LOW', () => {
    const sim = plainBoard();
    const { el, detach } = attach(sim);
    // A solve with the module's VCC on an unpowered net.
    useElectricalStore.getState().setSolveResult({
      ...useElectricalStore.getState(),
      pinNetMap: new Map([['ldr:VCC', 'n5'], ['ldr:GND', '0'], ['ldr:DO', 'n6']]),
      nodeVoltages: { n5: 0, n6: 0 },
    });
    expect(el.ledDO).toBe(false);
    expect(sim.setPinState).toHaveBeenLastCalledWith(4, false);
    detach?.();
  });
});
