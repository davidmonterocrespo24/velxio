/**
 * Issue #373 (bug 3): "coil_resistance appears non-functional". The reporter
 * swept it up to 5.365 GΩ on a relay fed straight from the supply and saw the
 * contacts do the same thing every time. Measured against the deck the
 * builder really emits, that IS the right answer, and these cases pin why so
 * the model cannot drift into a wrong one:
 *
 *   a) Ideal rail at Vnom: NO closes at 70 Ω and at 5.365 GΩ alike; only the
 *      coil current differs (71.4 mA against a few nA). A 5 V relay fed 5 V
 *      pulls in by definition, whatever its coil resistance.
 *   b) 1 kΩ in series: the 70 Ω coil keeps 0.33 V and stays open, the 5 GΩ
 *      coil keeps 5 V and closes. This is where the field shows.
 *   c) A 3.3 V pin on a 5 V coil stays under the 3.75 V pull-in and does not
 *      close; a 3.3 V coil does. Board pins are ideal sources today
 *      (`V_<board>_<pin> net 0 DC v`, no output resistance), so the 3.3 V /
 *      70 Ω coil draws 47 mA from the pin without complaint, which no ESP32
 *      pin can source. The number is pinned so a pin model that grows an
 *      output resistance is noticed here first.
 *   d) An Ammeter in series reads Vnom / R, so the field is observable.
 *   e) ngspice SW closes at Vt + Vh and opens at Vt - Vh: pull-in 0.75 Vnom,
 *      drop-out 0.45 Vnom on a transient ramp. A bare .op has no history and
 *      solves the hysteresis band open.
 *
 * The relay's datasheet and inspector labels are the user-facing answer to
 * the report; the last block keeps them present and the generated metadata in
 * step with its source (`scripts/component-overrides.json`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from './helpers/testSolver';
import { hasDoc, loadDoc } from '../components/componentDocs';
import type { BuildNetlistInput, PinSourceState } from '../simulation/spice/types';

interface CoilCase {
  /** Board logic rail; the NO contact is fed from it. */
  boardVcc: number;
  coilV: number;
  coilR: number;
  /** `rail` feeds the coil from the board's VCC pin, `pin` from GPIO D4. */
  feed: 'rail' | 'pin';
  pinV?: number;
  /** Optional resistor between the feed and the coil. */
  seriesR?: number;
}

/**
 * feed -> [Rs] -> Ammeter -> COIL+, COIL- -> GND, NO fed from VCC,
 * COM -> 1 kΩ -> GND. V(COM) is therefore ~VCC with the NO contact closed and
 * ~5 uV (Roff 1 GΩ against 1 kΩ) with it open.
 */
function coilInput(c: CoilCase): BuildNetlistInput {
  const vccPin = c.boardVcc === 5 ? '5V' : '3V3';
  const feedPin = c.feed === 'rail' ? vccPin : 'D4';
  const components: BuildNetlistInput['components'] = [
    {
      id: 'rly',
      metadataId: 'relay',
      properties: { coil_voltage: c.coilV, coil_resistance: c.coilR },
    },
    { id: 'amm', metadataId: 'instr-ammeter', properties: {} },
    { id: 'rload', metadataId: 'resistor', properties: { value: '1000' } },
  ];
  const wires: BuildNetlistInput['wires'] = [];
  const wire = (a: [string, string], b: [string, string]) =>
    wires.push({
      id: `w${wires.length}`,
      start: { componentId: a[0], pinName: a[1] },
      end: { componentId: b[0], pinName: b[1] },
    });
  if (c.seriesR) {
    components.push({ id: 'rs', metadataId: 'resistor', properties: { value: String(c.seriesR) } });
    wire(['b', feedPin], ['rs', '1']);
    wire(['rs', '2'], ['amm', 'A+']);
  } else {
    wire(['b', feedPin], ['amm', 'A+']);
  }
  wire(['amm', 'A-'], ['rly', 'COIL+']);
  wire(['rly', 'COIL-'], ['b', 'GND']);
  wire(['b', vccPin], ['rly', 'NO']);
  wire(['rly', 'COM'], ['rload', '1']);
  wire(['rload', '2'], ['b', 'GND']);
  const pins: Record<string, PinSourceState> = {};
  if (c.feed === 'pin') pins.D4 = { type: 'digital', v: c.pinV ?? c.boardVcc };
  return {
    components,
    wires,
    boards: [{ id: 'b', vcc: c.boardVcc, pins, groundPinNames: ['GND'], vccPinNames: [vccPin] }],
    analysis: { kind: 'op' },
  };
}

