/**
 * The L293D's outputs as the datasheet describes them (velxio/velxio-prod#165).
 *
 * Each output was an ideal voltage source from ground,
 * `B OUT 0 V = u(V(EN)-T) * u(V(IN)-T) * V(VCC2)`, with a 10 Mohm "high-Z"
 * resistor in parallel that did nothing. So:
 *  - with EN low an output sat at 0 V and sank whatever the load sent it
 *    (1 kohm to 5 V: 0.00 V and 5.00 mA), and a motor across a channel was
 *    shorted on both ends: braked where the real chip lets it coast;
 *  - an output had no drop: 5.000 V into 5 ohm, 1 A;
 *  - the current came out of node 0, never out of VCC2: a supply or an
 *    ammeter on VCC2 read 50 nA;
 *  - the logic threshold was half the board's supply, not the chip's.
 *
 * TI SLRS008D (L293D):
 *  - 8.1 / Table 1: EN low puts the outputs in the high-impedance state;
 *  - 6.5: VOH = VCC2 - 1.4 V typ and VOL = 1.2 V typ at 0.6 A, from a
 *    pseudo-Darlington source and a Darlington sink (8.1);
 *  - 6.5: the integrated clamp diodes, VOKH = VCC2 + 1.3 V and VOKL = 1.3 V
 *    at 0.6 A;
 *  - 6.3: VIH = 2.3 V min, VIL = 1.5 V max, whatever the board;
 *  - Figure 3: every input sits on a current source from VCC1, so an input
 *    left open reads HIGH.
 * The chip has no current limit (600 mA is a rating, 6.1), so none is
 * modelled.
 *
 * Every case is a netlist the real NetlistBuilder builds from a canvas,
 * solved on the shipped ngspice.
 */
import { describe, it, expect } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { solveInput } from './helpers/solveInput';
import type { PinSourceState } from '../simulation/spice/types';

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };
type End = { componentId: string; pinName: string };
const at = (componentId: string, pinName: string): End => ({ componentId, pinName });
const w = (id: string, a: End, b: End) => ({ id, start: a, end: b });

const UNO = 'arduino-uno';
const HIGH: PinSourceState = { type: 'digital', v: 5 };
const LOW: PinSourceState = { type: 'digital', v: 0 };

/** An L293D on an Uno: EN1 on 9, IN1 on 7, IN2 on 8, VCC1 on 5V, GND. */
function chip(extra: { components?: Comp[]; wires?: ReturnType<typeof w>[]; en?: boolean }) {
  const wires = [
    ...(extra.en === false ? [] : [w('w_en', at(UNO, '9'), at('u1', 'EN1'))]),
    w('w_in1', at(UNO, '7'), at('u1', 'IN1')),
    w('w_in2', at(UNO, '8'), at('u1', 'IN2')),
    w('w_vcc1', at(UNO, '5V'), at('u1', 'VCC1')),
    w('w_gnd', at('u1', 'GND.1'), at(UNO, 'GND')),
    ...(extra.wires ?? []),
  ];
  const components: Comp[] = [{ id: 'u1', metadataId: 'motor-driver-l293d', properties: {} }, ...(extra.components ?? [])];
  return { components, wires };
}

async function solve(canvas: ReturnType<typeof chip>, pins: Record<string, PinSourceState>) {
  const input = buildInputFromStore({
    components: canvas.components,
    wires: canvas.wires as never,
    boards: [{ id: UNO, boardKind: UNO, pinStates: pins }],
  });
  const s = await solveInput(input);
  const v = (key: string): number => {
    const net = s.pinNetMap.get(key);
    if (net === '0') return 0;
    return s.nodeVoltages[net ?? ''] ?? NaN;
  };
  const i = (source: string): number => s.branchCurrents[source.toLowerCase()] ?? NaN;
  return { s, v, i };
}

const R = (id: string, value: string): Comp => ({ id, metadataId: 'resistor', properties: { value } });
const supply = (id: string, voltage: number): Comp => ({
  id,
  metadataId: 'power-supply',
  properties: { mode: 'dc', voltage, currentLimit: 2 },
});

