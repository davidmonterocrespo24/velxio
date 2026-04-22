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
import {
  mappedMetadataIds,
  componentToSpice,
  PASSIVE_PRESETS,
} from '../simulation/spice/componentToSpice';
import { runNetlist } from '../simulation/spice/SpiceEngine';

/**
 * Fixture describing how to wire one component for the ngspice-acceptance test.
 *
 * `topology` — optional per-pin override. For each pin we can specify:
 *   - 'vcc'  → tie pin directly to the +5 V rail
 *   - 'gnd'  → tie pin directly to the 0 V rail
 *   - 'load' → connect pin through a 1 MΩ resistor to GND (high-Z observation)
 *
 * Pins NOT listed in `topology` fall back to the default wiring strategy:
 *   first pin → VCC, last pin → GND, every middle pin → 'load'.
 *
 * Why the override exists: components that DRIVE one of their own pins with a
 * B-source (logic gates → Y, regulators → VOUT, signal-generator → SIG) would
 * conflict with the default "last pin → GND" short. For those, we declare the
 * output pin as 'load' so ngspice can actually observe it.
 */
interface Fixture {
  pins: string[];
  properties?: Record<string, unknown>;
  topology?: Record<string, 'vcc' | 'gnd' | 'load'>;
}

const MINIMAL_FIXTURES: Record<string, Fixture> = {
  resistor: { pins: ['1', '2'] },
  'resistor-us': { pins: ['1', '2'] },
  capacitor: { pins: ['1', '2'] },
  'capacitor-electrolytic': { pins: ['+', '−'] },
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
  'bjt-2n3906': { pins: ['C', 'B', 'E'] },
  'bjt-bc557': { pins: ['C', 'B', 'E'] },
  'mosfet-2n7000': { pins: ['D', 'G', 'S'] },
  'mosfet-irf540': { pins: ['D', 'G', 'S'] },
  'mosfet-irf9540': { pins: ['D', 'G', 'S'] },
  'mosfet-fqp27p06': { pins: ['D', 'G', 'S'] },
  'opamp-ideal': { pins: ['IN+', 'IN-', 'OUT'] },
  'opamp-lm358': { pins: ['IN+', 'IN-', 'OUT'] },
  'opamp-lm741': { pins: ['IN+', 'IN-', 'OUT'] },
  'opamp-tl072': { pins: ['IN+', 'IN-', 'OUT'] },
  'opamp-lm324': { pins: ['IN+', 'IN-', 'OUT'] },
  // Linear regulators drive VOUT via a B-source. Don't short VOUT to GND —
  // load it so ngspice can actually observe the output voltage.
  'reg-7805': { pins: ['VIN', 'GND', 'VOUT'], topology: { VIN: 'vcc', GND: 'gnd', VOUT: 'load' } },
  'reg-7812': { pins: ['VIN', 'GND', 'VOUT'], topology: { VIN: 'vcc', GND: 'gnd', VOUT: 'load' } },
  'reg-7905': { pins: ['VIN', 'GND', 'VOUT'], topology: { VIN: 'vcc', GND: 'gnd', VOUT: 'load' } },
  'reg-lm317': { pins: ['VIN', 'ADJ', 'VOUT'], topology: { VIN: 'vcc', ADJ: 'gnd', VOUT: 'load' } },
  'battery-9v': { pins: ['+', '−'] },
  'battery-aa': { pins: ['+', '−'] },
  'battery-coin-cell': { pins: ['+', '−'] },
  // Signal generator drives SIG via a V-source; load it to GND, don't short it.
  'signal-generator': {
    pins: ['SIG', 'GND'],
    properties: { waveform: 'sine', frequency: 1000, amplitude: 1, offset: 0 },
    topology: { SIG: 'load', GND: 'gnd' },
  },
  pushbutton: { pins: ['A', 'B'] },
  'slide-switch': { pins: ['1', '2'], properties: { value: 1 } },
  'slide-potentiometer': {
    pins: ['VCC', 'SIG', 'GND'],
    properties: { value: '10k', position: 50 },
  },
  potentiometer: { pins: ['VCC', 'SIG', 'GND'], properties: { min: 0, max: 1023, value: 512 } },
  'ntc-temperature-sensor': { pins: ['VCC', 'OUT', 'GND'], properties: { temperature: 25 } },
  photoresistor: { pins: ['VCC', 'AO', 'GND'], properties: { lux: 500 } },
  'instr-voltmeter': { pins: ['V+', 'V-'] },
  'instr-ammeter': { pins: ['A+', 'A-'] },
  // Logic gates drive Y via a B-source. Drive inputs to VCC (high), observe
  // Y via a 1 MΩ load — shorting Y to GND would collide with the B-source.
  'logic-gate-and': { pins: ['A', 'B', 'Y'], topology: { A: 'vcc', B: 'vcc', Y: 'load' } },
  'logic-gate-nand': { pins: ['A', 'B', 'Y'], topology: { A: 'vcc', B: 'vcc', Y: 'load' } },
  'logic-gate-or': { pins: ['A', 'B', 'Y'], topology: { A: 'vcc', B: 'vcc', Y: 'load' } },
  'logic-gate-nor': { pins: ['A', 'B', 'Y'], topology: { A: 'vcc', B: 'vcc', Y: 'load' } },
  'logic-gate-xor': { pins: ['A', 'B', 'Y'], topology: { A: 'vcc', B: 'vcc', Y: 'load' } },
  'logic-gate-xnor': { pins: ['A', 'B', 'Y'], topology: { A: 'vcc', B: 'vcc', Y: 'load' } },
  'logic-gate-not': { pins: ['A', 'Y'], topology: { A: 'vcc', Y: 'load' } },
  'logic-gate-and-3': {
    pins: ['A', 'B', 'C', 'Y'],
    topology: { A: 'vcc', B: 'vcc', C: 'vcc', Y: 'load' },
  },
  'logic-gate-or-3': {
    pins: ['A', 'B', 'C', 'Y'],
    topology: { A: 'vcc', B: 'vcc', C: 'vcc', Y: 'load' },
  },
  'logic-gate-nand-3': {
    pins: ['A', 'B', 'C', 'Y'],
    topology: { A: 'vcc', B: 'vcc', C: 'vcc', Y: 'load' },
  },
  'logic-gate-nor-3': {
    pins: ['A', 'B', 'C', 'Y'],
    topology: { A: 'vcc', B: 'vcc', C: 'vcc', Y: 'load' },
  },
  'logic-gate-and-4': {
    pins: ['A', 'B', 'C', 'D', 'Y'],
    topology: { A: 'vcc', B: 'vcc', C: 'vcc', D: 'vcc', Y: 'load' },
  },
  'logic-gate-or-4': {
    pins: ['A', 'B', 'C', 'D', 'Y'],
    topology: { A: 'vcc', B: 'vcc', C: 'vcc', D: 'vcc', Y: 'load' },
  },
  'logic-gate-nand-4': {
    pins: ['A', 'B', 'C', 'D', 'Y'],
    topology: { A: 'vcc', B: 'vcc', C: 'vcc', D: 'vcc', Y: 'load' },
  },
  'logic-gate-nor-4': {
    pins: ['A', 'B', 'C', 'D', 'Y'],
    topology: { A: 'vcc', B: 'vcc', C: 'vcc', D: 'vcc', Y: 'load' },
  },
  'diode-1n5817': { pins: ['A', 'C'] },
  'diode-1n5819': { pins: ['A', 'C'] },
  photodiode: { pins: ['A', 'C'], properties: { lux: 500 } },
  relay: { pins: ['COIL+', 'COIL-', 'COM', 'NO', 'NC'], properties: { coil_voltage: 5 } },
  'opto-4n25': { pins: ['AN', 'CAT', 'COL', 'EMIT'] },
  'opto-pc817': { pins: ['AN', 'CAT', 'COL', 'EMIT'] },
  // ICs: include at least one full gate (1A, 1B, 1Y) so the mapper emits
  // cards. Listed in NEEDS_CUSTOM_TOPOLOGY so the ngspice-acceptance test
  // doesn't try to short the output to GND.
  'ic-74hc00': { pins: ['1A', '1B', '1Y'] },
  'ic-74hc02': { pins: ['1A', '1B', '1Y'] },
  'ic-74hc04': { pins: ['1A', '1Y'] },
  'ic-74hc08': { pins: ['1A', '1B', '1Y'] },
  'ic-74hc14': { pins: ['1A', '1Y'] },
  'ic-74hc32': { pins: ['1A', '1B', '1Y'] },
  'ic-74hc86': { pins: ['1A', '1B', '1Y'] },
  'motor-driver-l293d': { pins: ['EN1', 'IN1', 'OUT1'] },
};

