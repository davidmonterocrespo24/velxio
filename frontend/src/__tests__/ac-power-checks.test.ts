/**
 * Alternating sources meet the power checks (velxio/velxio-prod#117).
 *
 * The circuit check solved an operating point, the circuit at t = 0, where a
 * sine with no offset is 0 V and a square wave sits at its low level. The
 * burnout model read the last sample of the live transient, which for a
 * generator's window of whole periods is a zero crossing. A 12 V-peak sine
 * across 100 ohm dissipates Vrms^2 / R = 72 / 100 = 0.72 W on average, 2.9x a
 * 1/4 W rating; the check saw 0 W and the burnout 1.4e-30 W.
 *
 * Now a circuit whose source moves on its own is also solved over the
 * window the live simulation runs, and the checks take the time-weighted
 * mean power (and a supply's peak current, a source's RMS current, a
 * capacitor's highest and lowest voltage) over the span the meters read.
 * The burnout model does the same with the capture and the publish window
 * the store holds.
 */
import { describe, it, expect } from 'vitest';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildPreflightSnapshot, type PreflightState } from '../simulation/verify/verifyFromStore';
import { componentStress } from '../simulation/parts/runtimeBurnout';
import type { TimeWaveforms } from '../simulation/spice/types';

type Part = { id: string; metadataId: string; properties: Record<string, unknown> };

/** A source's SIG (or +) through one resistor back to its GND, built as the Run button builds it. */
function sourceIntoLoad(source: Part, load: Part, extra: Part[] = [], extraLinks: Array<[string, string, string, string]> = []) {
  const links: Array<[string, string, string, string]> = [
    [source.id, 'SIG', load.id, '1'],
    [load.id, '2', source.id, 'GND'],
    ...extraLinks,
  ];
  const wires = links.map(([a, pa, b, pb], i) => ({
    id: `w${i}`,
    start: { componentId: a, pinName: pa, x: 0, y: 0 },
    end: { componentId: b, pinName: pb, x: 0, y: 0 },
    color: '#666',
    waypoints: [],
  }));
  return buildInputFromStore({ components: [source, load, ...extra], wires, boards: [] });
}

const generator = (props: Record<string, unknown>): Part => ({ id: 'g1', metadataId: 'signal-generator', properties: props });
const acSupply = (props: Record<string, unknown>): Part => ({
  id: 'ps1',
  metadataId: 'power-supply',
  properties: { mode: 'ac', frequency: 50, ...props },
});
const resistor = (value: string, extra: Record<string, unknown> = {}): Part => ({
  id: 'r1',
  metadataId: 'resistor',
  properties: { value, ...extra },
});

