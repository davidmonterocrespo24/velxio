/**
 * An input that reaches nothing but an open contact floats, and Velxio's
 * floating node reads LOW (velxio/velxio-prod#192).
 *
 * A net with no DC path to a source gets a 100 MOhm pull-down (NetlistBuilder,
 * detectFloatingNets): Velxio's convention for a floating input, the one the
 * digital gate engine follows too (an open throw is Hi-Z and reads 0). An
 * open switch leg is a 1 GOhm resistor, and the floating-net walk counted it
 * as a path: a gate input or an MCU pin wired only to an open switch whose
 * other side is on 5 V sat at 5.000 V through that 1 GOhm, read HIGH, and a
 * voltmeter's 10 MOhm on it pulled it to 49.5 mV, so measuring changed the
 * result. On real parts such an input floats (Arduino reference: "unpredictable
 * results"; ATmega328P input leakage up to 1 uA against 1 GOhm is 1 kV, TI
 * SCBA004E): what decides it is the pull-up or pull-down the circuit lacks.
 * A resistance of 1 GOhm or more, and a relay's contact (open or closed as
 * the solve decides), is no DC path for that walk now.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { NgSpiceNodeAdapter } from '../simulation/spice/adapters/NgSpiceNodeAdapter';

const w = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
  waypoints: [],
  color: '#0af',
});
type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };

const solver = new NgSpiceNodeAdapter();
beforeAll(async () => {
  await solver.init();
}, 60_000);
afterAll(() => solver.dispose());

/** Operating point of a canvas: volts on the given component pins and the
 *  branch currents of the deck's sources. */
async function solve(
  components: Comp[],
  wires: ReturnType<typeof w>[],
  boards: Array<{ id: string; boardKind: string; pinStates: Record<string, unknown> }> = [],
) {
  const input = buildInputFromStore({ components, wires, boards } as never);
  input.analysis = { kind: 'op' };
  const res = buildNetlist(input);
  await solver.loadCircuit(res.netlist);
  const result = await solver.solve(
    { kind: 'op' },
    { vectorsOfInterest: [...res.nets.map((n) => `v(${n})`), ...res.voltageSources.map((v) => `i(${v.toLowerCase()})`)] },
  );
  const volts = (key: string): number => {
    const net = res.pinNetMap.get(key);
    if (net === '0') return 0;
    return result.vectors.get(`v(${net})`)?.real[0] ?? NaN;
  };
  const amps = (source: string): number => Math.abs(result.vectors.get(`i(${source})`)?.real[0] ?? NaN);
  const netOf = (key: string): string | undefined => res.pinNetMap.get(key);
  return { volts, amps, netOf, netlist: res.netlist };
}

/** The alarm of the book's chapter 18 with RS2 left out: Y = A AND B, A from
 *  S1 (with its pull-down RS1), B from S2 alone. */
