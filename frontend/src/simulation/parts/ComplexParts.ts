import { useSimulatorStore } from '../../store/useSimulatorStore';
import { PartSimulationRegistry } from './PartSimulationRegistry';
import { attachSpiDevice } from '../buses';
import type { AnySimulator, PartSimulationLogic } from './PartSimulationRegistry';
import { RP2040Simulator } from '../RP2040Simulator';
import { getADC, setAdcVoltage, emitPropertyChange } from './partUtils';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';
import { LOG_SLIDER_STEPS, logSliderToValue } from '../sensorControlConfig';

// ─── Helpers ────────────────────────────────────────────────────────────────

// ─── RGB LED (PWM-aware) ─────────────────────────────────────────────────────

/**
 * RGB LED implementation — supports both digital and PWM (analogWrite) output.
 * Falls back to digital mode if no PWM is detected.
 */
PartSimulationRegistry.register('rgb-led', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper, _componentId, getPinResolver) => {
    const pinManager = (avrSimulator as any).pinManager;
    if (!pinManager) return () => {};

    const el = element as any;
    const unsubscribers: (() => void)[] = [];
    const useResolver = typeof getPinResolver === 'function';

    // Digital path: prefer PinResolver so each channel works when driven
    // through an active device (e.g. a P-MOSFET high-side switch).
    type Channel = { pinName: 'R' | 'G' | 'B'; prop: 'ledRed' | 'ledGreen' | 'ledBlue' };
    const channels: Channel[] = [
      { pinName: 'R', prop: 'ledRed' },
      { pinName: 'G', prop: 'ledGreen' },
      { pinName: 'B', prop: 'ledBlue' },
    ];

    // Track Arduino pin numbers for the PWM hook below — analogWrite()
    // override still needs the integer pin number because PinResolver
    // doesn't (yet) expose PWM duty.
    const pwmPins: Array<{ pin: number; prop: Channel['prop'] }> = [];

    for (const { pinName, prop } of channels) {
      if (useResolver) {
        const resolver = getPinResolver!(pinName);
        if (resolver) {
          el[prop] = resolver.getCurrentState() === 'HIGH' ? 255 : 0;
          unsubscribers.push(
            resolver.onChange((state) => {
              el[prop] = state === 'HIGH' ? 255 : 0;
            }),
          );
        }
      } else {
        const pin = getArduinoPinHelper(pinName);
        if (pin !== null) {
          unsubscribers.push(
            pinManager.onPinChange(pin, (_: number, state: boolean) => {
              el[prop] = state ? 255 : 0;
            }),
          );
        }
      }
      // PWM hook still uses the raw pin number — duty cycle handling
      // doesn't live in PinResolver yet.
      const rawPin = getArduinoPinHelper(pinName);
      if (rawPin !== null) pwmPins.push({ pin: rawPin, prop });
    }

    // PWM override — analogWrite() value supersedes digital state.
    for (const { pin, prop } of pwmPins) {
      unsubscribers.push(
        pinManager.onPwmChange(pin, (_: number, dc: number) => {
          el[prop] = Math.round(dc * 255);
        }),
      );
    }

    return () => unsubscribers.forEach((u) => u());
  },
});

// ─── Potentiometer (rotary) ──────────────────────────────────────────────────

PartSimulationRegistry.register('potentiometer', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pin = getArduinoPinHelper('SIG');

    // Determine reference voltage based on board type
    const isRP2040 = simulator instanceof RP2040Simulator;
    const isESP32 = typeof (simulator as any).setAdcVoltage === 'function';
    const refVoltage = isRP2040 || isESP32 ? 3.3 : 5.0;

    const onInput = () => {
      const rawStr = (element as any).value ?? '0';
      const raw = parseInt(rawStr, 10);
      if (pin !== null) {
        const volts = (raw / 1023.0) * refVoltage;
        setAdcVoltage(simulator, pin, volts);
      }
      // Mirror to store so the SPICE netlist re-solves (op-amp
      // comparators, divider-driven circuits etc. depend on this).
      emitPropertyChange(componentId, 'value', raw);
    };

    onInput();

    element.addEventListener('input', onInput);
    return () => element.removeEventListener('input', onInput);
  },
});

// ─── Slide Potentiometer ─────────────────────────────────────────────────────

PartSimulationRegistry.register('slide-potentiometer', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper, componentId) => {
    const arduinoPin = getArduinoPinHelper('SIG') ?? getArduinoPinHelper('OUT');

    const el = element as any;
    const isRP2040 = avrSimulator instanceof RP2040Simulator;
    const isESP32 = typeof (avrSimulator as any).setAdcVoltage === 'function';
    const refVoltage = isRP2040 || isESP32 ? 3.3 : 5.0;

    const onInput = () => {
      const min = Number(el.min ?? 0);
      const max = Number(el.max ?? 1023);
      const value = Number(el.value ?? 0);
      const normalized = (value - min) / (max - min || 1);
      if (arduinoPin !== null) {
        const volts = normalized * refVoltage;
        setAdcVoltage(avrSimulator, arduinoPin, volts);
      }
      emitPropertyChange(componentId, 'value', value);
    };

    onInput();

    element.addEventListener('input', onInput);
    return () => element.removeEventListener('input', onInput);
  },
});

// ─── Photoresistor Sensor ────────────────────────────────────────────────────

/**
 * Photoresistor sensor — the wokwi element does not emit input events,
 * so we simulate light level with a slider drawn via the component's
 * luminance property when available, or simply set a mid-range voltage.
 *
 * The element exposes `ledDO` and `ledPower` for display only.
 * We inject a static mid-range voltage on the AO pin so analogRead()
 * returns a valid value. Users can modify the element's `value` attribute.
 */
