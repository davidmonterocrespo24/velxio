/**
 * The analog projects behind the "Analog electronics in the browser" post.
 *
 * The post quotes numbers from these circuits; each check here solves the
 * gallery example itself and holds it to the formula the post explains, so a
 * model change that breaks the physics fails here before it reaches readers.
 */
import { describe, expect, it } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { exampleProjects, type ExampleProject } from '../data/examples';
import { runNetlist, type VectorValue } from './helpers/testSolver';

const mag = (v: VectorValue): number => (typeof v === 'number' ? v : Math.hypot(v.real, v.img));

function example(id: string, props: Record<string, Record<string, unknown>> = {}): ExampleProject {
  const ex = exampleProjects.find((e) => e.id === id);
  if (!ex) throw new Error(`example ${id} not found`);
  return {
    ...ex,
    components: ex.components.map((c) =>
      props[c.id] ? { ...c, properties: { ...c.properties, ...props[c.id] } } : c,
    ),
  };
}

async function solve(ex: ExampleProject) {
  const built = buildNetlist(exampleToBuildNetlistInput(ex));
  const result = await runNetlist(built.netlist);
  const net = (pin: string) => {
    const n = built.pinNetMap.get(pin);
    if (!n) throw new Error(`no net for ${pin}`);
    return n;
  };
  const v = (pin: string) => (net(pin) === '0' ? 0 : mag(result.vAtLast(`v(${net(pin)})`)));
  const wave = (pin: string) =>
    result
      .vec(`v(${net(pin)})`)
      .map(mag)
      .filter(Number.isFinite);
  return { v, wave };
}

const settled = (s: number[]) => s.slice(Math.floor(s.length / 2));

describe('analog projects for the blog post', () => {
  it("LED + resistor: 9 V splits into I*R across 470 ohm and a red LED's forward voltage", async () => {
    const { v } = await solve(example('analog-led-ohms-law'));
    const vr = v('r1:1') - v('r1:2');
    const vled = v('led1:A') - v('led1:C');
    expect(vr / 470).toBeGreaterThan(0.014);
    expect(vr / 470).toBeLessThan(0.016);
    expect(vled).toBeGreaterThan(1.7);
    expect(vled).toBeLessThan(2.0);
  });

  it('5 V supply: the reservoir capacitor ripples under load and the 7805 holds 5 V', async () => {
    const { v, wave } = await solve(example('analog-5v-power-supply'));
    const cap = settled(wave('c1:+'));
    const ripple = Math.max(...cap) - Math.min(...cap);
    // I/(2fC) = 50 mA / (100 Hz * 220 uF) = 2.3 V; a regulator that drew
    // nothing from its input left this at ~0.
    expect(ripple).toBeGreaterThan(1.5);
    expect(ripple).toBeLessThan(3.0);
    expect(Math.min(...cap)).toBeGreaterThan(7); // still above the 7805's dropout
    expect(v('u1:VOUT')).toBeCloseTo(5, 2);
  });

  it('common-emitter amplifier: the collector swings about -Rc/Re times the base', async () => {
    const { wave } = await solve(example('analog-common-emitter-amp'));
    const b = settled(wave('q1:B'));
    const c = settled(wave('q1:C'));
    const gain = (Math.max(...c) - Math.min(...c)) / (Math.max(...b) - Math.min(...b));
    expect(gain).toBeGreaterThan(3.8);
    expect(gain).toBeLessThan(4.8);
  });

  it('night light: the LED is on in the dark and off in daylight', async () => {
    const dark = await solve(example('analog-night-light', { ldr: { lux: 20 } }));
    const day = await solve(example('analog-night-light', { ldr: { lux: 300 } }));
    const ledV = (s: typeof dark) => s.v('led1:A') - s.v('led1:C');
    expect(ledV(dark)).toBeGreaterThan(1.8);
    expect(ledV(day)).toBeLessThan(1.5);
  });

  it('thermostat: the comparator turns the fan LED on above the set point', async () => {
    const cool = await solve(example('analog-thermostat-comparator', { ntc: { temperature: 25 } }));
    const hot = await solve(example('analog-thermostat-comparator', { ntc: { temperature: 32 } }));
    expect(cool.v('u1:OUT')).toBeLessThan(0.5);
    expect(hot.v('u1:OUT')).toBeGreaterThan(3);
  });
});