function alarm(s1: 0 | 1, s2: 0 | 1, extra: { comps?: Comp[]; wires?: ReturnType<typeof w>[] } = {}) {
  const components: Comp[] = [
    { id: 'pwr', metadataId: 'signal-generator', properties: { waveform: 'dc', offset: 5, amplitude: 0, frequency: 1 } },
    { id: 's1', metadataId: 'slide-switch', properties: { value: s1 } },
    { id: 'rs1', metadataId: 'resistor', properties: { value: '10000' } },
    { id: 's2', metadataId: 'slide-switch', properties: { value: s2 } },
    { id: 'u1', metadataId: 'logic-gate-and', properties: {} },
    { id: 'rl', metadataId: 'resistor', properties: { value: '220' } },
    { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
    ...(extra.comps ?? []),
  ];
  const wires = [
    w('p1', ['pwr', 'SIG'], ['s1', '3']),
    w('a1', ['s1', '2'], ['u1', 'A']),
    w('a2', ['s1', '2'], ['rs1', '1']),
    w('a3', ['rs1', '2'], ['pwr', 'GND']),
    w('p2', ['pwr', 'SIG'], ['s2', '3']),
    w('b1', ['s2', '2'], ['u1', 'B']),
    w('y1', ['u1', 'Y'], ['rl', '1']),
    w('y2', ['rl', '2'], ['led1', 'A']),
    w('y3', ['led1', 'C'], ['pwr', 'GND']),
    ...(extra.wires ?? []),
  ];
  return { components, wires };
}

describe('an input on an open contact reads LOW, as a floating input does', () => {
  it('the alarm without RS2: B is LOW with S2 open, and the LED stays dark while S1 is on', { timeout: 60_000 }, async () => {
    const { components, wires } = alarm(1, 0);
    const { volts, amps } = await solve(components, wires);
    expect(volts('u1:B')).toBeLessThan(1);
    expect(amps('v_led1_sense')).toBeLessThan(1e-6);
  });

  it('closing S2 still lights the LED', { timeout: 60_000 }, async () => {
    const { components, wires } = alarm(1, 1);
    const { volts, amps } = await solve(components, wires);
    expect(volts('u1:B')).toBeGreaterThan(4.9);
    expect(amps('v_led1_sense')).toBeGreaterThan(0.01);
  });

  it('a voltmeter on B no longer changes the answer', { timeout: 60_000 }, async () => {
    const meter = { id: 'vm', metadataId: 'instr-voltmeter', properties: {} };
    const { components, wires } = alarm(1, 0, {
      comps: [meter],
      wires: [w('m1', ['vm', 'V+'], ['u1', 'B']), w('m2', ['vm', 'V-'], ['pwr', 'GND'])],
    });
    const { amps } = await solve(components, wires);
    expect(amps('v_led1_sense')).toBeLessThan(1e-6);
  });

  it('an MCU input with a button to 5 V and no pull reads LOW open and HIGH pressed', { timeout: 60_000 }, async () => {
    const uno = [{ id: 'arduino-uno', boardKind: 'arduino-uno', pinStates: {} }];
    const wires = [w('w1', ['arduino-uno', '2'], ['btn', '1.l']), w('w2', ['btn', '2.l'], ['arduino-uno', '5V'])];
    const open = await solve([{ id: 'btn', metadataId: 'pushbutton', properties: { pressed: false } }], wires, uno);
    expect(open.volts('arduino-uno:2')).toBeLessThan(1);
    const pressed = await solve([{ id: 'btn', metadataId: 'pushbutton', properties: { pressed: true } }], wires, uno);
    expect(pressed.volts('arduino-uno:2')).toBeGreaterThan(4.9);
  });

  it('a gate input on a relay\'s open contact reads LOW, and HIGH once the coil pulls in', { timeout: 60_000 }, async () => {
    const relayCircuit = (coilOn: 0 | 1) => {
      const { components, wires } = alarm(1, 1);
      // B now comes from a relay's NO contact instead of S2; the coil is
      // switched by a third slide switch from the 5 V rail.
      const comps = components.filter((c) => c.id !== 's2');
      comps.push(
        { id: 'k1', metadataId: 'relay', properties: {} },
        { id: 's3', metadataId: 'slide-switch', properties: { value: coilOn } },
      );
      const ws = wires.filter((x) => x.id !== 'p2' && x.id !== 'b1');
      ws.push(
        w('k1', ['pwr', 'SIG'], ['k1', 'COM']),
        w('k2', ['k1', 'NO'], ['u1', 'B']),
        w('k3', ['pwr', 'SIG'], ['s3', '3']),
        w('k4', ['s3', '2'], ['k1', 'COIL+']),
        w('k5', ['k1', 'COIL-'], ['pwr', 'GND']),
      );
      return { comps, ws };
    };
    const off = relayCircuit(0);
    const a = await solve(off.comps, off.ws);
    expect(a.volts('u1:B')).toBeLessThan(1);
    const on = relayCircuit(1);
    const b = await solve(on.comps, on.ws);
    expect(b.volts('u1:B')).toBeGreaterThan(4.9);
  });

  it('a node held only through an ordinary resistor keeps its level (no pull-down added)', { timeout: 60_000 }, async () => {
    // RS2 back in place as a 10 k pull-up instead of a pull-down: B must
    // stay at 5 V with S2 open.
    const { components, wires } = alarm(1, 0, {
      comps: [{ id: 'rs2', metadataId: 'resistor', properties: { value: '10000' } }],
      wires: [w('r1', ['pwr', 'SIG'], ['rs2', '1']), w('r2', ['rs2', '2'], ['u1', 'B'])],
    });
    const { volts, netOf, netlist } = await solve(components, wires);
    expect(volts('u1:B')).toBeGreaterThan(4.99);
    expect(netlist).not.toContain(`R_autopull_${netOf('u1:B')} `);
  });
});