describe('the circuit check sees what an alternating source dissipates (#117)', () => {
  it('a 12 V-peak sine across 100 ohm: 0.72 W on average', { timeout: 60_000 }, async () => {
    const input = sourceIntoLoad(generator({ waveform: 'sine', frequency: 50, amplitude: 12, offset: 0 }), resistor('100'));
    expect(input.analysis.kind).toBe('tran');
    const res = await verifyCircuit(input);
    const over = res.warnings.filter((w) => w.code === 'resistor-overpower');
    expect(over.map((w) => w.componentId)).toEqual(['r1']);
    expect(over[0]!.metric).toBeGreaterThan(0.72 * 0.97);
    expect(over[0]!.metric).toBeLessThan(0.72 * 1.03);
    expect(over[0]!.message).toContain('on average');
  });

  it('the same from a supply in AC mode', { timeout: 60_000 }, async () => {
    const input = sourceIntoLoad(acSupply({ voltage: 12, currentLimit: 1 }), resistor('100'));
    const res = await verifyCircuit(input);
    const over = res.warnings.filter((w) => w.code === 'resistor-overpower');
    expect(over.map((w) => w.componentId)).toEqual(['r1']);
    expect(over[0]!.metric).toBeGreaterThan(0.72 * 0.97);
    expect(over[0]!.metric).toBeLessThan(0.72 * 1.03);
  });

  it('a 0-24 V square wave, which starts at its low level', { timeout: 60_000 }, async () => {
    // Half the time 24 V across 470 ohm: 576 / 470 / 2 = 0.613 W.
    const input = sourceIntoLoad(generator({ waveform: 'square', frequency: 100, amplitude: 12, offset: 12 }), resistor('470'));
    const res = await verifyCircuit(input);
    const over = res.warnings.filter((w) => w.code === 'resistor-overpower');
    expect(over.map((w) => w.componentId)).toEqual(['r1']);
    expect(over[0]!.metric).toBeGreaterThan(0.613 * 0.95);
    expect(over[0]!.metric).toBeLessThan(0.613 * 1.05);
  });

  it('respects the rating the part carries', { timeout: 60_000 }, async () => {
    const input = sourceIntoLoad(
      generator({ waveform: 'sine', frequency: 50, amplitude: 12, offset: 0 }),
      resistor('100', { power: '1' }),
    );
    const res = await verifyCircuit(input);
    expect(res.warnings.filter((w) => w.code === 'resistor-overpower')).toEqual([]);
  });

  it('stays quiet within the rating', { timeout: 60_000 }, async () => {
    // 12 V peak across 1 kOhm: 72 mW.
    const input = sourceIntoLoad(generator({ waveform: 'sine', frequency: 50, amplitude: 12, offset: 0 }), resistor('1k'));
    const res = await verifyCircuit(input);
    expect(res.errors).toEqual([]);
    expect(res.warnings.filter((w) => w.code === 'resistor-overpower')).toEqual([]);
  });

  it('an AC supply that meets its current limit at its peaks', { timeout: 60_000 }, async () => {
    // 12 V peak into 10 ohm asks for 1.2 A peaks from a 0.5 A supply.
    const input = sourceIntoLoad(acSupply({ voltage: 12, currentLimit: 0.5 }), resistor('10'));
    const res = await verifyCircuit(input);
    const overload = res.errors.filter((e) => e.code === 'source-overload');
    expect(overload.map((e) => e.componentId)).toEqual(['ps1']);
    expect(overload[0]!.message).toMatch(/peaks/);
  });

  it('a generator delivering more than the short-circuit threshold (RMS)', { timeout: 60_000 }, async () => {
    // 12 V peak into 10 ohm: 0.85 A RMS.
    const input = sourceIntoLoad(generator({ waveform: 'sine', frequency: 50, amplitude: 12, offset: 0 }), resistor('10', { power: '5' }));
    const res = await verifyCircuit(input);
    const short = res.errors.filter((e) => e.code === 'short-circuit');
    expect(short.map((e) => e.componentId)).toEqual(['g1']);
    expect(short[0]!.metric).toBeCloseTo(12 / Math.SQRT2 / 10, 1);
  });

  it('an electrolytic capacitor straight across a sine: reverse-biased half the time', { timeout: 60_000 }, async () => {
    const cap: Part = { id: 'c1', metadataId: 'capacitor-electrolytic', properties: { value: '10u', voltage: '25' } };
    const input = sourceIntoLoad(
      generator({ waveform: 'sine', frequency: 50, amplitude: 5, offset: 0 }),
      resistor('1k'),
      [cap],
      [['g1', 'SIG', 'c1', '+'], ['c1', '−', 'g1', 'GND']],
    );
    const res = await verifyCircuit(input);
    const reverse = res.warnings.filter((w) => w.code === 'reverse-polarity');
    expect(reverse.map((w) => w.componentId)).toEqual(['c1']);
    expect(reverse[0]!.metric).toBeLessThan(-4.5);
  });
});