describe('L293D outputs (velxio/velxio-prod#165)', () => {
  it('EN low: the output is high-impedance, so a pull-up lifts it and nothing is sunk', { timeout: 30_000 }, async () => {
    const { v } = await solve(
      chip({
        components: [R('rp', '1000')],
        wires: [w('w_vcc2', at(UNO, '5V'), at('u1', 'VCC2')), w('w_r1', at('u1', 'OUT1'), at('rp', '1')), w('w_r2', at('rp', '2'), at(UNO, '5V'))],
      }),
      { '9': LOW, '7': HIGH, '8': LOW },
    );
    // Through 1 kohm from 5 V: under a microamp, so OUT1 sits at 5 V.
    expect(v('u1:OUT1')).toBeGreaterThan(4.999);
  });

  it('EN low lets a turning motor coast; the same motor braked (IN1 = IN2, EN high) carries current', { timeout: 30_000 }, async () => {
    // A motor that is still turning: its back-EMF (a 3 V cell) in series
    // with its winding (56 ohm), across OUT1 / OUT2. Below VCC2 plus two
    // clamp drops, so the disabled outputs give it no path; braked, the sink
    // on one side and the clamp to ground on the other carry it.
    const canvas = chip({
      components: [R('rm', '56'), { id: 'emf', metadataId: 'battery-coin-cell', properties: {} }],
      wires: [
        w('w_vcc2', at(UNO, '5V'), at('u1', 'VCC2')),
        w('w_m1', at('u1', 'OUT1'), at('rm', '1')),
        w('w_m2', at('rm', '2'), at('emf', '+')),
        w('w_m3', at('emf', '−'), at('u1', 'OUT2')),
      ],
    });
    const coast = await solve(canvas, { '9': LOW, '7': LOW, '8': LOW });
    expect(Math.abs(coast.i('v_emf'))).toBeLessThan(1e-6);
    const brake = await solve(canvas, { '9': HIGH, '7': LOW, '8': LOW });
    expect(Math.abs(brake.i('v_emf'))).toBeGreaterThan(0.01);
  });

  it('drops VCC2 - 1.4 V on the source side and 1.2 V on the sink side at 0.6 A', { timeout: 30_000 }, async () => {
    const { v, i } = await solve(
      chip({
        components: [supply('ps', 12), R('rh', '17.67'), R('rl', '18')],
        wires: [
          w('w_vcc2', at('ps', '+'), at('u1', 'VCC2')),
          w('w_psg', at('ps', '-'), at(UNO, 'GND')),
          // OUT1 sources 0.6 A into 17.67 ohm to ground ...
          w('w_h1', at('u1', 'OUT1'), at('rh', '1')),
          w('w_h2', at('rh', '2'), at(UNO, 'GND')),
          // ... and OUT2 sinks 0.6 A from 12 V through 18 ohm.
          w('w_l1', at('ps', '+'), at('rl', '1')),
          w('w_l2', at('rl', '2'), at('u1', 'OUT2')),
        ],
      }),
      { '9': HIGH, '7': HIGH, '8': LOW },
    );
    const vcc2 = v('u1:VCC2');
    expect(vcc2 - v('u1:OUT1')).toBeGreaterThan(1.3);
    expect(vcc2 - v('u1:OUT1')).toBeLessThan(1.5);
    expect(v('u1:OUT2')).toBeGreaterThan(1.1);
    expect(v('u1:OUT2')).toBeLessThan(1.3);
    // The supply on VCC2 delivers both currents.
    expect(Math.abs(i('v_ps'))).toBeGreaterThan(1.1);
  });

  it('the load current comes out of VCC2: a supply there delivers it', { timeout: 30_000 }, async () => {
    const { v, i } = await solve(
      chip({
        components: [supply('ps', 9), R('rm', '56')],
        wires: [
          w('w_vcc2', at('ps', '+'), at('u1', 'VCC2')),
          w('w_psg', at('ps', '-'), at(UNO, 'GND')),
          w('w_m1', at('u1', 'OUT1'), at('rm', '1')),
          w('w_m2', at('rm', '2'), at('u1', 'OUT2')),
        ],
      }),
      { '9': HIGH, '7': HIGH, '8': LOW },
    );
    const load = (v('u1:OUT1') - v('u1:OUT2')) / 56;
    expect(load).toBeGreaterThan(0.05);
    // 9 V less about 2.2 V of drops across 56 ohm.
    expect(load).toBeLessThan(0.13);
    expect(Math.abs(i('v_ps'))).toBeCloseTo(load, 4);
  });

  it('an EN left open reads HIGH: each input sits on a current source from VCC1', { timeout: 30_000 }, async () => {
    const { v } = await solve(
      chip({
        en: false,
        components: [R('rm', '56')],
        wires: [w('w_vcc2', at(UNO, '5V'), at('u1', 'VCC2')), w('w_m1', at('u1', 'OUT1'), at('rm', '1')), w('w_m2', at('rm', '2'), at('u1', 'OUT2'))],
      }),
      { '7': HIGH, '8': LOW },
    );
    expect(v('u1:OUT1') - v('u1:OUT2')).toBeGreaterThan(2);
  });

  it("reads its inputs against the chip's own thresholds (VIH 2.3 V, VIL 1.5 V), not half the board's supply", { timeout: 30_000 }, async () => {
    const canvas = chip({
      components: [R('rm', '56')],
      wires: [w('w_vcc2', at(UNO, '5V'), at('u1', 'VCC2')), w('w_m1', at('u1', 'OUT1'), at('rm', '1')), w('w_m2', at('rm', '2'), at('u1', 'OUT2'))],
    });
    const enabled = await solve(canvas, { '9': { type: 'digital', v: 2.4 }, '7': { type: 'digital', v: 2.4 }, '8': LOW });
    expect(enabled.v('u1:OUT1') - enabled.v('u1:OUT2')).toBeGreaterThan(2);
    const disabled = await solve(canvas, { '9': { type: 'digital', v: 1.4 }, '7': HIGH, '8': LOW });
    expect(Math.abs(disabled.v('u1:OUT1') - disabled.v('u1:OUT2'))).toBeLessThan(0.01);
  });

  it('the clamp diodes hold a disabled output a diode drop above VCC2', { timeout: 30_000 }, async () => {
    const { v } = await solve(
      chip({
        components: [supply('ps', 12), R('rp', '100')],
        wires: [
          w('w_vcc2', at(UNO, '5V'), at('u1', 'VCC2')),
          w('w_psg', at('ps', '-'), at(UNO, 'GND')),
          w('w_p1', at('ps', '+'), at('rp', '1')),
          w('w_p2', at('rp', '2'), at('u1', 'OUT1')),
        ],
      }),
      { '9': LOW, '7': LOW, '8': LOW },
    );
    // 12 V through 100 ohm into a 5 V VCC2: about 60 mA through the clamp.
    expect(v('u1:OUT1')).toBeGreaterThan(5.4);
    expect(v('u1:OUT1')).toBeLessThan(6.2);
  });
});
