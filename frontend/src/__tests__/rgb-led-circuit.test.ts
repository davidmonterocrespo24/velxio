/**
 * The RGB LED is three LEDs in the circuit, joined at a common pin
 * (velxio/velxio-prod#174).
 *
 * It had no SPICE card at all. The part lit a colour from its pin's logic
 * level alone, whatever resistor and COM wiring it had, so an ammeter in series
 * read the nanoamps of the 100 MOhm auto pull-down, the Run check could not
 * flag a channel with no series resistor (a plain LED wired the same way is
 * flagged), and COM on the supply (a common-anode LED, Wokwi's default) still
 * lit on HIGH. It also wrote 0-255 into the element's ledRed / ledGreen /
 * ledBlue, which the element reads as 0-1 brightness, so any non-zero PWM duty
 * drew full brightness and colour mixing collapsed to 8 colours.
 *
 * Datasheet: Young Sun YSL-R596CR3G4B5C-C10 (the common-cathode RGB LED
 * SparkFun sells as COM-00105): VF at IF = 20 mA is 2.0 V red, 3.2 V green,
 * 3.2 V blue (typ); IF max 20 mA per colour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CircuitSimulationService,
  type ElectricalSnapshot,
  type MixedModeSchedulerPort,
  type SimulatorStorePort,
} from '../simulation/spice/CircuitSimulationService';
import {
  getMixedModeScheduler,
  __resetMixedModeScheduler,
  __setSchedulerSolverFactoryForTests,
} from '../simulation/spice/MixedModeScheduler';
import { NgSpiceNodeAdapter } from '../simulation/spice/adapters/NgSpiceNodeAdapter';
import { createElectricalStorePort } from '../simulation/spice/start';
import { useElectricalStore } from '../store/useElectricalStore';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { componentToSpice, isSpiceMapped } from '../simulation/spice/componentToSpice';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { buildPreflightSnapshot } from '../simulation/verify/verifyFromStore';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { applyPinPwm } from '../store/useSimulatorStore';
import { PinManager } from '../simulation/PinManager';
import { runNetlist } from './helpers/testSolver';
import '../simulation/parts/ComplexParts';
import type { BuildNetlistInput, PinSourceState } from '../simulation/spice/types';
import type { BoardKind } from '../types/board';

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };
type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };
const w = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

/** 5 V from a bench source through one resistor per colour; COM to its ground. */
function rgbOn5V(ohms: { R: number; G: number; B: number }, rgbProps: Record<string, unknown> = {}): BuildNetlistInput {
  return {
    components: [
      { id: 'src', metadataId: 'signal-generator', properties: { waveform: 'dc', offset: 5, amplitude: 0, frequency: 1 } },
      { id: 'rr', metadataId: 'resistor', properties: { value: String(ohms.R) } },
      { id: 'rg', metadataId: 'resistor', properties: { value: String(ohms.G) } },
      { id: 'rb', metadataId: 'resistor', properties: { value: String(ohms.B) } },
      { id: 'rgb1', metadataId: 'rgb-led', properties: rgbProps },
    ],
    wires: [
      w('w1', ['src', 'SIG'], ['rr', '1']),
      w('w2', ['src', 'SIG'], ['rg', '1']),
      w('w3', ['src', 'SIG'], ['rb', '1']),
      w('w4', ['rr', '2'], ['rgb1', 'R']),
      w('w5', ['rg', '2'], ['rgb1', 'G']),
      w('w6', ['rb', '2'], ['rgb1', 'B']),
      w('w7', ['rgb1', 'COM'], ['src', 'GND']),
    ],
    boards: [],
    analysis: { kind: 'op' },
  };
}

/** A board snapshot as the store hands it to the netlist. */
function onBoard(boardKind: BoardKind, components: Comp[], wires: Wire[], pinStates: Record<string, PinSourceState>): BuildNetlistInput {
  return {
    ...buildInputFromStore({ components, wires, boards: [{ id: 'board', boardKind, pinStates }] } as never),
    analysis: { kind: 'op' },
  };
}

const amps = (r: Awaited<ReturnType<typeof runNetlist>>, name: string) => Math.abs(r.dcValue(name));

