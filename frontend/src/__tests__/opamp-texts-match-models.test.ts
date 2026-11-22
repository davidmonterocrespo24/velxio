/**
 * The op-amp texts say what the models do (velxio/velxio-prod#128).
 *
 * Found writing the book (chapter 15), on the texts around the op-amps:
 *   - The LM358's swing. Its catalog text, two analog gallery examples and
 *     its model's header said the output stops about 1.5 V below V+, which is
 *     TI's guarantee (VOH no lower than V+ - 1.5 V at 5 V into 2 kOhm,
 *     SLOS068). The macro-model Velxio runs reaches about 1 V below V+ at
 *     light load: 4.02 V on 5 V unloaded, 3.96 V into 10 kOhm, 3.89 V into
 *     2 kOhm. The texts now quote the model; where they also give the
 *     datasheet figure, they say it is the datasheet's.
 *   - "Rail-to-rail input" in the model's header: a real LM358's common-mode
 *     range ends at V+ - 1.5 V. The model takes inputs up to V+, and the
 *     header says both.
 *   - The LM324's text called it electrically the LM358 while it was a
 *     behavioural clamp, from V- + 0.05 V to V+ - 1.5 V with no slew or
 *     bandwidth limit: 3.5 V on 5 V where the LM358 gives 4.0 V. It is the
 *     LM358's amplifier design, four to a package, and it runs the LM358
 *     model now. No gallery example uses one.
 *   - The ideal op-amp's text said "infinite gain"; its VCVS has 10^6.
 *   - The follower example said it tracks its input "exactly", with
 *     "infinite input impedance"; on the LM358 that is within the 2 mV input
 *     offset, with the bias current, about 50 nA, flowing in the input.
 *   - Two Uno examples gave the textbook formulas: the inverting amplifier
 *     "Vout = -(Rf/Rin) * Vin", while IN+ sits at 2.5 V and the output can
 *     only be 0 to 4 V, and the follower "Vout = Vin" for a pot that goes
 *     to 5 V while the output stops at 4.02 V.
 *   - The ESP32 PWM-to-12 V example said its LM358, with V+ disconnected,
 *     stops "near 2 V" on the ESP32's 3.3 V (in its description and its
 *     sketch's comment): the 1.5 V headroom again (3.3 - 1.5 = 1.8 V). Its
 *     own circuit gives 2.30 V there, the figure the catalog text gives for
 *     the same case.
 *   - Comments: phase-2-lm358-subckt.test.ts said the subcircuit was not
 *     wired in (it has been since 54936ef6), and componentToSpice.ts called
 *     the LM324 identical to the LM358 next to its clamp.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import metadataJson from '../../public/components-metadata.json' with { type: 'json' };
import { analogExamples } from '../data/examples-analog';
import { analogProjectExamples } from '../data/examples-analog-projects';
import { circuitExamples } from '../data/examples-circuits';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { LM358_SUBCKT } from '../simulation/spice/models/lm358Subckt';
import { runNetlist } from './helpers/testSolver';
import type { BuildNetlistInput } from '../simulation/spice/types';

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

type Item = { id: string; description?: string };
const items = (Array.isArray(metadataJson) ? metadataJson : (metadataJson as { components: unknown[] }).components) as Item[];
const overrides = JSON.parse(source('../../../scripts/component-overrides.json')) as {
  _customComponents: Item[];
};
function catalogText(id: string): string {
  const text = items.find((c) => c.id === id)?.description ?? '';
  // The overrides carry the same text, so a regeneration keeps it.
  expect(overrides._customComponents.find((c) => c.id === id)?.description).toBe(text);
  return text;
}

/** V(out) of the LM358 subcircuit, saturated high (IN+ 0.5 V over IN-), on `vcc` into `load`. */
async function lm358High(vcc: number, load: string): Promise<number> {
  const r = await runNetlist(
    `* lm358 high\nVCC vp 0 DC ${vcc}\nVP inp 0 DC ${vcc / 2 + 0.5}\nVN inn 0 DC ${vcc / 2 - 0.5}\n` +
      `X1 inp inn vp 0 out LM358\nRL out 0 ${load}\n${LM358_SUBCKT}\n.op\n.end\n`,
  );
  return r.dcValue('v(out)');
}

function example(id: string) {
  const ex = analogExamples.find((e) => e.id === id);
  if (!ex) throw new Error(`${id} is not in the analog gallery`);
  return ex;
}

