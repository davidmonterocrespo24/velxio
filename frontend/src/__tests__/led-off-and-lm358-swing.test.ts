/**
 * An LED held off on purpose is not a fault, and the LM358 stays above its
 * negative rail and leaves its inputs alone (velxio/velxio-prod#134).
 *
 * 1. The circuit check warned "LED d1 appears wired but is carrying almost
 *    no current" for any LED below 1 uA, so an LED a comparator's low output
 *    or an off transistor keeps dark on purpose read as a wiring fault (and
 *    opened the output console on every Run). An LED that is off conducts
 *    leakage only, picoamperes; one starved by megaohms in series carries
 *    nanoamperes to microamperes, and that is the case worth a hint. An LED
 *    wired backwards now gets a warning that says so.
 * 2. The LM358 macro-model (National's) put 1 MOhm between the inputs
 *    (R1 + R2), which loaded a 10k/10k reference by 12 mV in a comparator,
 *    about 100 times what the datasheet's -20 nA bias current would; and its
 *    output saturated 19 mV BELOW its negative rail. TI SLOS068 (LM358):
 *    input bias current -20 nA typ, output swing from the negative rail
 *    5 mV typ, 20 mV max (VS = 5 V, RL <= 10 kOhm).
 */
import { describe, it, expect } from 'vitest';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from './helpers/testSolver';
import { analogProjectExamples } from '../data/examples-analog-projects';

type Part = { id: string; metadataId: string; properties: Record<string, unknown> };
type Link = [string, string, string, string];

function input(components: Part[], links: Link[]) {
  const wires = links.map(([a, pa, b, pb], i) => ({
    id: `w${i}`,
    start: { componentId: a, pinName: pa },
    end: { componentId: b, pinName: pb },
    color: '#666',
    waypoints: [],
  }));
  return buildInputFromStore({ components, wires, boards: [] });
}

const supply: Part = { id: 'ps1', metadataId: 'power-supply', properties: { mode: 'dc', voltage: 5, currentLimit: 1 } };
const part = (id: string, metadataId: string, properties: Record<string, unknown> = {}): Part => ({ id, metadataId, properties });

/**
 * An LM358 comparator on 5 V: IN- on a 10k/10k divider (2.5 V), IN+ on
 * `inPlus` ('GND' or 'SIG' of the supply), OUT through 330 ohm into a red
 * LED to ground, or into `load` alone.
 */
function comparator(inPlus: 'GND' | 'SIG', load: 'led' | '10k') {
  const parts = [
    supply,
    part('u1', 'opamp-lm358'),
    part('ra', 'resistor', { value: '10k' }),
    part('rb', 'resistor', { value: '10k' }),
  ];
  const links: Link[] = [
    ['ps1', 'SIG', 'u1', 'V+'], ['u1', 'V-', 'ps1', 'GND'],
    ['ps1', 'SIG', 'ra', '1'], ['ra', '2', 'rb', '1'], ['rb', '2', 'ps1', 'GND'], ['ra', '2', 'u1', 'IN-'],
    ['u1', 'IN+', 'ps1', inPlus],
  ];
  if (load === 'led') {
    parts.push(part('r1', 'resistor', { value: '330' }), part('d1', 'led', { color: 'red' }));
    links.push(['u1', 'OUT', 'r1', '1'], ['r1', '2', 'd1', 'A'], ['d1', 'C', 'ps1', 'GND']);
  } else {
    parts.push(part('rl', 'resistor', { value: '10k' }));
    links.push(['u1', 'OUT', 'rl', '1'], ['rl', '2', 'ps1', 'GND']);
  }
  return input(parts, links);
}

const ledFindings = async (i: ReturnType<typeof input>) =>
  (await verifyCircuit(i)).warnings.filter((w) => w.code.startsWith('led-'));