describe('the RGB LED in the netlist (velxio/velxio-prod#174)', () => {
  it('is SPICE-mapped: one sense source and one die per colour', () => {
    expect(isSpiceMapped('rgb-led')).toBe(true);
    const { netlist } = buildNetlist(rgbOn5V({ R: 150, G: 90, B: 90 }));
    for (const c of ['r', 'g', 'b']) {
      expect(netlist).toMatch(new RegExp(`^V_rgb1_${c}_sense `, 'm'));
      expect(netlist).toMatch(new RegExp(`^D_rgb1_${c} `, 'm'));
    }
  });

  it('each colour drops its datasheet voltage at 20 mA: 2.0 V red, 3.2 V green and blue', { timeout: 30_000 }, async () => {
    const { netlist, pinNetMap } = buildNetlist(rgbOn5V({ R: 150, G: 90, B: 90 }));
    const r = await runNetlist(netlist);
    const v = (pin: string) => r.dcValue(`v(${pinNetMap.get(`rgb1:${pin}`)})`);
    expect(v('R')).toBeCloseTo(2.0, 1);
    expect(v('G')).toBeCloseTo(3.2, 1);
    expect(v('B')).toBeCloseTo(3.2, 1);
    expect(amps(r, 'i(v_rgb1_r_sense)')).toBeCloseTo(0.02, 3);
    expect(amps(r, 'i(v_rgb1_g_sense)')).toBeCloseTo(0.02, 3);
    expect(amps(r, 'i(v_rgb1_b_sense)')).toBeCloseTo(0.02, 3);
  });

  it('an ammeter in series with a colour reads that colour\'s current, not nanoamps', { timeout: 30_000 }, async () => {
    // The book's case: Uno pin 9 -> ammeter -> 220 ohm -> R, COM to GND.
    const input = onBoard(
      'arduino-uno',
      [
        { id: 'amm', metadataId: 'instr-ammeter', properties: {} },
        { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'rgb1', metadataId: 'rgb-led', properties: {} },
      ],
      [
        w('w1', ['board', '9'], ['amm', 'A+']),
        w('w2', ['amm', 'A-'], ['r1', '1']),
        w('w3', ['r1', '2'], ['rgb1', 'R']),
        w('w4', ['rgb1', 'COM'], ['board', 'GND']),
      ],
      { '9': { type: 'digital', v: 5 } },
    );
    const r = await runNetlist(buildNetlist(input).netlist);
    const i = amps(r, 'i(v_amm_sense)');
    // (5 V - about 1.98 V) / 220 ohm
    expect(i).toBeGreaterThan(0.013);
    expect(i).toBeLessThan(0.0145);
    expect(amps(r, 'i(v_rgb1_r_sense)')).toBeCloseTo(i, 6);
  });

  it('COM on the supply is a common anode: a colour lights when its pin goes LOW', { timeout: 30_000 }, async () => {
    const canvas = (pin9: number) =>
      onBoard(
        'arduino-uno',
        [
          { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
          { id: 'rgb1', metadataId: 'rgb-led', properties: {} },
        ],
        [w('w1', ['board', '9'], ['r1', '1']), w('w2', ['r1', '2'], ['rgb1', 'R']), w('w3', ['rgb1', 'COM'], ['board', '5V'])],
        { '9': { type: 'digital', v: pin9 } },
      );
    const low = await runNetlist(buildNetlist(canvas(0)).netlist);
    expect(amps(low, 'i(v_rgb1_r_sense)')).toBeGreaterThan(0.013);
    const high = await runNetlist(buildNetlist(canvas(5)).netlist);
    expect(amps(high, 'i(v_rgb1_r_sense)')).toBeLessThan(1e-6);
  });

  it('the common property says which end COM is, whatever it is wired to', () => {
    const nets: Record<string, string> = { R: 'nr', G: 'ng', B: 'nb', COM: 'ncom' };
    const cards = (common: string) =>
      componentToSpice({ id: 'rgb1', metadataId: 'rgb-led', properties: { common } }, (p) => nets[p] ?? null, { vcc: 5 })!.cards;
    // Anode: COM -> sense -> die -> colour pin.
    expect(cards('anode')).toEqual(expect.arrayContaining(['V_rgb1_r_sense ncom rgb1_r_mid DC 0']));
    expect(cards('anode').find((c) => c.startsWith('D_rgb1_r '))).toMatch(/^D_rgb1_r rgb1_r_mid nr /);
    // Cathode: colour pin -> sense -> die -> COM.
    expect(cards('cathode')).toEqual(expect.arrayContaining(['V_rgb1_r_sense nr rgb1_r_mid DC 0']));
    expect(cards('cathode').find((c) => c.startsWith('D_rgb1_r '))).toMatch(/^D_rgb1_r rgb1_r_mid ncom /);
  });

  it('a colour with nothing wired gets no card; nothing wired at all gets none', () => {
    const only = (nets: Record<string, string>) =>
      componentToSpice({ id: 'rgb1', metadataId: 'rgb-led', properties: {} }, (p) => nets[p] ?? null, { vcc: 5 });
    expect(only({ R: 'nr' })).toBeNull(); // no COM: no path
    const e = only({ R: 'nr', COM: '0' })!;
    expect(e.cards.filter((c) => c.startsWith('D_'))).toEqual([expect.stringMatching(/^D_rgb1_r /)]);
  });
});

describe('the Run check sees each colour (velxio/velxio-prod#174)', () => {
  async function check(withResistors: boolean) {
    const components: Comp[] = [{ id: 'rgb1', metadataId: 'rgb-led', properties: {} }];
    const wires: Wire[] = [w('wc', ['rgb1', 'COM'], ['board', 'GND'])];
    for (const [pad, pin] of [['25', 'R'], ['26', 'G'], ['27', 'B']] as const) {
      if (withResistors) {
        components.push({ id: `r${pin}`, metadataId: 'resistor', properties: { value: '220' } });
        wires.push(w(`w${pin}1`, ['board', pad], [`r${pin}`, '1']), w(`w${pin}2`, [`r${pin}`, '2'], ['rgb1', pin]));
      } else {
        wires.push(w(`w${pin}`, ['board', pad], ['rgb1', pin]));
      }
    }
    const { snap, synthesizedPins } = buildPreflightSnapshot({ components, wires, boards: [{ id: 'board', boardKind: 'esp32' }] });
    return verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
  }

  it('an RGB LED straight on three GPIOs is flagged once per colour', { timeout: 30_000 }, async () => {
    const result = await check(false);
    const led = result.errors.filter((e) => e.componentId === 'rgb1' && (e.code === 'led-overcurrent' || e.code === 'unstable-solve'));
    expect(led).toHaveLength(3);
    const text = led.map((e) => e.message).join('\n');
    for (const colour of ['red', 'green', 'blue']) expect(text).toContain(colour);
  });

  it('with a 220 ohm resistor per colour it passes', { timeout: 30_000 }, async () => {
    const result = await check(true);
    expect(result.errors.filter((e) => e.componentId === 'rgb1')).toEqual([]);
  });

  it("a common anode on the board's 3V3 is not called dark: the check's HIGH pins are what turn it off", { timeout: 30_000 }, async () => {
    const components: Comp[] = [{ id: 'rgb1', metadataId: 'rgb-led', properties: {} }];
    const wires: Wire[] = [w('wc', ['rgb1', 'COM'], ['board', '3V3'])];
    for (const [pad, pin] of [['25', 'R'], ['26', 'G'], ['27', 'B']] as const) {
      components.push({ id: `r${pin}`, metadataId: 'resistor', properties: { value: '220' } });
      wires.push(w(`w${pin}1`, ['board', pad], [`r${pin}`, '1']), w(`w${pin}2`, [`r${pin}`, '2'], ['rgb1', pin]));
    }
    const { snap, synthesizedPins } = buildPreflightSnapshot({ components, wires, boards: [{ id: 'board', boardKind: 'esp32' }] });
    const result = await verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
    expect([...result.errors, ...result.warnings].filter((x) => x.componentId === 'rgb1')).toEqual([]);
  });
});

// ── The part: brightness from the solved currents, on the element's 0-1 scale ──

const services: CircuitSimulationService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  __resetMixedModeScheduler();
  useElectricalStore.getState().reset();
  vi.unstubAllGlobals();
});