// Each PASSIVE_PRESETS entry shares pins with its base, so we derive the
// fixture instead of restating it (keeps the two lists from drifting).
const BASE_PINS: Record<string, string[]> = {
  resistor: ['1', '2'],
  capacitor: ['1', '2'],
  'capacitor-electrolytic': ['+', '−'],
  inductor: ['1', '2'],
};
for (const [presetId, baseId] of Object.entries(PASSIVE_PRESETS)) {
  MINIMAL_FIXTURES[presetId] = { pins: BASE_PINS[baseId] };
}

describe('PASSIVE_PRESETS — preset variants share their base mapper', () => {
  it('every preset emits the same card prefix as its base (just the value/id differ)', () => {
    const PREFIX = {
      resistor: 'R_',
      capacitor: 'C_',
      'capacitor-electrolytic': 'C_',
      inductor: 'L_',
    } as const;
    for (const [presetId, baseId] of Object.entries(PASSIVE_PRESETS)) {
      const fx = MINIMAL_FIXTURES[presetId];
      const netLookup = (pin: string) => (fx.pins.includes(pin) ? `n_${pin}` : null);
      const emission = componentToSpice(
        { id: 'p', metadataId: presetId, properties: { value: '47' } },
        netLookup,
        { vcc: 5 },
      );
      expect(emission, `${presetId} emitted nothing`).not.toBeNull();
      expect(
        emission!.cards[0].startsWith(PREFIX[baseId]),
        `${presetId} should emit a ${PREFIX[baseId]}… card, got: ${emission!.cards[0]}`,
      ).toBe(true);
    }
  });

  it('electrolytic uses the +/− pin names (not 1/2)', () => {
    const onlyOnePinLookup = (pin: string) => (pin === '+' || pin === '−' ? `n_${pin}` : null);
    const emission = componentToSpice(
      { id: 'e1', metadataId: 'capacitor-electrolytic', properties: { value: '100u' } },
      onlyOnePinLookup,
      { vcc: 5 },
    );
    expect(emission).not.toBeNull();
    expect(emission!.cards[0]).toContain('n_+');
    expect(emission!.cards[0]).toContain('n_−');
  });

  it('electrolytic returns null if pin names are wrong', () => {
    const wrongPinLookup = (pin: string) => (pin === '1' || pin === '2' ? `n_${pin}` : null);
    const emission = componentToSpice(
      { id: 'e1', metadataId: 'capacitor-electrolytic', properties: { value: '100u' } },
      wrongPinLookup,
      { vcc: 5 },
    );
    expect(emission).toBeNull();
  });
});

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