PartSimulationRegistry.register('photoresistor-sensor', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper, componentId) => {
    const pinAO = getArduinoPinHelper('AO') ?? getArduinoPinHelper('A0');
    const pinDO = getArduinoPinHelper('DO') ?? getArduinoPinHelper('D0');
    const pinManager = (avrSimulator as any).pinManager;

    const unsubscribers: (() => void)[] = [];

    // Inject initial mid-range voltage (simulate moderate light, ~500 lux)
    if (pinAO !== null) {
      setAdcVoltage(avrSimulator, pinAO, 2.5);
    }

    // Watch element's 'input' events in case the element supports it
    const onInput = () => {
      const val = (element as any).value;
      if (val !== undefined) {
        if (pinAO !== null) {
          const volts = (val / 1023.0) * 5.0;
          setAdcVoltage(avrSimulator, pinAO, volts);
        }
        // Mirror to store — the slider position maps to lux LOGARITHMICALLY
        // (same curve as the Sensors popover): an LDR's whole useful range
        // lives in the low decades, and the linear map crammed it into the
        // first few percent of travel.
        emitPropertyChange(
          componentId,
          'lux',
          logSliderToValue((val / 1023) * LOG_SLIDER_STEPS, 0, 1000),
        );
      }
    };
    element.addEventListener('input', onInput);
    unsubscribers.push(() => element.removeEventListener('input', onInput));

    // DO (digital output) — if connected, update element's LED indicator
    if (pinDO !== null && pinManager) {
      unsubscribers.push(
        pinManager.onPinChange(pinDO, (_: number, state: boolean) => {
          (element as any).ledDO = state;
        }),
      );
    }

    // SensorControlPanel: lux 0–1000 → volts 0–5
    registerSensorUpdate(componentId, (values) => {
      if ('lux' in values) {
        if (pinAO !== null) {
          setAdcVoltage(avrSimulator, pinAO, ((values.lux as number) / 1000) * 5.0);
        }
        emitPropertyChange(componentId, 'lux', values.lux);
      }
    });

    return () => {
      unsubscribers.forEach((u) => u());
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Analog Joystick ─────────────────────────────────────────────────────────

/**
 * Analog Joystick — two axes (xValue/yValue 0-1023) + button press
 * Wokwi pins: VRX (X axis), VRY (Y axis), SW (button)
 */
PartSimulationRegistry.register('analog-joystick', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper, componentId) => {
    // wokwi-analog-joystick uses VERT/HORZ/SEL pin names
    const pinX =
      getArduinoPinHelper('VERT') ?? getArduinoPinHelper('VRX') ?? getArduinoPinHelper('XOUT');
    const pinY =
      getArduinoPinHelper('HORZ') ?? getArduinoPinHelper('VRY') ?? getArduinoPinHelper('YOUT');
    const pinSW = getArduinoPinHelper('SEL') ?? getArduinoPinHelper('SW');
    const el = element as any;

    // wokwi-analog-joystick exposes xValue/yValue as DIRECTION (-1 / 0 / +1),
    // not pot-style 0..1023.  See @wokwi/elements analog-joystick-element.js:
    // arrow-zone clicks call mousedown(e, dx, dy) where dx,dy ∈ {-1, 0, +1};
    // mouseup snaps back to 0.  Map that tri-state to an ADC voltage:
    //   -1 → 0 V   |   0 → VCC/2 (center)   |   +1 → VCC
    // AVR uses 5 V; everything else (RP2040, ESP32, ESP32-S3, …) runs at 3.3 V.
    const isAvr = !(avrSimulator instanceof RP2040Simulator)
      && typeof (avrSimulator as any).setAdcVoltage !== 'function';
    const vcc = isAvr ? 5.0 : 3.3;
    const centerV = vcc / 2;
    const dirToVolts = (d: number) => ((Math.max(-1, Math.min(1, d)) + 1) / 2) * vcc;

    // Initialize to center position and button not pressed
    if (pinX !== null) setAdcVoltage(avrSimulator, pinX, centerV);
    if (pinY !== null) setAdcVoltage(avrSimulator, pinY, centerV);
    if (pinSW !== null) avrSimulator.setPinState(pinSW, true); // HIGH = not pressed

    const onMove = () => {
      if (pinX !== null) {
        setAdcVoltage(avrSimulator, pinX, dirToVolts(Number(el.xValue ?? 0)));
      }
      if (pinY !== null) {
        setAdcVoltage(avrSimulator, pinY, dirToVolts(Number(el.yValue ?? 0)));
      }
    };

    const onPress = () => {
      if (pinSW !== null) avrSimulator.setPinState(pinSW, false); // Active LOW
      el.pressed = true;
    };
    const onRelease = () => {
      if (pinSW !== null) avrSimulator.setPinState(pinSW, true);
      el.pressed = false;
    };

    element.addEventListener('input', onMove);
    element.addEventListener('joystick-move', onMove);
    element.addEventListener('button-press', onPress);
    element.addEventListener('button-release', onRelease);

    // SensorControlPanel: xAxis/yAxis -512..512 → voltage 0–VCC (center = VCC/2)
    registerSensorUpdate(componentId, (values) => {
      if ('xAxis' in values && pinX !== null) {
        setAdcVoltage(avrSimulator, pinX, (((values.xAxis as number) + 512) / 1023) * vcc);
      }
      if ('yAxis' in values && pinY !== null) {
        setAdcVoltage(avrSimulator, pinY, (((values.yAxis as number) + 512) / 1023) * vcc);
      }
    });

    return () => {
      element.removeEventListener('input', onMove);
      element.removeEventListener('joystick-move', onMove);
      element.removeEventListener('button-press', onPress);
      element.removeEventListener('button-release', onRelease);
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Servo ───────────────────────────────────────────────────────────────────

/**
 * Servo motor — measures actual PWM pulse width from pin state changes.
 *
 * Standard RC servo protocol:
 *   - 50 Hz signal (20 ms period)
 *   - Pulse width 544 µs → 0°, 1472 µs → 90°, 2400 µs → 180°
 *   (Arduino Servo.h uses 544–2400 µs, NOT the generic 1000–2000 µs range)
 *
 * Approach: subscribe to the servo's PWM pin state changes, record the CPU
 * cycle count at the rising edge, then compute pulse width on the falling edge.
 * avr8js re-schedules Timer1 every 8 CPU cycles (prescaler=8), so each HIGH
 * and LOW transition fires in a separate count() call with a distinct cpu.cycles
 * value → the measurement is cycle-accurate.
 *
 * Fallback: if no wire is connected (pinSIG === null), poll OCR1A/ICR1 registers
 * via requestAnimationFrame (less accurate but still functional).
 */
PartSimulationRegistry.register('servo', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
    const pinSIG =
      getArduinoPinHelper('PWM') ?? getArduinoPinHelper('SIG') ?? getArduinoPinHelper('1');
    const el = element as any;

    // Arduino Servo.h actual pulse range (544µs = 0°, 2400µs = 180°)
    const MIN_PULSE_US = 544;
    const MAX_PULSE_US = 2400;
    const CPU_HZ = 16_000_000;

    // ── RP2040 path: measure GPIO pulse timing via onPinChangeWithTime ───────
    // Arduino-Pico Servo library uses PIO (not hardware PWM) — PIO toggles GPIO
    // directly, which fires gpio.addListener → onPinChangeWithTime with the
    // accurate simulation time from SimulationClock.nanosCounter.
    if (avrSimulator instanceof RP2040Simulator && pinSIG !== null) {
      let riseTimeMs = -1;

      // Self-calibrating pulse range: the PIO clock divider may not match
      // exactly, producing pulses offset from the standard 544-2400µs range.
      // Track the minimum observed pulse (= 0° reference) and map using the
      // known standard spread (MAX_PULSE_US - MIN_PULSE_US = 1856µs).
      let observedMin = Infinity;
      const EXPECTED_SPREAD = MAX_PULSE_US - MIN_PULSE_US; // 1856

      avrSimulator.onPinChangeWithTime = (pin, state, timeMs) => {
        if (pin !== pinSIG) return;
        if (state) {
          riseTimeMs = timeMs;
        } else if (riseTimeMs >= 0) {
          const pulseUs = (timeMs - riseTimeMs) * 1000;
          riseTimeMs = -1;

          // Reject noise: only consider pulses in a reasonable servo range
          if (pulseUs < 100 || pulseUs > 25000) return;

          // Update calibration baseline
          if (pulseUs < observedMin) observedMin = pulseUs;

          // Try standard range first
          if (pulseUs >= MIN_PULSE_US && pulseUs <= MAX_PULSE_US) {
            const angle = Math.round(((pulseUs - MIN_PULSE_US) / EXPECTED_SPREAD) * 180);
            el.angle = Math.max(0, Math.min(180, angle));
          } else if (observedMin < Infinity) {
            // Self-calibrated range: use observedMin as 0° reference
            const rangeMax = observedMin + EXPECTED_SPREAD;
            if (pulseUs >= observedMin - 50 && pulseUs <= rangeMax + 200) {
              const angle = Math.round(((pulseUs - observedMin) / EXPECTED_SPREAD) * 180);
              el.angle = Math.max(0, Math.min(180, angle));
            }
          }
        }
      };

      return () => {
        avrSimulator.onPinChangeWithTime = null;
      };
    }

    // ── ESP32 path: subscribe to LEDC PWM duty updates via PinManager ──
    // Esp32BridgeShim has pinManager but getCurrentCycles() returns -1
    // (no local CPU cycle counter — QEMU runs on the backend).
    if (pinSIG !== null && !(avrSimulator instanceof RP2040Simulator)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pinManager = (avrSimulator as any).pinManager as
        | import('../PinManager').PinManager
        | undefined;

      const hasCpuCycles =
        typeof (avrSimulator as any).getCurrentCycles === 'function' &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (avrSimulator as any).getCurrentCycles() >= 0;

      if (pinManager && !hasCpuCycles) {
        // A servo reads the PULSE WIDTH, not the duty cycle: the same 1.5 ms is
        // 7.5 % at 50 Hz and 49.5 % at 330 Hz. The engine reports the frequency
        // alongside the duty when it knows it (ESP32Servo runs servos at 50, 200
        // and 330 Hz); without one, assume the 50 Hz every Servo library defaults to.
        const DEFAULT_SERVO_HZ = 50;
        const unsubscribe = pinManager.onPwmChange(pinSIG, (pin, dutyCycle) => {
          const freqHz = pinManager.getPwmFreq(pin) || DEFAULT_SERVO_HZ;
          const pulseUs = (dutyCycle * 1e6) / freqHz;
          // Outside what any RC servo accepts: a disabled output or plain PWM.
          if (pulseUs < 200 || pulseUs > 4000) return;
          const angle = Math.round(((pulseUs - MIN_PULSE_US) / (MAX_PULSE_US - MIN_PULSE_US)) * 180);
          el.angle = Math.max(0, Math.min(180, angle));
        });
        return () => {
          unsubscribe();
        };
      }
    }

    // ── AVR primary: cycle-accurate pulse width measurement ────────────
    if (pinSIG !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pinManager = (avrSimulator as any).pinManager as
        | import('../PinManager').PinManager
        | undefined;
      if (pinManager) {
        let riseTime = -1; // cycle count at last rising edge

        const getCycles = () =>
          typeof (avrSimulator as any).getCurrentCycles === 'function'
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ((avrSimulator as any).getCurrentCycles() as number)
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (((avrSimulator as any).cpu?.cycles ?? 0) as number);

        const clockHz =
          typeof (avrSimulator as any).getClockHz === 'function'
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ((avrSimulator as any).getClockHz() as number)
            : CPU_HZ;

        const unsubscribe = pinManager.onPinChange(pinSIG, (_pin, state) => {
          if (state) {
            riseTime = getCycles();
          } else if (riseTime >= 0) {
            const pulseCycles = getCycles() - riseTime;
            const pulseUs = (pulseCycles / clockHz) * 1_000_000;
            riseTime = -1;
            if (pulseUs >= MIN_PULSE_US && pulseUs <= MAX_PULSE_US) {
              const angle = Math.round(
                ((pulseUs - MIN_PULSE_US) / (MAX_PULSE_US - MIN_PULSE_US)) * 180,
              );
              el.angle = angle;
            }
          }
        });

        return () => {
          unsubscribe();
        };
      }
    }

    // ── Fallback: poll OCR1A/ICR1 registers when no wire is connected ──
    // OCR1A low byte = 0x88, high byte = 0x89
    // ICR1L = 0x86, ICR1H = 0x87
    const OCR1AL = 0x88;
    const OCR1AH = 0x89;
    const ICR1L = 0x86;
    const ICR1H = 0x87;
    const SERVO_PERIOD_US = 20000;

    let rafId: number | null = null;
    let lastOcr1a = -1;

    const poll = () => {
      if (!avrSimulator.isRunning()) {
        rafId = requestAnimationFrame(poll);
        return;
      }

      const cpu = (avrSimulator as any).cpu;
      if (!cpu) {
        rafId = requestAnimationFrame(poll);
        return;
      }

      const ocr1a = cpu.data[OCR1AL] | (cpu.data[OCR1AH] << 8);
      if (ocr1a !== lastOcr1a) {
        lastOcr1a = ocr1a;
        const icr1 = cpu.data[ICR1L] | (cpu.data[ICR1H] << 8);

        let pulseUs: number;
        if (icr1 > 0) {
          pulseUs = (ocr1a / icr1) * SERVO_PERIOD_US;
        } else {
          // prescaler 8, 16MHz → 0.5µs per tick
          pulseUs = ocr1a * 0.5;
        }

        const clamped = Math.max(MIN_PULSE_US, Math.min(MAX_PULSE_US, pulseUs));
        const angle = Math.round(((clamped - MIN_PULSE_US) / (MAX_PULSE_US - MIN_PULSE_US)) * 180);
        el.angle = angle;
      }

      rafId = requestAnimationFrame(poll);
    };

    rafId = requestAnimationFrame(poll);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  },
});

// ─── Buzzer ──────────────────────────────────────────────────────────────────

/**
 * Buzzer — uses Web Audio API to generate a tone.
 *
 * Reads OCR2A (Timer2 CTC mode) to determine frequency:
 *   f = F_CPU / (2 × prescaler × (OCR2A + 1))
 *
 * Prescaler detected from TCCR2B[2:0] bits.
 * Activates when duty cycle > 0 (pin is driven HIGH).
 */
PartSimulationRegistry.register('buzzer', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper, _componentId, getPinResolver) => {
    const pinSIG =
      getArduinoPinHelper('1') ?? getArduinoPinHelper('+') ?? getArduinoPinHelper('POS');
    const pinManager = (avrSimulator as any).pinManager;
    // PWM tracking still needs the integer pin number; resolver doesn't
    // expose duty. The HIGH/LOW path migrates to PinResolver below.
    const useResolver = typeof getPinResolver === 'function';
    const sigResolver = useResolver
      ? getPinResolver!('1') ?? getPinResolver!('+') ?? getPinResolver!('POS')
      : null;

    let audioCtx: AudioContext | null = null;
    let activeOsc: OscillatorNode | null = null; // the note currently sounding (one per click)
    let activeGain: GainNode | null = null;
    let isSounding = false;
    // Once the pin is driven by hardware PWM (analogWrite/Timer), the PWM
    // handler owns the audio. The digital HIGH/LOW path is only for tone()
    // (software pin toggling); on a PWM pin its ~490Hz carrier would otherwise
    // fire spurious onsets at the duty edges. This flag mutes that path.
    let pwmActive = false;
    const el = element as any;

    // Timer2 register addresses
    const OCR2A = 0xb3;
    const TCCR2B = 0xb1;
    const F_CPU = 16_000_000;

    const prescalerTable: Record<number, number> = {
      1: 1,
      2: 8,
      3: 32,
      4: 64,
      5: 128,
      6: 256,
      7: 1024,
    };

    function getFrequency(cpu: any): number {
      const ocr2a = cpu.data[OCR2A] ?? 0;
      const tccr2b = cpu.data[TCCR2B] ?? 0;
      const csField = tccr2b & 0x07;
      const prescaler = prescalerTable[csField] ?? 64;
      // CTC mode: f = F_CPU / (2 × prescaler × (OCR2A + 1))
      return F_CPU / (2 * prescaler * (ocr2a + 1));
    }

    // ── Sample-accurate audio ────────────────────────────────────────────
    // PWM duty events arrive in per-frame batches (~16ms), so starting a note
    // "now" quantises every onset to the animation frame and a metronome
    // wobbles. We instead schedule each note on the AudioContext clock at the
    // time it happened in the simulation, with a small look-ahead. ONE
    // oscillator PER NOTE (created on the onset, stopped on the note-off) with a
    // short attack/release ramp: each note has a fresh fixed frequency and we
    // never automate gain/frequency on a long-lived node — Firefox in particular
    // clicks/pops on abrupt gain steps and glitches on live frequency changes.
    const LOOKAHEAD = 0.025; // target audio latency (~1-2 frames; aligns with the display)
    const ATTACK = 0.002; // 2 ms fade-in  — removes the start click/pop
    const RELEASE = 0.003; // 3 ms fade-out — removes the end click/pop
    let playWhen: number | null = null; // next scheduled audio time (monotonic)
    let lastSimMs: number | null = null; // simulated time of the previous onset
    let onWhen: number | null = null; // scheduled audio time of the current note's onset
    let onSimMs: number | null = null; // simulated time of the current note's onset

    function ensureCtx() {
      if (!audioCtx) audioCtx = new AudioContext();
      // Autoplay policy: the context starts 'suspended' until a user gesture.
      if (audioCtx.state === 'suspended') audioCtx.resume();
    }

    // Schedule onsets by their SIMULATED inter-onset spacing — exact and even,
    // because the firmware's clock is precise — advancing playWhen by the sim
    // gap (timeMs delta). A light pull holds the scheduling latency near
    // LOOKAHEAD, which bounds the slow sim↔audio clock drift and keeps the click
    // aligned with the on-screen playhead. Because the spacing comes straight
    // from the simulation (not a wall-clock average), turning a control (BPM,
    // K…) re-locks immediately and the rhythm stays even — no bursts, no
    // overlaps. whenFor sees ONLY onsets; note-offs are placed relative to their
    // own onset in stopTone.
    function whenFor(timeMs: number | undefined): number {
      const ctx = audioCtx!;
      const now = ctx.currentTime;
      if (timeMs === undefined || playWhen === null || lastSimMs === null) {
        playWhen = Math.max(now + LOOKAHEAD, (playWhen ?? 0) + 0.001);
        if (timeMs !== undefined) lastSimMs = timeMs;
        return playWhen;
      }
      const dSim = Math.max(0, (timeMs - lastSimMs) / 1000); // exact, even sim spacing
      let when = playWhen + dSim;
      when -= (when - now - LOOKAHEAD) * 0.2; // hold latency / absorb clock drift
      if (when < now + 0.003) when = now + 0.003;
      if (when <= playWhen) when = playWhen + 0.001; // strictly monotonic
      playWhen = when;
      lastSimMs = timeMs;
      return when;
    }

    // Ramp the note currently sounding down to silence ending at audio time
    // `off` and schedule its stop. Shared by stopTone (note-off) and the
    // monophonic guard in startTone (a pitch change with no note-off). Keeps the
    // envelope valid: never release before this note's own attack has finished,
    // nor in the past.
    //
    // Bounded-overlap note (guard path): on a normal metronome/melody — onsets
    // tens-to-hundreds of ms apart — the old note ends ~RELEASE before the next
    // onset. On a degenerate sub-4 ms onset (a >250-note/s trill, or two tone()
    // calls at the same simulated timestamp — neither of which a passive buzzer
    // produces) the `onWhen + ATTACK` floor pushes `off` past the next onset, so
    // two oscillators overlap for at most ~ATTACK+RELEASE (≈5 ms). That is
    // inaudible and still leak-free (one stop per note). We deliberately keep the
    // attack-finished envelope rather than clamp `off` down to the onset, which
    // would start the down-ramp from a gain that never reached its peak.
    function releaseActive(off: number) {
      const ctx = audioCtx;
      if (!ctx || !activeOsc || !activeGain) return;
      if (onWhen !== null && off < onWhen + ATTACK + 0.002) off = onWhen + ATTACK + 0.002;
      if (off < ctx.currentTime + 0.003) off = ctx.currentTime + 0.003;
      try {
        activeGain.gain.setValueAtTime(dutyLevel, off);
        activeGain.gain.linearRampToValueAtTime(0, off + RELEASE);
        activeOsc.stop(off + RELEASE + 0.001);
      } catch {
        /* already scheduled */
      }
      activeOsc = null;
      activeGain = null;
    }

    /** How loud a square wave of this duty cycle is.
     *
     *  A passive buzzer is driven by the pin, and what it puts out is the
     *  fundamental of that square wave — whose amplitude is sin(pi * duty).
     *  Loudest at 50%, and fading to nothing as the duty approaches either
     *  rail, where the pin is barely moving. So analogWrite() on a buzzer
     *  changes the volume, which is what people use it for, and tone() (a
     *  square wave at 50%) is unaffected: sin(pi/2) is 1.
     *
     *  Duty is only known on the PWM path; a tone driven by plain HIGH/LOW
     *  edges passes nothing and gets the full level. */
    const PEAK = 0.1;
    let dutyLevel = PEAK;
    const levelForDuty = (duty: number) =>
      PEAK * Math.sin(Math.PI * Math.min(1, Math.max(0, duty)));

    function startTone(freq: number, timeMs?: number) {
      ensureCtx();
      const ctx = audioCtx!;
      const when = whenFor(timeMs); // the scheduler tracks ONSETS only (clean rhythm)
      // Monophonic guard: a pitch change with no intervening note-off (a melody —
      // consecutive tone() calls) must REPLACE the current note, not stack a new
      // oscillator on top. Release the live note so it ends as the new one begins
      // (seamless legato) instead of orphaning it to play forever. Reads the
      // PREVIOUS note's onWhen, so it must run before onWhen is reassigned below.
      if (activeOsc && activeGain) releaseActive(when);
      onWhen = when;
      onSimMs = timeMs ?? null;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq; // fixed for the life of this note (no live change)
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(dutyLevel, when + ATTACK);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(when);
      osc.onended = () => {
        try {
          osc.disconnect();
          g.disconnect();
        } catch {
          /* already torn down */
        }
      };
      activeOsc = osc;
      activeGain = g;
      isSounding = true;
      if (el.playing !== undefined) el.playing = true;
    }

    function stopTone(timeMs?: number) {
      const ctx = audioCtx;
      if (ctx && activeOsc && activeGain) {
        // Note-off relative to its own onset, preserving the exact click length
        // from the simulation (not via the onset scheduler, which would smear
        // the short on→off and long off→on gaps together).
        const off =
          onWhen !== null && onSimMs !== null && timeMs !== undefined
            ? onWhen + Math.max(0.004, (timeMs - onSimMs) / 1000)
            : ctx.currentTime + 0.02;
        releaseActive(off);
      }
      isSounding = false;
      if (el.playing !== undefined) el.playing = false;
    }

    // Poll via PWM duty cycle on the buzzer pin
    const unsubscribers: (() => void)[] = [];

    // Stop means silence. A buzzer makes sound because a pin is driving it, so
    // when the board stops there is nothing left to drive it — but parts
    // deliberately survive a Stop (a display keeps its picture, an I2C part
    // keeps its state), so nothing was ending the note: the last tone played
    // on for ever and only Reset, which remounts the part and runs its
    // cleanup, could silence it (issue #351).
    //
    // `every` rather than `some`: with two boards on the canvas, stopping one
    // must not cut off a buzzer the other one is still driving.
    let wasRunning = useSimulatorStore.getState().boards.some((b) => b.running);
    unsubscribers.push(
      useSimulatorStore.subscribe((state) => {
        const running = state.boards.some((b) => b.running);
        if (wasRunning && !running) stopTone();
        wasRunning = running;
      }),
    );

    if (pinSIG !== null && pinManager) {
      unsubscribers.push(
        pinManager.onPwmChange(pinSIG, (_: number, dc: number, timeMs?: number) => {
          pwmActive = true;
          const cpu = (avrSimulator as any).cpu;
          if (dc > 0) {
            const freq = cpu ? getFrequency(cpu) : 440;
            dutyLevel = levelForDuty(dc);
            startTone(Math.max(20, Math.min(20000, freq)), timeMs);
          } else {
            stopTone(timeMs);
          }
        }),
      );

      // Also respond to digital HIGH/LOW (tone() toggles the pin).
      // Prefer the resolver — a buzzer driven through a transistor sees
      // the real collector voltage and threshold-converts via the board
      // logic family.
      if (sigResolver) {
        unsubscribers.push(
          sigResolver.onChange((state) => {
            if (pwmActive) return; // PWM-driven: the duty handler owns audio
            if (!isSounding && state === 'HIGH') {
              const cpu = (avrSimulator as any).cpu;
              const freq = cpu ? getFrequency(cpu) : 440;
              startTone(Math.max(20, Math.min(20000, freq)));
            }
            // tone() produces a square wave — don't stop on every LOW;
            // stop only when duty drops to 0 via onPwmChange.
          }),
        );
      } else {
        unsubscribers.push(
          pinManager.onPinChange(pinSIG, (_: number, state: boolean) => {
            if (pwmActive) return; // PWM-driven: the duty handler owns audio
            if (!isSounding && state) {
              const cpu = (avrSimulator as any).cpu;
              const freq = cpu ? getFrequency(cpu) : 440;
              startTone(Math.max(20, Math.min(20000, freq)));
            }
          }),
        );
      }
    }

    return () => {
      if (activeOsc) {
        try {
          activeOsc.stop();
          activeOsc.disconnect();
          activeGain?.disconnect();
        } catch {
          /* already stopped */
        }
        activeOsc = null;
        activeGain = null;
      }
      isSounding = false;
      pwmActive = false;
      if (el.playing !== undefined) el.playing = false;
      playWhen = null;
      lastSimMs = null;
      onWhen = null;
      onSimMs = null;
      if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
      }
      unsubscribers.forEach((u) => u());
    };
  },
});

