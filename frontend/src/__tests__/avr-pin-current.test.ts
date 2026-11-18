/**
 * A board pin is a driver with an output impedance and a current limit
 * (velxio/velxio-prod#140).
 *
 * Every driven pin was an ideal source: pin 13 HIGH into 120 Ohm gave 5.00 V
 * and 41.7 mA, above the ATmega328P's 40 mA absolute maximum per I/O pin,
 * and nothing said so. A pin driven HIGH and wired straight to GND got no
 * source at all. A real pin sags: VOH >= 4.1 V at 20 mA (datasheet 7810D,
 * section 28.2), about 4.5 V typical (DS40002061B Figure 31-355), so about
 * 25 Ohm, the output impedance LogicFamilies.ts already gave the family and
 * nothing used. Its limits (section 28.1): 40 mA per I/O pin and 200 mA
 * through VCC and GND, with the DC characteristics specified at 20 mA.
 *
 * The AVR boards' pins are now their source behind 25 Ohm, on a pin wired to
 * a rail as anywhere else, and the run checks each driven pin's current
 * against 20 mA (warning) and 40 mA (error), and the board's total each way
 * against 200 mA. The 3.3 V boards keep their ideal pins until their own
 * datasheets are taken in.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import type { PinSourceState } from '../simulation/spice/types';
import { solveInput } from './helpers/solveInput';

/** The run's check, loaded per test so the netlist cases stand on their own. */
async function check(
  boards: Array<{ id: string; boardKind: string }>,
  branchCurrents: Record<string, number>,
  pinNetMap: Map<string, string>,
) {
  const { pinCurrentFindings } = await import('../simulation/verify/pinCurrent');
  return pinCurrentFindings(boards, branchCurrents, pinNetMap);
}

type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const wire = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

function input(
  boardKind: string,
  pins: Record<string, PinSourceState>,
  components: Array<{ id: string; metadataId: string; properties: Record<string, unknown> }>,
  wires: Wire[],
) {
  return {
    ...buildInputFromStore({
      components,
      wires: wires as never,
      boards: [{ id: 'b', boardKind: boardKind as never, pinStates: pins }],
    }),
    analysis: { kind: 'op' as const },
  };
}

const HIGH: PinSourceState = { type: 'digital', v: 5 };

describe('AVR pin drive (velxio/velxio-prod#140)', () => {
  it('pin 13 HIGH into 120 Ohm: about 34 mA with the pin at 4.14 V, not 41.7 mA at 5.00 V', async () => {
    const circuit = input(
      'arduino-uno',
      { '13': HIGH },
      [{ id: 'r1', metadataId: 'resistor', properties: { value: '120' } }],
      [wire('w1', ['b', '13'], ['r1', '1']), wire('w2', ['r1', '2'], ['b', 'GND.1'])],
    );
    const solved = await solveInput(circuit);
    const net = buildNetlist(circuit).pinNetMap.get('b:13')!;
    expect(solved.nodeVoltages[net]).toBeCloseTo(5 * (120 / 145), 3);
    expect(Math.abs(solved.branchCurrents['v_b_13']!)).toBeCloseTo(5 / 145, 5);
    const findings = await check(
      [{ id: 'b', boardKind: 'arduino-uno' }],
      solved.branchCurrents,
      buildNetlist(circuit).pinNetMap,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ boardId: 'b', pinName: '13', severity: 'warning' });
    expect(findings[0]!.message).toMatch(/34\.5 mA/);
  });

  it('a pin driven HIGH and wired straight to GND is a 200 mA short, and an error', async () => {
    const circuit = input('arduino-uno', { '13': HIGH }, [], [wire('w1', ['b', '13'], ['b', 'GND.2'])]);
    const { netlist } = buildNetlist(circuit);
    expect(netlist).toMatch(/^V_b_13 /m);
    const solved = await solveInput(circuit);
    expect(Math.abs(solved.branchCurrents['v_b_13']!)).toBeCloseTo(0.2, 4);
    const findings = await check([{ id: 'b', boardKind: 'arduino-uno' }], solved.branchCurrents, buildNetlist(circuit).pinNetMap);
    expect(findings.map((f) => f.severity)).toContain('error');
  });

  it('a pin LOW on GND carries nothing and is not reported', async () => {
    const circuit = input('arduino-uno', { '13': { type: 'digital', v: 0 } }, [], [wire('w1', ['b', '13'], ['b', 'GND.2'])]);
    const solved = await solveInput(circuit);
    expect(Math.abs(solved.branchCurrents['v_b_13'] ?? 0)).toBeLessThan(1e-9);
    expect(await check([{ id: 'b', boardKind: 'arduino-uno' }], solved.branchCurrents, buildNetlist(circuit).pinNetMap)).toEqual([]);
  });

  it("the board's total through VCC is checked too: eight pins at 30 mA each", async () => {
    const pinNetMap = new Map<string, string>();
    const branch: Record<string, number> = {};
    for (let p = 2; p <= 9; p++) {
      pinNetMap.set(`b:${p}`, `n${p}`);
      branch[`v_b_${p}`] = -0.03; // sourcing: current leaves the source's + node
    }
    const findings = await check([{ id: 'b', boardKind: 'arduino-uno' }], branch, pinNetMap);
    expect(findings.filter((f) => f.severity === 'warning')).toHaveLength(8);
    const total = findings.find((f) => f.pinName === undefined);
    expect(total?.severity).toBe('error');
    expect(total?.message).toMatch(/240(\.0)? mA/);
  });

  it('an LED on 220 Ohm stays a quiet 12 mA', async () => {
    const circuit = input(
      'arduino-uno',
      { '13': HIGH },
      [
        { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'd1', metadataId: 'led', properties: { color: 'red' } },
      ],
      [wire('w1', ['b', '13'], ['r1', '1']), wire('w2', ['r1', '2'], ['d1', 'A']), wire('w3', ['d1', 'C'], ['b', 'GND.1'])],
    );
    const solved = await solveInput(circuit);
    const i = Math.abs(solved.branchCurrents['v_b_13']!);
    expect(i).toBeGreaterThan(0.010);
    expect(i).toBeLessThan(0.0135);
    expect(await check([{ id: 'b', boardKind: 'arduino-uno' }], solved.branchCurrents, buildNetlist(circuit).pinNetMap)).toEqual([]);
  });

  it('an ESP32 pin keeps its ideal source and no limits', async () => {
    const circuit = input(
      'esp32',
      { '2': { type: 'digital', v: 3.3 } },
      [{ id: 'r1', metadataId: 'resistor', properties: { value: '120' } }],
      [wire('w1', ['b', '2'], ['r1', '1']), wire('w2', ['r1', '2'], ['b', 'GND'])],
    );
    const { netlist, pinNetMap } = buildNetlist(circuit);
    expect(netlist).toMatch(new RegExp(`^V_b_2 ${pinNetMap.get('b:2')} 0 DC 3.3$`, 'm'));
    expect(await check([{ id: 'b', boardKind: 'esp32' }], { v_b_2: -0.0275 }, pinNetMap)).toEqual([]);
  });
});