/** The gallery's uno-rgb-cycle: pins 9/10/11 -> 220 ohm -> R/G/B, COM -> GND. */
const UNO_RGB: { components: Comp[]; wires: Wire[] } = {
  components: [
    { id: 'rr', metadataId: 'resistor', properties: { value: '220' } },
    { id: 'rg', metadataId: 'resistor', properties: { value: '220' } },
    { id: 'rb', metadataId: 'resistor', properties: { value: '220' } },
    { id: 'rgb1', metadataId: 'rgb-led', properties: {} },
  ],
  wires: [
    w('w1', ['arduino-uno', '9'], ['rr', '1']),
    w('w2', ['rr', '2'], ['rgb1', 'R']),
    w('w3', ['arduino-uno', '10'], ['rg', '1']),
    w('w4', ['rg', '2'], ['rgb1', 'G']),
    w('w5', ['arduino-uno', '11'], ['rb', '1']),
    w('w6', ['rb', '2'], ['rgb1', 'B']),
    w('w7', ['rgb1', 'COM'], ['arduino-uno', 'GND.1']),
  ],
};

function service(canvas: { components: Comp[]; wires: Wire[] }, pins: () => Record<string, PinSourceState>) {
  __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
  const published: ElectricalSnapshot[] = [];
  const storePort = createElectricalStorePort();
  const simStore: SimulatorStorePort = {
    getState: () => ({ ...canvas, boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', running: true }] }),
    subscribe: () => () => {},
  };
  const svc = new CircuitSimulationService(
    simStore,
    { publish: (s) => { published.push(s); storePort.publish(s); } },
    getMixedModeScheduler() as unknown as MixedModeSchedulerPort,
    { collectBoardPinStates: pins },
  );
  services.push(svc);
  return { svc, published };
}

type RgbEl = HTMLElement & { ledRed: number; ledGreen: number; ledBlue: number };

function attachRgb(componentId: string, pins: Record<string, number>, pinManager?: unknown) {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const el = { addEventListener: () => {}, removeEventListener: () => {}, ledRed: 0, ledGreen: 0, ledBlue: 0 } as unknown as RgbEl;
  const pm = pinManager ?? { onPinChange: () => () => {}, onPwmChange: () => () => {}, getPwmValue: () => 0 };
  PartSimulationRegistry.get('rgb-led')!.attachEvents!(el, { pinManager: pm } as never, (n: string) => pins[n] ?? null, componentId);
  return el;
}

describe('the RGB LED part (velxio/velxio-prod#174)', () => {
  it('lights each colour from its solved current, PWM at its duty, on a 0-1 scale', { timeout: 60_000 }, async () => {
    const { svc, published } = service(UNO_RGB, () => ({
      '9': { type: 'digital', v: 5 },
      '10': { type: 'pwm', duty: 0.5 },
      '11': { type: 'digital', v: 0 },
    }));
    const el = attachRgb('rgb1', { R: 9, G: 10, B: 11, COM: -1 });
    await svc.tick();
    const snap = published.at(-1)!;
    const states = snap.window?.states ?? [{ weight: 1, branchCurrents: snap.branchCurrents }];
    const onA = (key: string) => Math.max(...states.map((s) => Math.abs(s.branchCurrents[key] ?? 0)));
    const meanA = (key: string) => states.reduce((a, s) => a + s.weight * Math.abs(s.branchCurrents[key] ?? 0), 0);
    // Red: 5 V - 2.0 V over 220 ohm, steady.
    expect(onA('v_rgb1_r_sense')).toBeGreaterThan(0.012);
    expect(el.ledRed).toBeCloseTo(meanA('v_rgb1_r_sense') / 0.02, 3);
    // Green: on half the time, so half its on-current, and half its on-brightness.
    expect(onA('v_rgb1_g_sense')).toBeGreaterThan(0.007);
    expect(meanA('v_rgb1_g_sense')).toBeCloseTo(0.5 * onA('v_rgb1_g_sense'), 6);
    expect(el.ledGreen).toBeCloseTo(meanA('v_rgb1_g_sense') / 0.02, 3);
    expect(el.ledGreen).toBeGreaterThan(0.15);
    expect(el.ledGreen).toBeLessThan(0.3);
    // Blue: its pin is LOW.
    expect(el.ledBlue).toBe(0);
    for (const v of [el.ledRed, el.ledGreen, el.ledBlue]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('before any solve, a HIGH pin lights its colour at 1, the top of the element\'s scale', () => {
    let onChange: ((pin: number, state: boolean) => void) | null = null;
    const pm = {
      onPinChange: (_pin: number, cb: (pin: number, state: boolean) => void) => {
        onChange = cb;
        return () => {};
      },
      onPwmChange: () => () => {},
      getPwmValue: () => 0,
    };
    const el = attachRgb('rgb-fallback', { R: 9, COM: -1 }, pm);
    onChange!(9, true);
    expect(el.ledRed).toBe(1);
    onChange!(9, false);
    expect(el.ledRed).toBe(0);
  });
});

describe('LEDC full scale is 100 %, not 100.39 % (velxio/velxio-prod#174)', () => {
  it('a duty above 100 % reaches the pin as 100 %', () => {
    // QEMU's LEDC divides by 2^N - 1, so ledcWrite(pin, 255) at 8 bits, which
    // arduino-esp32 writes as 256 ("LEDC FULL ON"), reports 100.39 %.
    const pm = new PinManager();
    applyPinPwm(pm, 25, 100.39);
    expect(pm.getPwmValue(25)).toBe(1);
    applyPinPwm(pm, 26, -3);
    expect(pm.getPwmValue(26)).toBe(0);
    applyPinPwm(pm, 27, 50);
    expect(pm.getPwmValue(27)).toBe(0.5);
  });
});