// ─── LCD 1602 / 2004 ─────────────────────────────────────────────────────────

function createLcdSimulation(cols: number, rows: number) {
  return {
    attachEvents: (
      element: HTMLElement,
      avrSimulator: AnySimulator,
      getArduinoPinHelper: (pin: string) => number | null,
    ) => {
      const el = element as any;

      const ddram = new Uint8Array(128).fill(0x20);
      let ddramAddress = 0;
      let entryIncrement = true;
      let displayOn = true;
      let cursorOn = false;
      let blinkOn = false;
      let nibbleState: 'high' | 'low' = 'high';
      let highNibble = 0;
      let initialized = false;
      let initCount = 0;

      let rsState = false;
      let eState = false;
      let d4State = false;
      let d5State = false;
      let d6State = false;
      let d7State = false;

      const lineOffsets = rows >= 4 ? [0x00, 0x40, 0x14, 0x54] : [0x00, 0x40];

      function ddramToLinear(addr: number): number {
        for (let row = 0; row < rows; row++) {
          const offset = lineOffsets[row];
          if (addr >= offset && addr < offset + cols) {
            return row * cols + (addr - offset);
          }
        }
        return -1;
      }

      function refreshDisplay() {
        if (!displayOn) {
          el.characters = new Uint8Array(cols * rows).fill(0x20);
          return;
        }
        const chars = new Uint8Array(cols * rows);
        for (let row = 0; row < rows; row++) {
          const offset = lineOffsets[row];
          for (let col = 0; col < cols; col++) {
            chars[row * cols + col] = ddram[offset + col];
          }
        }
        el.characters = chars;
        el.cursor = cursorOn;
        el.blink = blinkOn;
        const cursorLinear = ddramToLinear(ddramAddress);
        if (cursorLinear >= 0) {
          el.cursorX = cursorLinear % cols;
          el.cursorY = Math.floor(cursorLinear / cols);
        }
      }

      function processByte(rs: boolean, data: number) {
        if (!rs) {
          if (data & 0x80) {
            ddramAddress = data & 0x7f;
          } else if (data & 0x40) {
            // CGRAM — not implemented
          } else if (data & 0x20) {
            initialized = true;
          } else if (data & 0x10) {
            const sc = (data >> 3) & 1;
            const rl = (data >> 2) & 1;
            if (!sc) {
              ddramAddress = (ddramAddress + (rl ? 1 : -1)) & 0x7f;
            }
          } else if (data & 0x08) {
            displayOn = !!(data & 0x04);
            cursorOn = !!(data & 0x02);
            blinkOn = !!(data & 0x01);
          } else if (data & 0x04) {
            entryIncrement = !!(data & 0x02);
          } else if (data & 0x02) {
            ddramAddress = 0;
          } else if (data & 0x01) {
            ddram.fill(0x20);
            ddramAddress = 0;
          }
        } else {
          ddram[ddramAddress & 0x7f] = data;
          ddramAddress = entryIncrement ? (ddramAddress + 1) & 0x7f : (ddramAddress - 1) & 0x7f;
        }
        refreshDisplay();
      }

      function onEnableFallingEdge() {
        const nibble =
          (d4State ? 0x01 : 0) | (d5State ? 0x02 : 0) | (d6State ? 0x04 : 0) | (d7State ? 0x08 : 0);

        if (!initialized) {
          initCount++;
          if (initCount >= 4) {
            initialized = true;
            nibbleState = 'high';
          }
          return;
        }

        if (nibbleState === 'high') {
          highNibble = nibble << 4;
          nibbleState = 'low';
        } else {
          processByte(rsState, highNibble | nibble);
          nibbleState = 'high';
        }
      }

      const pinRS = getArduinoPinHelper('RS');
      const pinE = getArduinoPinHelper('E');
      const pinD4 = getArduinoPinHelper('D4');
      const pinD5 = getArduinoPinHelper('D5');
      const pinD6 = getArduinoPinHelper('D6');
      const pinD7 = getArduinoPinHelper('D7');

      const pinManager = (avrSimulator as any).pinManager;
      if (!pinManager) return () => {};

      const unsubscribers: (() => void)[] = [];

      if (pinRS !== null)
        unsubscribers.push(
          pinManager.onPinChange(pinRS, (_: number, s: boolean) => {
            rsState = s;
          }),
        );
      if (pinD4 !== null)
        unsubscribers.push(
          pinManager.onPinChange(pinD4, (_: number, s: boolean) => {
            d4State = s;
          }),
        );
      if (pinD5 !== null)
        unsubscribers.push(
          pinManager.onPinChange(pinD5, (_: number, s: boolean) => {
            d5State = s;
          }),
        );
      if (pinD6 !== null)
        unsubscribers.push(
          pinManager.onPinChange(pinD6, (_: number, s: boolean) => {
            d6State = s;
          }),
        );
      if (pinD7 !== null)
        unsubscribers.push(
          pinManager.onPinChange(pinD7, (_: number, s: boolean) => {
            d7State = s;
          }),
        );

      if (pinE !== null) {
        unsubscribers.push(
          pinManager.onPinChange(pinE, (_: number, s: boolean) => {
            const wasHigh = eState;
            eState = s;
            if (wasHigh && !s) onEnableFallingEdge();
          }),
        );
      }

      refreshDisplay();

      return () => {
        unsubscribers.forEach((u) => u());
      };
    },
  };
}

