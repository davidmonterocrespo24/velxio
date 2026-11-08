// @vitest-environment jsdom
/**
 * The two OSS leftovers of velxio/velxio-prod#21.
 *
 *  - After Run, a bare LED still burnt out with "LED burnt out — it drew
 *    3926842489288.3 A": an ideal source across a diode solves at trillions of
 *    amperes, a figure that means nothing. The pre-run check already says "no
 *    series resistor" past 1 A; the running LED now says the same.
 *  - The net-based short check rightly stops a project whose LCD1602 sits with
 *    GND, VCC, SDA and SCL in one 5-hole breadboard strip (3V3 meets GND in that
 *    strip), but said only "the 3V3 supply pin of esp32 is wired to ground
 *    (GND)", which the user cannot find on the canvas. It now names the strip
 *    and the part pins it joins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { BOARD_PIN_GROUPS } from '../simulation/spice/boardPinGroups';
import type { BoardForSpice, BuildNetlistInput } from '../simulation/spice/types';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/BasicParts';
import { PinManager } from '../simulation/PinManager';
import { useElectricalStore } from '../store/useElectricalStore';

function esp32(): BoardForSpice {
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
}

function w(id: string, from: [string, string], to: [string, string]): BuildNetlistInput['wires'][number] {
  return { id, start: { componentId: from[0], pinName: from[1] }, end: { componentId: to[0], pinName: to[1] } };
}

/** A QA project: an I2C LCD1602 jumpered to the ESP32, its four-pin header
 *  pushed into the breadboard down one column, so one strip holds all four. */
function lcdInOneStrip(): BuildNetlistInput {
  return {
    components: [
      { id: 'bb1', metadataId: 'breadboard', properties: {} },
      { id: 'lcd1', metadataId: 'lcd1602-i2c', properties: {} },
    ],
    wires: [
      w('w1', ['esp32', '3V3'], ['lcd1', 'VCC']),
      w('w2', ['esp32', 'GND'], ['lcd1', 'GND']),
      w('w3', ['esp32', '21'], ['lcd1', 'SDA']),
      w('w4', ['esp32', '22'], ['lcd1', 'SCL']),
      // The header as the breadboard seats it.
      w('bb-0', ['lcd1', 'GND'], ['bb1', '12t.a']),
      w('bb-1', ['lcd1', 'VCC'], ['bb1', '12t.b']),
      w('bb-2', ['lcd1', 'SDA'], ['bb1', '12t.c']),
      w('bb-3', ['lcd1', 'SCL'], ['bb1', '12t.d']),
    ],
    boards: [esp32()],
    analysis: { kind: 'op' },
  };
}

describe('the power short names what joins the supply to ground', () => {
  it('a header seated down one strip: the strip and the part pins in it', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit(lcdInOneStrip());
    const short = result.errors.find((e) => e.code === 'power-short');
    expect(short, JSON.stringify(result.errors)).toBeDefined();
    const msg = short!.message;
    expect(msg).toContain('3V3');
    expect(msg).toContain('bb1');
    expect(msg).toMatch(/column 12/);
    expect(msg).toMatch(/lcd1's GND, VCC, SDA and SCL pins/);
  });

  it('the same header across four strips shorts nothing', { timeout: 30_000 }, async () => {
    const input = lcdInOneStrip();
    input.wires = input.wires.map((wire, i) =>
      wire.id.startsWith('bb-') ? { ...wire, end: { ...wire.end, pinName: `${12 + i - 4}t.c` } } : wire,
    );
    const result = await verifyCircuit(input);
    expect(result.errors.map((e) => e.code), JSON.stringify(result.errors)).not.toContain('power-short');
  });

  it('a short through two strips a wire joins names both strips and the wire', { timeout: 30_000 }, async () => {
    // 3V3 into strip 10t, a jumper from 10t to 20t, GND into 20t.
    const result = await verifyCircuit({
      components: [{ id: 'bb1', metadataId: 'breadboard', properties: {} }],
      wires: [
        w('w1', ['esp32', '3V3'], ['bb1', '10t.a']),
        w('j1', ['bb1', '10t.e'], ['bb1', '20t.e']),
        w('w2', ['esp32', 'GND'], ['bb1', '20t.a']),
      ],
      boards: [esp32()],
      analysis: { kind: 'op' },
    });
    const short = result.errors.find((e) => e.code === 'power-short');
    expect(short, JSON.stringify(result.errors)).toBeDefined();
    const msg = short!.message;
    expect(msg).toMatch(/strip 10t of breadboard bb1 \(column 10, holes a-e\), then a wire to strip 20t of breadboard bb1 \(column 20, holes a-e\)/);
    expect(msg).toMatch(/reaches ground \(esp32's GND pin\)/);
    // Not the old reading: one pin is not a short.
    expect(msg).not.toMatch(/which joins esp32's 3V3 pin\b/);
  });

  it('a supply wired straight to a ground pin still names the pins', { timeout: 30_000 }, async () => {
    const result = await verifyCircuit({
      components: [],
      wires: [w('w1', ['esp32', '3V3'], ['esp32', 'GND'])],
      boards: [esp32()],
      analysis: { kind: 'op' },
    });
    const short = result.errors.find((e) => e.code === 'power-short');
    expect(short, JSON.stringify(result.errors)).toBeDefined();
    expect(short!.message).toContain('3V3');
    expect(short!.message).toMatch(/esp32's GND pin/);
  });
});

describe('a burnt LED does not print an ideal source’s current', () => {
  const faults: string[] = [];
  const onFault = (e: Event) => faults.push((e as CustomEvent<{ message: string }>).detail.message);

  afterEach(() => {
    window.removeEventListener('velxio-circuit-fault', onFault);
    faults.length = 0;
    useElectricalStore.setState({ branchCurrents: {} });
  });

  function burnWith(amps: number): string {
    window.addEventListener('velxio-circuit-fault', onFault);
    useElectricalStore.setState({ branchCurrents: { v_led1_sense: amps } });
    const el = document.createElement('div');
    const detach = PartSimulationRegistry.get('led')!.attachEvents!(
      el,
      { pinManager: new PinManager() } as never,
      () => null,
      'led1',
    );
    detach();
    expect(faults.length).toBe(1);
    return faults[0];
  }

  it('past 1 A it says there is no series resistor, without the figure', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const msg = burnWith(3926842489288.3);
    expect(msg).toMatch(/no series resistor/);
    expect(msg).not.toMatch(/3926842489288/);
    expect(msg).not.toMatch(/\d\s*A\b/);
  });

  it('a physical overcurrent keeps its figure', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(burnWith(0.25)).toMatch(/250 mA/);
  });
});
