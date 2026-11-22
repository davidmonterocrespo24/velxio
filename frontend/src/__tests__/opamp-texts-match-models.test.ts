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
 *   - The LM324's text called it electrically the LM358 while it is a
 *     behavioural clamp, from V- + 0.05 V to V+ - 1.5 V with no slew or
 *     bandwidth limit: 3.5 V on 5 V where the LM358 gives 4.0 V. Its texts
 *     now say what it is.
 *   - The ideal op-amp's text said "infinite gain"; its VCVS has 10^6.
 *   - The follower example said it tracks its input "exactly", with
 *     "infinite input impedance"; on the LM358 that is within the 2 mV input
 *     offset, with the bias current, about 50 nA, flowing in the input.
 *   - Comments: phase-2-lm358-subckt.test.ts said the subcircuit was not
 *     wired in (it has been since 54936ef6), and componentToSpice.ts called
 *     the LM324 identical to the LM358 next to its clamp.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import metadataJson from '../../public/components-metadata.json' with { type: 'json' };
import { analogExamples } from '../data/examples-analog';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { LM358_SUBCKT } from '../simulation/spice/models/lm358Subckt';
import { runNetlist } from './helpers/testSolver';

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

describe('the LM324 (velxio/velxio-prod#128)', () => {
  it('its text and its mapper describe the clamp it is, not the LM358', () => {
    const nets: Record<string, string> = { 'IN+': 'a', 'IN-': 'b', OUT: 'c' };
    const e = componentToSpice({ id: 'q', metadataId: 'opamp-lm324', properties: {} }, (pin) => nets[pin] ?? null, {
      vcc: 5,
    })!;
    expect(e.cards).toContain('B_q c 0 V = max(0.05, min(3.5, 100000*(V(a)-V(b))))');
    const text = catalogText('opamp-lm324');
    expect(text).not.toMatch(/electrically like the LM358/);
    expect(text).toMatch(/clamped between V- \+ 0\.05 V and V\+ - 1\.5 V/);
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

describe('stale comments (velxio/velxio-prod#128)', () => {
  it('the phase-2 test no longer says the subcircuit is not wired in', () => {
    expect(source('./phase-2-lm358-subckt.test.ts')).not.toMatch(/NOT currently wired/);
    expect(source('./examples-opamp-ranges.test.ts')).not.toMatch(/the simulator does exactly that/);
  });
});
