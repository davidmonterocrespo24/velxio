/**
 * The signal generator's square wave is high for half its period, measured
 * at its 50 % level (velxio/velxio-prod#149).
 *
 * ngspice's PULSE(V1 V2 TD TR TF PW PER) holds V2 for PW only, after a rise
 * of TR and before a fall of TF, so between the 50 % points the pulse lasts
 * TR/2 + PW + TF/2. The generator emitted PW = PER/2 with 1 ns edges, which
 * kept every square wave high for T/2 + 1 ns. Two generators whose edges
 * should meet (the falling edge of 1 kHz and the rising edge of 2 kHz)
 * overlapped by 1 ns, and an AND gate fed by them put out a 1.2 ns spike at
 * 0.5, 1.5, 2.5 ... ms on the ngspice path (scope traces, meters).
 *
 * Runs the app's netlist builder and ngspice (the Node adapter).
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { solveInput } from './helpers/solveInput';
import type { Wire } from '../types/wire';

const wire = (id: string, a: [string, string], b: [string, string]) =>
  ({ id, start: { componentId: a[0], pinName: a[1] }, end: { componentId: b[0], pinName: b[1] } }) as Wire;

/** The PULSE parameters the generator emits for a square wave at `frequency`. */
function pulseOf(frequency: number | string) {
  const out = componentToSpice(
    { id: 'g', metadataId: 'signal-generator', properties: { waveform: 'square', frequency, amplitude: 2.5, offset: 2.5 } },
    (pin) => (pin === 'SIG' ? 's' : pin === 'GND' ? '0' : null),
    { vcc: 5 },
  );
  const card = out?.cards[0] ?? '';
  const m = card.match(/PULSE\(([^)]*)\)/i);
  expect(m, card).not.toBeNull();
  const scale: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3 };
  const [v1, v2, td, tr, tf, pw, per] = m![1]!
    .trim()
    .split(/\s+/)
    .map((t) => {
      const s = t.match(/^(-?[\d.]+(?:e-?\d+)?)([num]?)$/i);
      expect(s, `PULSE field ${t}`).not.toBeNull();
      return Number(s![1]) * (s![2] ? scale[s![2].toLowerCase()]! : 1);
    });
  return { v1: v1!, v2: v2!, td: td!, tr: tr!, tf: tf!, pw: pw!, per: per! };
}

/** The [start, end] times where `y` is above `level`, crossings interpolated. */
function highIntervals(t: readonly number[], y: readonly number[], level: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start: number | null = y[0]! > level ? t[0]! : null;
  for (let i = 1; i < t.length; i++) {
    const a = y[i - 1]! - level;
    const b = y[i]! - level;
    if (a <= 0 && b > 0) start = t[i - 1]! + ((t[i]! - t[i - 1]!) * -a) / (b - a);
    if (a > 0 && b <= 0 && start !== null) {
      out.push([start, t[i - 1]! + ((t[i]! - t[i - 1]!) * a) / (a - b)]);
      start = null;
    }
  }
  return out;
}

describe('the square wave is high for half its period at its 50 % level', () => {
  it.each([50, 1000, 2000, 100e3])('%d Hz: rise/2 + PW + fall/2 is half the period', (f) => {
    const p = pulseOf(f);
    expect(p.per).toBeCloseTo(1 / f, 15);
    expect(p.td).toBe(0);
    // It was T/2 + 1 ns.
    expect(Math.abs(p.tr / 2 + p.pw + p.tf / 2 - p.per / 2)).toBeLessThan(p.per * 1e-9);
    expect(p.v1).toBe(0);
    expect(p.v2).toBe(5);
  });

  it('a generator faster than its own edges still emits a pulse that fits its period', () => {
    // 1 GHz: a period of 1 ns cannot hold two 1 ns edges.
    const p = pulseOf('1G');
    expect(p.pw).toBeGreaterThanOrEqual(0);
    expect(p.tr + p.pw + p.tf).toBeLessThanOrEqual(p.per * (1 + 1e-9));
    expect(Math.abs(p.tr / 2 + p.pw + p.tf / 2 - p.per / 2)).toBeLessThan(p.per * 1e-9);
  });

  it('an AND gate fed 1 kHz and 2 kHz squares puts out clean 250 µs pulses, with no 1 ns spikes', async () => {
    const components = [
      { id: 'g1', metadataId: 'signal-generator', properties: { waveform: 'square', frequency: 1000, amplitude: 2.5, offset: 2.5 } },
      { id: 'g2', metadataId: 'signal-generator', properties: { waveform: 'square', frequency: 2000, amplitude: 2.5, offset: 2.5 } },
      { id: 'u1', metadataId: 'logic-gate-and', properties: {} },
      { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
    ];
    const wires = [
      wire('w1', ['g1', 'SIG'], ['u1', 'A']),
      wire('w2', ['g2', 'SIG'], ['u1', 'B']),
      wire('w3', ['g1', 'GND'], ['g2', 'GND']),
      wire('w4', ['vm', 'V+'], ['u1', 'Y']),
      wire('w5', ['vm', 'V-'], ['g1', 'GND']),
    ];
    const input = buildInputFromStore({ components, wires, boards: [] });
    expect(input.analysis.kind).toBe('tran');
    const solve = await solveInput(input);
    const tw = solve.timeWaveforms!;
    const y = tw.nodes.get(solve.pinNetMap.get('u1:Y')!)!;
    const a = tw.nodes.get(solve.pinNetMap.get('u1:A')!)!;
    const widths = highIntervals(tw.time, y, 2.5).map(([s, e]) => e - s);
    // Y = A AND B is high from k ms to k ms + 250 µs. On the old card it also
    // rose for 1.235 ns at every k ms + 500 µs, where 1 kHz falls as 2 kHz rises.
    const spikes = widths.filter((w) => w < 1e-6);
    expect(spikes, `spikes of ${spikes.map((w) => (w * 1e9).toFixed(3)).join(', ')} ns`).toEqual([]);
    expect(widths.length).toBeGreaterThanOrEqual(4);
    for (const w of widths) expect(Math.abs(w - 250e-6)).toBeLessThan(1e-9);
    // The 1 kHz input itself is high for 500 µs at 2.5 V (it was 500.001 µs).
    const aWidths = highIntervals(tw.time, a, 2.5).map(([s, e]) => e - s);
    expect(aWidths.length).toBeGreaterThanOrEqual(3);
    for (const w of aWidths) expect(Math.abs(w - 500e-6)).toBeLessThan(1e-10);
  });
});