interface Reading {
  netlist: string;
  vCoil: number;
  iCoil: number;
  vCom: number;
  closed: boolean;
}

async function solveCoil(c: CoilCase): Promise<Reading> {
  const { netlist } = buildNetlist(coilInput(c));
  const cooked = await runNetlist(netlist);
  const comNet = /S_rly_no (\S+) /.exec(netlist)![1]!;
  const coilNet = /R_rly_coil (\S+) /.exec(netlist)![1]!;
  const vCom = cooked.dcValue(`v(${comNet})`);
  return {
    netlist,
    vCoil: cooked.dcValue(`v(${coilNet})`),
    iCoil: cooked.dcValue('i(v_amm_sense)'),
    vCom,
    closed: vCom > 0.5 * c.boardVcc,
  };
}

describe('relay coil_resistance (#373): what the field does and where it shows', () => {
  it('a) ideal 5 V rail: 70 Ω and 5.365 GΩ both pull in, only the current differs', { timeout: 60_000 }, async () => {
    const low = await solveCoil({ boardVcc: 5, coilV: 5, coilR: 70, feed: 'rail' });
    const high = await solveCoil({ boardVcc: 5, coilV: 5, coilR: 5.365e9, feed: 'rail' });
    expect(low.closed).toBe(true);
    expect(high.closed).toBe(true);
    // The rail is stiff, so the coil sees Vnom whatever R is.
    expect(low.vCoil).toBeCloseTo(5, 2);
    expect(high.vCoil).toBeCloseTo(5, 2);
    // d) The ammeter reads Vnom / R: 71.4 mA at 70 Ω. At 5.365 GΩ the coil
    // takes 0.93 nA and the reverse-biased flyback 1N4148 (Is = 2.52 nA) adds
    // its leakage, so the meter shows a few nA, not zero.
    expect(low.iCoil).toBeCloseTo(5 / 70, 4);
    expect(high.iCoil).toBeGreaterThan(0.9e-9);
    expect(high.iCoil).toBeLessThan(10e-9);
  });

  it('b) through 1 kΩ: the 70 Ω coil stays open, the 5 GΩ coil closes', { timeout: 60_000 }, async () => {
    const low = await solveCoil({ boardVcc: 5, coilV: 5, coilR: 70, feed: 'rail', seriesR: 1000 });
    const high = await solveCoil({ boardVcc: 5, coilV: 5, coilR: 5e9, feed: 'rail', seriesR: 1000 });
    // V_coil = 5 * 70 / 1070 = 0.327 V, far under the 3.75 V pull-in.
    expect(low.vCoil).toBeCloseTo((5 * 70) / 1070, 3);
    expect(low.closed).toBe(false);
    expect(low.iCoil).toBeCloseTo(5 / 1070, 5);
    // The 5 GΩ coil leaves nothing across the 1 kΩ and sees the full 5 V.
    expect(high.vCoil).toBeGreaterThan(4.99);
    expect(high.closed).toBe(true);
  });

  it('c) a 3.3 V pin never pulls in a 5 V coil, and does pull in a 3.3 V coil', { timeout: 60_000 }, async () => {
    const fiveVoltCoil = await solveCoil({ boardVcc: 3.3, coilV: 5, coilR: 70, feed: 'pin', pinV: 3.3 });
    expect(fiveVoltCoil.vCoil).toBeCloseTo(3.3, 3);
    expect(fiveVoltCoil.closed).toBe(false);
    // Negative control for the ideal-pin caveat: the GPIO is a plain DC source
    // with no series element, so 3.3 V / 70 Ω = 47 mA flows out of it.
    expect(fiveVoltCoil.netlist).toMatch(/^V_b_D4 \S+ 0 DC 3\.3$/m);
    expect(fiveVoltCoil.iCoil).toBeCloseTo(3.3 / 70, 4);

    const matchedCoil = await solveCoil({ boardVcc: 3.3, coilV: 3.3, coilR: 70, feed: 'pin', pinV: 3.3 });
    expect(matchedCoil.closed).toBe(true);
    expect(matchedCoil.iCoil).toBeCloseTo(3.3 / 70, 4);
  });

  it('e) .op pull-in edge sits at 0.75 Vnom; the band below it solves open', { timeout: 60_000 }, async () => {
    const under = await solveCoil({ boardVcc: 5, coilV: 5, coilR: 70, feed: 'pin', pinV: 3.74 });
    const over = await solveCoil({ boardVcc: 5, coilV: 5, coilR: 70, feed: 'pin', pinV: 3.76 });
    expect(under.closed).toBe(false);
    expect(over.closed).toBe(true);
    expect(over.netlist).toMatch(/\.model RELAY_SW SW\(Vt=3 Vh=0\.75 /);
  });

  it('e) transient ramp: closes at 0.75 Vnom, opens at 0.45 Vnom', { timeout: 60_000 }, async () => {
    // Same cards the mapper emits; only the GPIO source becomes a slow ramp
    // (0 -> 5 V in 50 ms, back to 0 in 50 ms; L/R = 0.29 ms is negligible).
    const { netlist } = buildNetlist(coilInput({ boardVcc: 5, coilV: 5, coilR: 70, feed: 'pin', pinV: 0 }));
    const deck = netlist
      .replace(/^(V_b_D4 \S+ 0) DC 0$/m, '$1 PWL(0 0 50m 5 100m 0)')
      .replace(/^\.op$/m, '.tran 50u 100m');
    expect(deck).toContain('PWL(');
    expect(deck).toContain('.tran');
    const cooked = await runNetlist(deck);
    const comNet = /S_rly_no (\S+) /.exec(deck)![1]!;
    const coilNet = /R_rly_coil (\S+) /.exec(deck)![1]!;
    const vCoil = cooked.vec(`v(${coilNet})`) as number[];
    const vCom = cooked.vec(`v(${comNet})`) as number[];
    const edges: Array<{ closed: boolean; at: number }> = [];
    let prev = vCom[0]! > 2.5;
    for (let i = 1; i < vCom.length; i++) {
      const now = vCom[i]! > 2.5;
      if (now !== prev) {
        edges.push({ closed: now, at: vCoil[i]! });
        prev = now;
      }
    }
    expect(edges).toHaveLength(2);
    expect(edges[0]!.closed).toBe(true);
    expect(edges[0]!.at).toBeCloseTo(3.75, 1);
    expect(edges[1]!.closed).toBe(false);
    expect(edges[1]!.at).toBeCloseTo(2.25, 1);
  });
});

describe('relay coil_resistance (#373): the user-facing explanation', () => {
  it('the datasheet exists and says what the field does', async () => {
    expect(hasDoc('relay')).toBe(true);
    // Negative control: the registry answers by basename, not by prefix.
    expect(hasDoc('relay-that-does-not-exist')).toBe(false);
    const doc = await loadDoc('relay');
    expect(doc).not.toBeNull();
    expect(doc!.body).toMatch(/`coil_resistance` sets the coil current/);
    expect(doc!.body).toMatch(/\*\*75%\*\*/);
    expect(doc!.body).toMatch(/\*\*45%\*\*/);
    expect(doc!.body).toMatch(/Ammeter/);
  });

  it('inspector labels explain the pair, and the generated metadata matches its source', () => {
    const root = resolve(__dirname, '../..');
    const generated = JSON.parse(readFileSync(resolve(root, 'public/components-metadata.json'), 'utf-8'));
    const overrides = JSON.parse(readFileSync(resolve(root, '../scripts/component-overrides.json'), 'utf-8'));
    const list = Array.isArray(generated) ? generated : generated.components;
    const fromGenerated = list.find((c: { id: string }) => c.id === 'relay');
    const fromSource = overrides._customComponents.find((c: { id: string }) => c.id === 'relay');
    expect(fromGenerated).toBeDefined();
    expect(fromSource).toBeDefined();
    // The generator copies _customComponents verbatim; a hand edit on one side
    // only would be wiped by the next `npm run generate:metadata`.
    expect(fromGenerated.properties).toEqual(fromSource.properties);
    const byName = Object.fromEntries(
      fromSource.properties.map((p: { name: string; description: string }) => [p.name, p.description]),
    );
    expect(byName.coil_resistance).toBe('Coil resistance (Ω). Sets the coil current (coil voltage / R)');
    expect(byName.coil_voltage).toBe('Nominal coil voltage (V). Contacts pull in at 75% of it');
  });
});