describe("the LM358's swing, as the model gives it (velxio/velxio-prod#128)", () => {
  it('the macro-model stops about 1 V below V+ at light load, a little more into a heavier one', { timeout: 60_000 }, async () => {
    expect(await lm358High(5, '1G')).toBeCloseTo(4.02, 1);
    expect(await lm358High(5, '10k')).toBeCloseTo(3.96, 1);
    expect(await lm358High(5, '2k')).toBeCloseTo(3.89, 1);
    expect(await lm358High(15, '1G')).toBeCloseTo(14.02, 1);
    expect(await lm358High(3.3, '10k')).toBeCloseTo(2.27, 1);
  });

  it("the part's catalog text quotes the model, and gives TI's 1.5 V as the datasheet's", { timeout: 60_000 }, async () => {
    const text = catalogText('opamp-lm358');
    expect(text).not.toMatch(/swings from near V- to about 1\.5 V below V\+/);
    expect(text).toMatch(/about 1 V below V\+ at light load/);
    // "a 15 V supply gives 0..14 V" and "the output stops near 2.3 V" on 3.3 V.
    const on15 = Number(/15 V supply gives 0\.\.([\d.]+) V/.exec(text)?.[1]);
    expect(on15).toBeCloseTo(await lm358High(15, '1G'), 0);
    const on33 = Number(/3\.3 V on an ESP32: the output stops near ([\d.]+) V/.exec(text)?.[1]);
    expect(Math.abs(on33 - (await lm358High(3.3, '10k')))).toBeLessThan(0.1);
    expect(text).toMatch(/a real LM358 is only guaranteed to reach V\+ - 1\.5 V/);
  });

  it('the inverting and non-inverting examples quote the model: about 4 V on 5 V, not 3.5 V', { timeout: 60_000 }, async () => {
    const inv = example('an-opamp-inverting').description;
    const non = example('an-opamp-non-inverting').description;
    expect(inv).not.toMatch(/3\.5 V/);
    expect(non).not.toMatch(/3\.5 V/);
    expect(inv).toMatch(/from about 0 V to about 4 V/);
    expect(non).toMatch(/tops out near 4 V/);
    // Where the non-inverting example tops out: its own circuit, its input
    // raised until x11 asks for 11 V.
    const ex = example('an-opamp-non-inverting');
    const src = ex.components.find((c) => c.id === 'src')!;
    const overdriven = {
      ...ex,
      components: ex.components.map((c) =>
        c === src ? { ...c, properties: { ...c.properties, waveform: 'dc', offset: 1, amplitude: 0 } } : c,
      ),
    };
    const { netlist, pinNetMap } = buildNetlist(exampleToBuildNetlistInput(overdriven, { analysis: { kind: 'op' } }));
    const top = (await runNetlist(netlist)).dcValue(`v(${pinNetMap.get('u1:OUT')})`);
    expect(Math.abs(top - 4)).toBeLessThan(0.1);
  });

  it("the model's header gives the measured swing and inputs, and calls it rail-to-rail nowhere", () => {
    const header = source('../simulation/spice/models/lm358Subckt.ts').split('export const')[0]!;
    expect(header).not.toMatch(/rail-to-rail/i);
    expect(header).toMatch(/4\.02 V open, 3\.96 V into 10 kOhm, 3\.89 V into\s+\*?\s*2 kOhm/);
    expect(header).toMatch(/common-mode input range ends\s+\*?\s*1\.5 V below V\+/);
    const elements = source('../components/velxio-components/OpAmpElements.ts');
    expect(elements).not.toMatch(/rail-to-rail/i);
    expect(elements).not.toMatch(/about 13\.5 V/);
  });
});

describe("the LM358's inputs, as the model takes them (velxio/velxio-prod#128)", () => {
  it('a comparator still switches with both inputs at 4.9 V on 5 V: the model takes inputs up to V+', { timeout: 60_000 }, async () => {
    const cmp = async (p: number, n: number) =>
      (
        await runNetlist(
          `* cmp\nVCC vp 0 DC 5\nVP inp 0 DC ${p}\nVN inn 0 DC ${n}\nX1 inp inn vp 0 out LM358\nRL out 0 10k\n${LM358_SUBCKT}\n.op\n.end\n`,
        )
      ).dcValue('v(out)');
    expect(await cmp(4.95, 4.9)).toBeGreaterThan(3.9);
    expect(await cmp(4.9, 4.95)).toBeLessThan(0.02);
  });
});