PartSimulationRegistry.register('lcd1602', createLcdSimulation(16, 2));
PartSimulationRegistry.register('lcd2004', createLcdSimulation(20, 4));
PartSimulationRegistry.register('lcd2002', createLcdSimulation(20, 2));

// ─── ILI9341 TFT Display (SPI) ───────────────────────────────────────────────

/**
 * ILI9341 TFT display simulation.
 *
 * A write-only device on the board's SPI fabric (it registers its own SCK /
 * MOSI / MISO / CS pins and is clocked only while its chip select is active).
 * It decodes ILI9341 commands:
 *   - 0x2A CASET  – set column address window
 *   - 0x2B PASET  – set page (row) address window
 *   - 0x2C RAMWR  – rewind the cursor to the window's start and stream
 *                    RGB-565 pixel data
 *   - 0x36 MADCTL – memory access control (rotation MV / MX / MY bits)
 *   - 0x01 SWRESET – clear display
 *   - All others are silently accepted (DISPON, COLMOD, …)
 *
 * Coordinates in CASET/PASET are LOGICAL — driver libraries (Adafruit_
 * ILI9341 etc.) call `setRotation(1|3)` which emits MADCTL with MV set
 * and then writes CASET in 0..319 / PASET in 0..239. The emulator keeps
 * the underlying canvas at the panel's native 240×320 and remaps each
 * pixel through MV/MX/MY at write time. Without this, every landscape
 * sketch (rotation 1 or 3) used to render to nothing because the X
 * bound check filtered out anything past column 239.
 *
 * DC/RS pin: LOW = command byte, HIGH = data bytes.
 */
