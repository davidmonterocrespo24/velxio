/**
 * The two L293D gallery examples (velxio/velxio-prod#166).
 *
 * - Their "motor" was a 5 ohm resistor on the Uno's 5 V: 5 V across it and
 *   1 A (5 W) with the old ideal driver, 2.46 V and 0.49 A (1.2 W) with the
 *   L293D's real drops (#165), either way far past its 0.25 W and burnt by
 *   the runtime monitor, and an amp out of a board's 5 V pin.
 * - l293d-speed-pwm printed without Serial.begin(): a real Uno sends nothing
 *   until Serial.begin() sets TXEN0 (ATmega328P datasheet, UCSRnB bit 3).
 * - brake() wrote IN1 = IN2 = LOW and analogWrite(EN, 0). With EN low the
 *   outputs are high-impedance (TI SLRS008D, Table 1): the motor coasts. A
 *   brake is both inputs at the same level with EN high ("fast motor stop"
 *   in the Unitrode L293 table).
 *
 * Each example is solved on the shipped ngspice with the sketch's forward
 * drive on its pins, through the same netlist path the app uses.
 */
import { describe, it, expect } from 'vitest';
import { circuitExamples } from '../data/examples-circuits';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { componentStress } from '../simulation/parts/runtimeBurnout';
import { stripBrandPrefix, isBoardComponentType } from '../utils/exampleToBuildNetlistInput';
import { solveInput } from './helpers/solveInput';
import type { PinSourceState } from '../simulation/spice/types';

const HIGH: PinSourceState = { type: 'digital', v: 5 };
const LOW: PinSourceState = { type: 'digital', v: 0 };

function example(id: string) {
  const e = circuitExamples.find((x) => x.id === id);
  if (!e) throw new Error(`no example ${id}`);
  return e;
}

/** The example on an Uno whose pins hold `pins`. */
async function solveExample(id: string, pins: Record<string, PinSourceState>) {
  const e = example(id);
  const components = e.components
    .filter((c) => !isBoardComponentType(c.type))
    .map((c) => ({ id: c.id, metadataId: stripBrandPrefix(c.type), properties: c.properties ?? {} }));
  const input = buildInputFromStore({
    components,
    wires: e.wires as never,
    boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', pinStates: pins }],
  });
  const s = await solveInput(input);
  return { e, s, components };
}

/** The body of a C function in a sketch, braces balanced. */
function functionBody(code: string, name: string): string {
  const start = code.indexOf(`void ${name}()`);
  if (start < 0) return '';
  const open = code.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(open + 1, i);
  }
  return '';
}

describe('the L293D gallery examples (velxio/velxio-prod#166)', () => {
  for (const id of ['l293d-motor-control', 'l293d-speed-pwm']) {
    it(`${id}: the motor stand-in survives full forward drive, within its rating`, { timeout: 30_000 }, async () => {
      // EN1 on 9 held HIGH (the most the sketch ever asks), IN1 HIGH, IN2 LOW.
      const { s, components } = await solveExample(id, { '9': HIGH, '7': HIGH, '8': LOW });
      const load = components.find((c) => c.id === 'rm')!;
      const stress = componentStress(load, s.nodeVoltages, s.pinNetMap);
      expect(stress).not.toBeNull();
      // Below its rating: no pre-flight warning, and nothing for the runtime
      // monitor (which burns at twice the rating) to act on.
      expect(stress!.ratio).toBeLessThan(0.5);
      // And the motor current is a small motor's, not an amp out of 5V.
      const vcc = Math.abs(s.branchCurrents['v_vcc_rail'] ?? NaN);
      expect(vcc).toBeGreaterThan(0.02);
      expect(vcc).toBeLessThan(0.1);
    });
  }

  it('l293d-speed-pwm starts the serial port before it prints', () => {
    const code = example('l293d-speed-pwm').code;
    const setup = functionBody(code, 'setup');
    expect(setup).toMatch(/Serial\.begin\(\s*\d+\s*\)/);
    expect(code.indexOf('Serial.begin(')).toBeLessThan(code.indexOf('Serial.print'));
  });

  it('l293d-motor-control brakes with both inputs at one level and EN HIGH, and coasts with EN LOW', () => {
    const code = example('l293d-motor-control').code;
    const brake = functionBody(code, 'brake');
    expect(brake).toMatch(/digitalWrite\(\s*IN1\s*,\s*LOW\s*\)/);
    expect(brake).toMatch(/digitalWrite\(\s*IN2\s*,\s*LOW\s*\)/);
    expect(brake).toMatch(/digitalWrite\(\s*EN\s*,\s*HIGH\s*\)/);
    expect(brake).not.toMatch(/analogWrite\(\s*EN\s*,\s*0\s*\)/);
    const coast = functionBody(code, 'coast');
    expect(coast).toMatch(/digitalWrite\(\s*EN\s*,\s*LOW\s*\)/);
  });

  it('l293d-motor-control braked: the driver holds both outputs low; coasting, it lets them go', { timeout: 30_000 }, async () => {
    const braked = await solveExample('l293d-motor-control', { '9': HIGH, '7': LOW, '8': LOW });
    const coasting = await solveExample('l293d-motor-control', { '9': LOW, '7': LOW, '8': LOW });
    const out = (r: typeof braked, pin: string) => {
      const net = r.s.pinNetMap.get(`u1:${pin}`)!;
      return net === '0' ? 0 : r.s.nodeVoltages[net]!;
    };
    // Braked: both sinks on, so both outputs sit at the sink's drop or less.
    expect(out(braked, 'OUT1')).toBeLessThan(1);
    expect(out(braked, 'OUT2')).toBeLessThan(1);
    // Neither carries current through the load in either state.
    for (const r of [braked, coasting]) {
      expect(Math.abs(out(r, 'OUT1') - out(r, 'OUT2'))).toBeLessThan(1e-3);
    }
  });
});