describe('the LM324 is the LM358 model (velxio/velxio-prod#128)', () => {
  type Wire = BuildNetlistInput['wires'][number];
  function stage(part: string, vplus: number | null, vin: number, gain: boolean): BuildNetlistInput {
    const wires: Wire[] = [];
    const w = (a: [string, string], b: [string, string]) =>
      wires.push({
        id: `w${wires.length}`,
        start: { componentId: a[0], pinName: a[1] },
        end: { componentId: b[0], pinName: b[1] },
      } as Wire);
    const components: BuildNetlistInput['components'] = [
      { id: 'u1', metadataId: part, properties: {} },
      { id: 'src', metadataId: 'power-supply', properties: { mode: 'dc', voltage: String(vin), currentLimit: '1' } },
      { id: 'rl', metadataId: 'resistor', properties: { value: '10000' } },
    ];
    w(['src', 'SIG'], ['u1', 'IN+']);
    w(['src', 'GND'], ['rl', '2']);
    w(['u1', 'OUT'], ['rl', '1']);
    if (gain) {
      // Non-inverting, x3.7: 27k from OUT to IN-, 10k from IN- to ground.
      components.push({ id: 'rf', metadataId: 'resistor', properties: { value: '27000' } });
      components.push({ id: 'rg', metadataId: 'resistor', properties: { value: '10000' } });
      w(['u1', 'OUT'], ['rf', '1']);
      w(['rf', '2'], ['u1', 'IN-']);
      w(['u1', 'IN-'], ['rg', '1']);
      w(['rg', '2'], ['src', 'GND']);
    } else {
      w(['u1', 'OUT'], ['u1', 'IN-']);
    }
    if (vplus !== null) {
      components.push({ id: 'pp', metadataId: 'power-supply', properties: { mode: 'dc', voltage: String(vplus), currentLimit: '1' } });
      w(['pp', 'SIG'], ['u1', 'V+']);
      w(['pp', 'GND'], ['src', 'GND']);
      w(['u1', 'V-'], ['src', 'GND']);
    }
    return { components, wires, boards: [], analysis: { kind: 'op' } };
  }
  async function vout(part: string, vplus: number | null, vin: number, gain: boolean): Promise<number> {
    const { netlist, pinNetMap } = buildNetlist(stage(part, vplus, vin, gain));
    return (await runNetlist(netlist)).dcValue(`v(${pinNetMap.get('u1:OUT')})`);
  }

  it.each([
    ['a follower of 2.5 V, V+ unwired (5 V rail)', null, 2.5, false],
    ['x3.7 of 3.0 V on 15 V: 11.1 V', 15, 3.0, true],
    ['x3.7 of 3.0 V on 9 V: saturated about 1 V below V+', 9, 3.0, true],
    ['x3.7 of 3.0 V, V+ unwired: saturated below the 5 V rail', null, 3.0, true],
  ] as const)('%s: the same output as an LM358', { timeout: 60_000 }, async (_name, vplus, vin, gain) => {
    const lm358 = await vout('opamp-lm358', vplus, vin, gain);
    const lm324 = await vout('opamp-lm324', vplus, vin, gain);
    expect(Math.abs(lm324 - lm358)).toBeLessThan(1e-6);
  });

  it('emits the LM358 subcircuit, and its text says so instead of a 1.5 V headroom', () => {
    const nets: Record<string, string> = { 'IN+': 'a', 'IN-': 'b', OUT: 'c', 'V+': 'p' };
    const e = componentToSpice({ id: 'q', metadataId: 'opamp-lm324', properties: {} }, (pin) => nets[pin] ?? null, {
      vcc: 5,
    })!;
    expect(e.cards).toEqual(['X_q a b p 0 c LM358']);
    expect([...e.modelsUsed]).toEqual([LM358_SUBCKT]);
    expect(e.drives).toEqual(['c']);
    const text = catalogText('opamp-lm324');
    expect(text).not.toMatch(/1\.5 V/);
    expect(text).toMatch(/runs the same model/);
    expect(source('../simulation/spice/componentToSpice.ts')).not.toMatch(/electrically identical to LM358/);
  });
});

