/**
 * The pre-run check warns when a part puts more on a GPIO than the pad takes
 * (velxio/velxio-prod#225).
 *
 * Since the #96 follow-up a supply, a battery or a generator wired straight
 * to a GPIO (with its return on ground) is an input the part drives, as it
 * should be: the pre-flight no longer forces that pin HIGH. Nothing then
 * looked at the level. A 9 V battery on an ESP32's VP, or a 7805's 5 V on its
 * GPIO32, ran silently, and so did a bench supply at 5-9 V on a GPIO. None of
 * an ESP32's pads is 5 V tolerant: on hardware the pad's protection diodes
 * conduct and the chip is likely damaged.
 *
 * The limit is the board's, from its pin data: VDD + 0.3 V on an Espressif
 * chip, IOVDD + 0.5 V on the RP2040, VCC + 0.5 V on an ATmega. An STM32 is
 * not checked: its 5 V-tolerant (FT) pads sit beside pads that are not.
 *
 * The real pre-flight (buildPreflightSnapshot, as the Run button builds it)
 * and the real check on ngspice.
 */
import { describe, it, expect } from 'vitest';
import { buildPreflightSnapshot, type PreflightState } from '../simulation/verify/verifyFromStore';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { verifyCircuit, type CircuitWarning } from '../simulation/verify/circuitVerifier';
import { gpioMaxVoltsFor } from '../simulation/spice/boardPinGroups';
import { registerProBoards } from '../lib/proBoardRegistry';
import type { PinSourceState } from '../simulation/spice/types';

const wire = (id: string, a: string, b: string) => {
  const [ac, ap] = a.split(':');
  const [bc, bp] = b.split(':');
  return { id, start: { componentId: ac!, pinName: ap! }, end: { componentId: bc!, pinName: bp! } };
};

type Part = { id: string; metadataId: string; properties: Record<string, unknown> };
const supply = (voltage: number, mode = 'dc'): Part => ({
  id: 'ps',
  metadataId: 'power-supply',
  properties: { mode, voltage, frequency: 50, currentLimit: 1 },
});
const battery = (metadataId: string): Part => ({ id: 'bat', metadataId, properties: {} });
const generator = (waveform: string, offset: number, amplitude: number): Part => ({
  id: 'gen',
  metadataId: 'signal-generator',
  properties: { waveform, offset, amplitude, frequency: 1000 },
});

/** A part's + on a board pin and its - on the board's GND. */
function onPin(src: Part, board: { id: string; boardKind: string }, pin: string, gnd: string): PreflightState {
  const [pos, neg] = src.metadataId.startsWith('battery') ? ['+', '−'] : ['SIG', 'GND'];
  return {
    components: [src],
    wires: [wire('w0', `${src.id}:${pos}`, `${board.id}:${pin}`), wire('w1', `${src.id}:${neg}`, `${board.id}:${gnd}`)],
    boards: [board],
  };
}
const ESP32 = { id: 'esp32', boardKind: 'esp32' };
const onEsp32 = (src: Part, pin = '32') => onPin(src, ESP32, pin, 'GND');

async function preflight(state: PreflightState) {
  const { snap, synthesizedPins } = buildPreflightSnapshot(state);
  return verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
}

const overVoltage = (findings: CircuitWarning[]) => findings.filter((f) => f.code === 'over-voltage');

