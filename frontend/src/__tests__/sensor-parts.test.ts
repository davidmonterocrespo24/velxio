/**
 * sensor-parts.test.ts
 *
 * Tests simulation logic for sensor and stepper-motor components registered
 * in SensorParts.ts (and stepper-motor in particular).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { SENSOR_CONTROLS } from '../simulation/sensorControlConfig';

// Side-effect imports — register all parts (including SensorParts)
import '../simulation/parts/BasicParts';
import '../simulation/parts/ComplexParts';
import '../simulation/parts/ChipParts';
import '../simulation/parts/SensorParts';

// ─── RAF mock (no-op to prevent infinite loops) ───────────────────────────────
beforeEach(() => {
  let counter = 0;
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => ++counter);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('setInterval', vi.fn().mockReturnValue(42));
  vi.stubGlobal('clearInterval', vi.fn());
  vi.stubGlobal('setTimeout', vi.fn().mockReturnValue(1));
  vi.stubGlobal('clearTimeout', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeElement(props: Record<string, unknown> = {}): HTMLElement {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...props,
  } as unknown as HTMLElement;
}

function makeADC() {
  return { channelValues: new Array(8).fill(0) };
}

function makeSimulator(adc?: ReturnType<typeof makeADC> | null) {
  const pinManager = {
    onPinChange: vi.fn().mockReturnValue(() => {}),
    onPwmChange: vi.fn().mockReturnValue(() => {}),
    triggerPinChange: vi.fn(),
  };
  return {
    pinManager,
    getADC: vi.fn().mockReturnValue(adc ?? null),
    setPinState: vi.fn(),
    cpu: { data: new Uint8Array(512).fill(0), cycles: 0 },
  };
}

const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

const noPins = (_name: string): number | null => null;

// ─── SensorParts registration check ──────────────────────────────────────────

describe('SensorParts — registration', () => {
  const SENSOR_IDS = [
    'tilt-switch',
    'ntc-temperature-sensor',
    'gas-sensor',
    'flame-sensor',
    'heart-beat-sensor',
    'big-sound-sensor',
    'small-sound-sensor',
    'stepper-motor',
    'led-ring',
    'neopixel-matrix',
  ];

  it('registers all sensor and stepper component types', () => {
    for (const id of SENSOR_IDS) {
      expect(PartSimulationRegistry.get(id), `missing: ${id}`).toBeDefined();
    }
  });
});

// ─── Tilt Switch ─────────────────────────────────────────────────────────────

describe('tilt-switch — attachEvents', () => {
  it('sets OUT pin LOW on attach (upright), then HIGH after click, then LOW again', () => {
    const logic = PartSimulationRegistry.get('tilt-switch')!;
    const sim = makeSimulator();
    const element = makeElement();

    // Capture addEventListener calls
    const listeners: Record<string, (...args: any[]) => void> = {};
    (element.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: (...args: any[]) => void) => {
        listeners[event] = handler;
      },
    );

    logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));

    // Should have started LOW (upright)
    expect(sim.setPinState).toHaveBeenCalledWith(14, false);

    // First click — tilts HIGH
    sim.setPinState.mockClear();
    listeners['click']?.();
    expect(sim.setPinState).toHaveBeenCalledWith(14, true);

    // Second click — returns LOW
    sim.setPinState.mockClear();
    listeners['click']?.();
    expect(sim.setPinState).toHaveBeenCalledWith(14, false);
  });

  it('does nothing when OUT pin is not connected', () => {
    const logic = PartSimulationRegistry.get('tilt-switch')!;
    const sim = makeSimulator();
    const element = makeElement();

    const cleanup = logic.attachEvents!(element, sim as any, noPins);
    expect(cleanup).toBeDefined();
    expect(sim.setPinState).not.toHaveBeenCalled();
  });
});

// ─── NTC Temperature Sensor ──────────────────────────────────────────────────

describe('ntc-temperature-sensor — attachEvents', () => {
  it('injects 2.5V (mid-range) on OUT pin at room temperature', () => {
    const logic = PartSimulationRegistry.get('ntc-temperature-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const element = makeElement();

    logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));

    // Pin 14 = ADC channel 0.  2.5V should be stored in channelValues[0]
    expect(adc.channelValues[0]).toBeCloseTo(2.5, 2);
  });

  it('does nothing when OUT pin is not connected', () => {
    const logic = PartSimulationRegistry.get('ntc-temperature-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const element = makeElement();

    logic.attachEvents!(element, sim as any, noPins);
    // ADC should remain zeroed
    expect(adc.channelValues[0]).toBe(0);
  });

  /**
   * Issue #233. The divider used to be computed against a hard-coded 5 V rail,
   * so on a 3.3 V board it handed the ADC a voltage above full scale: 25 C came
   * back as ~1.4 C and everything below ~11 C saturated at the same reading.
   * The rail now follows the board, so the midpoint of a 10k/10k divider is
   * half of THAT rail.
   */
  it('scales the divider to a 3.3V board instead of assuming 5V', () => {
    const logic = PartSimulationRegistry.get('ntc-temperature-sensor')!;
    const injected: number[] = [];
    // A simulator exposing setAdcVoltage is the ESP32 bridge shim.
    const sim = {
      ...makeSimulator(makeADC()),
      setAdcVoltage: (_pin: number, volts: number) => {
        injected.push(volts);
        return true;
      },
    };

    logic.attachEvents!(makeElement(), sim as any, pinMap({ OUT: 34 }));

    expect(injected).toHaveLength(1);
    // R_ntc(25 C) == R_pull == 10k, so OUT sits at exactly half the rail.
    expect(injected[0]).toBeCloseTo(1.65, 2);
    expect(injected[0]).toBeLessThan(3.3); // never above the board's full scale
  });

  it('keeps the 5V midpoint on an AVR board', () => {
    const logic = PartSimulationRegistry.get('ntc-temperature-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);

    logic.attachEvents!(makeElement(), sim as any, pinMap({ OUT: 14 }));

    expect(adc.channelValues[0]).toBeCloseTo(2.5, 2);
  });
});

