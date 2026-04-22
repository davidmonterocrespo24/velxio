/**
 * End-to-end regression test for the `mosfet-pwm-led` example.
 *
 * Reproduces the exact topology of the gallery example (5V → R220 → LED →
 * MOSFET drain, source-to-GND low-side switch, gate driven by an Arduino
 * pin with a 100 kΩ pull-down) and verifies that:
 *
 *   1. The LED's V-sense source is emitted so ngspice exposes the branch
 *      current under `i(v_led1_sense)` — the key `BasicParts.ts` reads.
 *   2. With the gate held LOW, almost no current flows through the LED.
 *   3. With the gate driven HIGH (5V), a realistic LED current flows (a
 *      few mA, bounded by the 220 Ω series resistor and the LED forward
 *      drop + MOSFET R_DS(on)).
 *   4. Intermediate gate voltages produce monotonically increasing current,
 *      i.e. the analog PWM-dimming behaviour that was previously broken.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from '../simulation/spice/SpiceEngine';
import type { BuildNetlistInput } from '../simulation/spice/types';

function mosfetPwmLedNetlist(gateVolts: number) {
  const input: BuildNetlistInput = {
    components: [
      { id: 'rl', metadataId: 'resistor', properties: { value: '220' } },
      { id: 'led1', metadataId: 'led', properties: { color: 'white' } },
      { id: 'q1', metadataId: 'mosfet-2n7000', properties: {} },
      { id: 'rg', metadataId: 'resistor', properties: { value: '100000' } },
    ],
    wires: [
      // 5V → R → LED anode
      {
        id: 'w1',
        start: { componentId: 'uno', pinName: '5V' },
        end: { componentId: 'rl', pinName: '1' },
      },
      {
        id: 'w2',
        start: { componentId: 'rl', pinName: '2' },
        end: { componentId: 'led1', pinName: 'A' },
      },
      // LED cathode → MOSFET drain
      {
        id: 'w3',
        start: { componentId: 'led1', pinName: 'C' },
        end: { componentId: 'q1', pinName: 'D' },
      },
      // Source to GND (low-side)
      {
        id: 'w4',
        start: { componentId: 'q1', pinName: 'S' },
        end: { componentId: 'uno', pinName: 'GND' },
      },
      // Gate driven from GPIO 9, plus pull-down to GND
      {
        id: 'w5',
        start: { componentId: 'uno', pinName: '9' },
        end: { componentId: 'q1', pinName: 'G' },
      },
      {
        id: 'w6',
        start: { componentId: 'q1', pinName: 'G' },
        end: { componentId: 'rg', pinName: '1' },
      },
      {
        id: 'w7',
        start: { componentId: 'rg', pinName: '2' },
        end: { componentId: 'uno', pinName: 'GND' },
      },
    ],
    boards: [
      {
        id: 'uno',
        vcc: 5,
        pins: {
          '5V': { type: 'digital', v: 5 },
          GND: { type: 'digital', v: 0 },
          '9': { type: 'digital', v: gateVolts },
        },
        groundPinNames: ['GND'],
        vccPinNames: ['5V'],
      },
    ],
    analysis: { kind: 'op' },
  };
  return buildNetlist(input).netlist;
}

describe('MOSFET PWM LED dimmer (mosfet-pwm-led example)', () => {
  it('emits V-sense card so ngspice exposes i(v_led1_sense)', { timeout: 30_000 }, async () => {
    const netlist = mosfetPwmLedNetlist(5);
    expect(netlist).toMatch(/V_led1_sense /);
    expect(netlist).toMatch(/D_led1 led1_sense_mid /);

    const { variableNames } = await runNetlist(netlist);
    const lowered = variableNames.map((n) => n.toLowerCase());
    expect(lowered).toContain('i(v_led1_sense)');
  });

  it('gate LOW → LED current is ~0 (MOSFET off)', { timeout: 30_000 }, async () => {
    const netlist = mosfetPwmLedNetlist(0);
    const { dcValue } = await runNetlist(netlist);
    // Convention inside the builder: V-sense sources are oriented from
    // anode → mid-net, so conducting current is *negative* (flows into
    // the V+ terminal). Compare magnitudes.
    const i = Math.abs(dcValue('i(v_led1_sense)'));
    expect(i).toBeLessThan(1e-6); // sub-µA leakage is fine
  });

  it('gate HIGH → LED conducts a realistic current (2–20 mA)', { timeout: 30_000 }, async () => {
    const netlist = mosfetPwmLedNetlist(5);
    const { dcValue } = await runNetlist(netlist);
    const i = Math.abs(dcValue('i(v_led1_sense)'));
    expect(i).toBeGreaterThan(2e-3);
    expect(i).toBeLessThan(20e-3);
  });

  it(
    'LED current increases monotonically as the gate voltage ramps 0 → 5V',
    { timeout: 60_000 },
    async () => {
      const gatePoints = [0, 1.0, 1.5, 2.0, 2.5, 3.5, 5.0];
      const currents: number[] = [];
      for (const vg of gatePoints) {
        const { dcValue } = await runNetlist(mosfetPwmLedNetlist(vg));
        currents.push(Math.abs(dcValue('i(v_led1_sense)')));
      }
      // 0V and 1V are below the MOSFET Vto (1.6V) — both near-zero.
      expect(currents[0]).toBeLessThan(1e-6);
      expect(currents[1]).toBeLessThan(1e-5);
      // By 5V the MOSFET is fully on.
      expect(currents[currents.length - 1]).toBeGreaterThan(1e-3);
      // Each step above threshold should be ≥ the previous (within noise).
      for (let i = 2; i < currents.length; i++) {
        expect(currents[i]).toBeGreaterThanOrEqual(currents[i - 1] - 1e-6);
      }
    },
  );
});
