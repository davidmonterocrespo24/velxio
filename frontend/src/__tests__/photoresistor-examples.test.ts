/**
 * Every gallery example with the photoresistor module does what its text says
 * with the module's real polarity: AO falls as the light rises (the LDR sits
 * between AO and GND under a 10 kOhm resistor; velxio/velxio-prod#103).
 *
 * Each check solves the example's own circuit with ngspice, turns the voltage
 * into the reading its board's ADC gives, and runs the sketch's arithmetic on
 * it. The sketch lines that arithmetic copies are asserted too, so the copy
 * cannot drift from the code a user runs.
 *
 * Two kinds of example:
 * - light meters (uno-photoresistor, photoresistor-light, nano-sensor-station)
 *   must read more in brighter light;
 * - night lights (analog-night-light, the 100-days auto night light) must
 *   light in the dark and not in daylight, and robot-desktop-eyes, a real
 *   sketch written for the real module, must go to sleep in the dark and see
 *   the light once there is light.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { exampleProjects, type ExampleProject } from '../data/examples';
import { runNetlist } from './helpers/testSolver';
import type { BoardKind } from '../types/board';

function example(id: string): ExampleProject {
  const ex = exampleProjects.find((e) => e.id === id);
  if (!ex) throw new Error(`example ${id} not found`);
  return ex;
}

/** The example with its photoresistor (or any part) given other properties. */
function withProps(ex: ExampleProject, id: string, props: Record<string, unknown>, drop: string[] = []): ExampleProject {
  return {
    ...ex,
    components: ex.components.map((c) => {
      if (c.id !== id) return c;
      const next: Record<string, unknown> = { ...c.properties, ...props };
      for (const k of drop) delete next[k];
      return { ...c, properties: next };
    }),
  };
}

/** Solve an example on its board; `v(pin)` reads a `component:pin` node. */
async function solve(ex: ExampleProject, board?: { id: string; kind: BoardKind }) {
  const built = buildNetlist(
    exampleToBuildNetlistInput(ex, board ? { boards: [{ id: board.id, boardKind: board.kind, pinStates: {} }] } : {}),
  );
  const result = await runNetlist(built.netlist);
  return (pin: string) => {
    const net = built.pinNetMap.get(pin);
    if (!net) throw new Error(`no net for ${pin}`);
    return net === '0' ? 0 : result.dcValue(`v(${net})`);
  };
}

/** An AVR's analogRead of `v` (5 V reference, 10 bits). */
const avrRead = (v: number) => Math.min(1023, Math.max(0, Math.floor((v / 5) * 1024)));

/**
 * The classic ESP32's 12-bit read of `v` at 11 dB, two ways, because the two
 * engines differ: the QEMU worker converts linearly over 0-3.3 V; the
 * in-browser engine gives the code ESP-IDF's line-fitting calibration maps to
 * the voltage (offset 142 mV, 65536 / 52800 codes per mV at the default
 * 1100 mV Vref), saturating at 4095.
 */
const esp32Reads = (v: number): number[] => {
  const mv = v * 1000;
  const linear = Math.max(0, Math.min(4095, Math.floor((mv * 4095) / 3300)));
  const idf = mv <= 142 ? 0 : Math.min(4095, Math.round(((mv - 142) * 65536) / 52800));
  return [linear, idf];
};

/** Arduino's map(): long arithmetic, truncated toward zero. */
const arduinoMap = (x: number, inMin: number, inMax: number, outMin: number, outMax: number) =>
  Math.trunc(((x - inMin) * (outMax - outMin)) / (inMax - inMin)) + outMin;

describe('light meters read more in brighter light (#103)', () => {
  it('uno-photoresistor: light % rises with lux and the LED fades; 88 % at the default 500 lux', { timeout: 60_000 }, async () => {
    const ex = example('uno-photoresistor');
    expect(ex.code).toContain('int percent = map(raw, 0, 1023, 100, 0);');
    expect(ex.code).toContain('int ledPWM = map(raw, 0, 1023, 0, 255);');
    const board = { id: 'arduino-uno', kind: 'arduino-uno' as BoardKind };
    const rows: Array<{ lux: number; raw: number; percent: number; led: number }> = [];
    for (const lux of [0, 1, 10, 100, 500, 1000]) {
      const v = await solve(withProps(ex, 'uno-photo1', { lux }), board);
      const raw = avrRead(v('arduino-uno:A0'));
      rows.push({ lux, raw, percent: arduinoMap(raw, 0, 1023, 100, 0), led: arduinoMap(raw, 0, 1023, 0, 255) });
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].percent, `${rows[i].lux} lux`).toBeGreaterThan(rows[i - 1].percent);
      expect(rows[i].led, `${rows[i].lux} lux`).toBeLessThan(rows[i - 1].led);
    }
    // The default (no lux property): 500 lux, A0 = 5 V * 1434.6 / 11434.6 = 0.627 V.
    const v = await solve(ex, board);
    const raw = avrRead(v('arduino-uno:A0'));
    expect(raw).toBe(128);
    expect(arduinoMap(raw, 0, 1023, 100, 0)).toBe(88);
    expect(arduinoMap(raw, 0, 1023, 0, 255)).toBe(31);
    expect(rows[0].percent).toBeLessThanOrEqual(1); // dark
  });

  it('photoresistor-light: light % rises with lux', { timeout: 60_000 }, async () => {
    const ex = example('photoresistor-light');
    expect(ex.code).toContain('float light = map(raw, 0, 1023, 100, 0);');
    const board = { id: 'arduino-uno', kind: 'arduino-uno' as BoardKind };
    let last = -1;
    for (const lux of [0, 10, 100, 500, 1000]) {
      const v = await solve(withProps(ex, 'ldr', { lux }), board);
      const light = arduinoMap(avrRead(v('arduino-uno:A0')), 0, 1023, 100, 0);
      expect(light, `${lux} lux`).toBeGreaterThan(last);
      last = light;
    }
    expect(last).toBeGreaterThanOrEqual(90);
  });

  it('nano-sensor-station: light % rises with lux, 84 % at its 300 lux', { timeout: 60_000 }, async () => {
    const ex = example('nano-sensor-station');
    expect(ex.code).toContain('float lightPct = 100.0 - lightRaw * 100.0 / 1023.0;');
    const board = { id: 'arduino-nano', kind: 'arduino-nano' as BoardKind };
    const pct = async (props: Record<string, unknown>) => {
      const v = await solve(withProps(ex, 'ldr', props), board);
      return 100 - (avrRead(v('arduino-nano:A1')) * 100) / 1023;
    };
    let last = -1;
    for (const lux of [0, 10, 100, 300, 1000]) {
      const p = await pct({ lux });
      expect(p, `${lux} lux`).toBeGreaterThan(last);
      last = p;
    }
    expect(Math.round(await pct({}))).toBe(84);
  });
});