describe("a supply on a board's power pin is a fight with the board's rail, not an overload (#117, #96)", () => {
  // A board's power pins are ideal sources in the netlist (an ESP32's 3V3
  // regulator output, its USB 5 V behind a diode on VIN, an Uno's 5V), so a
  // supply at another voltage there sits at its current limit whatever the
  // limit is, and the check names that fight as a supply-on-rail warning
  // (#96). An AC supply's peak current over the window comes out a hair above
  // its operating-point current, and the check took that for a load that
  // clips the supply at its peaks: it blocked Run with "Raise the
  // currentLimit", at a 10 A limit too.
  const link = (id: string, a: string, b: string) => {
    const [ac, ap] = a.split(':');
    const [bc, bp] = b.split(':');
    return {
      id,
      start: { componentId: ac!, pinName: ap! },
      end: { componentId: bc!, pinName: bp! },
    };
  };
  type Extra = Pick<PreflightState, 'components' | 'wires'>;
  const supplyOnPin = (
    board: { boardKind: string; id: string; pin: string; gnd: string },
    properties: Record<string, unknown>,
    extra: Extra = { components: [], wires: [] },
  ): PreflightState => ({
    components: [{ id: 'ps', metadataId: 'power-supply', properties }, ...extra.components],
    wires: [
      link('w0', 'ps:SIG', `${board.id}:${board.pin}`),
      link('w1', 'ps:GND', `${board.id}:${board.gnd}`),
      ...extra.wires,
    ],
    boards: [{ id: board.id, boardKind: board.boardKind }],
  });
  /** A resistor from `pin` to a 5 V-peak, 50 Hz generator whose GND is `gnd`. */
  const generatorFrom = (pin: string, ohms: string, gnd: string): Extra => ({
    components: [
      {
        id: 'g1',
        metadataId: 'signal-generator',
        properties: { waveform: 'sine', frequency: 50, amplitude: 5, offset: 0 },
      },
      { id: 'rl', metadataId: 'resistor', properties: { value: ohms, power: '20' } },
    ],
    wires: [link('w2', pin, 'rl:1'), link('w3', 'rl:2', 'g1:SIG'), link('w4', 'g1:GND', gnd)],
  });
  async function supplyFindings(state: PreflightState) {
    const { snap, synthesizedPins } = buildPreflightSnapshot(state);
    const input = buildInputFromStore(snap);
    // Every circuit here is also solved over the window: something on it moves.
    expect(input.analysis.kind === 'tran' && input.analysis.timeVarying).toBe(true);
    const res = await verifyCircuit(input, { synthesizedPins });
    return { res, mine: [...res.errors, ...res.warnings].filter((f) => f.componentId === 'ps') };
  }

  const pins = [
    { boardKind: 'esp32', id: 'esp32', pin: '3V3', gnd: 'GND' },
    { boardKind: 'esp32', id: 'esp32', pin: 'VIN', gnd: 'GND' },
    { boardKind: 'arduino-uno', id: 'uno', pin: '5V', gnd: 'GND.1' },
  ];
  for (const board of pins) {
    for (const limit of [1, 10]) {
      it(
        `5 V AC on the ${board.pin} pin of ${board.id}, ${limit} A limit: a warning`,
        { timeout: 60_000 },
        async () => {
          const { res, mine } = await supplyFindings(
            supplyOnPin(board, { mode: 'ac', voltage: 5, frequency: 50, currentLimit: limit }),
          );
          expect(res.errors).toEqual([]);
          expect(mine.map((f) => f.code)).toEqual(['supply-on-rail']);
          expect(mine[0]!.message).toContain(`${board.pin} pin of ${board.id}`);
          expect(mine[0]!.message).toContain(`its ${limit} A current limit`);
          expect(mine[0]!.message).toMatch(/fight over that pin/);
          expect(mine[0]!.message).not.toMatch(/asks for more|Raise the currentLimit|peaks/);
        },
      );
    }
  }

  it(
    'a DC supply on 3V3 with a generator elsewhere on the canvas keeps its warning',
    { timeout: 60_000 },
    async () => {
      const esp32 = pins[0]!;
      const { res, mine } = await supplyFindings(
        supplyOnPin(
          esp32,
          { mode: 'dc', voltage: 5, frequency: 50, currentLimit: 1 },
          generatorFrom('esp32:GND', '1k', 'esp32:GND'),
        ),
      );
      expect(res.errors).toEqual([]);
      expect(mine.map((f) => f.code)).toEqual(['supply-on-rail']);
      expect(mine[0]!.message).toMatch(/back-feed/);
    },
  );

  it(
    "a supply that powers the board through VIN and meets its limit at its load's peaks still blocks",
    { timeout: 60_000 },
    async () => {
      // 9 V into VIN, and 10 ohm from the 5V pin (the same net on the board) to
      // a 5 V-peak sine: 0.9 A at t = 0, and 1.4 A asked at the sine's troughs.
      const { mine } = await supplyFindings(
        supplyOnPin(
          pins[1]!,
          { mode: 'dc', voltage: 9, frequency: 50, currentLimit: 1 },
          generatorFrom('esp32:5V', '10', 'esp32:GND'),
        ),
      );
      expect(mine.map((f) => f.code)).toEqual(['source-overload']);
      expect(mine[0]!.message).toMatch(/peaks/);
    },
  );
});

