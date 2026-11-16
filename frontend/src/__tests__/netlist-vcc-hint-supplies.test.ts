/**
 * A part's VCC pin and the supply that actually feeds it (velxio/velxio-prod#102).
 *
 * NetlistBuilder reads a part pin named VCC / VDD / 5V / 3V3 as a hint: on a
 * net no board pin names, the pin joins the logic rail (`vcc_rail`, 5 V with
 * no board). That gives a module a supply when nothing else does (two modules
 * with their VCC pins wired to each other), but it also overrode the supply
 * the user did wire:
 *   - a pot on a 9 V battery read 2.50 V at mid-scale, the battery pushed
 *     2.67 A into the hidden rail, and Run was blocked as a short circuit;
 *   - a generator, a 7805 or a 7812 on a pot's VCC was blocked as a "source
 *     conflict" with "the board's main supply rail", with no board at all;
 *   - with an ESP32 on the canvas, a pot on a 9 V supply sat at 3.3 V.
 * The hint now applies only where no explicit supply reaches the net: no
 * board rail, no source's output, on the net or behind series parts.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { BOARD_PIN_GROUPS } from '../simulation/spice/boardPinGroups';
import { runNetlist } from './helpers/testSolver';
import type { BoardForSpice, BuildNetlistInput } from '../simulation/spice/types';

type Comp = BuildNetlistInput['components'][number];
type Wire = BuildNetlistInput['wires'][number];

const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});
const pot: Comp = { id: 'pot', metadataId: 'potentiometer', properties: { value: 512 } };
const battery: Comp = { id: 'bat', metadataId: 'battery-9v', properties: {} };
const supply = (volts: number): Comp => ({
  id: 'ps',
  metadataId: 'power-supply',
  properties: { mode: 'dc', voltage: volts, currentLimit: 1 },
});

/** The circuit, with a voltmeter on the pot's wiper when there is a pot. */
function input(components: Comp[], wires: Wire[], boards: BoardForSpice[] = []): BuildNetlistInput {
  const meter = components.some((c) => c.id === 'pot') && !components.some((c) => c.id === 'vm');
  return {
    components: meter
      ? [...components, { id: 'vm', metadataId: 'instr-voltmeter', properties: {} }]
      : components,
    wires: meter
      ? [...wires, w('wm1', ['pot', 'SIG'], ['vm', 'V+']), w('wm2', ['vm', 'V-'], ['pot', 'GND'])]
      : wires,
    boards,
    analysis: { kind: 'op' },
  };
}

/** The pot's wiper and the deck, solved. */
async function wiper(inp: BuildNetlistInput) {
  const { netlist, pinNetMap } = buildNetlist(inp);
  const r = await runNetlist(netlist);
  return { volts: r.dcValue(`v(${pinNetMap.get('pot:SIG')})`), netlist, r, pinNetMap };
}

function esp32(): BoardForSpice {
  const g = BOARD_PIN_GROUPS.esp32;
  return {
    id: 'esp32',
    boardKind: 'esp32',
    vcc: g.vcc,
    pins: {},
    groundPinNames: g.gnd,
    vccPinNames: g.vcc_pins,
    auxPinNames: g.aux?.pins,
    auxVolts: g.aux?.volts,
  };
}