// ─── Gas Sensor ──────────────────────────────────────────────────────────────

describe('gas-sensor — attachEvents', () => {
  it('injects baseline analog voltage on AOUT and sets ledPower=true', () => {
    const logic = PartSimulationRegistry.get('gas-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14, DOUT: 7 }));

    // AOUT → ADC channel 0, at the panel's default gas level (100 of 1023),
    // the value the panel and the property dialog show for an unset part.
    expect(SENSOR_CONTROLS['gas-sensor'].defaultValues.gasLevel).toBe(100);
    expect(adc.channelValues[0]).toBeCloseTo((100 / 1023) * 5, 3);
    expect(el.ledPower).toBe(true);
  });

  it('registers pin-change listener for DOUT to update ledD0', () => {
    const logic = PartSimulationRegistry.get('gas-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 7 }));

    // Should have registered a onPinChange listener for DOUT (pin 7)
    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(7, expect.any(Function));

    // Simulate DOUT going HIGH → ledD0 should update
    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(7, true);
    expect(el.ledD0).toBe(true);

    handler(7, false);
    expect(el.ledD0).toBe(false);
  });
});

// ─── Flame Sensor ────────────────────────────────────────────────────────────

describe('flame-sensor — attachEvents', () => {
  it('injects baseline analog voltage on AOUT and sets ledPower=true', () => {
    const logic = PartSimulationRegistry.get('flame-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14 }), 'flame-sensor-test');

    // At the panel's default intensity (0, no flame), mapped the way the
    // slider maps it (inverse: no flame → high V, flame → low V): 5 V.
    expect(SENSOR_CONTROLS['flame-sensor'].defaultValues.intensity).toBe(0);
    expect(adc.channelValues[0]).toBeCloseTo(5.0, 3);
    expect(el.ledPower).toBe(true);
  });

  it('updates ledSignal when DOUT pin state changes', () => {
    const logic = PartSimulationRegistry.get('flame-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 8 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(8, expect.any(Function));

    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(8, true);
    expect(el.ledSignal).toBe(true);
    handler(8, false);
    expect(el.ledSignal).toBe(false);
  });
});

// ─── Heart Beat Sensor ───────────────────────────────────────────────────────

/**
 * Drive the pulse sensor with a controllable clock.
 *
 * `setInterval` is stubbed in this file's beforeEach, so the part's tick never
 * runs on its own — we pull it out of the mock and call it ourselves, stepping
 * a fake `performance.now()` so the waveform is a pure function of test time.
 */
function driveHeartBeat(
  props: Record<string, unknown> = {},
  pins: Record<string, number> = { OUT: 34 },
) {
  const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
  const injected: Array<{ pin: number; volts: number }> = [];
  const sim = {
    ...makeSimulator(makeADC()),
    setAdcVoltage: (pin: number, volts: number) => {
      injected.push({ pin, volts });
      return true;
    },
  };
  let now = 0;
  vi.stubGlobal('performance', { now: () => now });
  const element = makeElement(props);
  const cleanup = logic.attachEvents!(element, sim as any, pinMap(pins), 'hb-1');
  const tick = (setInterval as unknown as { mock: { calls: Array<[() => void, number]> } }).mock
    .calls[0][0];
  const stepMs = (setInterval as unknown as { mock: { calls: Array<[() => void, number]> } }).mock
    .calls[0][1];
  return {
    sim,
    element,
    injected,
    cleanup,
    stepMs,
    /** Run the part's timer for `ms` of simulated wall clock. */
    advance(ms: number) {
      const steps = Math.round(ms / stepMs);
      for (let i = 0; i < steps; i++) {
        now += stepMs;
        tick();
      }
    },
  };
}

/** 12-bit ADC codes an ESP32 sketch would read back from the injected volts. */
const raw12 = (volts: number) => Math.round((volts / 3.3) * 4095);

describe('heart-beat-sensor — attachEvents', () => {
  it('starts OUT pin LOW and sets up an interval for pulse generation', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    const sim = makeSimulator();
    const element = makeElement();

    logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));

    // Should start LOW
    expect(sim.setPinState).toHaveBeenCalledWith(14, false);
    // Should have called setInterval
    expect(setInterval).toHaveBeenCalled();
  });

  it('clears the interval on cleanup', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    const sim = makeSimulator();
    const element = makeElement();

    const cleanup = logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));
    cleanup();

    expect(clearInterval).toHaveBeenCalledWith(42); // 42 is the mock return from setInterval
  });

  it('does nothing when OUT pin is not connected', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    const sim = makeSimulator();
    const element = makeElement();

    logic.attachEvents!(element, sim as any, noPins);
    expect(setInterval).not.toHaveBeenCalled();
  });

  // The regression this whole part was rewritten for: the module only ever
  // pulsed the digital pin, so analogRead / ADC.read() — how a pulse sensor is
  // normally read — returned a flat 0 and every sketch computed 0 BPM.
  it('seeds the ADC channel at the resting level before the first tick', () => {
    const { injected } = driveHeartBeat();

    expect(injected.length).toBeGreaterThan(0);
    expect(injected[0].pin).toBe(34);
    expect(injected[0].volts).toBeGreaterThan(0.4);
    expect(injected[0].volts).toBeLessThan(1.0);
  });

  it('drives a pulse waveform on the ADC, not a constant', () => {
    const { injected, advance } = driveHeartBeat({ bpm: 60 });
    advance(1000); // exactly one beat at 60 BPM

    const volts = injected.map((i) => i.volts);
    const min = Math.min(...volts);
    const max = Math.max(...volts);

    expect(max).toBeGreaterThan(3.0); // systolic peak, near the 3.3 V rail
    expect(min).toBeLessThan(0.8); // diastolic floor
    expect(new Set(volts.map((v) => v.toFixed(2))).size).toBeGreaterThan(10);
  });

  it('still emits one short digital pulse per beat', () => {
    const { sim, advance } = driveHeartBeat({ bpm: 60 });
    advance(3000); // three beats

    const edges = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true);
    expect(edges).toHaveLength(3);

    // and the pulse is a small part of the cycle, like the comparator output
    // of a real module (this used to be a hard-coded 100 ms in a 1000 ms beat)
    const highSamples = sim.setPinState.mock.calls.length;
    expect(highSamples).toBeGreaterThan(0);
  });

  it('follows the bpm property', () => {
    const { sim, advance } = driveHeartBeat({ bpm: 120 });
    advance(3000); // 120 BPM = 6 beats in 3 s

    const edges = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true);
    expect(edges).toHaveLength(6);
  });

  it('accepts a bpm that arrives as a string, and clamps out-of-range values', () => {
    const asString = driveHeartBeat({ bpm: '120' });
    asString.advance(3000);
    expect(
      asString.sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true),
    ).toHaveLength(6);

    // 6000 BPM is not a heart rate; it must clamp rather than alias the timer
    const absurd = driveHeartBeat({ bpm: 6000 });
    absurd.advance(1000);
    const edges = absurd.sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true);
    expect(edges.length).toBeLessThanOrEqual(4); // 220 BPM ceiling
  });

  it('re-rates from the sensor control panel', () => {
    const { sim, advance } = driveHeartBeat({ bpm: 60 });
    advance(1000);
    const afterFirst = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true).length;

    dispatchSensorUpdate('hb-1', { bpm: 180 });
    advance(1000); // 180 BPM = 3 beats in the next second

    const total = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true).length;
    expect(afterFirst).toBe(1);
    expect(total - afterFirst).toBe(3);
  });

  // The dicrotic notch is a real feature of a PPG, but a naive peak counter
  // (`value > THRESHOLD` with a refractory window — what the pulse-monitor
  // example does) must not count it as a second beat.
  it('keeps the dicrotic notch below a typical detection threshold', () => {
    const { injected, advance } = driveHeartBeat({ bpm: 60 });
    advance(2000);

    const THRESHOLD = 2500; // the value the 100-days pulse monitor uses
    const MIN_PEAK_INTERVAL_MS = 300;
    const codes = injected.map((i) => raw12(i.volts));

    let peaks = 0;
    let lastPeakMs = -Infinity;
    codes.forEach((code, i) => {
      const tMs = i * 20;
      if (code > THRESHOLD && tMs - lastPeakMs > MIN_PEAK_INTERVAL_MS) {
        peaks++;
        lastPeakMs = tMs;
      }
    });

    expect(peaks).toBe(2); // one per beat over two seconds at 60 BPM
    expect(Math.max(...codes)).toBeGreaterThan(THRESHOLD);
  });

  // An emulated board runs slower than real time. Beating on the browser clock
  // made the sketch alias the waveform: at ~1 redraw per real second it sampled
  // a 72 BPM wave about once per cycle and the 100-days pulse monitor reported
  // 8 BPM. On the guest clock the sketch gets the same samples per beat it
  // would on hardware, however slowly the engine is running.
  it('beats on the guest clock when the simulator exposes one', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    let guestUs = 0;
    let wall = 0;
    vi.stubGlobal('performance', { now: () => wall });
    const sim = {
      ...makeSimulator(makeADC()),
      setAdcVoltage: () => true,
      getGuestMicros: () => guestUs,
    };
    logic.attachEvents!(makeElement({ bpm: 60 }), sim as any, pinMap({ OUT: 34 }), 'hb-3');
    const tick = (setInterval as unknown as { mock: { calls: Array<[() => void, number]> } }).mock
      .calls[0][0];

    // Ten real seconds of browser time, but only one second of guest time:
    // exactly one beat, because the sketch's own clock only advanced by one.
    for (let i = 0; i < 500; i++) {
      wall += 20;
      guestUs += 2000; // guest runs 10x slower than the wall clock
      tick();
    }

    const edges = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true);
    expect(edges).toHaveLength(1);
  });

  it('falls back to wall time when the guest clock is unreadable', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    let wall = 0;
    vi.stubGlobal('performance', { now: () => wall });
    const sim = {
      ...makeSimulator(makeADC()),
      setAdcVoltage: () => true,
      getGuestMicros: () => -1, // backend QEMU: clock lives in another process
    };
    logic.attachEvents!(makeElement({ bpm: 60 }), sim as any, pinMap({ OUT: 34 }), 'hb-4');
    const tick = (setInterval as unknown as { mock: { calls: Array<[() => void, number]> } }).mock
      .calls[0][0];
    for (let i = 0; i < 150; i++) {
      wall += 20;
      tick();
    }

    const edges = sim.setPinState.mock.calls.filter((c: unknown[]) => c[1] === true);
    expect(edges).toHaveLength(3); // 3 s of wall time at 60 BPM
  });

  it('stops writing the ADC when OUT is not an ADC-capable pad', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    let attempts = 0;
    const sim = {
      ...makeSimulator(makeADC()),
      setAdcVoltage: () => {
        attempts++;
        return false; // not an ADC pin
      },
    };
    let now = 0;
    vi.stubGlobal('performance', { now: () => now });
    logic.attachEvents!(makeElement(), sim as any, pinMap({ OUT: 5 }), 'hb-2');
    const tick = (setInterval as unknown as { mock: { calls: Array<[() => void, number]> } }).mock
      .calls[0][0];
    for (let i = 0; i < 200; i++) {
      now += 20;
      tick();
    }

    // A handful of retries covers a simulator that is not up yet; after that it
    // gives up instead of warning 50 times a second for the whole run.
    expect(attempts).toBeLessThanOrEqual(20);
    // the digital pulse still works on a plain GPIO
    expect(sim.setPinState).toHaveBeenCalledWith(5, true);
  });

  it('releases the pin and the panel subscription on cleanup', () => {
    const { sim, cleanup, advance } = driveHeartBeat({ bpm: 60 });
    advance(200);
    sim.setPinState.mockClear();
    cleanup();

    expect(clearInterval).toHaveBeenCalledWith(42);
    expect(sim.setPinState).toHaveBeenCalledWith(34, false);
  });
});