describe('a part above what an ESP32 pad takes is named, without blocking Run (#225)', () => {
  it('the issue: a 9 V battery on VP', async () => {
    const result = await preflight(onEsp32(battery('battery-9v'), 'VP'));
    expect(result.errors).toEqual([]);
    const [w, ...rest] = overVoltage(result.warnings);
    expect(rest).toEqual([]);
    expect(w!.componentId).toBe('bat');
    expect(w!.severity).toBe('warning');
    expect(w!.metric!).toBeGreaterThan(8.9);
    expect(w!.message).toContain("battery-9v bat holds esp32's VP pin at 9.0 V");
    expect(w!.message).toContain('above the 3.6 V that a GPIO pin of esp32 takes');
    expect(w!.message).toContain('under 3.3 V');
  });

  it("the issue: a 7805's 5 V on GPIO32, read from the solve", async () => {
    const state: PreflightState = {
      components: [battery('battery-9v'), { id: 'reg', metadataId: 'reg-7805', properties: {} }],
      wires: [
        wire('w0', 'bat:+', 'reg:VIN'),
        wire('w1', 'bat:−', 'esp32:GND'),
        wire('w2', 'reg:GND', 'esp32:GND'),
        wire('w3', 'reg:VOUT', 'esp32:32'),
      ],
      boards: [ESP32],
    };
    const result = await preflight(state);
    expect(result.errors).toEqual([]);
    const found = overVoltage(result.warnings);
    expect(found.map((w) => w.componentId)).toEqual(['reg']);
    expect(found[0]!.message).toContain("reg-7805 reg holds esp32's 32 pin at 5.0 V");
  });

  it('a bench supply at 5 V and 9 V on GPIO32; an AA cell and 3.3 V or 3.6 V are fine', async () => {
    for (const v of [5, 9]) {
      const found = overVoltage((await preflight(onEsp32(supply(v)))).warnings);
      expect(found.map((w) => w.componentId), `${v} V`).toEqual(['ps']);
    }
    for (const src of [supply(3.3), supply(3.6), battery('battery-aa'), battery('battery-coin-cell')]) {
      const result = await preflight(onEsp32(src));
      expect(overVoltage(result.warnings), src.metadataId).toEqual([]);
    }
  });

  it("a generator by the crest of its wave, and an AC supply by its peak", async () => {
    // 2 V about a 2 V offset reaches 4 V; its last sample or its offset would not say so.
    const sine = overVoltage((await preflight(onEsp32(generator('sine', 2, 2)))).warnings);
    expect(sine.map((w) => w.componentId)).toEqual(['gen']);
    expect(sine[0]!.message).toContain("signal-generator gen drives esp32's 32 pin up to 4.0 V");
    expect(overVoltage((await preflight(onEsp32(generator('square', 1, 3)))).warnings)).toHaveLength(1);
    expect(overVoltage((await preflight(onEsp32(generator('dc', 5, 0)))).warnings)).toHaveLength(1);
    // The issue's #232 probe: 1 V about 1.25 V stays under 2.25 V.
    expect(overVoltage((await preflight(onEsp32(generator('sine', 1.25, 1)))).warnings)).toEqual([]);
    expect(overVoltage((await preflight(onEsp32(supply(5, 'ac')))).warnings)).toHaveLength(1);
  });

  it('every ESP32 board the same, an overlay one by the chip it carries', async () => {
    registerProBoards([
      {
        kind: 'test-c6-board',
        label: 'Test C6',
        fqbn: null,
        description: '',
        tag: 'velxio-test-c6',
        size: { w: 10, h: 10 },
        esp32Family: 'esp32-c6',
        power: { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3'], aux: { volts: 5, pins: ['5V'] } },
      } as never,
    ]);
    expect(gpioMaxVoltsFor('test-c6-board')).toBe(3.6);
    for (const kind of ['esp32-s3', 'esp32-c3', 'xiao-esp32-c3', 'esp32-devkit-c-v4']) {
      expect(gpioMaxVoltsFor(kind), kind).toBe(3.6);
    }
    const c3 = await preflight(onPin(supply(5), { id: 'c3', boardKind: 'esp32-c3' }, '2', 'GND.1'));
    expect(overVoltage(c3.warnings).map((w) => w.componentId)).toEqual(['ps']);
  });
});

describe('other boards by their own pin data (#225)', () => {
  it('an Uno takes 5 V on a pin but not a 9 V battery on A0', async () => {
    const uno = { id: 'uno', boardKind: 'arduino-uno' };
    expect(overVoltage((await preflight(onPin(supply(5), uno, '7', 'GND.1'))).warnings)).toEqual([]);
    const found = overVoltage((await preflight(onPin(battery('battery-9v'), uno, 'A0', 'GND.1'))).warnings);
    expect(found.map((w) => w.componentId)).toEqual(['bat']);
    expect(found[0]!.message).toContain('above the 5.5 V that a GPIO pin of uno takes');
  });

  it("a Pico's RP2040 takes 3.3 V on a pin but not 5 V", async () => {
    const pico = { id: 'pico', boardKind: 'raspberry-pi-pico' };
    expect(overVoltage((await preflight(onPin(supply(3.3), pico, 'GP26', 'GND.1'))).warnings)).toEqual([]);
    const found = overVoltage((await preflight(onPin(supply(5), pico, 'GP26', 'GND.1'))).warnings);
    expect(found.map((w) => w.componentId)).toEqual(['ps']);
    expect(found[0]!.message).toContain('above the 3.8 V');
  });

  it("an STM32 is not checked: its FT pads take 5 V and its others do not", async () => {
    expect(gpioMaxVoltsFor('stm32-bluepill')).toBeUndefined();
    const bp = { id: 'bp', boardKind: 'stm32-bluepill' };
    expect(overVoltage((await preflight(onPin(supply(5), bp, 'PA8', 'GND'))).warnings)).toEqual([]);
  });
});

describe('what the check leaves alone (#225)', () => {
  it('a divider brings 9 V down to 3 V: the pin is not on the battery\'s net', async () => {
    const state: PreflightState = {
      components: [
        battery('battery-9v'),
        { id: 'r1', metadataId: 'resistor', properties: { value: '20k' } },
        { id: 'r2', metadataId: 'resistor', properties: { value: '10k' } },
      ],
      wires: [
        wire('w0', 'bat:+', 'r1:1'),
        wire('w1', 'r1:2', 'esp32:34'),
        wire('w2', 'esp32:34', 'r2:1'),
        wire('w3', 'r2:2', 'esp32:GND'),
        wire('w4', 'bat:−', 'esp32:GND'),
      ],
      boards: [ESP32],
    };
    expect(overVoltage((await preflight(state)).warnings)).toEqual([]);
  });

  it("a pin the sketch drives against the part: the conflict is named, not an over-voltage too", async () => {
    const state = onEsp32(supply(5));
    const high: PinSourceState = { type: 'digital', v: 3.3 };
    const input = buildInputFromStore({
      components: state.components,
      wires: state.wires as never,
      boards: [{ id: 'esp32', boardKind: 'esp32' as never, pinStates: { '32': high } }],
    });
    const result = await verifyCircuit(input);
    expect(result.errors.map((e) => e.code)).toContain('source-conflict');
    expect(overVoltage(result.warnings)).toEqual([]);
  });

  it("a supply on a pin that is not a GPIO (the ESP32's EN) is left to the rest of the check", async () => {
    expect(overVoltage((await preflight(onEsp32(supply(5), 'EN'))).warnings)).toEqual([]);
  });
});
