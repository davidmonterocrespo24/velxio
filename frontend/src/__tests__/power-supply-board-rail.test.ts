/**
 * A bench supply wired straight onto a board's power pin (velxio/velxio-prod#96
 * follow-up).
 *
 * The constant-voltage / constant-current supply of 58b532d2 is stiff up to
 * its limit, and a board's power pins were ideal sources in the netlist: the
 * 3V3 pin is the board's own 3.3 V regulator, VIN / 5V on a 3.3 V board its
 * USB 5 V. A supply at any other voltage on such a pin pushed into, or was
 * pushed by, an ideal source, sat at its limit whatever the limit was, and
 * Run was blocked with "the load asks for more ... Raise the currentLimit"
 * (10 A did not help; 3.7 V on VIN, which the supply SINKS, said the same).
 * The old supply, an ideal source behind V / (1.5 limit), let these sink or
 * source about half its limit in silence.
 *
 * What each wiring is, on hardware:
 *  - VIN / 5V of a 3.3 V board is where the board takes power in; its USB
 *    5 V reaches that pin through a Schottky diode. A supply above it powers
 *    the board: the pin sits at the supply's voltage, and the supply delivers
 *    what the board's 5 V side draws. One below it is held off by the USB
 *    5 V and, since a bench supply cannot sink current, delivers nothing.
 *  - 3V3 is the output of the board's own regulator: a different voltage
 *    there back-feeds it (above) or is held off by it (below).
 * Neither is an overload. The fights are named as what they are, as
 * warnings, next to the board over-voltage warning the check already gives
 * for 5 V on a 3.6 V pin. A supply that really reaches its limit (9 V / 1 A
 * into 5 ohm) still blocks Run as constant current.
 *
 * The circuits are the browser checker's (bookv batch-a X4, X5, A4) and the
 * reviewer's variants of them (R1-R3), through the Run button's pre-flight.
 */
import { describe, it, expect } from 'vitest';
import { buildPreflightSnapshot, type PreflightState } from '../simulation/verify/verifyFromStore';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { verifyCircuit, findSourceConflicts } from '../simulation/verify/circuitVerifier';
import { solveInput } from './helpers/solveInput';

const wire = (id: string, a: string, b: string) => {
  const [ac, ap] = a.split(':');
  const [bc, bp] = b.split(':');
  return { id, start: { componentId: ac!, pinName: ap! }, end: { componentId: bc!, pinName: bp! } };
};

const supply = (voltage: number | string, currentLimit = 1) => ({
  id: 'ps',
  metadataId: 'power-supply',
  properties: { mode: 'dc', voltage, frequency: 50, currentLimit },
});

/** X4 / X5: an ESP32 with a supply between one of its power pins and GND. */
function onBoardPin(pin: string, voltage: number, currentLimit = 1, extra: Partial<PreflightState> = {}): PreflightState {
  return {
    components: [supply(voltage, currentLimit), ...(extra.components ?? [])],
    wires: extra.wires ?? [wire('w0', 'ps:SIG', `esp32:${pin}`), wire('w1', 'ps:GND', 'esp32:GND')],
    boards: [{ id: 'esp32', boardKind: 'esp32' }],
  };
}

async function check(state: PreflightState) {
  const { snap, synthesizedPins } = buildPreflightSnapshot(state);
  const input = buildInputFromStore(snap);
  const result = await verifyCircuit(input, { synthesizedPins });
  return { input, result, codes: result.errors.map((e) => e.code) };
}

async function solved(state: PreflightState) {
  const input = buildInputFromStore(buildPreflightSnapshot(state).snap);
  const solve = await solveInput(input);
  const v = (key: string) => solve.nodeVoltages[solve.pinNetMap.get(key) ?? ''] ?? (solve.pinNetMap.get(key) === '0' ? 0 : NaN);
  return { solve, v };
}

