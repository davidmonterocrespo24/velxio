/**
 * A source wired straight to a GPIO is a test voltage into an input (the
 * velxio/velxio-prod#96 sibling the book-ab2s review found).
 *
 * The Run button's pre-flight forces every wired GPIO HIGH as an ideal source
 * (the worst case: the sketch will drive the LED it is wired to), and leaves
 * a pin alone only when a component's ideal source already holds its net. The
 * constant-voltage / constant-current supply of 58b532d2 sits behind 10 mΩ,
 * so that rule no longer saw it: a bench supply on an ESP32's GPIO32 (an
 * analogRead of a supply, the common lab) faced the forced 3.3 V, sat at its
 * current limit whatever the limit, and Run was blocked with "the load asks
 * for more ... Raise the currentLimit". c2d4ef37 ran it. A 9 V or an AA
 * battery there was blocked as a "short circuit" before the batch, for the
 * same reason.
 *
 * The pin is decided the way book-ab2s decided a board's power pins: a part
 * that declares the net it powers (a supply's or a battery's +, a
 * generator's output, a regulator's VOUT) and holds it against ground
 * through its own cards and connections (an ammeter, a closed switch) drives
 * that pin, which is then the input it is. If the sketch does drive that pin
 * as an output, the two fight: that is named as a conflict between the part
 * and the pin, as the pre-flight names other conflicts, never as the
 * supply's current limit.
 */
import { describe, it, expect } from 'vitest';
import { buildPreflightSnapshot, type PreflightState } from '../simulation/verify/verifyFromStore';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { verifyCircuit, findSourceConflicts } from '../simulation/verify/circuitVerifier';
import type { PinSourceState } from '../simulation/spice/types';
import { solveInput } from './helpers/solveInput';

const wire = (id: string, a: string, b: string) => {
  const [ac, ap] = a.split(':');
  const [bc, bp] = b.split(':');
  return { id, start: { componentId: ac!, pinName: ap! }, end: { componentId: bc!, pinName: bp! } };
};

const supply = (voltage: number | string, currentLimit = 1, mode = 'dc') => ({
  id: 'ps',
  metadataId: 'power-supply',
  properties: { mode, voltage, frequency: 50, currentLimit },
});
const battery = (metadataId: string) => ({ id: 'bat', metadataId, properties: {} });
const generator = { id: 'gen', metadataId: 'signal-generator', properties: { waveform: 'dc', offset: 1.5, amplitude: 1, frequency: 1 } };

/** A source's + on a board GPIO and its - on the board's GND (the corpus shape). */
function onGpio(
  src: { id: string; metadataId: string; properties: Record<string, unknown> },
  board = { id: 'esp32', boardKind: 'esp32' },
  pin = '32',
  gnd = 'GND',
): PreflightState {
  const [pos, neg] = src.metadataId.startsWith('battery') ? ['+', '−'] : ['SIG', 'GND'];
  return {
    components: [src],
    wires: [wire('w0', `${src.id}:${pos}`, `${board.id}:${pin}`), wire('w1', `${src.id}:${neg}`, `${board.id}:${gnd}`)],
    boards: [board],
  };
}

async function preflight(state: PreflightState) {
  const { snap, synthesizedPins } = buildPreflightSnapshot(state);
  const result = await verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
  return { snap, synthesizedPins, result };
}

/** The same circuit as the live run sees it once the sketch has set its pins. */
async function asSketchDrives(state: PreflightState, pins: Record<string, Record<string, PinSourceState>>) {
  const input = buildInputFromStore({
    components: state.components,
    wires: state.wires as never,
    boards: state.boards.map((b) => ({ id: b.id, boardKind: b.boardKind as never, pinStates: pins[b.id] ?? {} })),
  });
  return { input, result: await verifyCircuit(input) };
}

async function pinVolts(state: PreflightState, key: string) {
  const input = buildInputFromStore(buildPreflightSnapshot(state).snap);
  const solve = await solveInput(input);
  const net = solve.pinNetMap.get(key);
  return net === '0' ? 0 : (solve.nodeVoltages[net ?? ''] ?? NaN);
}

