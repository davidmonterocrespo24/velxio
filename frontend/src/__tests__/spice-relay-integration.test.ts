/**
 * Regression: Relay-Controlled LED example (examples-circuits.ts
 * `relay-led-switch`). Covers two historical bugs:
 *   1) relay mapper returned null when NC was unwired → no relay cards
 *      emitted at all, LED stuck off regardless of coil drive.
 *   2) coil was R || L instead of R — L — in series; at .op the L shorted
 *      the R, V(COIL+) ≡ V(COIL-), switch control was 0, NO never closed.
 *
 * Circuit:
 *   pin 9 → Rb(1k) → Q1(2N2222).B
 *   5V → relay.COIL+ ; relay.COIL- → Q1.C ; Q1.E → GND
 *   5V → relay.NO ; relay.COM → Rl(220) → LED.A ; LED.C → GND
 *   relay.NC left unconnected (normal pattern)
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from '../simulation/spice/SpiceEngine';
import type { BuildNetlistInput, PinSourceState } from '../simulation/spice/types';

function relayWires() {
  return [
    {
      id: 'w1',
      start: { componentId: 'arduino-uno', pinName: '9' },
      end: { componentId: 'rb', pinName: '1' },
    },
    {
      id: 'w2',
      start: { componentId: 'rb', pinName: '2' },
      end: { componentId: 'q1', pinName: 'B' },
    },
    {
      id: 'w3',
      start: { componentId: 'arduino-uno', pinName: '5V' },
      end: { componentId: 'rly', pinName: 'COIL+' },
    },
    {
      id: 'w4',
      start: { componentId: 'rly', pinName: 'COIL-' },
      end: { componentId: 'q1', pinName: 'C' },
    },
    {
      id: 'w5',
      start: { componentId: 'q1', pinName: 'E' },
      end: { componentId: 'arduino-uno', pinName: 'GND' },
    },
    {
      id: 'w6',
      start: { componentId: 'arduino-uno', pinName: '5V' },
      end: { componentId: 'rly', pinName: 'NO' },
    },
    {
      id: 'w7',
      start: { componentId: 'rly', pinName: 'COM' },
      end: { componentId: 'rl', pinName: '1' },
    },
    {
      id: 'w8',
      start: { componentId: 'rl', pinName: '2' },
      end: { componentId: 'led1', pinName: 'A' },
    },
    {
      id: 'w9',
      start: { componentId: 'led1', pinName: 'C' },
      end: { componentId: 'arduino-uno', pinName: 'GND' },
    },
  ];
}

function relayInput(pinStates: Record<string, PinSourceState>): BuildNetlistInput {
  return {
    components: [
      { id: 'rb', metadataId: 'resistor', properties: { value: '1000' } },
      { id: 'q1', metadataId: 'bjt-2n2222', properties: {} },
      { id: 'rly', metadataId: 'relay', properties: { coil_voltage: 5 } },
      { id: 'rl', metadataId: 'resistor', properties: { value: '220' } },
      { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
    ],
    wires: relayWires(),
    boards: [
      {
        id: 'arduino-uno',
        vcc: 5,
        pins: pinStates,
        groundPinNames: ['GND'],
        vccPinNames: ['5V'],
      },
    ],
    analysis: { kind: 'op' },
  };
}

describe('Relay-Controlled LED — SPICE integration', () => {
  it('coil energised when pin 9 HIGH → NO closes → LED lights', { timeout: 60_000 }, async () => {
    const { netlist } = buildNetlist(relayInput({ '9': { type: 'digital', v: 5 } }));
    expect(netlist).toMatch(/R_rly_coil\b/);
    expect(netlist).toMatch(/S_rly_no\b/);
    const cooked = await runNetlist(netlist);
    const iLed = Math.abs(cooked.dcValue('i(v_led1_sense)'));
    expect(iLed).toBeGreaterThan(5e-3);
  });

  it('coil idle when pin 9 LOW → NO open → LED dark', { timeout: 60_000 }, async () => {
    const { netlist } = buildNetlist(relayInput({}));
    const cooked = await runNetlist(netlist);
    const iLed = Math.abs(cooked.dcValue('i(v_led1_sense)'));
    expect(iLed).toBeLessThan(1e-6);
  });
});