describe('a supply into a 3.3 V board VIN pin powers the board', () => {
  it('X5: 9 V / 1 A on VIN runs, with VIN at 9 V and no overload', async () => {
    const { result } = await check(onBoardPin('VIN', 9));
    expect(result.errors).toEqual([]);
    expect([...result.errors, ...result.warnings].filter((f) => f.componentId === 'ps')).toEqual([]);
    // The board's own rating stays a warning: Velxio rates the DevKit's VIN
    // at 6 V (componentRatings), as before.
    expect(result.warnings.map((w) => `${w.code} ${w.componentId}`)).toContain('over-voltage esp32');
    const { v, solve } = await solved(onBoardPin('VIN', 9));
    expect(v('esp32:VIN')).toBeCloseTo(9, 3);
    expect(Math.abs(solve.branchCurrents.v_ps ?? NaN)).toBeLessThan(1e-3);
  });

  it('in a transient (a 1 kHz generator elsewhere on the canvas) VIN holds 9 V throughout', async () => {
    const state = onBoardPin('VIN', 9, 1, {
      components: [
        { id: 'gen', metadataId: 'signal-generator', properties: { waveform: 'sine', frequency: 1000, amplitude: 1, offset: 0 } },
        { id: 'rg', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [
        wire('w0', 'ps:SIG', 'esp32:VIN'),
        wire('w1', 'ps:GND', 'esp32:GND'),
        wire('w2', 'gen:SIG', 'rg:1'),
        wire('w3', 'rg:2', 'gen:GND'),
        wire('w4', 'gen:GND', 'esp32:GND'),
      ],
    });
    const { solve } = await solved(state);
    expect(solve.analysisMode).toBe('tran');
    const vin = solve.timeWaveforms!.nodes.get(solve.pinNetMap.get('esp32:VIN')!)!;
    expect(Math.min(...vin)).toBeGreaterThan(8.99);
    expect(Math.max(...vin)).toBeLessThan(9.01);
  });

  it('R1: the same with the limit at 10 A', async () => {
    const { result } = await check(onBoardPin('VIN', 9, 10));
    expect(result.errors).toEqual([]);
  });

  it('R2: 3.7 V on VIN runs and is named as held off by the USB 5 V (it said "the load asks for more")', async () => {
    const { result } = await check(onBoardPin('VIN', 3.7));
    expect(result.errors).toEqual([]);
    const mine = result.warnings.filter((w) => w.componentId === 'ps');
    expect(mine.map((w) => w.code)).toEqual(['supply-on-rail']);
    expect(mine[0]!.message).toContain('VIN');
    expect(mine[0]!.message).toMatch(/cannot sink/);
    expect(mine[0]!.message).not.toMatch(/asks for more|Raise the currentLimit/);
    // The board's 5 V through its Schottky holds the pin: 5 V less the
    // diode's 0.48 V at the supply's 1 A.
    const { v } = await solved(onBoardPin('VIN', 3.7));
    expect(v('esp32:VIN')).toBeGreaterThan(4.4);
    expect(v('esp32:VIN')).toBeLessThan(4.7);
  });

  it('an AA cell on the 5V pin is still a short: the USB 5 V drives current into it', async () => {
    const state: PreflightState = {
      components: [{ id: 'bat', metadataId: 'battery-aa', properties: {} }],
      wires: [wire('w0', 'bat:+', 'esp32:5V'), wire('w1', 'bat:−', 'esp32:GND')],
      boards: [{ id: 'esp32', boardKind: 'esp32' }],
    };
    expect((await check(state)).codes).toContain('short-circuit');
  });

  it('through an ammeter, the meter reads what the board side draws, not the limit', async () => {
    const state = onBoardPin('VIN', 9, 1, {
      components: [{ id: 'am', metadataId: 'instr-ammeter', properties: {} }],
      wires: [wire('w0', 'ps:SIG', 'am:A+'), wire('w1', 'am:A-', 'esp32:VIN'), wire('w2', 'ps:GND', 'esp32:GND')],
    });
    const { result } = await check(state);
    expect(result.errors).toEqual([]);
    const { solve, v } = await solved(state);
    expect(v('esp32:VIN')).toBeCloseTo(9, 3);
    expect(Math.abs(solve.branchCurrents.v_am_sense ?? NaN)).toBeLessThan(1e-3);
  });

  it('a 5 V part on the 5 V side sees the supply, and the supply delivers its current', async () => {
    // 9 V into VIN with a 100 ohm load on the 5V pin (the same net on the board).
    const state = onBoardPin('VIN', 9, 1, {
      components: [{ id: 'rl', metadataId: 'resistor', properties: { value: '100', power: 2 } }],
      wires: [
        wire('w0', 'ps:SIG', 'esp32:VIN'),
        wire('w1', 'ps:GND', 'esp32:GND'),
        wire('w2', 'esp32:5V', 'rl:1'),
        wire('w3', 'rl:2', 'esp32:GND'),
      ],
    });
    const { solve, v } = await solved(state);
    expect(v('rl:1')).toBeCloseTo(9, 2);
    expect(Math.abs(solve.branchCurrents.v_ps ?? NaN)).toBeCloseTo(0.09, 3);
  });

  it('a 9 V battery on VIN powers the board too (it read as a 2.67 A short circuit)', async () => {
    const state: PreflightState = {
      components: [{ id: 'bat', metadataId: 'battery-9v', properties: {} }],
      wires: [wire('w0', 'bat:+', 'esp32:VIN'), wire('w1', 'bat:−', 'esp32:GND')],
      boards: [{ id: 'esp32', boardKind: 'esp32' }],
    };
    const { result } = await check(state);
    expect(result.errors).toEqual([]);
    const { v } = await solved(state);
    expect(v('esp32:VIN')).toBeCloseTo(9, 3);
  });

  it("a battery whose return does not reach the board's GND does not take its 5 V over", async () => {
    // Its - runs through a 1 kΩ resistor: it holds VIN against nothing.
    const state: PreflightState = {
      components: [
        { id: 'bat', metadataId: 'battery-9v', properties: {} },
        { id: 'rs', metadataId: 'resistor', properties: { value: '1k' } },
      ],
      wires: [wire('w0', 'bat:+', 'esp32:VIN'), wire('w1', 'bat:−', 'rs:1'), wire('w2', 'rs:2', 'esp32:GND')],
      boards: [{ id: 'esp32', boardKind: 'esp32' }],
    };
    const { netlist } = buildNetlist(buildInputFromStore(buildPreflightSnapshot(state).snap));
    expect(netlist).toMatch(/^V_AUX_RAIL_5 aux_rail_5 0 DC 5$/m);
    const { v } = await solved(state);
    expect(v('esp32:VIN')).toBeCloseTo(5, 3);
  });

  it("an input tied to another board's 5 V output stays an output: a 9 V battery there back-feeds the Uno", async () => {
    const state: PreflightState = {
      components: [{ id: 'bat', metadataId: 'battery-9v', properties: {} }],
      wires: [
        wire('w0', 'uno:5V', 'esp32:VIN'),
        wire('w1', 'uno:GND.1', 'esp32:GND'),
        wire('w2', 'bat:+', 'esp32:VIN'),
        wire('w3', 'bat:−', 'esp32:GND'),
      ],
      boards: [
        { id: 'uno', boardKind: 'arduino-uno' },
        { id: 'esp32', boardKind: 'esp32' },
      ],
    };
    const { netlist } = buildNetlist(buildInputFromStore(buildPreflightSnapshot(state).snap));
    expect(netlist).toMatch(/^V_AUX_RAIL_5 aux_rail_5 0 DC 5$/m);
    expect(netlist).not.toMatch(/^D_AUX_RAIL_5 /m);
    expect((await check(state)).codes).toContain('short-circuit');
  });

  it('through a power switch: closed, the supply powers VIN; open, the board keeps its 5 V', async () => {
    const withSwitch = (value: number): PreflightState =>
      onBoardPin('VIN', 9, 1, {
        components: [{ id: 'sw', metadataId: 'slide-switch', properties: { value } }],
        wires: [wire('w0', 'ps:SIG', 'sw:3'), wire('w1', 'sw:2', 'esp32:VIN'), wire('w2', 'ps:GND', 'esp32:GND')],
      });
    expect((await solved(withSwitch(1))).v('esp32:VIN')).toBeCloseTo(9, 3);
    expect((await solved(withSwitch(0))).v('esp32:VIN')).toBeCloseTo(5, 3);
    expect((await check(withSwitch(1))).result.errors).toEqual([]);
    expect((await check(withSwitch(0))).result.errors).toEqual([]);
  });

  it('no source conflict: the board feeds the pin through its diode (trap 2 of the triage)', () => {
    const input = buildInputFromStore(buildPreflightSnapshot(onBoardPin('VIN', 9)).snap);
    const { netlist } = buildNetlist(input);
    expect(netlist).toMatch(/^V_AUX_RAIL_5 board_aux_rail_5 0 DC 5$/m);
    expect(netlist).toMatch(/^D_AUX_RAIL_5 board_aux_rail_5 aux_rail_5 D_BOARD_INPUT$/m);
    expect(findSourceConflicts(netlist, input)).toEqual([]);
  });
});

describe("a supply on the board's 3.3 V regulator output", () => {
  it('X4: 5 V / 1 A on 3V3 is named as back-feeding the 3.3 V rail, a warning, not a current limit', async () => {
    const { result } = await check(onBoardPin('3V3', 5));
    expect(result.errors).toEqual([]);
    const mine = result.warnings.filter((w) => w.componentId === 'ps');
    expect(mine.map((w) => w.code)).toEqual(['supply-on-rail']);
    expect(mine[0]!.message).toContain('3V3');
    expect(mine[0]!.message).toContain('3.3 V');
    expect(mine[0]!.message).toMatch(/back-feed/);
    expect(mine[0]!.message).not.toMatch(/asks for more|Raise the currentLimit/);
    // The damage stays the board's over-voltage warning (3.6 V maximum).
    expect(result.warnings.map((w) => `${w.code} ${w.componentId}`)).toContain('over-voltage esp32');
  });

  it('3.0 V on 3V3: held off by the board, which a bench supply cannot sink; a warning', async () => {
    const { result } = await check(onBoardPin('3V3', 3));
    expect(result.errors).toEqual([]);
    const mine = result.warnings.filter((w) => w.componentId === 'ps');
    expect(mine.map((w) => w.code)).toEqual(['supply-on-rail']);
    expect(mine[0]!.message).toContain('3.3 V');
    expect(mine[0]!.message).toMatch(/cannot sink/);
  });

  it('R3: 3.3 V on 3V3 says nothing', async () => {
    const { result } = await check(onBoardPin('3V3', 3.3));
    expect(result.errors).toEqual([]);
    expect(result.warnings.filter((w) => w.componentId === 'ps')).toEqual([]);
  });
});

describe('a real overload still reports constant current', () => {
  it('A4: 9 V / 1 A into 5 ohm through an ammeter', async () => {
    const state: PreflightState = {
      components: [
        supply(9),
        { id: 'am', metadataId: 'instr-ammeter', properties: {} },
        { id: 'r1', metadataId: 'resistor', properties: { value: '5' } },
        { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
      ],
      wires: [
        wire('w0', 'ps:SIG', 'am:A+'),
        wire('w1', 'am:A-', 'r1:1'),
        wire('w2', 'r1:2', 'ps:GND'),
        wire('w3', 'r1:1', 'vm:V+'),
        wire('w4', 'r1:2', 'vm:V-'),
      ],
      boards: [],
    };
    const { result } = await check(state);
    const overload = result.errors.filter((e) => e.code === 'source-overload');
    expect(overload.map((e) => e.componentId)).toEqual(['ps']);
    expect(overload[0]!.message).toMatch(/constant current/);
  });

  it('9 V on VIN with a 5 ohm load on the 5 V side is an overload of the supply', async () => {
    const state = onBoardPin('VIN', 9, 1, {
      components: [{ id: 'rl', metadataId: 'resistor', properties: { value: '5', power: 20 } }],
      wires: [
        wire('w0', 'ps:SIG', 'esp32:VIN'),
        wire('w1', 'ps:GND', 'esp32:GND'),
        wire('w2', 'esp32:5V', 'rl:1'),
        wire('w3', 'rl:2', 'esp32:GND'),
      ],
    });
    const { result } = await check(state);
    expect(result.errors.filter((e) => e.code === 'source-overload').map((e) => e.componentId)).toEqual(['ps']);
  });
});