describe('night lights light in the dark and not in daylight (#103)', () => {
  it('analog-night-light: the sensor output rises as the light falls and the LED lights below about 30 lux', { timeout: 60_000 }, async () => {
    const ex = example('analog-night-light');
    const at = async (lux: number, drop: string[] = []) => {
      const v = await solve(withProps(ex, 'ldr', { lux }, drop));
      return { ao: v('ldr:AO'), mA: ((v('rled:1') - v('rled:2')) / 220) * 1000 };
    };
    const dark = await at(10);
    const dusk = await at(20);
    const half = await at(31);
    const day = await at(60);
    const sun = await at(300);
    expect(dark.ao).toBeGreaterThan(dusk.ao);
    expect(dusk.ao).toBeGreaterThan(day.ao);
    expect(dark.mA).toBeGreaterThan(12);
    expect(dusk.mA).toBeGreaterThan(12);
    expect(half.mA).toBeGreaterThan(2);
    expect(half.mA).toBeLessThan(12);
    expect(day.mA).toBeLessThan(0.1);
    expect(sun.mA).toBeLessThan(0.01);
    // The text: with the stock GL5528 it would light below about 120 lux.
    expect((await at(100, ['rl10', 'gamma'])).mA).toBeGreaterThan(12);
    expect((await at(140, ['rl10', 'gamma'])).mA).toBeLessThan(2);
  });

  it('100d-auto-night-light: the lamp is off at 400 lux and on at 15, 5, 1 and 0 lux, on both ESP32 engines', { timeout: 60_000 }, async () => {
    const ex = example('100d-auto-night-light-using-ldr-esp32-plus-micropython');
    const main = ex.files?.find((f) => f.name === 'main.py')?.content ?? '';
    const threshold = Number(/^threshold = (\d+)/m.exec(main)?.[1]);
    const op = /if light ([<>]) threshold:\s+# It's dark/.exec(main)?.[1];
    expect(Number.isFinite(threshold)).toBe(true);
    const lampOn = (reading: number) => (op === '>' ? reading > threshold : reading < threshold);
    // The 100-days canvases name the board `arduino-uno` whatever it is.
    const board = { id: 'arduino-uno', kind: 'esp32' as BoardKind };
    for (const [lux, on] of [[400, false], [30, false], [15, true], [5, true], [1, true], [0, true]] as const) {
      const v = await solve(withProps(ex, 'night-ldr', { lux }), board);
      for (const reading of esp32Reads(v('arduino-uno:34'))) {
        expect(lampOn(reading), `${lux} lux reads ${reading}`).toBe(on);
      }
    }
  });

  it('robot-desktop-eyes: its unchanged sketch sleeps in the dark it starts in and sees the light once it is lit', { timeout: 60_000 }, async () => {
    const ex = example('robot-desktop-eyes');
    const driver = ex.files?.find((f) => f.name === 'SensorDriver.h')?.content ?? '';
    // The sketch's own light test, copied below: a LOW reading is light,
    // against the midpoint of the darkest and brightest readings so far.
    expect(driver).toContain('int minLight = 10;');
    expect(driver).toContain('int maxLight = 10;');
    expect(driver).toContain('lightThreshold = (minLight + maxLight) / 2;');
    expect(driver).toContain('bool lightPresent = (light < lightThreshold);');
    const board = { id: 'esp32', kind: 'esp32' as BoardKind };
    const ldr = ex.components.find((c) => c.id === 'ldr')!;
    const readsAt = async (lux: unknown) => esp32Reads((await solve(withProps(ex, 'ldr', { lux }), board))('esp32:34'));
    const startReads = await readsAt(ldr.properties?.lux);
    const litReads = await readsAt(500);
    for (const engine of [0, 1]) {
      let minLight = 10;
      let maxLight = 10;
      const isLightOn = (light: number) => {
        if (light < minLight) minLight = light;
        if (light > maxLight) maxLight = light;
        return light < Math.trunc((minLight + maxLight) / 2);
      };
      // The task polls every 500 ms; a few polls at the example's start light.
      for (let i = 0; i < 3; i++) expect(isLightOn(startReads[engine]), `engine ${engine}: starts dark`).toBe(false);
      for (let i = 0; i < 3; i++) expect(isLightOn(litReads[engine]), `engine ${engine}: 500 lux`).toBe(true);
      expect(isLightOn(startReads[engine]), `engine ${engine}: dark again`).toBe(false);
    }
  });
});
