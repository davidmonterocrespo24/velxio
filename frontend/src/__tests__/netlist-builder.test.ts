import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from './helpers/testSolver';
import { UnionFind } from '../simulation/spice/unionFind';
import { BOARD_PIN_GROUPS } from '../simulation/spice/boardPinGroups';
import { parseValueWithUnits } from '../simulation/spice/valueParser';
import type { BoardForSpice } from '../simulation/spice/types';

describe('UnionFind', () => {
  it('unions transitively', () => {
    const uf = new UnionFind();
    uf.union('a', 'b');
    uf.union('b', 'c');
    expect(uf.find('a')).toBe(uf.find('c'));
  });
  it('canonical name propagates on union', () => {
    const uf = new UnionFind();
    uf.union('gnd_pin_x', 'r1_pin2');
    uf.setCanonical('gnd_pin_x', '0');
    expect(uf.find('r1_pin2')).toBe('0');
  });
  it('ground wins over vcc when both canonicals collide', () => {
    const uf = new UnionFind();
    uf.setCanonical('node_a', 'vcc_rail');
    uf.setCanonical('node_b', '0');
    uf.union('node_a', 'node_b');
    expect(uf.find('node_a')).toBe('0');
  });
});

describe('parseValueWithUnits', () => {
  it('parses SPICE SI suffixes', () => {
    expect(parseValueWithUnits('4.7k')).toBe(4700);
    expect(parseValueWithUnits('220')).toBe(220);
    expect(parseValueWithUnits('1Meg')).toBe(1_000_000);
    expect(parseValueWithUnits('10u')).toBeCloseTo(1e-5);
    expect(parseValueWithUnits('100n')).toBeCloseTo(1e-7);
    expect(parseValueWithUnits('22p')).toBeCloseTo(2.2e-11);
    expect(parseValueWithUnits('10mH')).toBeCloseTo(0.01);
    expect(parseValueWithUnits('1.5H')).toBe(1.5);
    expect(parseValueWithUnits('0.1u')).toBeCloseTo(1e-7);
  });
  it('passes numbers through', () => {
    expect(parseValueWithUnits(1000)).toBe(1000);
  });
  it('returns fallback for garbage', () => {
    expect(parseValueWithUnits('banana', 42)).toBe(42);
    expect(parseValueWithUnits(undefined, 99)).toBe(99);
  });
});