describe('the circuit check and an LED that is off (#134)', () => {
  it('says nothing about an LED a comparator holds off', { timeout: 60_000 }, async () => {
    expect(await ledFindings(comparator('GND', 'led'))).toEqual([]);
  });

  it('says nothing about an LED its transistor holds off', { timeout: 60_000 }, async () => {
    const i = input(
      [supply, part('r1', 'resistor', { value: '220' }), part('d1', 'led'), part('q1', 'bjt-2n2222'),
        part('rb', 'resistor', { value: '10k' })],
      [
        ['ps1', 'SIG', 'r1', '1'], ['r1', '2', 'd1', 'A'], ['d1', 'C', 'q1', 'C'],
        ['q1', 'E', 'ps1', 'GND'], ['q1', 'B', 'rb', '1'], ['rb', '2', 'ps1', 'GND'],
      ],
    );
    expect(await ledFindings(i)).toEqual([]);
  });

  it('says nothing about an LED behind a button that is not pressed', { timeout: 60_000 }, async () => {
    // The open contact is 1 GOhm: a few nA leak through it.
    const i = input(
      [supply, part('sw1', 'pushbutton'), part('r1', 'resistor', { value: '330' }), part('d1', 'led')],
      [['ps1', 'SIG', 'sw1', '1.l'], ['sw1', '2.l', 'r1', '1'], ['r1', '2', 'd1', 'A'], ['d1', 'C', 'ps1', 'GND']],
    );
    expect(await ledFindings(i)).toEqual([]);
  });

  it('still points at an LED starved by megaohms in series', { timeout: 60_000 }, async () => {
    // 5 V through 10 MOhm: about 0.36 uA, far too little to see.
    const i = input(
      [supply, part('r1', 'resistor', { value: '10M' }), part('d1', 'led')],
      [['ps1', 'SIG', 'r1', '1'], ['r1', '2', 'd1', 'A'], ['d1', 'C', 'ps1', 'GND']],
    );
    const found = await ledFindings(i);
    expect(found.map((w) => [w.code, w.componentId])).toEqual([['led-no-current', 'd1']]);
    expect(found[0]!.metric).toBeGreaterThan(1e-7);
    expect(found[0]!.message).toMatch(/series/);
  });

  it('names an LED wired backwards', { timeout: 60_000 }, async () => {
    const i = input(
      [supply, part('r1', 'resistor', { value: '330' }), part('d1', 'led')],
      [['ps1', 'SIG', 'r1', '1'], ['r1', '2', 'd1', 'C'], ['d1', 'A', 'ps1', 'GND']],
    );
    const found = await ledFindings(i);
    expect(found.map((w) => [w.code, w.componentId])).toEqual([['led-reverse-biased', 'd1']]);
    expect(found[0]!.message).toMatch(/backwards/);
    // 5 V backwards is at the 5 V most LEDs are rated to withstand, not past it.
    expect(found[0]!.message).not.toMatch(/withstand/);
  });

  it('and says when the reverse voltage is past what an LED withstands', { timeout: 60_000 }, async () => {
    const nine: Part = { id: 'ps1', metadataId: 'power-supply', properties: { mode: 'dc', voltage: 9, currentLimit: 1 } };
    const i = input(
      [nine, part('r1', 'resistor', { value: '330' }), part('d1', 'led')],
      [['ps1', 'SIG', 'r1', '1'], ['r1', '2', 'd1', 'C'], ['d1', 'A', 'ps1', 'GND']],
    );
    const found = await ledFindings(i);
    expect(found.map((w) => w.code)).toEqual(['led-reverse-biased']);
    expect(found[0]!.message).toMatch(/withstand/);
  });
});