describe('a VCC pin follows the supply wired to it (#102)', () => {
  it('a pot on a 9 V battery divides 9 V, and Run sees no short', async () => {
    const inp = input(
      [battery, pot],
      [w('w1', ['bat', '+'], ['pot', 'VCC']), w('w2', ['bat', '−'], ['pot', 'GND'])],
    );
    const s = await wiper(inp);
    expect(s.netlist).not.toMatch(/V_VCC_RAIL/);
    expect(s.volts).toBeCloseTo(4.5, 2);
    const v = await verifyCircuit(inp);
    expect(v.errors).toEqual([]);
  });

  it('a pot on a 9 V bench supply divides 9 V', async () => {
    const s = await wiper(
      input(
        [supply(9), pot],
        [w('w1', ['ps', 'SIG'], ['pot', 'VCC']), w('w2', ['ps', 'GND'], ['pot', 'GND'])],
      ),
    );
    expect(s.volts).toBeCloseTo(4.5, 2);
  });

  it('a generator on a pot solves and is no source conflict', async () => {
    const gen: Comp = {
      id: 'gen',
      metadataId: 'signal-generator',
      properties: { waveform: 'dc', offset: 5, amplitude: 0, frequency: 1 },
    };
    const inp = input(
      [gen, pot],
      [w('w1', ['gen', 'SIG'], ['pot', 'VCC']), w('w2', ['gen', 'GND'], ['pot', 'GND'])],
    );
    const s = await wiper(inp);
    expect(s.volts).toBeCloseTo(2.5, 2);
    const v = await verifyCircuit(inp);
    expect(v.errors.map((e) => e.code)).toEqual([]);
  });

  it('a 7805 on a 9 V battery feeds the pot 5 V, and a 7812 on 15 V feeds it 12 V', async () => {
    for (const [reg, src, srcPin, volts] of [
      ['reg-7805', battery, '+', 5],
      ['reg-7812', supply(15), 'SIG', 12],
    ] as const) {
      const neg = src.id === 'bat' ? '−' : 'GND';
      const inp = input(
        [src, { id: 'u1', metadataId: reg, properties: {} }, pot],
        [
          w('w1', [src.id, srcPin], ['u1', 'VIN']),
          w('w2', [src.id, neg], ['u1', 'GND']),
          w('w3', ['u1', 'VOUT'], ['pot', 'VCC']),
          w('w4', ['pot', 'GND'], ['u1', 'GND']),
        ],
      );
      const s = await wiper(inp);
      expect(s.volts, reg).toBeCloseTo(volts / 2, 2);
      const v = await verifyCircuit(inp);
      expect(v.errors.map((e) => e.code), reg).toEqual([]);
    }
  });

  it('a pot behind a closed switch and an ammeter still runs from the battery', async () => {
    const inp = input(
      [
        battery,
        { id: 'sw', metadataId: 'slide-switch', properties: { value: 0 } },
        { id: 'am', metadataId: 'instr-ammeter', properties: {} },
        pot,
      ],
      [
        w('w1', ['bat', '+'], ['sw', '1']),
        w('w2', ['sw', '2'], ['am', 'A+']),
        w('w3', ['am', 'A-'], ['pot', 'VCC']),
        w('w4', ['pot', 'GND'], ['bat', '−']),
      ],
    );
    const s = await wiper(inp);
    expect(s.volts).toBeCloseTo(4.5, 2);
    // The ammeter carries the pot's current, 9 V across 10 kOhm.
    expect(Math.abs(s.r.dcValue('i(v_am_sense)'))).toBeCloseTo(0.0009, 5);
  });

  it('an open switch between the battery and the pot leaves the pot unpowered', async () => {
    const s = await wiper(
      input(
        [battery, { id: 'sw', metadataId: 'slide-switch', properties: { value: 1 } }, pot],
        [
          w('w1', ['bat', '+'], ['sw', '1']),
          w('w2', ['sw', '2'], ['pot', 'VCC']),
          w('w3', ['pot', 'GND'], ['bat', '−']),
        ],
      ),
    );
    expect(s.volts).toBeLessThan(0.01);
  });

  it("an op-amp's output does not take the rail from the pot that sets its input", async () => {
    // A pot on VCC pins only, its wiper into an inverting stage: the output
    // reaches the pot through the feedback resistors, but powers nothing.
    const s = await wiper(
      input(
        [
          pot,
          { id: 'u1', metadataId: 'opamp-lm358', properties: {} },
          { id: 'rin', metadataId: 'resistor', properties: { value: '1000' } },
          { id: 'rf', metadataId: 'resistor', properties: { value: '10000' } },
          { id: 'rl', metadataId: 'resistor', properties: { value: '1Meg' } },
        ],
        [
          w('w1', ['pot', 'VCC'], ['rl', '1']),
          w('w7', ['rl', '2'], ['pot', 'GND']),
          w('w2', ['pot', 'SIG'], ['rin', '1']),
          w('w3', ['rin', '2'], ['u1', 'IN-']),
          w('w4', ['u1', 'IN-'], ['rf', '1']),
          w('w5', ['rf', '2'], ['u1', 'OUT']),
          w('w6', ['u1', 'IN+'], ['pot', 'GND']),
        ],
      ),
    );
    expect(s.pinNetMap.get('pot:VCC')).toBe('vcc_rail');
  });

  it('with an ESP32 on the canvas, a pot on its own 9 V supply still divides 9 V', async () => {
    const s = await wiper(
      input(
        [supply(9), pot],
        [w('w1', ['ps', 'SIG'], ['pot', 'VCC']), w('w2', ['ps', 'GND'], ['pot', 'GND'])],
        [esp32()],
      ),
    );
    expect(s.volts).toBeCloseTo(4.5, 2);
  });

  it('a DHT22 on 9 V gets the over-voltage warning, not a short circuit', async () => {
    const inp = input(
      [battery, { id: 'dht', metadataId: 'dht22', properties: {} }],
      [w('w1', ['bat', '+'], ['dht', 'VCC']), w('w2', ['bat', '−'], ['dht', 'GND'])],
    );
    const v = await verifyCircuit(inp);
    expect(v.errors.map((e) => e.code)).toEqual([]);
    expect(v.warnings.map((e) => e.code)).toContain('over-voltage');
  });

  it('VCC pins wired only to each other still get the 5 V rail', async () => {
    // Nothing else powers them (analog-thermostat-comparator relies on this).
    const ntc: Comp = { id: 'ntc', metadataId: 'ntc-temperature-sensor', properties: { temperature: 25 } };
    const s = await wiper(
      input(
        [ntc, pot],
        [w('w1', ['ntc', 'VCC'], ['pot', 'VCC']), w('w2', ['ntc', 'GND'], ['pot', 'GND'])],
      ),
    );
    expect(s.netlist).toMatch(/^V_VCC_RAIL vcc_rail 0 DC 5$/m);
    expect(s.pinNetMap.get('pot:VCC')).toBe('vcc_rail');
    expect(s.volts).toBeCloseTo(2.5, 2);
  });
});