describe('the ideal op-amp and the follower example (velxio/velxio-prod#128)', () => {
  it('the ideal op-amp is a gain of 10^6, and its text says so rather than infinite', () => {
    const nets: Record<string, string> = { 'IN+': 'a', 'IN-': 'b', OUT: 'c' };
    const e = componentToSpice({ id: 'i', metadataId: 'opamp-ideal', properties: {} }, (pin) => nets[pin] ?? null, {
      vcc: 5,
    })!;
    expect(e.cards).toEqual(['E_i c 0 a b 1e6']);
    const text = catalogText('opamp-ideal');
    expect(text).not.toMatch(/infinite gain/i);
    expect(text).toMatch(/10\^6/);
  });

  it("the follower example gives the LM358's offset and bias current, not 'exactly' and 'infinite'", { timeout: 60_000 }, async () => {
    const text = example('an-opamp-follower').description;
    expect(text).not.toMatch(/exactly/);
    expect(text).not.toMatch(/infinite/i);
    expect(text).toMatch(/2 mV offset/);
    expect(text).toMatch(/about 50 nA/);
    // The offset: a follower of 2.5 V reads 2 mV high.
    const r = await runNetlist(
      `* f\nVCC vp 0 DC 5\nVS s 0 DC 2.5\nRS s inp 1Meg\nX1 inp out vp 0 out LM358\nRL out 0 1k\n${LM358_SUBCKT}\n.op\n.end\n`,
    );
    // The bias current: what the 1 MOhm in front of the input drops.
    const bias = Math.abs(r.dcValue('v(inp)') - 2.5) / 1e6;
    expect(bias).toBeGreaterThan(40e-9);
    expect(bias).toBeLessThan(60e-9);
    expect(r.dcValue('v(out)') - r.dcValue('v(inp)')).toBeCloseTo(0.002, 3);
    // Where it stops: the example's own circuit, its input raised to 4.5 V.
    const top = Number(/up to about ([\d.]+) V, where its output stops into this load/.exec(text)?.[1]);
    const ex = example('an-opamp-follower');
    const raised = {
      ...ex,
      components: ex.components.map((c) =>
        c.id === 'src' ? { ...c, properties: { ...c.properties, waveform: 'dc', offset: 4.5, amplitude: 0 } } : c,
      ),
    };
    const { netlist, pinNetMap } = buildNetlist(exampleToBuildNetlistInput(raised, { analysis: { kind: 'op' } }));
    const out = (await runNetlist(netlist)).dcValue(`v(${pinNetMap.get('u1:OUT')})`);
    expect(Math.abs(out - top)).toBeLessThan(0.06);
  });
});

describe("the Uno's op-amp examples (velxio/velxio-prod#128)", () => {
  /** OUT (and the pot's wiper) of a Uno example with its pot(s) at `pots` (0-1023), the Uno's rails on. */
  async function uno(id: string, pots: Record<string, number>) {
    const ex = circuitExamples.find((e) => e.id === id)!;
    const set = {
      ...ex,
      components: ex.components.map((c) => (c.id in pots ? { ...c, properties: { ...c.properties, value: pots[c.id] } } : c)),
    };
    const input = exampleToBuildNetlistInput(set, {
      analysis: { kind: 'op' },
      boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', pinStates: {} }],
    });
    const { netlist, pinNetMap } = buildNetlist(input);
    const r = await runNetlist(netlist);
    return (pin: string) => r.dcValue(`v(${pinNetMap.get(pin)})`);
  }
  const text = (id: string) => circuitExamples.find((e) => e.id === id)!.description;

  it('the inverting amplifier: Vout = 2.5 - 10 * (Vin - 2.5), unclipped only between the Vin its text gives', { timeout: 60_000 }, async () => {
    const t = text('opamp-inverting');
    expect(t).not.toMatch(/Vout = -\(Rf\/Rin\) \* Vin/);
    expect(t).toMatch(/Vout = 2\.5 - 10 \* \(Vin - 2\.5\)/);
    // In its linear range the output is the formula (within the 2 mV offset x 11).
    for (const pot of [480, 520, 560]) {
      const v = await uno('opamp-inverting', { pot });
      expect(Math.abs(v('u1:OUT') - (2.5 - 10 * (v('pot:SIG') - 2.5)))).toBeLessThan(0.03);
    }
    // The range it gives is where the output leaves its rails, 0 and about 4 V.
    const [lo, hi] = /between about ([\d.]+) and ([\d.]+) V comes out unclipped/.exec(t)!.slice(1).map(Number);
    const top = (await uno('opamp-inverting', { pot: 0 }))('u1:OUT');
    expect(top).toBeCloseTo(4, 0);
    expect(Math.abs(lo! - (2.5 - (top - 2.5) / 10))).toBeLessThan(0.01);
    expect(Math.abs(hi! - (2.5 + 2.5 / 10))).toBeLessThan(0.01);
  });

  it('the follower: Vout = Vin up to about 4 V, then about 4.0 V while the pot goes on to 5 V', { timeout: 60_000 }, async () => {
    const t = text('opamp-voltage-follower');
    expect(t).not.toMatch(/Vout = Vin\. /);
    expect(t).toMatch(/up to about 4 V/);
    const mid = await uno('opamp-voltage-follower', { pot: 512 });
    expect(Math.abs(mid('u1:OUT') - mid('u1:IN+'))).toBeLessThan(0.003);
    // The last fifth of the travel: from 82 % up, A1 (OUT) holds about 4.0 V.
    for (const pot of [840, 1023]) {
      const v = await uno('opamp-voltage-follower', { pot });
      expect(v('u1:OUT')).toBeCloseTo(4.0, 1);
      expect(v('u1:IN+')).toBeGreaterThan(4.1);
    }
    expect((await uno('opamp-voltage-follower', { pot: 800 }))('u1:OUT')).toBeLessThan(3.95);
  });
});