describe('the burnout model averages over what the solve published (#117)', () => {
  const pinNetMap = new Map([
    ['r1:1', 'n0'],
    ['r1:2', '0'],
    ['c1:+', 'n0'],
    ['c1:−', '0'],
  ]);
  /** Four periods of a 50 Hz sine at T/20, ending on a zero crossing, as a capture. */
  function sineCapture(peak: number): TimeWaveforms {
    const time: number[] = [];
    const v: number[] = [];
    for (let i = 0; i <= 80; i++) {
      const t = i * 0.001;
      time.push(t);
      v.push(peak * Math.sin(2 * Math.PI * 50 * t));
    }
    return { time, nodes: new Map([['n0', v]]), branches: new Map(), period: 0.02 };
  }

  it('a resistor on a sine: the mean power, not the last sample', () => {
    const tw = sineCapture(12);
    const last = { n0: tw.nodes.get('n0')!.at(-1)!, '0': 0 };
    const r1 = { id: 'r1', metadataId: 'resistor', properties: { value: '100' } };
    // The instant alone is a zero crossing.
    expect(componentStress(r1, last, pinNetMap)!.ratio).toBeLessThan(1e-20);
    const s = componentStress(r1, last, pinNetMap, { timeWaveforms: tw })!;
    // 0.72 W against 2 x 1/4 W.
    expect(s.ratio).toBeCloseTo(0.72 / 0.5, 2);
    expect(s.message).toContain('0.72 W on average');
  });

  it('a resistor on a PWM pad: the states weighted by their shares', () => {
    // 25 % at 12 V across 100 ohm (1.44 W), 75 % at 0 V: 0.36 W.
    const window = {
      states: [
        { weight: 0.25, nodeVoltages: { n0: 12 } },
        { weight: 0.75, nodeVoltages: { n0: 0 } },
      ],
    };
    const r1 = { id: 'r1', metadataId: 'resistor', properties: { value: '100' } };
    expect(componentStress(r1, { n0: 12 }, pinNetMap)!.ratio).toBeCloseTo(1.44 / 0.5, 3);
    expect(componentStress(r1, { n0: 12 }, pinNetMap, { window })!.ratio).toBeCloseTo(0.36 / 0.5, 3);
  });

  it('an electrolytic capacitor on a sine: its peak and its reverse half', () => {
    const c1 = (voltage: string) => ({ id: 'c1', metadataId: 'capacitor-electrolytic', properties: { voltage } });
    const offsetSine = sineCapture(10);
    offsetSine.nodes.set('n0', offsetSine.nodes.get('n0')!.map((x) => x + 20));
    // 10 V around 20 V: up to 30 V on a 25 V part.
    const over = componentStress(c1('25'), { n0: 20 }, pinNetMap, { timeWaveforms: offsetSine })!;
    expect(over.ratio).toBeCloseTo(30 / 25, 2);
    // A bare sine: 10 V backwards every other half period.
    const reverse = componentStress(c1('25'), { n0: 0 }, pinNetMap, { timeWaveforms: sineCapture(10) })!;
    expect(reverse.ratio).toBe(3);
    expect(reverse.message).toMatch(/backwards/);
  });
});
