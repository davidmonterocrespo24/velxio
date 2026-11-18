/**
 * analog-night-light is dark above its switch point, as its text says
 * (velxio/velxio-prod#226).
 *
 * After the photoresistor module's polarity fix (#103) the example's two
 * transistors follow AO: Q1's emitter feeds Q2's base, a pair that turns on
 * at two base-emitter drops. It lit at 20 lux and was dim at 30, but it kept
 * leaking: 0.71 mA at 40 lux, 26 uA at 60 and 1.1 uA at 90. The LED part drew
 * every current above 1 uA as lit, and the element draws a lit LED at 30 % of
 * its full glow or more, so the LED showed the same faint glow from about 35
 * to 90 lux.
 *
 * Two changes, both checked here:
 * - Rbe, 10 kOhm from Q2's base to its emitter, the usual bias of such a
 *   pair: Q2 stays off until Q1 passes it about 60 uA, so the current falls
 *   twice as fast with the light (13 mA at 25 lux, 3.0 to 3.7 mA at 30, under
 *   20 uA from 42; the spread is the 2N2222's model, which release 8 fitted
 *   to its datasheet, velxio/velxio-prod#136);
 * - the LED part draws an LED lit from a thousandth of its full brightness
 *   (20 uA for a 20 mA LED) on every path. A publish window and the hold
 *   after a solve already did; a single solve used 1 uA.
 *
 * The example's own circuit on ngspice, and the real LED part reading it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { exampleProjects, type ExampleProject } from '../data/examples';
import { useElectricalStore } from '../store/useElectricalStore';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/BasicParts';
import { runNetlist } from './helpers/testSolver';

const NIGHT_LIGHT = exampleProjects.find((e) => e.id === 'analog-night-light')!;

/** The example at `lux`, with or without its Rbe. */
function nightLight(lux: number, withRbe = true): ExampleProject {
  return {
    ...NIGHT_LIGHT,
    components: NIGHT_LIGHT.components
      .filter((c) => withRbe || c.id !== 'rbe')
      .map((c) => (c.id === 'ldr' ? { ...c, properties: { ...c.properties, lux } } : c)),
    wires: NIGHT_LIGHT.wires.filter((w) => withRbe || (w.start.componentId !== 'rbe' && w.end.componentId !== 'rbe')),
  };
}

/** The LED's current, A, as ngspice solves the example. */
async function ledAmps(ex: ExampleProject): Promise<number> {
  const built = buildNetlist(exampleToBuildNetlistInput(ex, {}));
  const result = await runNetlist(built.netlist);
  return Math.abs(result.dcValue('i(v_led1_sense)'));
}

afterEach(() => {
  useElectricalStore.getState().reset();
  vi.unstubAllGlobals();
});

/** The LED part as the canvas attaches it, with the store holding `amps`. */
function drawnAt(amps: number): { value: boolean; brightness: number } {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  useElectricalStore.getState().setSolveResult({
    ...useElectricalStore.getState(),
    branchCurrents: { v_led1_sense: amps },
    timeWaveforms: undefined,
    window: undefined,
  });
  const el = { addEventListener: () => {}, removeEventListener: () => {}, value: false, brightness: 0 } as unknown as HTMLElement & { value: boolean; brightness: number };
  const pinManager = { onPinChange: () => () => {}, onPwmChange: () => () => {}, getPwmValue: () => 0 };
  const detach = PartSimulationRegistry.get('led')!.attachEvents!(el, { pinManager } as never, () => null, 'led1');
  const out = { value: el.value, brightness: el.brightness };
  detach?.();
  return out;
}

describe('analog-night-light lights below about 30 lux and is out by about 40 (#226)', () => {
  it('its LED, as the canvas draws it, from 20 to 90 lux', { timeout: 60_000 }, async () => {
    const drawn = async (lux: number) => drawnAt(await ledAmps(nightLight(lux)));
    // Lit, and bright, in the dark.
    for (const lux of [10, 20, 25]) {
      const d = await drawn(lux);
      expect(d.value, `${lux} lux`).toBe(true);
      expect(d.brightness, `${lux} lux`).toBeGreaterThan(0.6);
    }
    // Dim at the switch point, as the text says.
    const dusk = await drawn(30);
    expect(dusk.value).toBe(true);
    expect(dusk.brightness).toBeGreaterThan(0.1);
    expect(dusk.brightness).toBeLessThan(0.5);
    // Out from about 40 lux; the faint glow used to last to 90.
    for (const lux of [45, 50, 60, 70, 90, 300]) {
      expect((await drawn(lux)).value, `${lux} lux`).toBe(false);
    }
  });

  it('Rbe makes the switch: the pair without it still glows at 50 lux', { timeout: 60_000 }, async () => {
    expect(NIGHT_LIGHT.components.find((c) => c.id === 'rbe')?.properties.value).toBe('10000');
    // The currents the text quotes, with Rbe.
    expect(await ledAmps(nightLight(25))).toBeGreaterThan(0.012);
    expect(await ledAmps(nightLight(30))).toBeGreaterThan(0.0025);
    expect(await ledAmps(nightLight(42))).toBeLessThan(20e-6);
    expect(await ledAmps(nightLight(50))).toBeLessThan(20e-6);
    // Without it, about 0.1 mA at 50 lux: drawn lit.
    const without = await ledAmps(nightLight(50, false));
    expect(without).toBeGreaterThan(20e-6);
    expect(drawnAt(without).value).toBe(true);
    expect(await ledAmps(nightLight(70, false))).toBeLessThan(20e-6);
  });

  it('the text says so', () => {
    expect(NIGHT_LIGHT.description).toContain('below about 30 lux the LED lights up, and by about 40 lux it is out');
    expect(NIGHT_LIGHT.description).toContain("Rbe, 10 kOhm from Q2's base to its emitter");
  });
});

describe('the LED part draws an LED lit from a thousandth of its full brightness (#226)', () => {
  it('a single solve: 10 uA is dark, 30 uA is lit, as a window and the hold already drew them', () => {
    expect(drawnAt(1.1e-6).value).toBe(false);
    expect(drawnAt(10e-6).value).toBe(false);
    expect(drawnAt(30e-6).value).toBe(true);
    expect(drawnAt(0.013).value).toBe(true);
  });

  it('a publish window of the same currents draws the same', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const state = (weight: number, amps: number) => ({ weight, ms: weight * 33, levels: {}, nodeVoltages: {}, branchCurrents: { v_led1_sense: amps } });
    const el = { addEventListener: () => {}, removeEventListener: () => {}, value: true, brightness: 0 } as unknown as HTMLElement & { value: boolean; brightness: number };
    const pinManager = { onPinChange: () => () => {}, onPwmChange: () => () => {}, getPwmValue: () => 0 };
    PartSimulationRegistry.get('led')!.attachEvents!(el, { pinManager } as never, () => null, 'led1');
    const publish = (states: ReturnType<typeof state>[]) =>
      useElectricalStore.getState().setSolveResult({
        ...useElectricalStore.getState(),
        branchCurrents: { v_led1_sense: states.at(-1)!.branchCurrents.v_led1_sense },
        window: { ms: 33, states },
      });
    publish([state(0.5, 10e-6), state(0.5, 10e-6)]);
    expect(el.value).toBe(false);
    publish([state(0.5, 30e-6), state(0.5, 30e-6)]);
    expect(el.value).toBe(true);
  });
});