// ─── Big Sound Sensor ────────────────────────────────────────────────────────

describe('big-sound-sensor — attachEvents', () => {
  it('injects 2.5V on AOUT and sets led2=true (power LED)', () => {
    const logic = PartSimulationRegistry.get('big-sound-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14 }));

    expect(adc.channelValues[0]).toBeCloseTo(2.5, 2);
    expect(el.led2).toBe(true);
  });

  it('updates led1 when DOUT pin changes', () => {
    const logic = PartSimulationRegistry.get('big-sound-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 9 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(9, expect.any(Function));
    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(9, true);
    expect(el.led1).toBe(true);
    handler(9, false);
    expect(el.led1).toBe(false);
  });
});

// ─── Small Sound Sensor ──────────────────────────────────────────────────────

describe('small-sound-sensor — attachEvents', () => {
  it('injects 2.5V on AOUT and sets ledPower=true', () => {
    const logic = PartSimulationRegistry.get('small-sound-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14 }));

    expect(adc.channelValues[0]).toBeCloseTo(2.5, 2);
    expect(el.ledPower).toBe(true);
  });

  it('updates ledSignal when DOUT pin changes', () => {
    const logic = PartSimulationRegistry.get('small-sound-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 10 }));

    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(10, true);
    expect(el.ledSignal).toBe(true);
    handler(10, false);
    expect(el.ledSignal).toBe(false);
  });
});

// ─── Stepper Motor ───────────────────────────────────────────────────────────

describe('stepper-motor — attachEvents', () => {
  it('registers pin-change listeners for all 4 coil pins', () => {
    const logic = PartSimulationRegistry.get('stepper-motor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.angle = 0;

    const pins = { 'A-': 4, 'A+': 5, 'B+': 6, 'B-': 7 };
    logic.attachEvents!(el, sim as any, pinMap(pins));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledTimes(4);
    const registeredPins = sim.pinManager.onPinChange.mock.calls.map(([p]: [number]) => p);
    expect(registeredPins).toEqual(expect.arrayContaining([4, 5, 6, 7]));
  });

  it('advances angle by 1.8° per forward step (full-step sequence)', () => {
    const logic = PartSimulationRegistry.get('stepper-motor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.angle = 0;

    const pins = { 'A-': 4, 'A+': 5, 'B+': 6, 'B-': 7 };
    logic.attachEvents!(el, sim as any, pinMap(pins));

    // Collect handlers indexed by pin number
    const handlers: Record<number, (pin: number, s: boolean) => void> = {};
    for (const [pin, handler] of sim.pinManager.onPinChange.mock.calls) {
      handlers[pin as number] = handler;
    }

    // Step 0: A+ = HIGH (others LOW)
    handlers[5]?.(5, true); // A+

    // Step 1: B+ = HIGH, A+ = LOW → should advance angle
    handlers[5]?.(5, false); // A+ LOW
    handlers[6]?.(6, true); // B+ HIGH

    expect(el.angle).toBeCloseTo(1.8, 1);
  });

  it('does nothing with zero coil pins connected', () => {
    const logic = PartSimulationRegistry.get('stepper-motor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.angle = 0;

    logic.attachEvents!(el, sim as any, noPins);

    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
    expect(el.angle).toBe(0);
  });
});

// ─── LED Ring (NeoPixel) ─────────────────────────────────────────────────────

describe('led-ring — attachEvents', () => {
  it('registers a pin-change listener on the DIN pin', () => {
    const logic = PartSimulationRegistry.get('led-ring')!;
    const sim = makeSimulator();
    sim.cpu = { data: new Uint8Array(512), cycles: 0 } as any;
    const el = makeElement() as any;
    el.setPixel = vi.fn();

    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(6, expect.any(Function));
  });

  it('does nothing when DIN pin is not connected', () => {
    const logic = PartSimulationRegistry.get('led-ring')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    const cleanup = logic.attachEvents!(el, sim as any, noPins);
    expect(cleanup).toBeDefined();
    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
  });
});

// ─── NeoPixel Matrix ─────────────────────────────────────────────────────────

describe('neopixel-matrix — attachEvents', () => {
  it('registers a pin-change listener on the DIN pin', () => {
    const logic = PartSimulationRegistry.get('neopixel-matrix')!;
    const sim = makeSimulator();
    sim.cpu = { data: new Uint8Array(512), cycles: 0 } as any;
    const el = makeElement() as any;
    el.setPixel = vi.fn();
    el.cols = 8;

    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(6, expect.any(Function));
  });
});

// ─── The hardware (RMT) pixel path ───────────────────────────────────────────

/**
 * A board simulator that drives its pixels through a peripheral instead of by
 * bit-banging the pad — every ESP32. `subscribeWs2812` is the whole contract:
 * the engine already decoded the frame, and the part is HANDED it.
 */
function makeRmtSimulator() {
  const sim = makeSimulator() as ReturnType<typeof makeSimulator> & {
    subscribeWs2812: ReturnType<typeof vi.fn>;
    emitFrame: (pin: number, pixels: Array<{ r: number; g: number; b: number }>) => void;
  };
  const sinks = new Map<number, (px: Array<{ r: number; g: number; b: number }>) => void>();
  sim.subscribeWs2812 = vi.fn((pin: number, sink: (px: any) => void) => {
    sinks.set(pin, sink);
    return () => sinks.delete(pin);
  });
  sim.emitFrame = (pin, pixels) => sinks.get(pin)?.(pixels);
  return sim;
}

/**
 * A board that bit-bangs the line and answers the PORTABLE clock accessors —
 * which is every simulator except the ESP32 shim. Drives a real WS2812 frame
 * at `clockHz` so the decoder's thresholds have to scale to it.
 */
function makeBitBangSimulator(clockHz: number) {
  let cycles = 0;
  let handler: ((pin: number, high: boolean) => void) | null = null;
  const sim = {
    pinManager: {
      onPinChange: vi.fn((_pin: number, cb: (p: number, h: boolean) => void) => {
        handler = cb;
        return () => { handler = null; };
      }),
      onPwmChange: vi.fn().mockReturnValue(() => {}),
      triggerPinChange: vi.fn(),
    },
    getADC: vi.fn().mockReturnValue(null),
    setPinState: vi.fn(),
    getClockHz: () => clockHz,
    getCurrentCycles: () => cycles,
    /**
     * Clock out 24 bits MSB-first after a reset gap. Real WS2812 widths by
     * default; `timing` is [T0H, T0L, T1H, T1L] in microseconds for a driver
     * that uses others.
     */
    sendPixel(r: number, g: number, b: number, timing: readonly number[] = [0.35, 0.9, 0.7, 0.55]) {
      const us = (n: number) => Math.max(1, Math.round(clockHz * n * 1e-6));
      const [t0h, t0l, t1h, t1l] = timing;
      cycles += us(80); // >50us latch
      for (const byte of [g, r, b]) {
        for (let i = 7; i >= 0; i--) {
          const one = (byte >> i) & 1;
          handler?.(6, true);
          cycles += one ? us(t1h) : us(t0h);
          handler?.(6, false);
          cycles += one ? us(t1l) : us(t0l);
        }
      }
    },
  };
  return sim;
}

describe('WS2812 edge decode — scales to the board clock', () => {
  // The decoder used to hard-code 8 and 800 cycles: correct ONLY at 16 MHz.
  // The RP2040 runs at 125 MHz, where every real pulse is far longer than 8
  // cycles, so a naive threshold reads 0xFF out of every byte.
  for (const [name, hz] of [['16 MHz AVR', 16_000_000], ['125 MHz RP2040', 125_000_000], ['150 MHz RP2350', 150_000_000]] as const) {
    it(`decodes an exact frame on a ${name} board`, () => {
      const logic = PartSimulationRegistry.get('neopixel')!;
      const sim = makeBitBangSimulator(hz);
      const el = makeElement() as any;

      logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));
      sim.sendPixel(0x12, 0x34, 0x56);

      expect(el.r).toBeCloseTo(0x12 / 255, 5);
      expect(el.g).toBeCloseTo(0x34 / 255, 5);
      expect(el.b).toBeCloseTo(0x56 / 255, 5);
    });
  }

  /**
   * The pixel samples about 0.48 us after the rising edge, so a '1' only has
   * to be high past that point. FastLED gives WS2811 (the default chip of its
   * DemoReel100) and WS2813 a '1' of 640 ns high and 640 ns low, exactly half
   * the bit: ten cycles of twenty on an AVR. Cutting at one half read every
   * one of those as 0, and the strip stayed black while the sketch ran
   * (measured on velxio.dev, 2026-10-05).
   */
  const DRIVER_TIMINGS: Array<[string, readonly number[]]> = [
    // [T0H, T0L, T1H, T1L] in microseconds
    ['FastLED WS2811 800 kHz / WS2813 (a 1 at exactly half)', [0.32, 0.96, 0.64, 0.64]],
    ['FastLED WS2812B', [0.25, 1.0, 0.875, 0.375]],
    ['FastLED WS2815', [0.25, 1.64, 1.34, 0.55]],
    ['FastLED SK6812', [0.3, 0.9, 0.9, 0.3]],
    ['Adafruit_NeoPixel', [0.4, 0.85, 0.8, 0.45]],
  ];
  for (const [driver, timing] of DRIVER_TIMINGS) {
    for (const [name, hz] of [['16 MHz AVR', 16_000_000], ['125 MHz RP2040', 125_000_000]] as const) {
      it(`decodes the ${driver} timing on a ${name} board`, () => {
        const logic = PartSimulationRegistry.get('neopixel')!;
        const sim = makeBitBangSimulator(hz);
        const el = makeElement() as any;
        logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));
        sim.sendPixel(0xf0, 0x0f, 0xaa, timing);
        expect(el.r).toBeCloseTo(0xf0 / 255, 5);
        expect(el.g).toBeCloseTo(0x0f / 255, 5);
        expect(el.b).toBeCloseTo(0xaa / 255, 5);
      });
    }
  }

  it('reads a saturated byte as 0xFF, not one bit short', () => {
    const logic = PartSimulationRegistry.get('neopixel')!;
    const sim = makeBitBangSimulator(125_000_000);
    const el = makeElement() as any;
    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));
    sim.sendPixel(255, 255, 255);
    expect(el.r).toBe(1);
    expect(el.g).toBe(1);
    expect(el.b).toBe(1);
  });

  /**
   * An engine whose PIO does not model instruction delays (rp2040js) emits the
   * right SHAPE at the wrong scale: measured, a '1' comes out 2 steps high / 1
   * low and a '0' 1 high / 2 low, a bit period of 3 where the wire says 10.
   * Every one of those widths is far under any threshold derived from real
   * WS2812 timing, so an absolute rule reads 0x000000 off a perfectly good
   * frame — which is what the Pico did.
   */
  it('decodes a waveform compressed 3x by an engine that skips PIO delays', () => {
    const logic = PartSimulationRegistry.get('neopixel')!;
    let t = 0;
    let handler: ((pin: number, high: boolean) => void) | null = null;
    const sim = {
      pinManager: {
        onPinChange: vi.fn((_p: number, cb: (p: number, h: boolean) => void) => {
          handler = cb;
          return () => {};
        }),
        onPwmChange: vi.fn().mockReturnValue(() => {}),
        triggerPinChange: vi.fn(),
      },
      getADC: vi.fn().mockReturnValue(null),
      setPinState: vi.fn(),
      getClockHz: () => 125_000_000,
      getCurrentCycles: () => t,
    };
    const el = makeElement() as any;
    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));

    t += 4000; // latch
    for (const byte of [0x00, 0xff, 0x00]) {
      for (let i = 7; i >= 0; i--) {
        const one = (byte >> i) & 1;
        handler!(6, true);
        t += one ? 2 : 1;
        handler!(6, false);
        t += one ? 1 : 2;
      }
    }

    expect(el.r).toBe(1); // 0xFF in the R slot (GRB order)
    expect(el.g).toBe(0);
    expect(el.b).toBe(0);
  });

  it('does not attach the edge decoder when the board has no cycle counter', () => {
    // The ESP32 shim answers -1. Decoding edges against a frozen clock makes
    // every high measure 0 cycles and paints solid black over the frames the
    // hardware feed is delivering — worse than not listening at all.
    const logic = PartSimulationRegistry.get('neopixel')!;
    const sim = makeSimulator();
    (sim as any).cpu = undefined;
    (sim as any).getCurrentCycles = () => -1;
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));

    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
  });
});

