/**
 * The photoresistor MODULE's AO falls as the light rises, as on the real board
 * and in Wokwi (velxio/velxio-prod#103, David's decision of 2026-11-11).
 *
 * The module is the LM393 light-sensor board Wokwi models as
 * wokwi-photoresistor-sensor: a fixed 10 kOhm from VCC to AO and the LDR from
 * AO to GND.
 * - Wokwi's docs (docs.wokwi.com/parts/wokwi-photoresistor-sensor): "The AO pin
 *   is connected between the LDR and the 10K resistor", and on 5 V with its
 *   defaults (rl10 50 kOhm, gamma 0.7) AO reads 4.96 V at 0.1 lux and 0.83 V at
 *   1000 lux. Its lux formula takes the LDR as R = 2000 * V / (1 - V / 5), that
 *   is 10 kOhm * V / (5 - V): the LDR is the lower leg.
 * - The board's schematic: R2 10K from VCC to AO, the photoresistor R3 from AO
 *   to GND, the LM393 driving DO HIGH in the dark.
 *
 * Velxio had the LDR from VCC to AO, so AO rose with the light, and a sketch
 * written for the real module (robot-desktop-eyes counts a LOW reading as
 * light) read darkness as light.
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { runNetlist } from './helpers/testSolver';
import type { ExampleProject } from '../data/examples';
import type { BoardKind } from '../types/board';

/** The module's cards with its pins on nets `vcc`, `0` and `n_ao`. */
function cards(properties: Record<string, unknown>): string[] {
  const nets: Record<string, string> = { VCC: 'vcc', GND: '0', AO: 'n_ao' };
  return componentToSpice(
    { id: 'ldr1', metadataId: 'photoresistor-sensor', properties },
    (pin: string) => nets[pin] ?? null,
    { vcc: 5 },
  )!.cards;
}

/**
 * The module alone on a board's supply, solved by ngspice: VCC on the board's
 * `vccPin`, GND on GND, AO on `aoPin`. Returns AO in volts.
 */
async function solvedAo(
  properties: Record<string, unknown>,
  board: { kind: BoardKind; vccPin: string; aoPin: string } = { kind: 'arduino-uno', vccPin: '5V', aoPin: 'A0' },
): Promise<number> {
  const ex = {
    id: 'ldr-probe',
    title: '',
    description: '',
    category: 'sensors',
    difficulty: 'beginner',
    code: '',
    components: [{ type: 'wokwi-photoresistor-sensor', id: 'ldr', x: 0, y: 0, properties }],
    wires: [
      { id: 'w1', start: { componentId: 'board', pinName: board.vccPin }, end: { componentId: 'ldr', pinName: 'VCC' }, color: '' },
      { id: 'w2', start: { componentId: 'ldr', pinName: 'GND' }, end: { componentId: 'board', pinName: 'GND' }, color: '' },
      { id: 'w3', start: { componentId: 'ldr', pinName: 'AO' }, end: { componentId: 'board', pinName: board.aoPin }, color: '' },
    ],
  } as unknown as ExampleProject;
  const input = exampleToBuildNetlistInput(ex, {
    boards: [{ id: 'board', boardKind: board.kind, pinStates: {} }],
  });
  const { netlist, pinNetMap } = buildNetlist(input);
  const r = await runNetlist(netlist);
  return r.dcValue(`v(${pinNetMap.get('ldr:AO')})`);
}

/** Wokwi's table for its defaults on 5 V: lux, AO volts, analogRead. */
const WOKWI_TABLE: Array<[number, number, number]> = [
  [0.1, 4.96, 1016],
  [1, 4.81, 985],
  [10, 4.17, 853],
  [50, 3.09, 633],
  [100, 2.5, 511],
  [400, 1.37, 281],
  [1000, 0.83, 170],
  [10_000, 0.19, 39],
  [100_000, 0.04, 8],
];

/** Wokwi's sketch: the lux an Uno's analogRead of AO stands for. */
function wokwiLux(analogValue: number, rl10 = 50, gamma = 0.7): number {
  const voltage = (analogValue / 1024) * 5;
  const resistance = (2000 * voltage) / (1 - voltage / 5);
  return Math.pow((rl10 * 1e3 * Math.pow(10, gamma)) / resistance, 1 / gamma);
}

describe('photoresistor module polarity: AO falls as the light rises (#103)', () => {
  it('puts the LDR between AO and GND and the fixed 10 kOhm between VCC and AO', () => {
    const [ldr, fixed] = cards({ lux: 10 });
    expect(ldr).toBe('R_ldr1_ldr n_ao 0 15000');
    expect(fixed).toBe('R_ldr1_pull vcc n_ao 10000');
    // `pullup` still overrides the fixed resistor, now on the VCC side.
    expect(cards({ lux: 10, pullup: '100k' })[1]).toBe('R_ldr1_pull vcc n_ao 100000');
  });

  it("follows Wokwi's table on 5 V with Wokwi's defaults (rl10 50, gamma 0.7)", { timeout: 60_000 }, async () => {
    for (const [lux, volts, reading] of WOKWI_TABLE) {
      const ao = await solvedAo({ lux, rl10: 50, gamma: 0.7 });
      expect(ao, `${lux} lux`).toBeCloseTo(volts, 2);
      expect(Math.round((ao / 5) * 1024), `${lux} lux`).toBe(reading);
    }
  });

  it("reads back through Wokwi's lux formula as the light it was solved at", { timeout: 60_000 }, async () => {
    for (const lux of [1, 10, 50, 100, 400, 1000]) {
      const ao = await solvedAo({ lux, rl10: 50, gamma: 0.7 });
      const analogValue = Math.min(1023, Math.floor((ao / 5) * 1024)); // an Uno's analogRead
      expect(wokwiLux(analogValue) / lux, `${lux} lux`).toBeGreaterThan(0.95);
      expect(wokwiLux(analogValue) / lux, `${lux} lux`).toBeLessThan(1.05);
    }
  });

  it('reads near VCC in the dark and falls as the light rises, on 5 V and on 3.3 V', { timeout: 60_000 }, async () => {
    const boards = [
      { kind: 'arduino-uno' as BoardKind, vccPin: '5V', aoPin: 'A0', vcc: 5 },
      { kind: 'esp32' as BoardKind, vccPin: '3V3', aoPin: '34', vcc: 3.3 },
    ];
    for (const b of boards) {
      const series: number[] = [];
      for (const lux of [0, 1, 10, 100, 500, 1000]) series.push(await solvedAo({ lux }, b));
      // The stock GL5528 (15 kOhm at 10 lux, gamma 0.6, 1 MOhm dark) under 10 kOhm.
      expect(series[0], `${b.kind} dark`).toBeCloseTo((b.vcc * 1e6) / (1e6 + 1e4), 2);
      expect(series[2], `${b.kind} 10 lux`).toBeCloseTo((b.vcc * 15_000) / 25_000, 2);
      for (let i = 1; i < series.length; i++) expect(series[i]).toBeLessThan(series[i - 1]);
      expect(series[series.length - 1], `${b.kind} 1000 lux`).toBeLessThan(0.1 * b.vcc);
    }
  });
});