// Components that can't be tested with the one-component harness regardless
// of topology overrides:
//   - Op-amps have huge open-loop gain; need real feedback (e.g. inverting
//     or follower) to converge. Covered by spice-opamps.test.ts.
//   - Multi-gate ICs (74hc*, motor-driver) have many output pins that all
//     need individual loads. Covered by spice-active.test.ts and
//     spice_mapped_74hc.test.js.
const NEEDS_CUSTOM_TOPOLOGY = new Set([
  'opamp-ideal',
  'opamp-lm358',
  'opamp-lm741',
  'opamp-tl072',
  'opamp-lm324',
  'ic-74hc00',
  'ic-74hc02',
  'ic-74hc04',
  'ic-74hc08',
  'ic-74hc14',
  'ic-74hc32',
  'ic-74hc86',
  'motor-driver-l293d',
]);

describe('componentToSpice — ngspice accepts every card', () => {
  for (const id of Object.keys(MINIMAL_FIXTURES)) {
    if (NEEDS_CUSTOM_TOPOLOGY.has(id)) continue;
    it(`${id} produces a netlist ngspice can solve`, { timeout: 30_000 }, async () => {
      const fx = MINIMAL_FIXTURES[id];
      const pins = fx.pins;
      const board = {
        id: 'brd',
        vcc: 5,
        pins: {},
        groundPinNames: ['GND'],
        vccPinNames: ['VCC'],
      };

      // Decide where each pin goes: explicit topology override wins; otherwise
      // fall back to the "first → VCC, last → GND, middle → load" default.
      type PinRole = 'vcc' | 'gnd' | 'load';
      const roleOf = (pinName: string, idx: number): PinRole => {
        if (fx.topology && fx.topology[pinName]) return fx.topology[pinName];
        if (idx === 0) return 'vcc';
        if (idx === pins.length - 1) return 'gnd';
        return 'load';
      };

      const wires: Array<{
        id: string;
        start: { componentId: string; pinName: string };
        end: { componentId: string; pinName: string };
      }> = [];
      const loadResistors: Array<{
        id: string;
        metadataId: string;
        properties: Record<string, unknown>;
      }> = [];

      pins.forEach((pinName, idx) => {
        const role = roleOf(pinName, idx);
        if (role === 'vcc') {
          wires.push({
            id: `w_${idx}_vcc`,
            start: { componentId: 'brd', pinName: 'VCC' },
            end: { componentId: 'dut', pinName },
          });
        } else if (role === 'gnd') {
          wires.push({
            id: `w_${idx}_gnd`,
            start: { componentId: 'dut', pinName },
            end: { componentId: 'brd', pinName: 'GND' },
          });
        } else {
          // 'load': wire pin through an auto-created 1 MΩ resistor to GND.
          const loadId = `load_${idx}`;
          loadResistors.push({ id: loadId, metadataId: 'resistor', properties: { value: '1Meg' } });
          wires.push({
            id: `w_${idx}_load_a`,
            start: { componentId: 'dut', pinName },
            end: { componentId: loadId, pinName: '1' },
          });
          wires.push({
            id: `w_${idx}_load_b`,
            start: { componentId: loadId, pinName: '2' },
            end: { componentId: 'brd', pinName: 'GND' },
          });
        }
      });

      const { netlist } = buildNetlist({
        components: [
          { id: 'dut', metadataId: id, properties: fx.properties ?? {} },
          ...loadResistors,
        ],
        wires,
        boards: [board],
        analysis: { kind: 'op' },
      });

      // Must at least contain the device's card. Accepted prefixes:
      //   R/C/L (passives), D (diode), Q/M (BJT/MOSFET), E (VCVS),
      //   S (switch), V (voltage source, e.g. signal-generator, battery),
      //   B (behavioral source, e.g. logic gates, regulators, op-amps).
      expect(netlist).toMatch(new RegExp(`[RCLDQMESVB]_dut`));

      const result = await runNetlist(netlist);
      // Accept if ngspice returned any voltage variable without throwing
      expect(result.variableNames.length).toBeGreaterThan(0);
      expect(Number.isFinite(result.dcValue(result.variableNames[0]))).toBe(true);
    });
  }
});