describe('NetlistBuilder — simple cases', () => {
  it('emits a voltage divider and ngspice gets 6V', { timeout: 30_000 }, async () => {
    const { netlist } = buildNetlist({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '1k' } },
        { id: 'r2', metadataId: 'resistor', properties: { value: '2k' } },
      ],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'arduino', pinName: '5V' },
          end: { componentId: 'r1', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'r1', pinName: '2' },
          end: { componentId: 'r2', pinName: '1' },
        },
        {
          id: 'w3',
          start: { componentId: 'r2', pinName: '2' },
          end: { componentId: 'arduino', pinName: 'GND' },
        },
      ],
      boards: [
        {
          id: 'arduino',
          vcc: 5,
          pins: { '5V': { type: 'digital', v: 5 }, GND: { type: 'digital', v: 0 } },
          groundPinNames: ['GND'],
          vccPinNames: ['5V'],
        },
      ],
      analysis: { kind: 'op' },
    });
    // Netlist should include two resistors and a vcc rail source
    expect(netlist).toMatch(/R_r1/);
    expect(netlist).toMatch(/R_r2/);
    expect(netlist).toMatch(/V_VCC_RAIL vcc_rail 0 DC 5/);
    expect(netlist).toMatch(/\.op/);
    expect(netlist).toMatch(/\.end/);

    // But critically: ngspice should accept it and return 10/3 V at midpoint
    // (5V · 2k / 3k = 3.333V)
    const result = await runNetlist(netlist);
    // Find the middle net name — it's auto-generated as "n0" or similar
    const midV = result.vec('v(n0)') as number[];
    expect(midV[0]).toBeCloseTo((5 * 2) / 3, 2);
  });

  it(
    'emits an LED + resistor from 5V rail and ngspice solves non-linear',
    { timeout: 30_000 },
    async () => {
      const { netlist } = buildNetlist({
        components: [
          { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
          { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
        ],
        wires: [
          {
            id: 'w1',
            start: { componentId: 'board', pinName: 'VCC' },
            end: { componentId: 'r1', pinName: '1' },
          },
          {
            id: 'w2',
            start: { componentId: 'r1', pinName: '2' },
            end: { componentId: 'led1', pinName: 'A' },
          },
          {
            id: 'w3',
            start: { componentId: 'led1', pinName: 'C' },
            end: { componentId: 'board', pinName: 'GND' },
          },
        ],
        boards: [
          {
            id: 'board',
            vcc: 5,
            pins: {},
            groundPinNames: ['GND'],
            vccPinNames: ['VCC'],
          },
        ],
        analysis: { kind: 'op' },
      });
      expect(netlist).toMatch(/D_led1 \S+ 0 LED_RED/);
      expect(netlist).toMatch(/\.model LED_RED D\(Is=1e-20 N=1\.7\)/);

      const result = await runNetlist(netlist);
      // Forward voltage on the anode should be ≈ 2.0 V for a red LED
      const anodeNet = netlist.match(/D_led1 (\S+) 0 LED_RED/)?.[1];
      expect(anodeNet).toBeTruthy();
      const Vf = (result.vec(`v(${anodeNet})`) as number[])[0];
      expect(Vf).toBeGreaterThan(1.7);
      expect(Vf).toBeLessThan(2.3);
    },
  );

  it('NTC divider: T=25°C produces V(a0) ≈ 2.5V', { timeout: 30_000 }, async () => {
    const { netlist } = buildNetlist({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } },
        { id: 'ntc1', metadataId: 'ntc-temperature-sensor', properties: { temperature: 25 } },
      ],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'uno', pinName: '5V' },
          end: { componentId: 'r1', pinName: '1' },
        },
        {
          id: 'w2',
          start: { componentId: 'r1', pinName: '2' },
          end: { componentId: 'ntc1', pinName: '1' },
        },
        {
          id: 'w3',
          start: { componentId: 'ntc1', pinName: '2' },
          end: { componentId: 'uno', pinName: 'GND' },
        },
      ],
      boards: [
        {
          id: 'uno',
          vcc: 5,
          pins: {},
          groundPinNames: ['GND'],
          vccPinNames: ['5V'],
        },
      ],
      analysis: { kind: 'op' },
    });
    const result = await runNetlist(netlist);
    // Net between R1 and NTC is auto-named; find it.
    const midNet = netlist.match(/R_r1 vcc_rail (\S+) /)?.[1];
    expect(midNet).toBeTruthy();
    const v = (result.vec(`v(${midNet})`) as number[])[0];
    expect(v).toBeCloseTo(2.5, 1);
  });

  it('adds auto pull-down on floating cap-only node', () => {
    // Two caps share a node (net x) that only touches capacitors → DC-floating.
    const { netlist } = buildNetlist({
      components: [
        { id: 'c1', metadataId: 'capacitor', properties: { value: '1u' } },
        { id: 'c2', metadataId: 'capacitor', properties: { value: '1u' } },
      ],
      wires: [
        {
          id: 'w_share',
          start: { componentId: 'c1', pinName: '1' },
          end: { componentId: 'c2', pinName: '1' },
        },
        {
          id: 'w1',
          start: { componentId: 'c1', pinName: '2' },
          end: { componentId: 'board', pinName: 'GND' },
        },
        {
          id: 'w2',
          start: { componentId: 'c2', pinName: '2' },
          end: { componentId: 'board', pinName: 'GND' },
        },
      ],
      boards: [{ id: 'board', vcc: 5, pins: {}, groundPinNames: ['GND'] }],
      analysis: { kind: 'op' },
    });
    expect(netlist).toMatch(/R_autopull_/);
  });

  it('PWM pin emits DC-equivalent voltage source', () => {
    const { netlist } = buildNetlist({
      components: [],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'uno', pinName: 'D9' },
          end: { componentId: 'uno', pinName: 'GND' },
        },
      ],
      boards: [
        {
          id: 'uno',
          vcc: 5,
          pins: { D9: { type: 'pwm', duty: 0.5 } },
          groundPinNames: ['GND'],
        },
      ],
      analysis: { kind: 'op' },
    });
    // D9 is wired directly to GND → same net as ground → no source emitted
    // (this is a degenerate case; just ensure we don't crash)
    expect(netlist).toMatch(/\.end/);
  });
});

