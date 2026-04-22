import { PartSimulationRegistry } from './PartSimulationRegistry';
import type { AnySimulator } from './PartSimulationRegistry';
import { RP2040Simulator } from '../RP2040Simulator';
import { getADC, setAdcVoltage, emitPropertyChange } from './partUtils';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';

// ─── Helpers ────────────────────────────────────────────────────────────────

// ─── RGB LED (PWM-aware) ─────────────────────────────────────────────────────

/**
 * RGB LED implementation — supports both digital and PWM (analogWrite) output.
 * Falls back to digital mode if no PWM is detected.
 */
PartSimulationRegistry.register('rgb-led', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
    const pinManager = (avrSimulator as any).pinManager;
    if (!pinManager) return () => {};

    const el = element as any;
    const unsubscribers: (() => void)[] = [];

    const pinR = getArduinoPinHelper('R');
    const pinG = getArduinoPinHelper('G');
    const pinB = getArduinoPinHelper('B');

    // Digital fallback
    if (pinR !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinR, (_: number, state: boolean) => {
          el.ledRed = state ? 255 : 0;
        }),
      );
    }
    if (pinG !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinG, (_: number, state: boolean) => {
          el.ledGreen = state ? 255 : 0;
        }),
      );
    }
    if (pinB !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinB, (_: number, state: boolean) => {
          el.ledBlue = state ? 255 : 0;
        }),
      );
    }

    // PWM override — when analogWrite() is used the OCR value supersedes digital
    const pwmPins = [
      { pin: pinR, prop: 'ledRed' },
      { pin: pinG, prop: 'ledGreen' },
      { pin: pinB, prop: 'ledBlue' },
    ];
    for (const { pin, prop } of pwmPins) {
      if (pin !== null) {
        unsubscribers.push(
          pinManager.onPwmChange(pin, (_: number, dc: number) => {
            el[prop] = Math.round(dc * 255);
          }),
        );
      }
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
        // Mirror to store — maps the slider 0-1023 back to lux 0-1000
        // so the SPICE photoresistor handler re-computes its R_ldr.
        emitPropertyChange(componentId, 'lux', Math.round((val / 1023) * 1000));
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

    // RP2040 uses 3.3V reference; AVR uses 5V
    const vcc = avrSimulator instanceof RP2040Simulator ? 3.3 : 5.0;
    const centerV = vcc / 2;

    // Initialize to center position and button not pressed
    if (pinX !== null) setAdcVoltage(avrSimulator, pinX, centerV);
    if (pinY !== null) setAdcVoltage(avrSimulator, pinY, centerV);
    if (pinSW !== null) avrSimulator.setPinState(pinSW, true); // HIGH = not pressed

    const onMove = () => {
      // xValue / yValue are 0-1023
      if (pinX !== null) {
        const vx = ((el.xValue ?? 512) / 1023.0) * vcc;
        setAdcVoltage(avrSimulator, pinX, vx);
      }
      if (pinY !== null) {
        const vy = ((el.yValue ?? 512) / 1023.0) * vcc;
        setAdcVoltage(avrSimulator, pinY, vy);
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
        // ESP32 Servo.h uses 50Hz PWM with pulse 544-2400µs
        // dutyCycle here is 0.0-1.0 (fraction of PWM period = 20ms)
        // 544µs = 2.72%, 2400µs = 12.0%
        const MIN_DC = MIN_PULSE_US / 20000; // 0.0272
        const MAX_DC = MAX_PULSE_US / 20000; // 0.12
        const unsubscribe = pinManager.onPwmChange(pinSIG, (_pin, dutyCycle) => {
          if (dutyCycle < 0.01 || dutyCycle > 0.2) return; // ignore out-of-range
          const angle = Math.round(((dutyCycle - MIN_DC) / (MAX_DC - MIN_DC)) * 180);
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
  attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
    const pinSIG =
      getArduinoPinHelper('1') ?? getArduinoPinHelper('+') ?? getArduinoPinHelper('POS');
    const pinManager = (avrSimulator as any).pinManager;

    let audioCtx: AudioContext | null = null;
    let oscillator: OscillatorNode | null = null;
    let gainNode: GainNode | null = null;
    let isSounding = false;
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

    function startTone(freq: number) {
      if (!audioCtx) {
        audioCtx = new AudioContext();
        gainNode = audioCtx.createGain();
        gainNode.gain.value = 0.1;
        gainNode.connect(audioCtx.destination);
      }
      // Browser autoplay policy: AudioContext starts in 'suspended' state
      // until a user gesture has occurred. Resume it here so sound plays.
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      if (oscillator) {
        oscillator.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.01);
        return;
      }
      oscillator = audioCtx.createOscillator();
      oscillator.type = 'square';
      oscillator.frequency.value = freq;
      oscillator.connect(gainNode!);
      oscillator.start();
      isSounding = true;
      if (el.playing !== undefined) el.playing = true;
    }

    function stopTone() {
      if (oscillator) {
        oscillator.stop();
        oscillator.disconnect();
        oscillator = null;
      }
      isSounding = false;
      if (el.playing !== undefined) el.playing = false;
    }

    // Poll via PWM duty cycle on the buzzer pin
    const unsubscribers: (() => void)[] = [];

    if (pinSIG !== null && pinManager) {
      unsubscribers.push(
        pinManager.onPwmChange(pinSIG, (_: number, dc: number) => {
          const cpu = (avrSimulator as any).cpu;
          if (dc > 0) {
            const freq = cpu ? getFrequency(cpu) : 440;
            startTone(Math.max(20, Math.min(20000, freq)));
          } else {
            stopTone();
          }
        }),
      );

      // Also respond to digital HIGH/LOW (tone() toggles the pin)
      unsubscribers.push(
        pinManager.onPinChange(pinSIG, (_: number, state: boolean) => {
          if (!isSounding && state) {
            const cpu = (avrSimulator as any).cpu;
            const freq = cpu ? getFrequency(cpu) : 440;
            startTone(Math.max(20, Math.min(20000, freq)));
          } else if (isSounding && !state) {
            // Don't stop on every LOW — tone() generates a square wave
            // We stop only when duty cycle drops to 0 via onPwmChange
          }
        }),
      );
    }

    return () => {
      stopTone();
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
 * ILI9341 TFT display simulation via hardware SPI.
 *
 * Intercepts writes to SPDR (via AVRSPI) and decodes ILI9341 commands:
 *   - 0x2A CASET  – set column address window
 *   - 0x2B PASET  – set page (row) address window
 *   - 0x2C RAMWR  – stream RGB-565 pixel data
 *   - 0x01 SWRESET – clear display
 *   - All others are silently accepted (init sequences, DISPON, MADCTL…)
 *
 * DC/RS pin: LOW = command byte, HIGH = data bytes.
 */
const ili9341Simulation = {
  attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
    const el = element as any;
    const pinManager = (avrSimulator as any).pinManager;
    const spi = (avrSimulator as any).spi;

    if (!pinManager || !spi) return () => {};

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

    let pendingFlush = false;
    let rafId: number | null = null;

    const scheduleFlush = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (pendingFlush && ctx && imageData) {
          ctx.putImageData(imageData, 0, 0);
          pendingFlush = false;
        }
      });
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
    const writePixel = (hi: number, lo: number) => {
      if (curX > colEnd || curY > rowEnd || curY >= SCREEN_H || curX >= SCREEN_W) return;

      const id = getOrCreateImageData();
      const color = (hi << 8) | lo;
      const r = ((color >> 11) & 0x1f) * 8;
      const g = ((color >> 5) & 0x3f) * 4;
      const b = (color & 0x1f) * 8;

      const idx = (curY * SCREEN_W + curX) * 4;
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

      if (cmd === 0x01) {
        // SWRESET – clear framebuffer
        colStart = 0;
        colEnd = SCREEN_W - 1;
        rowStart = 0;
        rowEnd = SCREEN_H - 1;
        curX = 0;
        curY = 0;
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
        // All other commands (DISPON, MADCTL, COLMOD…) just buffer data
      }
    };

    // ── Intercept SPI ─────────────────────────────────────────────────
    const prevOnByte = spi.onByte.bind(spi);

    spi.onByte = (value: number) => {
      if (!dcState) {
        processCommand(value);
      } else {
        processData(value);
      }
      spi.completeTransfer(0xff); // Unblock CPU immediately
    };

    // ── Cleanup ───────────────────────────────────────────────────────
    return () => {
      spi.onByte = prevOnByte;
      if (rafId !== null) cancelAnimationFrame(rafId);
      el.removeEventListener('canvas-ready', onCanvasReady);
      unsubscribers.forEach((u) => u());
    };
  },
};

PartSimulationRegistry.register('ili9341', ili9341Simulation);
// board-ili9341-cap-touch (Wokwi type) maps to 'ili9341-cap-touch' metadataId — same SPI simulation
PartSimulationRegistry.register('ili9341-cap-touch', ili9341Simulation);
