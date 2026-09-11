/**
 * The 2026-09-05 canvas: a 9 V cell into a 7805 whose VOUT is wired into the
 * board's 5V pin. The board's 5V pin is the ideal V_VCC_RAIL source and the
 * 7805 is an ideal B-source, two sources on one node -> ngspice "singular
 * matrix" -> the live solver published no voltages and a voltmeter across a
 * second, perfectly wired battery read "0 V". The pre-flight said nothing.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { findSourceConflicts, verifyCircuit } from '../simulation/verify/circuitVerifier';
import type { BuildNetlistInput } from '../simulation/spice/types';

const wire = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

function incident(voutToRail: boolean): BuildNetlistInput {
  const wires = [
    wire('w1', ['bat', '+'], ['reg', 'VIN']),
    wire('w2', ['bat', '−'], ['reg', 'GND']),
    wire('w3', ['reg', 'GND'], ['uno', 'GND.1']),
  ];
  if (voutToRail) wires.push(wire('w4', ['reg', 'VOUT'], ['uno', '5V']));
  return {
    components: [
      { id: 'bat', metadataId: 'battery-9v', properties: {} },
      { id: 'reg', metadataId: 'reg-7805', properties: {} },
    ],
    wires,
    boards: [
      {
        id: 'uno',
        boardKind: 'arduino-uno',
        vcc: 5,
        groundPinNames: ['GND.1', 'GND.2'],
        vccPinNames: ['5V'],
        pins: {},
      } as BuildNetlistInput['boards'][number],
    ],
    analysis: { kind: 'op' },
  };
}

describe('source-conflict pre-flight rule', () => {
  it('names the regulator and the rail when VOUT is wired into the 5V pin', () => {
    const input = incident(true);
    const { netlist } = buildNetlist(input);
    const found = findSourceConflicts(netlist, input);
    expect(found).toHaveLength(1);
    expect(found[0]!.code).toBe('source-conflict');
    expect(found[0]!.severity).toBe('error');
    expect(found[0]!.componentId).toBe('reg');
    expect(found[0]!.message).toContain('reg-7805 reg output (VOUT)');
    expect(found[0]!.message).toContain('main supply rail');
  });

  it('is silent for the same circuit without that wire', () => {
    const input = incident(false);
    const { netlist } = buildNetlist(input);
    expect(findSourceConflicts(netlist, input)).toEqual([]);
  });

  it('flags a source shorted onto its own reference', () => {
    const input = incident(false);
    const found = findSourceConflicts('B_reg 0 0 V = min(V(n0)-2, 5)\n.op\n.end', input);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('reg-7805 reg output (VOUT)');
  });

  it('verifyCircuit blocks the incident circuit and never reports it as clean', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(incident(true));
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('source-conflict');
    expect(result.warnings.map((w) => w.code)).not.toContain('solver-failed');
  });

  it('verifyCircuit passes the corrected circuit', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(incident(false));
    expect(result.errors.map((e) => e.code)).not.toContain('source-conflict');
    expect(result.errors.map((e) => e.code)).not.toContain('solver-failed');
  });
});

/**
 * Cause G (project/gallery-libraries-2026-09): the pre-flight used to force
 * EVERY wired numeric pin HIGH, including the ADC pin a sensor module drives
 * with its own ideal source. Two ideal sources, one net, refused before a
 * single line compiled. Every Grove analog example on the XIAO went that way.
 */
import { buildPreflightSnapshot } from '../simulation/verify/verifyFromStore';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';

const board = (id: string, boardKind = 'arduino-uno') => ({ id, boardKind });
const comp = (id: string, metadataId: string, properties: Record<string, unknown> = {}) => ({ id, metadataId, properties });
const dcSource = (id: string) => comp(id, 'signal-generator', { waveform: 'dc', offset: 2.5 });

describe('pre-flight demotion: a pin a component already sources is an input', () => {
  it('does not stamp pin 0 when a component ideal source holds its net, and reports no conflict', async () => {
    const state = {
      components: [dcSource('sg')],
      wires: [wire('w1', ['sg', 'SIG'], ['uno', '0']), wire('w2', ['sg', 'GND'], ['uno', 'GND.1'])],
      boards: [board('uno')],
    };
    const { snap, synthesizedPins } = buildPreflightSnapshot(state);
    expect(snap.boards[0]!.pinStates['0']).toBeUndefined();
    expect(synthesizedPins.has('uno:0')).toBe(false);
    const res = await verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
    expect(res.errors.map((e) => e.code)).toEqual([]);
  });

  it('still forces an LED-driving pin HIGH and still catches a bare LED', async () => {
    const state = {
      components: [
        dcSource('sg'),
        comp('r1', 'resistor', { value: '220' }),
        comp('led1', 'led', { color: 'red' }),
        comp('led2', 'led', { color: 'red' }),
      ],
      wires: [
        wire('w1', ['sg', 'SIG'], ['uno', '0']),
        wire('w2', ['sg', 'GND'], ['uno', 'GND.1']),
        // pin 1 -> 220 R -> LED -> GND: a proper output, must still be forced HIGH
        wire('w3', ['uno', '1'], ['r1', '1']),
        wire('w4', ['r1', '2'], ['led1', 'A']),
        wire('w5', ['led1', 'C'], ['uno', 'GND.1']),
        // pin 13 -> bare LED -> GND: the defect the worst case exists to catch
        wire('w6', ['uno', '13'], ['led2', 'A']),
        wire('w7', ['led2', 'C'], ['uno', 'GND.2']),
      ],
      boards: [board('uno')],
    };
    const { snap, synthesizedPins } = buildPreflightSnapshot(state);
    expect(snap.boards[0]!.pinStates['0']).toBeUndefined();
    expect(snap.boards[0]!.pinStates['1']).toEqual({ type: 'digital', v: 5 });
    expect(snap.boards[0]!.pinStates['13']).toEqual({ type: 'digital', v: 5 });
    expect([...synthesizedPins].sort()).toEqual(['uno:1', 'uno:13']);
    const res = await verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
    expect(res.errors.map((e) => e.code)).not.toContain('source-conflict');
    expect(res.errors.map((e) => e.code)).toContain('led-overcurrent');
  });

  it('invents ONE source for two GPIOs that share a net (a board-to-board link)', () => {
    const state = {
      components: [],
      wires: [wire('w1', ['uno', '5'], ['uno-2', '6']), wire('w2', ['uno', 'GND.1'], ['uno-2', 'GND.1'])],
      boards: [board('uno'), board('uno-2')],
    };
    const { snap, synthesizedPins } = buildPreflightSnapshot(state);
    const stamped = snap.boards.flatMap((b) => Object.keys(b.pinStates).map((p) => `${b.id}:${p}`));
    expect(stamped).toHaveLength(1);
    expect(synthesizedPins.size).toBe(1);
  });

  it('names an invented source honestly when a conflict remains', () => {
    // Force the old behaviour by hand: pin 0 stamped although a component holds it.
    const input = buildInputFromStore({
      components: [dcSource('sg')],
      wires: [wire('w1', ['sg', 'SIG'], ['uno', '0']), wire('w2', ['sg', 'GND'], ['uno', 'GND.1'])],
      boards: [{ id: 'uno', boardKind: 'arduino-uno', pinStates: { '0': { type: 'digital', v: 5 } } }],
    } as never);
    const { netlist } = buildNetlist({ ...input, analysis: { kind: 'op' } });
    const found = findSourceConflicts(netlist, input, new Set(['uno:0']));
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('assumed HIGH by the circuit check');
    expect(found[0]!.message).not.toContain('driven by the MCU');
  });
});
