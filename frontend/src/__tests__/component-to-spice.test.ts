/**
 * Smoke-test every metadataId registered in componentToSpice:
 * build a trivial circuit with that component and verify ngspice accepts
 * the resulting netlist without error.
 *
 * This acts as a canary — if a mapping produces malformed SPICE
 * (wrong pin count, bogus .model), this test will catch it.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { mappedMetadataIds, componentToSpice } from '../simulation/spice/componentToSpice';
import { runNetlist } from '../simulation/spice/SpiceEngine';

const MINIMAL_FIXTURES: Record<string, { pins: string[]; properties?: Record<string, unknown> }> = {
  resistor: { pins: ['1', '2'] },
  'resistor-us': { pins: ['1', '2'] },
  capacitor: { pins: ['1', '2'] },
  inductor: { pins: ['1', '2'] },
  'analog-resistor': { pins: ['A', 'B'], properties: { value: '10k' } },
  'analog-capacitor': { pins: ['A', 'B'], properties: { value: '1u' } },
  'analog-inductor': { pins: ['A', 'B'], properties: { value: '10m' } },
  led: { pins: ['A', 'C'], properties: { color: 'red' } },
  diode: { pins: ['A', 'C'] },
  'diode-1n4148': { pins: ['A', 'C'] },
  'diode-1n4007': { pins: ['A', 'C'] },
  'zener-1n4733': { pins: ['A', 'C'] },
  'bjt-2n2222': { pins: ['C', 'B', 'E'] },
  'bjt-bc547': { pins: ['C', 'B', 'E'] },
  'bjt-2n3055': { pins: ['C', 'B', 'E'] },
  'mosfet-2n7000': { pins: ['D', 'G', 'S'] },
  'mosfet-irf540': { pins: ['D', 'G', 'S'] },
  'opamp-ideal': { pins: ['IN+', 'IN-', 'OUT'] },
  pushbutton: { pins: ['A', 'B'] },
  'slide-switch': { pins: ['1', '2'], properties: { value: 1 } },
  'slide-potentiometer': { pins: ['VCC', 'SIG', 'GND'], properties: { value: '10k', position: 50 } },
  'ntc-temperature-sensor': { pins: ['1', '2'], properties: { temperature: 25 } },
  photoresistor: { pins: ['LDR1', 'LDR2'], properties: { lux: 500 } },
  'instr-voltmeter': { pins: ['V+', 'V-'] },
  'instr-ammeter': { pins: ['A+', 'A-'] },
};

describe('componentToSpice — catalog completeness', () => {
  it('every mapped metadataId has a test fixture', () => {
    const missing = mappedMetadataIds().filter((id) => !MINIMAL_FIXTURES[id]);
    expect(missing, `Missing fixtures for: ${missing.join(', ')}`).toEqual([]);
  });

  it('every mapping emits at least one card', () => {
    for (const id of mappedMetadataIds()) {
      const fx = MINIMAL_FIXTURES[id];
      if (!fx) continue;
      const netLookup = (pin: string) => (fx.pins.includes(pin) ? `n_${pin}` : null);
      const emission = componentToSpice(
        { id: 'test', metadataId: id, properties: fx.properties ?? {} },
        netLookup,
        { vcc: 5 },
      );
      expect(emission, `${id} emitted nothing`).not.toBeNull();
      expect(emission!.cards.length, `${id} emitted 0 cards`).toBeGreaterThan(0);
    }
  });
});

// The ideal op-amp has infinite gain and needs real feedback to converge
// in DC — can't be tested with the one-component fixture below.
// It has its own dedicated test in spice-active.test.ts.
const NEEDS_CUSTOM_TOPOLOGY = new Set(['opamp-ideal']);

describe('componentToSpice — ngspice accepts every card', () => {
  for (const id of Object.keys(MINIMAL_FIXTURES)) {
    if (NEEDS_CUSTOM_TOPOLOGY.has(id)) continue;
    it(`${id} produces a netlist ngspice can solve`, { timeout: 30_000 }, async () => {
      const fx = MINIMAL_FIXTURES[id];
      // Build a minimal closed circuit: connect the component between a
      // 5V source and ground, plus a 1 MΩ load on any spare pin.
      const wires = [];
      const pins = fx.pins;
      const board = {
        id: 'brd',
        vcc: 5,
        pins: {},
        groundPinNames: ['GND'],
        vccPinNames: ['VCC'],
      };
      // Wire first pin to VCC, last pin to GND, middle pins (if any) to
      // their own auto-created loads.
      wires.push({
        id: 'w0',
        start: { componentId: 'brd', pinName: 'VCC' },
        end: { componentId: 'dut', pinName: pins[0] },
      });
      wires.push({
        id: 'w1',
        start: { componentId: 'dut', pinName: pins[pins.length - 1] },
        end: { componentId: 'brd', pinName: 'GND' },
      });
      const extraLoadCards: string[] = [];
      for (let i = 1; i < pins.length - 1; i++) {
        wires.push({
          id: `w_mid_${i}`,
          start: { componentId: 'dut', pinName: pins[i] },
          end: { componentId: `load_${i}`, pinName: '1' },
        });
        wires.push({
          id: `w_mid_${i}_gnd`,
          start: { componentId: `load_${i}`, pinName: '2' },
          end: { componentId: 'brd', pinName: 'GND' },
        });
        extraLoadCards.push(`R_load_${i} n_probe_${i} 0 1Meg`);
      }
      const netlist = buildNetlist({
        components: [
          { id: 'dut', metadataId: id, properties: fx.properties ?? {} },
          ...Array.from({ length: pins.length - 2 }, (_, i) => ({
            id: `load_${i + 1}`,
            metadataId: 'resistor',
            properties: { value: '1Meg' },
          })),
        ],
        wires,
        boards: [board],
        analysis: { kind: 'op' },
      });

      // Must at least contain the device's card (R_, C_, L_, D_, Q_, M_, E_)
      expect(netlist).toMatch(new RegExp(`[RCLDQMES]_dut`));

      const result = await runNetlist(netlist);
      // Accept if ngspice returned any voltage variable without throwing
      expect(result.variableNames.length).toBeGreaterThan(0);
      expect(Number.isFinite(result.dcValue(result.variableNames[0]))).toBe(true);
      void extraLoadCards;
    });
  }
});
