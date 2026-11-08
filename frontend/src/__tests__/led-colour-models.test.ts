/**
 * Every LED colour has its own forward voltage (velxio/velxio-prod#95).
 *
 * The colour select offers red, green, blue, yellow, orange, white and
 * purple, but the diode table only had five of them: orange and purple fell
 * back to the red card (about 1.8 V). A purple LED, an InGaN part near 3.3 V,
 * then drew almost twice its current on 5 V, and with 150 Ohm the pre-flight
 * blocked a correct circuit as over 20 mA.
 *
 * Datasheets: Kingbright WP7113SED (orange, 601 nm) 2.0 V typ at 20 mA;
 * Lumimax LED5-PUR420 (purple, 420 nm) 3.3 V typ at 20 mA (LED5PUR,
 * 395 nm: 3.4 V).
 */
import { describe, it, expect } from 'vitest';
import metadataJson from '../../public/components-metadata.json' with { type: 'json' };
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { runNetlist } from './helpers/testSolver';
import type { BuildNetlistInput } from '../simulation/spice/types';

type Wire = BuildNetlistInput['wires'][number];
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

/** 5 V through `ohms` into an LED of `color`, cathode to ground. */
function ledOn5V(color: string, ohms: number): BuildNetlistInput {
  return {
    components: [
      {
        id: 'src',
        metadataId: 'signal-generator',
        properties: { waveform: 'dc', offset: 5, amplitude: 0, frequency: 1 },
      },
      { id: 'r1', metadataId: 'resistor', properties: { value: String(ohms) } },
      { id: 'led1', metadataId: 'led', properties: { color } },
    ],
    wires: [
      w('w1', ['src', 'SIG'], ['r1', '1']),
      w('w2', ['r1', '2'], ['led1', 'A']),
      w('w3', ['led1', 'C'], ['src', 'GND']),
    ],
    boards: [],
    analysis: { kind: 'op' },
  };
}

/** The LED's forward voltage and current. */
async function operatingPoint(color: string, ohms: number) {
  const { netlist, pinNetMap } = buildNetlist(ledOn5V(color, ohms));
  const r = await runNetlist(netlist);
  const va = r.dcValue(`v(${pinNetMap.get('led1:A')})`);
  return { vf: va, amps: Math.abs(r.dcValue('i(v_led1_sense)')) };
}

/** The .model line the LED mapper emits for a colour. */
function modelOf(color: string): string {
  const e = componentToSpice(
    { id: 'led1', metadataId: 'led', properties: { color } },
    (pin) => ({ A: 'a', C: 'c' })[pin] ?? null,
    { vcc: 5 },
  );
  return [...e!.modelsUsed][0]!;
}

describe('LED colours (#95)', () => {
  it('every colour the inspector offers has its own diode model', () => {
    const catalog = metadataJson as unknown as {
      components: Array<{ id: string; properties: Array<{ name: string; options?: string[] }> }>;
    };
    const led = catalog.components.find((c) => c.id === 'led')!;
    const colors = led.properties.find((p) => p.name === 'color')!.options!;
    expect(colors).toEqual(expect.arrayContaining(['orange', 'purple']));
    for (const c of colors) expect(modelOf(c), c).toMatch(new RegExp(`^\\.model LED_${c.toUpperCase()} `));
  });

  it('orange drops 2.0 V at 20 mA (Kingbright WP7113SED)', async () => {
    const op = await operatingPoint('orange', 150);
    expect(op.amps).toBeGreaterThan(0.018);
    expect(op.amps).toBeLessThan(0.022);
    expect(op.vf).toBeGreaterThan(1.95);
    expect(op.vf).toBeLessThan(2.1);
  });

  it('purple drops 3.3 V at 20 mA (Lumimax LED5-PUR420)', async () => {
    const op = await operatingPoint('purple', 85);
    expect(op.amps).toBeGreaterThan(0.018);
    expect(op.amps).toBeLessThan(0.022);
    expect(op.vf).toBeGreaterThan(3.2);
    expect(op.vf).toBeLessThan(3.45);
  });

  it('a purple LED with 150 Ohm on 5 V passes the over-current check', async () => {
    const op = await operatingPoint('purple', 150);
    expect(op.amps).toBeLessThan(0.013);
    const v = await verifyCircuit(ledOn5V('purple', 150));
    expect(v.errors.map((e) => e.code)).not.toContain('led-overcurrent');
  });

  it('a red LED with 100 Ohm on 5 V still fails it', async () => {
    const v = await verifyCircuit(ledOn5V('red', 100));
    expect(v.errors.map((e) => e.code)).toContain('led-overcurrent');
  });
});