describe('the LM358 model (#134)', () => {
  async function solve(i: ReturnType<typeof input>) {
    const built = buildNetlist(i);
    const r = await runNetlist(built.netlist);
    const v = (id: string, pin: string) => {
      const net = built.pinNetMap.get(`${id}:${pin}`)!;
      return net === '0' ? 0 : r.dcValue(`v(${net})`);
    };
    return v;
  }

  it('saturates low just above its negative rail, not below it', { timeout: 60_000 }, async () => {
    const v = await solve(comparator('GND', '10k'));
    const out = v('u1', 'OUT');
    expect(out).toBeGreaterThanOrEqual(0);
    expect(out).toBeLessThanOrEqual(0.02);
    expect(out).toBeCloseTo(0.005, 3);
  });

  it('follows 0 V to within the datasheet\'s 20 mV', { timeout: 60_000 }, async () => {
    // A follower of ground (IN+ on GND, OUT on IN-, OUT into 10 kOhm).
    const i = input(
      [supply, part('u1', 'opamp-lm358'), part('rl', 'resistor', { value: '10k' })],
      [
        ['ps1', 'SIG', 'u1', 'V+'], ['u1', 'V-', 'ps1', 'GND'], ['u1', 'IN+', 'ps1', 'GND'],
        ['u1', 'OUT', 'u1', 'IN-'], ['u1', 'OUT', 'rl', '1'], ['rl', '2', 'ps1', 'GND'],
      ],
    );
    const out = (await solve(i))('u1', 'OUT');
    expect(out).toBeGreaterThanOrEqual(0);
    expect(out).toBeLessThanOrEqual(0.02);
  });

  it('does not load the reference its inputs compare', { timeout: 60_000 }, async () => {
    // The 10k/10k divider is 2.5 V unloaded; the bias current (tens of nA)
    // through its 5 kOhm moves it by a fraction of a millivolt.
    for (const inPlus of ['GND', 'SIG'] as const) {
      const v = await solve(comparator(inPlus, '10k'));
      expect(Math.abs(v('u1', 'IN-') - 2.5), inPlus).toBeLessThan(1e-3);
    }
  });

  it('keeps an input nothing drives inside its supply', { timeout: 60_000 }, async () => {
    // arduino-pwm-dac-opamp before its sketch drives pin 9: IN+ sits on the
    // RC filter's capacitor and a 10k to an undriven pin. Only the model's
    // own input network holds it (against its 5 nA offset current).
    const ex = analogProjectExamples.find((e) => e.id === 'arduino-pwm-dac-opamp')!;
    const components = ex.components
      .filter((c) => !c.type.includes('arduino'))
      .map((c) => ({ id: c.id, metadataId: c.type.replace(/^(wokwi|velxio)-/, ''), properties: c.properties ?? {} }));
    const wires = ex.wires.map((w) => ({ id: w.id, start: w.start, end: w.end, color: '#666', waypoints: [] }));
    const i = buildInputFromStore({
      components,
      wires,
      boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', pinStates: {} }],
    });
    const v = await solve(i);
    const inPlus = v('u1', 'IN+');
    expect(inPlus).toBeGreaterThan(0);
    expect(inPlus).toBeLessThan(5);
  });

  it('follows as it did in a closed loop', { timeout: 60_000 }, async () => {
    // A follower on the divider: the macro-model's 2.25 mV offset, as before.
    const i = input(
      [supply, part('u1', 'opamp-lm358'), part('ra', 'resistor', { value: '10k' }),
        part('rb', 'resistor', { value: '10k' }), part('rl', 'resistor', { value: '10k' })],
      [
        ['ps1', 'SIG', 'u1', 'V+'], ['u1', 'V-', 'ps1', 'GND'],
        ['ps1', 'SIG', 'ra', '1'], ['ra', '2', 'rb', '1'], ['rb', '2', 'ps1', 'GND'], ['ra', '2', 'u1', 'IN+'],
        ['u1', 'OUT', 'u1', 'IN-'], ['u1', 'OUT', 'rl', '1'], ['rl', '2', 'ps1', 'GND'],
      ],
    );
    const v = await solve(i);
    expect(v('u1', 'OUT')).toBeCloseTo(2.5022, 3);
  });
});