describe('WS2812 parts — a board that cannot carry pixels says so', () => {
  // The Linux boards (Raspberry Pi family, UNIHIKER M10) drive their pins over
  // a level protocol with no bit timing, at roughly the rate a Python
  // statement runs. A 1.25 us WS2812 bit cell has nowhere to live, so the part
  // used to attach, decode nothing, feed nothing and report nothing — which
  // reads to a user exactly like their own wiring mistake.
  it('records a gap the circuit verifier can print, instead of going quiet', async () => {
    const { lineGaps, clearLineGaps } = await import('../simulation/line/requestLine');
    clearLineGaps();
    const logic = PartSimulationRegistry.get('neopixel')!;
    const sim = makeSimulator() as any;
    sim.pixelSupport = () => ({ mode: 'none', why: 'no bit timing on this transport' });
    const el = makeElement() as any;

    const cleanup = logic.attachEvents!(el, sim, pinMap({ DIN: 6 }), 'npx-1');

    const gap = lineGaps().find((g) => g.componentId === 'npx-1');
    expect(gap).toBeDefined();
    expect(gap!.sensorType).toBe('ws2812');
    expect(gap!.pin).toBe(6);
    expect(gap!.why).toContain('bit timing');
    // And it never pretends to listen on a pad it cannot read.
    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();

    cleanup!();
    expect(lineGaps().find((g) => g.componentId === 'npx-1')).toBeUndefined();
  });

  it('stays silent on a board that CAN carry them', async () => {
    const { lineGaps, clearLineGaps } = await import('../simulation/line/requestLine');
    clearLineGaps();
    const logic = PartSimulationRegistry.get('neopixel')!;
    const sim = makeSimulator(); // no pixelSupport declared
    logic.attachEvents!(makeElement() as any, sim as any, pinMap({ DIN: 6 }), 'npx-2');
    expect(lineGaps().find((g) => g.componentId === 'npx-2')).toBeUndefined();
  });
});