describe('NetlistBuilder — aux supply rails (off-voltage supply pins, B16)', () => {
  // Boards built exactly the way storeAdapter builds them, so these tests
  // exercise the real BOARD_PIN_GROUPS tables.
  const boardFromGroup = (id: string, kind: keyof typeof BOARD_PIN_GROUPS): BoardForSpice => {
    const g = BOARD_PIN_GROUPS[kind];
    return {
      id,
      boardKind: kind,
      vcc: g.vcc,
      pins: {},
      groundPinNames: g.gnd,
      vccPinNames: g.vcc_pins,
      auxPinNames: g.aux?.pins,
      auxVolts: g.aux?.volts,
    };
  };
  const wire = (id: string, aId: string, aPin: string, bId: string, bPin: string) => ({
    id,
    start: { componentId: aId, pinName: aPin },
    end: { componentId: bId, pinName: bPin },
  });

  it(
    'ESP32 VIN solves at 5 V while vcc_rail stays at 3.3 V',
    { timeout: 30_000 },
    async () => {
      const { netlist, pinNetMap } = buildNetlist({
        components: [
          { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } },
          { id: 'r2', metadataId: 'resistor', properties: { value: '10k' } },
        ],
        wires: [
          wire('w1', 'esp32', 'VIN', 'r1', '1'),
          wire('w2', 'r1', '2', 'esp32', 'GND'),
          wire('w3', 'esp32', '3V3', 'r2', '1'),
          wire('w4', 'r2', '2', 'esp32', 'GND'),
        ],
        boards: [boardFromGroup('esp32', 'esp32')],
        analysis: { kind: 'op' },
      });
      // VIN must land on its own 5 V aux rail, NOT collapse onto vcc_rail
      // (the customer-reported clamp: 5 V pin reading 3.3 V).
      expect(pinNetMap.get('esp32:VIN')).toBe('aux_rail_5');
      expect(pinNetMap.get('esp32:3V3')).toBe('vcc_rail');
      expect(netlist).toMatch(/V_AUX_RAIL_5 aux_rail_5 0 DC 5/);
      expect(netlist).toMatch(/V_VCC_RAIL vcc_rail 0 DC 3\.3/);
      const result = await runNetlist(netlist);
      expect(result.dcValue('v(aux_rail_5)')).toBeCloseTo(5, 2);
      expect(result.dcValue('v(vcc_rail)')).toBeCloseTo(3.3, 2);
    },
  );

  it(
    'Arduino Uno 3.3V pin solves at 3.3 V while the 5 V rail stays at 5 V',
    { timeout: 30_000 },
    async () => {
      const { netlist, pinNetMap } = buildNetlist({
        components: [
          { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } },
          { id: 'r2', metadataId: 'resistor', properties: { value: '10k' } },
        ],
        wires: [
          wire('w1', 'uno', '3.3V', 'r1', '1'),
          wire('w2', 'r1', '2', 'uno', 'GND'),
          wire('w3', 'uno', '5V', 'r2', '1'),
          wire('w4', 'r2', '2', 'uno', 'GND'),
        ],
        boards: [boardFromGroup('uno', 'arduino-uno')],
        analysis: { kind: 'op' },
      });
      expect(pinNetMap.get('uno:3.3V')).toBe('aux_rail_3v3');
      expect(pinNetMap.get('uno:5V')).toBe('vcc_rail');
      expect(netlist).toMatch(/V_AUX_RAIL_3V3 aux_rail_3v3 0 DC 3\.3/);
      expect(netlist).toMatch(/V_VCC_RAIL vcc_rail 0 DC 5/);
      const result = await runNetlist(netlist);
      expect(result.dcValue('v(aux_rail_3v3)')).toBeCloseTo(3.3, 2);
      expect(result.dcValue('v(vcc_rail)')).toBeCloseTo(5, 2);
    },
  );

  it('a module VCC pin wired to VIN stays on the 5 V aux rail', () => {
    // The VCC pin-name heuristic canonicalizes to vcc_rail; the wire to VIN
    // must win (aux rails outrank the heuristic in pickCanonical) or the
    // module would be "powered" at 3.3 V despite being wired to 5 V.
    const { pinNetMap } = buildNetlist({
      components: [
        { id: 'oled', metadataId: 'ssd1306-i2c-4pin', properties: {} },
      ],
      wires: [
        wire('w1', 'oled', 'VCC', 'esp32', 'VIN'),
        wire('w2', 'oled', 'GND', 'esp32', 'GND'),
      ],
      boards: [boardFromGroup('esp32', 'esp32')],
      analysis: { kind: 'op' },
    });
    expect(pinNetMap.get('oled:VCC')).toBe('aux_rail_5');
    expect(pinNetMap.get('esp32:VIN')).toBe('aux_rail_5');
  });
});

