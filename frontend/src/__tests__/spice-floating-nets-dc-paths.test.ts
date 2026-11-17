/**
 * The floating-net detector follows every DC path (velxio/velxio-prod#99).
 *
 * NetlistBuilder gives a net it believes has no DC path to ground a 100 MOhm
 * pull-down (R_autopull_<net>), so ngspice can solve it. The walk read a
 * card's nodes only while they were canvas nets, so a part's internal node
 * (a supply's or a battery's `<id>_int`, an ammeter's `amm_<id>_mid`, an
 * LED's `<id>_sense_mid`) ended the card, and it never walked diodes, LEDs,
 * transistors or MOSFETs at all. Nets reached only through those parts got
 * a pull-down they did not need, and the book measured its current:
 *   - two ammeters in one series loop read 637.37 and 637.14 uA;
 *   - an IRF540 gate fed through an ammeter drew 100.0 nA;
 *   - the night-light's LED, held off by its transistor, carried 35.2 nA;
 *   - an ammeter in series with a blue LED that does not conduct read 18.2 nA.
 *
 * A junction is a DC path for this question: SPICE stamps GMIN across every
 * pn junction, so a node reached only through one is never singular. A
 * capacitor is not, nor is a MOSFET gate, nor the control input of a
 * controlled source or a switch: a net reached only through those keeps its
 * pull-down.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { runNetlist } from './helpers/testSolver';

type Part = { id: string; metadataId: string; properties: Record<string, unknown> };
type Link = [string, string, string, string];

function circuit(components: Part[], links: Link[]) {
  const wires = links.map(([a, pa, b, pb], i) => ({
    id: `w${i}`,
    start: { componentId: a, pinName: pa },
    end: { componentId: b, pinName: pb },
    color: '#666',
    waypoints: [],
  }));
  const input = buildInputFromStore({ components, wires, boards: [] });
  const built = buildNetlist(input);
  const pulled = built.netlist
    .split('\n')
    .filter((l) => l.startsWith('R_autopull_'))
    .map((l) => l.split(/\s+/)[1]!);
  return { ...built, pulled, net: (id: string, pin: string) => built.pinNetMap.get(`${id}:${pin}`)! };
}

async function solve(netlist: string) {
  const r = await runNetlist(netlist);
  return (name: string) => r.dcValue(name);
}

const supply = (id: string, voltage: number): Part => ({
  id,
  metadataId: 'power-supply',
  properties: { mode: 'dc', voltage, currentLimit: 1 },
});
const part = (id: string, metadataId: string, properties: Record<string, unknown> = {}): Part => ({
  id,
  metadataId,
  properties,
});

describe('floating nets: internal nodes and junctions are DC paths (#99)', () => {
  it('two ammeters in one series loop read the same current', async () => {
    // Supply -> A1 -> 4.7k -> A2 -> 10k -> supply GND.
    const c = circuit(
      [supply('ps1', 9), part('a1', 'instr-ammeter'), part('a2', 'instr-ammeter'),
        part('r1', 'resistor', { value: '4.7k' }), part('r2', 'resistor', { value: '10k' })],
      [
        ['ps1', 'SIG', 'a1', 'A+'], ['a1', 'A-', 'r1', '1'], ['r1', '2', 'a2', 'A+'],
        ['a2', 'A-', 'r2', '1'], ['r2', '2', 'ps1', 'GND'],
      ],
    );
    expect(c.pulled).toEqual([]);
    const v = await solve(c.netlist);
    const i1 = v('i(v_a1_sense)');
    const i2 = v('i(v_a2_sense)');
    // Equal within the solver's tolerance (abstol 1 pA); a 100 MOhm pull
    // on a 9 V net takes 90 nA.
    expect(Math.abs(i1 - i2)).toBeLessThan(1e-10);
    expect(i1).toBeCloseTo(9 / 14_700, 7);
  });

  it('an LED held off by its transistor carries no phantom current', async () => {
    // Supply -> 220 -> LED -> 2N2222 collector; base to GND through 10k (off).
    const c = circuit(
      [supply('ps1', 5), part('r1', 'resistor', { value: '220' }), part('d1', 'led', { color: 'red' }),
        part('q1', 'bjt-2n2222'), part('rb', 'resistor', { value: '10k' })],
      [
        ['ps1', 'SIG', 'r1', '1'], ['r1', '2', 'd1', 'A'], ['d1', 'C', 'q1', 'C'],
        ['q1', 'E', 'ps1', 'GND'], ['q1', 'B', 'rb', '1'], ['rb', '2', 'ps1', 'GND'],
      ],
    );
    expect(c.pulled).not.toContain(c.net('q1', 'C'));
    expect(c.pulled).toEqual([]);
    const v = await solve(c.netlist);
    expect(Math.abs(v('i(v_d1_sense)'))).toBeLessThan(1e-9);
  });

  it('a MOSFET gate fed through an ammeter draws no gate current', async () => {
    const c = circuit(
      [supply('ps1', 10), supply('ps2', 12), part('a1', 'instr-ammeter'), part('m1', 'mosfet-irf540'),
        part('rl', 'resistor', { value: '100' })],
      [
        ['ps1', 'SIG', 'a1', 'A+'], ['a1', 'A-', 'm1', 'G'], ['m1', 'S', 'ps1', 'GND'],
        ['ps2', 'SIG', 'rl', '1'], ['rl', '2', 'm1', 'D'], ['ps2', 'GND', 'ps1', 'GND'],
      ],
    );
    expect(c.pulled).toEqual([]);
    const v = await solve(c.netlist);
    expect(Math.abs(v('i(v_a1_sense)'))).toBeLessThan(1e-9);
  });

  it('an ammeter in series with a dark LED reads the LED current', async () => {
    // Supply 2 V -> 100 -> A2 -> blue LED -> GND: 2 V is under the blue LED's knee.
    const c = circuit(
      [supply('ps1', 2), part('a2', 'instr-ammeter'), part('r1', 'resistor', { value: '100' }),
        part('d1', 'led', { color: 'blue' })],
      [['ps1', 'SIG', 'r1', '1'], ['r1', '2', 'a2', 'A+'], ['a2', 'A-', 'd1', 'A'], ['d1', 'C', 'ps1', 'GND']],
    );
    expect(c.pulled).toEqual([]);
    const v = await solve(c.netlist);
    const meter = v('i(v_a2_sense)');
    const led = v('i(v_d1_sense)');
    expect(Math.abs(meter)).toBeLessThan(1e-9);
    expect(Math.abs(meter - led)).toBeLessThan(1e-10);
  });
});

describe('floating nets: what is not a DC path keeps its pull-down (#99)', () => {
  it('a MOSFET gate reached only through a capacitor', () => {
    const c = circuit(
      [supply('ps1', 10), part('c1', 'capacitor', { value: '100n' }), part('m1', 'mosfet-2n7000'),
        part('rl', 'resistor', { value: '1k' })],
      [
        ['ps1', 'SIG', 'c1', '1'], ['c1', '2', 'm1', 'G'], ['m1', 'S', 'ps1', 'GND'],
        ['ps1', 'SIG', 'rl', '1'], ['rl', '2', 'm1', 'D'],
      ],
    );
    expect(c.pulled).toEqual([c.net('m1', 'G')]);
  });

  it('an op-amp input wired to nothing but a capacitor', async () => {
    // An ideal op-amp senses its inputs and conducts nothing into them: a
    // net reached only through IN+ and a capacitor has no DC level of its
    // own, so it is the one that takes the pull-down (OUT at 0 V). The old
    // walk joined the input to the output instead and pulled the supply's
    // net; ngspice solved that deck to the same 0 V.
    const c = circuit(
      [supply('ps1', 5), part('u1', 'opamp-ideal'), part('c1', 'capacitor', { value: '1u' }),
        part('rf', 'resistor', { value: '10k' }), part('rl', 'resistor', { value: '10k' })],
      [
        ['ps1', 'SIG', 'c1', '1'], ['c1', '2', 'u1', 'IN+'], ['u1', 'IN-', 'u1', 'OUT'],
        ['u1', 'OUT', 'rl', '1'], ['rl', '2', 'ps1', 'GND'], ['rf', '1', 'u1', 'OUT'], ['rf', '2', 'ps1', 'GND'],
      ],
    );
    expect(c.pulled).toEqual([c.net('u1', 'IN+')]);
    const v = await solve(c.netlist);
    expect(v(`v(${c.net('u1', 'OUT')})`)).toBeCloseTo(0, 6);
  });
});