const ili9341Simulation: PartSimulationLogic = {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const el = element as any;
    const pinManager = (simulator as any).pinManager;

    if (!pinManager) return () => {};

    // ── Canvas setup ──────────────────────────────────────────────────
    const SCREEN_W = 240;
    const SCREEN_H = 320;

    const initCanvas = (): CanvasRenderingContext2D | null => {
      // el.canvas is the getter defined in ili9341-element.ts:
      //   get canvas() { return this.shadowRoot?.querySelector('canvas'); }
      // The element already sets width=240 height=320 in its LitElement template.
      const canvas = el.canvas as HTMLCanvasElement | null;
      if (!canvas) return null;
      return canvas.getContext('2d');
    };

    let ctx = initCanvas();

    const onCanvasReady = () => {
      ctx = initCanvas();
    };
    el.addEventListener('canvas-ready', onCanvasReady);

    // ── Shared ImageData buffer ───────────────────────────────────────
    // Accumulate pixels here; flush to canvas once per animation frame.
    let imageData: ImageData | null = null;

    const getOrCreateImageData = (): ImageData => {
      if (!ctx) ctx = initCanvas();
      if (!imageData && ctx) imageData = ctx.createImageData(SCREEN_W, SCREEN_H);
      return imageData!;
    };

    // Flush is debounced rather than rAF-pinned: TFT firmwares emit each
    // frame as one long SPI burst that often takes >16 ms to drain
    // (rp2040js is sub-realtime), so painting every rAF would snapshot
    // the canvas mid-burst — the user would see only the pixels that
    // happened to land before that tick. We instead wait for SPI silence
    // (a real frame boundary), bounded by a hard cap so continuous-write
    // sketches still update.
    let pendingFlush = false;
    let idleTimerId: number | null = null;
    let firstWriteSinceFlush = 0;
    const IDLE_FLUSH_MS = 16;
    const MAX_FLUSH_INTERVAL_MS = 100;

    const doFlush = () => {
      if (idleTimerId !== null) {
        clearTimeout(idleTimerId);
        idleTimerId = null;
      }
      if (pendingFlush && ctx && imageData) {
        ctx.putImageData(imageData, 0, 0);
        pendingFlush = false;
        firstWriteSinceFlush = 0;
      }
    };

    const scheduleFlush = () => {
      if (!pendingFlush) return;
      const now = performance.now();
      if (firstWriteSinceFlush === 0) firstWriteSinceFlush = now;
      if (now - firstWriteSinceFlush >= MAX_FLUSH_INTERVAL_MS) {
        doFlush();
        return;
      }
      if (idleTimerId !== null) clearTimeout(idleTimerId);
      idleTimerId = window.setTimeout(doFlush, IDLE_FLUSH_MS);
    };

    // ── ILI9341 state ─────────────────────────────────────────────────
    let colStart = 0,
      colEnd = SCREEN_W - 1;
    let rowStart = 0,
      rowEnd = SCREEN_H - 1;
    let curX = 0,
      curY = 0;

    let currentCmd = -1;
    let dataBytes: number[] = [];
    let inRamWrite = false;
    let pixelHiByte = 0;
    let pixelByteCount = 0;

    // ── MADCTL state ──────────────────────────────────────────────────
    // ILI9341 0x36 command bits we care about (datasheet §8.2.29). Set
    // by setRotation() in every Adafruit-style driver; default is
    // rotation 0 = all bits clear (portrait, no swap, no mirror).
    let madMV = false; // row/column exchange — landscape orientation
    let madMX = false; // column address mirror
    let madMY = false; // row address mirror

    // ── DC pin tracking ───────────────────────────────────────────────
    let dcState = false; // LOW = command, HIGH = data
    const pinDC = getArduinoPinHelper('D/C');

    const unsubscribers: (() => void)[] = [];

    if (pinDC !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinDC, (_: number, s: boolean) => {
          dcState = s;
        }),
      );
    }

    // ── Pixel writer ──────────────────────────────────────────────────
    // curX / curY / col* / row* are LOGICAL coordinates — the values the
    // driver thinks it's writing to. In rotation 0 logical = physical.
    // In rotation 1/3 (MV set) the driver iterates X in 0..319 and Y in
    // 0..239; we swap them at the last possible moment before touching
    // the imageData buffer (which is always physically 240 wide × 320 tall).
    //
    // The mapping is rotation-specific because applying MX/MY/MV as three
    // independent flags double-mirrors the output (we tried that in
    // commit 6edc715 and the user saw "espejada" text). The four
    // Adafruit_ILI9341 setRotation() values map cleanly to four explicit
    // (curX, curY) → (physX, physY) formulae taken from the chip's
    // datasheet section 8.2.29 (Memory Access Control):
    //
    //   rot 0  M=0x48 (MX|BGR)            : (curX, curY)              [portrait]
    //   rot 1  M=0x28 (MV|BGR)            : (curY, (319 - curX))      [landscape]
    //   rot 2  M=0x88 (MY|BGR)            : ((239 - curX), (319 - curY))  [portrait flipped]
    //   rot 3  M=0xE8 (MX|MY|MV|BGR)      : ((239 - curY), curX)      [landscape flipped]
    //
    // The Adafruit driver computes the rotation register value, sends it
    // once via MADCTL, then writes pixels in the rotated framebuffer's
    // coordinate space — we mirror that on the receive side.
    const writePixel = (hi: number, lo: number) => {
      if (curX > colEnd || curY > rowEnd) return;

      // Map logical → physical via the (MV, MX, MY) rotation signature.
      let physX: number, physY: number;
      if (!madMV) {
        // Portrait (rotations 0 or 2)
        physX = madMY ? (SCREEN_W - 1) - curX : curX;
        physY = madMY ? (SCREEN_H - 1) - curY : curY;
      } else if (!madMX) {
        // Landscape, turned one way: MV with the column order left alone.
        // Adafruit's rotation 1 (m = MV | BGR) and LovyanGFX's rotation 3
        // (m = MV | MY | ML) both land here.
        physX = curY;
        physY = (SCREEN_H - 1) - curX;
      } else {
        // Landscape, turned the other way: MV with the column order reversed.
        // Adafruit's rotation 3 (m = MX | MY | MV | BGR) and LovyanGFX's
        // rotation 1 (m = MV | MX | MH).
        //
        // Asking "neither mirror bit" instead of "is MX set" is an
        // Adafruit-shaped question: it always sets MX and MY together, so its
        // pair agrees. LovyanGFX sets ONE of them per landscape rotation, so
        // both of its landscapes fell in the same branch and rendered
        // identically — and touch, which a driver rotates by the rotation the
        // panel is in, then disagreed with the picture (issue #338).
        physX = (SCREEN_W - 1) - curY;
        physY = curX;
      }

      if (physX < 0 || physX >= SCREEN_W || physY < 0 || physY >= SCREEN_H) {
        curX++;
        if (curX > colEnd) {
          curX = colStart;
          curY++;
        }
        return;
      }

      const id = getOrCreateImageData();
      const color = (hi << 8) | lo;
      const r = ((color >> 11) & 0x1f) * 8;
      const g = ((color >> 5) & 0x3f) * 4;
      const b = (color & 0x1f) * 8;

      const idx = (physY * SCREEN_W + physX) * 4;
      id.data[idx] = r;
      id.data[idx + 1] = g;
      id.data[idx + 2] = b;
      id.data[idx + 3] = 255;

      pendingFlush = true;
      curX++;
      if (curX > colEnd) {
        curX = colStart;
        curY++;
      }
    };

    // ── Command / data processing ─────────────────────────────────────
    const processCommand = (cmd: number) => {
      currentCmd = cmd;
      dataBytes = [];
      inRamWrite = cmd === 0x2c;
      pixelByteCount = 0;

      // RAMWR (2Ch) puts the frame-memory pointer back at the start of the
      // window (datasheet 8.2.22 Memory Write): the next pixel lands on
      // (SC, SP) whether or not CASET/PASET were sent again. Without this the
      // cursor only ever moved on a CASET/PASET, so a driver that keeps the
      // window and re-sends RAMWR alone (a second fillScreen of the same
      // area, TFT_eSPI skipping an unchanged setAddrWindow) went on writing
      // past rowEnd and drew nothing at all.
      if (cmd === 0x2c) {
        curX = colStart;
        curY = rowStart;
      }

      if (cmd === 0x01) {
        // SWRESET – clear framebuffer + reset MADCTL to defaults
        colStart = 0;
        colEnd = SCREEN_W - 1;
        rowStart = 0;
        rowEnd = SCREEN_H - 1;
        curX = 0;
        curY = 0;
        madMV = false;
        madMX = false;
        madMY = false;
        imageData = null;
        if (ctx) ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
      }
    };

    const processData = (value: number) => {
      if (inRamWrite) {
        // RGB-565: two bytes per pixel
        if (pixelByteCount === 0) {
          pixelHiByte = value;
          pixelByteCount = 1;
        } else {
          writePixel(pixelHiByte, value);
          scheduleFlush();
          pixelByteCount = 0;
        }
        return;
      }

      dataBytes.push(value);
      switch (currentCmd) {
        case 0x2a: // CASET – column address set
          if (dataBytes.length === 2) colStart = (dataBytes[0] << 8) | dataBytes[1];
          if (dataBytes.length === 4) {
            colEnd = (dataBytes[2] << 8) | dataBytes[3];
            curX = colStart;
          }
          break;
        case 0x2b: // PASET – page address set
          if (dataBytes.length === 2) rowStart = (dataBytes[0] << 8) | dataBytes[1];
          if (dataBytes.length === 4) {
            rowEnd = (dataBytes[2] << 8) | dataBytes[3];
            curY = rowStart;
          }
          break;
        case 0x36: // MADCTL – memory access control (rotation / mirror)
          if (dataBytes.length === 1) {
            const m = dataBytes[0];
            madMY = (m & 0x80) !== 0;
            madMX = (m & 0x40) !== 0;
            madMV = (m & 0x20) !== 0;
          }
          break;
        // All other commands (DISPON, COLMOD…) just buffer data
      }
    };

    // ── On the SPI bus ────────────────────────────────────────────────
    // The panel is a write-only sink: it never drives MISO, so it answers
    // null and the fabric resolves the line. The fabric hands it a frame
    // only while its OWN chip select is active, which is what a real panel
    // does and what the chain never did: a card or a touch controller on the
    // same SCK/MOSI used to paint its traffic as pixels (#343).
    //
    // CS rising deliberately does NOT end a RAM write. On the chip the frame
    // memory pointer and the active command survive CSX, which is what every
    // Adafruit driver relies on: setAddrWindow + RAMWR go out in one
    // transaction and the pixels in the next (pushColor). Only a new RAMWR
    // moves the cursor.
    const owner = componentId || (el?.id as string) || 'ili9341';
    const feed = (value: number) => {
      if (!dcState) processCommand(value);
      else processData(value);
    };
    const handle = attachSpiDevice(
      { owner, pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } },
      {
        transfer: (value: number) => {
          feed(value);
          return null;
        },
        transferBlock: (bytes: Uint8Array) => {
          for (let i = 0; i < bytes.length; i++) feed(bytes[i]);
        },
        boardReset: () => {
          // The MCU rebooted: the next byte on the wire is a fresh command,
          // so the half-read parameter list and the half-read pixel go. The
          // window, the rotation and the picture are the panel's own and
          // stay, as they do on a board whose reset button is pressed.
          currentCmd = -1;
          dataBytes = [];
          inRamWrite = false;
          pixelByteCount = 0;
        },
      },
    );

    // ── Cleanup ───────────────────────────────────────────────────────
    return () => {
      handle.dispose();
      if (idleTimerId !== null) clearTimeout(idleTimerId);
      el.removeEventListener('canvas-ready', onCanvasReady);
      unsubscribers.forEach((u) => u());
    };
  },
};

PartSimulationRegistry.register('ili9341', ili9341Simulation);
// board-ili9341-cap-touch (Wokwi type) maps to 'ili9341-cap-touch' metadataId — same SPI simulation
PartSimulationRegistry.register('ili9341-cap-touch', ili9341Simulation);