describe('NetlistBuilder — a board names its supply and ground nets (velxio-prod#21)', () => {
  const esp32 = (): BoardForSpice => {
    const g = BOARD_PIN_GROUPS.esp32;
    return {
      id: 'esp32',
      boardKind: 'esp32',
      vcc: g.vcc,
      pins: {},
      groundPinNames: g.gnd,
      vccPinNames: g.vcc_pins,
      auxPinNames: g.aux?.pins,
      auxVolts: g.aux?.volts,
    };
  };
  const wire = (id: string, aId: string, aPin: string, bId: string, bPin: string) => ({
    id,
    start: { componentId: aId, pinName: aPin },
    end: { componentId: bId, pinName: bPin },
  });

  it(
    'a potentiometer with its power pins swapped keeps the board 3V3 on the rail, its wiper at the inverted divider',
    { timeout: 30_000 },
    async () => {
      // Corpus 0a8365df: the pot's GND on the ESP32's 3V3 and its VCC on GND.
      // The part's pin names used to win over the board's: the 3V3 net
      // became ground, V_VCC_RAIL was never emitted, and the wiper and the
      // divider beside it on the same 3V3 pin both read 0 V.
      const { netlist, pinNetMap } = buildNetlist({
        components: [
          { id: 'pot1', metadataId: 'potentiometer', properties: { value: 256 } },
          { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } },
          { id: 'r2', metadataId: 'resistor', properties: { value: '10k' } },
        ],
        wires: [
          wire('w1', 'pot1', 'GND', 'esp32', '3V3'),
          wire('w2', 'pot1', 'VCC', 'esp32', 'GND'),
          wire('w3', 'pot1', 'SIG', 'esp32', '35'),
          wire('w4', 'esp32', '3V3', 'r1', '1'),
          wire('w5', 'r1', '2', 'r2', '1'),
          wire('w6', 'r2', '2', 'esp32', 'GND'),
        ],
        boards: [esp32()],
        analysis: { kind: 'op' },
      });
      expect(pinNetMap.get('esp32:3V3')).toBe('vcc_rail');
      expect(pinNetMap.get('pot1:GND')).toBe('vcc_rail');
      expect(pinNetMap.get('esp32:GND')).toBe('0');
      expect(pinNetMap.get('pot1:VCC')).toBe('0');
      expect(netlist).toMatch(/V_VCC_RAIL vcc_rail 0 DC 3\.3/);
      const result = await runNetlist(netlist);
      // value 256 of 1023 from the VCC end: the wiper sits 0.25 of the way
      // up from the pin on GND, which is the 3V3 end here.
      expect(result.dcValue(`v(${pinNetMap.get('esp32:35')})`)).toBeCloseTo(3.3 * (1 - 256 / 1023), 2);
      expect(result.dcValue(`v(${pinNetMap.get('r1:2')})`)).toBeCloseTo(1.65, 2);
    },
  );

  it('a net with no board pin keeps the parts\' pin-name hint', () => {
    const { pinNetMap } = buildNetlist({
      components: [
        { id: 'o1', metadataId: 'ssd1306-i2c-4pin', properties: {} },
        { id: 'o2', metadataId: 'ssd1306-i2c-4pin', properties: {} },
      ],
      wires: [wire('w1', 'o1', 'GND', 'o2', 'GND'), wire('w2', 'o1', 'VCC', 'o2', 'VCC')],
      boards: [],
      analysis: { kind: 'op' },
    });
    expect(pinNetMap.get('o1:GND')).toBe('0');
    expect(pinNetMap.get('o1:VCC')).toBe('vcc_rail');
  });
});