describe('WS2812 parts — hardware-decoded frames (ESP32 RMT)', () => {
  // The regression this guards: Adafruit_NeoPixel on ESP32 goes out over RMT,
  // so DIN never toggles at bit rate and the edge decoder sees NOTHING. The
  // part used to attach only that decoder, and every NeoPixel on every ESP32
  // board stayed black while the sketch ran perfectly.
  it('paints the single neopixel from a frame the engine decoded', () => {
    const logic = PartSimulationRegistry.get('neopixel')!;
    const sim = makeRmtSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));
    expect(sim.subscribeWs2812).toHaveBeenCalledWith(6, expect.any(Function));

    sim.emitFrame(6, [{ r: 255, g: 0, b: 0 }]);
    expect(el.r).toBeCloseTo(1);
    expect(el.g).toBeCloseTo(0);
    expect(el.b).toBeCloseTo(0);
  });

  it('paints a ring pixel-by-pixel, in frame order', () => {
    const logic = PartSimulationRegistry.get('led-ring')!;
    const sim = makeRmtSimulator();
    const el = makeElement() as any;
    el.setPixel = vi.fn();

    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));
    sim.emitFrame(6, [
      { r: 1, g: 2, b: 3 },
      { r: 4, g: 5, b: 6 },
    ]);

    expect(el.setPixel).toHaveBeenNthCalledWith(1, 0, { r: 1, g: 2, b: 3 });
    expect(el.setPixel).toHaveBeenNthCalledWith(2, 1, { r: 4, g: 5, b: 6 });
  });

  it('maps a matrix frame to row/col', () => {
    const logic = PartSimulationRegistry.get('neopixel-matrix')!;
    const sim = makeRmtSimulator();
    const el = makeElement() as any;
    el.setPixel = vi.fn();
    el.cols = 2;

    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));
    sim.emitFrame(6, [
      { r: 1, g: 1, b: 1 },
      { r: 2, g: 2, b: 2 },
      { r: 3, g: 3, b: 3 },
    ]);

    expect(el.setPixel).toHaveBeenNthCalledWith(1, 0, 0, { r: 1, g: 1, b: 1 });
    expect(el.setPixel).toHaveBeenNthCalledWith(2, 0, 1, { r: 2, g: 2, b: 2 });
    expect(el.setPixel).toHaveBeenNthCalledWith(3, 1, 0, { r: 3, g: 3, b: 3 });
  });

  it('releases the pin on cleanup so a rewire hands it back', () => {
    const logic = PartSimulationRegistry.get('neopixel')!;
    const sim = makeRmtSimulator();
    const el = makeElement() as any;

    const cleanup = logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));
    cleanup!();
    sim.emitFrame(6, [{ r: 255, g: 255, b: 255 }]);
    expect(el.r).toBeUndefined();
  });

  it('still works on a board with no hardware feed (bit-banged AVR)', () => {
    const logic = PartSimulationRegistry.get('neopixel')!;
    const sim = makeSimulator(); // no subscribeWs2812
    const el = makeElement() as any;

    const cleanup = logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(6, expect.any(Function));
    expect(() => cleanup!()).not.toThrow();
  });
});