describe("the ESP32's PWM-to-12 V example (velxio/velxio-prod#128)", () => {
  it("gives the model's figure for its LM358 on the ESP32's 3.3 V, the catalog's, not the 1.5 V headroom's 2 V", { timeout: 60_000 }, async () => {
    const ex = analogProjectExamples.find((e) => e.id === 'esp32-pwm-dac-lm358-12v')!;
    // Where the text says it: V+ disconnected, the op-amp on the ESP32's 3.3 V.
    const said = [
      /Disconnect V\+ and the op-amp falls back to the ESP32's 3\.3 V: the output stops near ([\d.]+) V/.exec(
        ex.description,
      )?.[1],
      /on the ESP32's 3\.3 V an LM358 stops near ([\d.]+) V/.exec(ex.code)?.[1],
    ].map(Number);
    // The example's own circuit with V+ disconnected and GPIO25 held at
    // 3.3 V: the x3.7 stage asks for 12.2 V and saturates on the rail.
    const vplus = (w: (typeof ex.wires)[number]) =>
      [w.start, w.end].some((end) => end.componentId === 'u1' && end.pinName === 'V+');
    const unpowered = { ...ex, wires: ex.wires.filter((w) => !vplus(w)) };
    expect(unpowered.wires.length).toBe(ex.wires.length - 1);
    const { netlist, pinNetMap } = buildNetlist(
      exampleToBuildNetlistInput(unpowered, {
        analysis: { kind: 'op' },
        boards: [{ id: 'esp32', boardKind: 'esp32', pinStates: { '25': { type: 'digital', v: 3.3 } } as never }],
      }),
    );
    const top = (await runNetlist(netlist)).dcValue(`v(${pinNetMap.get('u1:OUT')})`);
    expect(top).toBeLessThan(3.3 - 0.9);
    for (const v of said) expect(Math.abs(v - top)).toBeLessThan(0.1);
    // The same figure as the catalog text's for the same case.
    const catalog = Number(/3\.3 V on an ESP32: the output stops near ([\d.]+) V/.exec(catalogText('opamp-lm358'))?.[1]);
    expect(said).toEqual([catalog, catalog]);
  });
});

describe('stale comments (velxio/velxio-prod#128)', () => {
  it('the phase-2 test no longer says the subcircuit is not wired in', () => {
    expect(source('./phase-2-lm358-subckt.test.ts')).not.toMatch(/NOT currently wired/);
    expect(source('./examples-opamp-ranges.test.ts')).not.toMatch(/the simulator does exactly that/);
  });

  it("the analog projects' spec gives the ESP32 example's LM358 on 3.3 V the model's 2.3 V", () => {
    expect(source('./examples-analog-projects.test.ts')).not.toMatch(/3\.3 V and stops near 2 V/);
  });
});