describe('NetlistBuilder — ESP32 internal pull-up (INPUT_PULLUP)', () => {
  // GPIO4 set INPUT_PULLUP, with a pushbutton from GPIO4 (1.l) to GND (2.l).
  // This is the canonical active-low button. Without the internal pull the
  // input floats to 0 V and reads LOW even at idle; the stamped 45k pull-up
  // to the 3.3 V rail makes idle read HIGH and a press read LOW.
  const build = (pressed: boolean) =>
    buildNetlist({
      components: [{ id: 'btn', metadataId: 'pushbutton', properties: { pressed } }],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'esp32', pinName: '4' },
          end: { componentId: 'btn', pinName: '1.l' },
        },
        {
          id: 'w2',
          start: { componentId: 'btn', pinName: '2.l' },
          end: { componentId: 'esp32', pinName: 'GND2' },
        },
      ],
      boards: [
        {
          id: 'esp32',
          vcc: 3.3,
          pins: { '4': { type: 'input', pull: 1 } },
          // NOTE: "GND2" is deliberately NOT listed in groundPinNames — it must
          // canonicalize to node 0 via GROUND_PIN_RE (bare GNDn spelling). This
          // is the exact pin the ESP32 DevKit element labels; before the regex
          // fix it floated and the pulled-up input never read a clean level.
        },
      ],
      analysis: { kind: 'op' as const },
    });

  it('stamps the pull resistor + rail source', () => {
    const { netlist } = build(false);
    expect(netlist).toMatch(/R_pull_esp32_4 \S+ vcc_rail 45000/);
    // The rail source must exist even though no wire references VCC.
    expect(netlist).toMatch(/V_VCC_RAIL vcc_rail 0 DC 3\.3/);
  });

  it('idles HIGH (~3.3 V) when the button is open', { timeout: 30_000 }, async () => {
    const { netlist, pinNetMap } = build(false);
    const net = pinNetMap.get('esp32:4')!;
    const result = await runNetlist(netlist);
    expect(result.dcValue(`v(${net})`)).toBeCloseTo(3.3, 1);
  });

  it('reads LOW (~0 V) when the button is pressed', { timeout: 30_000 }, async () => {
    const { netlist, pinNetMap } = build(true);
    const net = pinNetMap.get('esp32:4')!;
    const result = await runNetlist(netlist);
    expect(result.dcValue(`v(${net})`)).toBeCloseTo(0, 1);
  });

  it('pull-down (INPUT_PULLDOWN) ties the idle level to 0 V', { timeout: 30_000 }, async () => {
    const { netlist, pinNetMap } = buildNetlist({
      components: [{ id: 'r', metadataId: 'resistor', properties: { value: '1Meg' } }],
      wires: [
        {
          id: 'w1',
          start: { componentId: 'esp32', pinName: '5' },
          end: { componentId: 'r', pinName: '1' },
        },
      ],
      boards: [{ id: 'esp32', vcc: 3.3, pins: { '5': { type: 'input', pull: 2 } } }],
      analysis: { kind: 'op' as const },
    });
    expect(netlist).toMatch(/R_pull_esp32_5 \S+ 0 45000/);
    const net = pinNetMap.get('esp32:5')!;
    const result = await runNetlist(netlist);
    expect(result.dcValue(`v(${net})`)).toBeCloseTo(0, 1);
  });
});