describe('a supply, a battery or a generator straight on a GPIO runs', () => {
  it('the review case: 3 V / 1 A on an ESP32 GPIO32 runs, reads 3 V, and the pin is left as an input', async () => {
    const { result, synthesizedPins } = await preflight(onGpio(supply(3)));
    expect(result.errors).toEqual([]);
    expect([...result.errors, ...result.warnings].filter((f) => f.componentId === 'ps')).toEqual([]);
    expect(synthesizedPins.has('esp32:32')).toBe(false);
    expect(await pinVolts(onGpio(supply(3)), 'esp32:32')).toBeCloseTo(3, 3);
  });

  it('the same at 10 A (raising the limit never helped)', async () => {
    expect((await preflight(onGpio(supply(3, 10)))).result.errors).toEqual([]);
  });

  it('2 V on an ESP32-C3 GPIO0, 5 V on GPIO32, 0 V, and a supply in AC mode', async () => {
    const c3 = { id: 'c3', boardKind: 'esp32-c3' };
    expect((await preflight(onGpio(supply(2), c3, '0', 'GND.9'))).result.errors).toEqual([]);
    expect((await preflight(onGpio(supply(5)))).result.errors).toEqual([]);
    expect((await preflight(onGpio(supply(0)))).result.errors).toEqual([]);
    expect((await preflight(onGpio(supply(3, 1, 'ac')))).result.errors).toEqual([]);
  });

  it('on a 5 V board: 3 V on an Uno pin 7 (c2d4ef37 blocked it at 1.00 A)', async () => {
    const uno = { id: 'uno', boardKind: 'arduino-uno' };
    const { result, synthesizedPins } = await preflight(onGpio(supply(3), uno, '7', 'GND.1'));
    expect(result.errors).toEqual([]);
    expect(synthesizedPins.has('uno:7')).toBe(false);
  });

  it('through an ammeter, which reads what the input draws', async () => {
    const state: PreflightState = {
      components: [supply(3), { id: 'am', metadataId: 'instr-ammeter', properties: {} }],
      wires: [wire('w0', 'ps:SIG', 'am:A+'), wire('w1', 'am:A-', 'esp32:32'), wire('w2', 'ps:GND', 'esp32:GND')],
      boards: [{ id: 'esp32', boardKind: 'esp32' }],
    };
    const { result, synthesizedPins } = await preflight(state);
    expect(result.errors).toEqual([]);
    expect(synthesizedPins.has('esp32:32')).toBe(false);
    const solve = await solveInput(buildInputFromStore(buildPreflightSnapshot(state).snap));
    expect(Math.abs(solve.branchCurrents.v_am_sense ?? NaN)).toBeLessThan(1e-6);
  });

  it('a 9 V and an AA battery run too (both were a "Possible short circuit"); so does a coin cell', async () => {
    for (const kind of ['battery-9v', 'battery-aa', 'battery-coin-cell']) {
      const { result, synthesizedPins } = await preflight(onGpio(battery(kind)));
      expect(result.errors, kind).toEqual([]);
      expect(synthesizedPins.has('esp32:32'), kind).toBe(false);
    }
  });

  it('a DC generator, which ran already, still runs; so does a 7805 output', async () => {
    const { result, synthesizedPins } = await preflight(onGpio(generator));
    expect(result.errors).toEqual([]);
    expect(synthesizedPins.has('esp32:32')).toBe(false);
    const regulator: PreflightState = {
      components: [battery('battery-9v'), { id: 'reg', metadataId: 'reg-7805', properties: {} }],
      wires: [
        wire('w0', 'bat:+', 'reg:VIN'),
        wire('w1', 'bat:−', 'esp32:GND'),
        wire('w2', 'reg:GND', 'esp32:GND'),
        wire('w3', 'reg:VOUT', 'esp32:32'),
      ],
      boards: [{ id: 'esp32', boardKind: 'esp32' }],
    };
    expect((await preflight(regulator)).result.errors).toEqual([]);
  });

  it('a generator set to DC 0 V runs (its 0 V card read as a wire, and the forced pin as a source shorted onto ground)', async () => {
    const zero = { ...generator, properties: { ...generator.properties, offset: 0 } };
    const { result, synthesizedPins } = await preflight(onGpio(zero));
    expect(result.errors).toEqual([]);
    expect(synthesizedPins.has('esp32:32')).toBe(false);
  });

  it('two boards reading one supply: neither pin is forced, and nothing conflicts', async () => {
    const state: PreflightState = {
      components: [supply(3)],
      wires: [
        wire('w0', 'ps:SIG', 'esp32:32'),
        wire('w1', 'ps:GND', 'esp32:GND'),
        wire('w2', 'esp32:32', 'uno:7'),
        wire('w3', 'uno:GND.1', 'esp32:GND'),
      ],
      boards: [
        { id: 'esp32', boardKind: 'esp32' },
        { id: 'uno', boardKind: 'arduino-uno' },
      ],
    };
    const { result, synthesizedPins } = await preflight(state);
    expect([...synthesizedPins]).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('the worst case stays where no part holds the pin', () => {
  it('through 1 kΩ the pin is still forced HIGH, and the circuit is clean', async () => {
    const state: PreflightState = {
      components: [supply(3), { id: 'rs', metadataId: 'resistor', properties: { value: '1k' } }],
      wires: [wire('w0', 'ps:SIG', 'rs:1'), wire('w1', 'rs:2', 'esp32:32'), wire('w2', 'ps:GND', 'esp32:GND')],
      boards: [{ id: 'esp32', boardKind: 'esp32' }],
    };
    const { result, synthesizedPins } = await preflight(state);
    expect(synthesizedPins.has('esp32:32')).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("a battery whose return does not reach the board's GND holds the pin against nothing", async () => {
    // Its - runs through a 1 kΩ resistor, as in the board power pin spec.
    const state: PreflightState = {
      components: [battery('battery-9v'), { id: 'rs', metadataId: 'resistor', properties: { value: '1k' } }],
      wires: [wire('w0', 'bat:+', 'esp32:32'), wire('w1', 'bat:−', 'rs:1'), wire('w2', 'rs:2', 'esp32:GND')],
      boards: [{ id: 'esp32', boardKind: 'esp32' }],
    };
    const { result, synthesizedPins } = await preflight(state);
    expect(synthesizedPins.has('esp32:32')).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('an LED pin beside it is still forced HIGH and a bare LED still caught', async () => {
    const state: PreflightState = {
      components: [supply(3), { id: 'led1', metadataId: 'led', properties: { color: 'red' } }],
      wires: [
        wire('w0', 'ps:SIG', 'esp32:32'),
        wire('w1', 'ps:GND', 'esp32:GND'),
        wire('w2', 'esp32:13', 'led1:A'),
        wire('w3', 'led1:C', 'esp32:GND'),
      ],
      boards: [{ id: 'esp32', boardKind: 'esp32' }],
    };
    const { result, synthesizedPins } = await preflight(state);
    expect([...synthesizedPins]).toEqual(['esp32:13']);
    expect(result.errors.map((e) => e.code)).toContain('led-overcurrent');
    expect(result.errors.filter((e) => e.componentId === 'ps')).toEqual([]);
  });

  it('no source conflict in the netlist: the supply keeps its 10 mΩ (trap 2 of the triage)', () => {
    const input = buildInputFromStore(buildPreflightSnapshot(onGpio(supply(3))).snap);
    const { netlist } = buildNetlist({ ...input, analysis: { kind: 'op' } });
    expect(netlist).toMatch(/^R_ps_out ps_int ps_a 10m$/m);
    expect(netlist).not.toMatch(/^V_esp32_32 /m);
    expect(findSourceConflicts(netlist, input)).toEqual([]);
  });
});

describe('a GPIO the sketch drives against the part is a conflict, never a current limit', () => {
  const high: PinSourceState = { type: 'digital', v: 3.3 };
  const low: PinSourceState = { type: 'digital', v: 0 };

  it('a supply against a pin driven HIGH or LOW is named with the pin, and blocks', async () => {
    for (const state of [high, low]) {
      const { result } = await asSketchDrives(onGpio(supply(3)), { esp32: { '32': state } });
      const conflicts = result.errors.filter((e) => e.code === 'source-conflict');
      expect(conflicts.map((e) => e.componentId), JSON.stringify(result.errors)).toEqual(['ps']);
      expect(conflicts[0]!.message).toContain('power-supply ps');
      expect(conflicts[0]!.message).toContain('board esp32 pin 32 (driven by the MCU)');
      expect(conflicts[0]!.message).toMatch(/input/);
      expect(result.errors.map((e) => e.code)).not.toContain('source-overload');
      for (const e of result.errors) expect(e.message).not.toMatch(/current ?limit|asks for more/i);
    }
  });

  it('a 9 V battery against a pin driven HIGH is the same conflict, not a short circuit', async () => {
    const { result } = await asSketchDrives(onGpio(battery('battery-9v')), { esp32: { '32': high } });
    expect(result.errors.filter((e) => e.code === 'source-conflict').map((e) => e.componentId)).toEqual(['bat']);
    expect(result.errors.map((e) => e.code)).not.toContain('short-circuit');
  });

  it('a generator against a pin driven HIGH is named once, as before', async () => {
    const { result } = await asSketchDrives(onGpio(generator), { esp32: { '32': high } });
    expect(result.errors.filter((e) => e.code === 'source-conflict')).toHaveLength(1);
  });

  it('the pin left as an input (analogRead) is no conflict', async () => {
    const { result } = await asSketchDrives(onGpio(supply(3)), { esp32: { '32': { type: 'input' } } });
    expect(result.errors).toEqual([]);
  });
});
