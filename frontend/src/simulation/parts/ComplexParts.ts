/**
 * ComplexParts.ts — Simulation logic for PWM-aware LEDs, analog inputs,
 * character displays, joysticks and the ILI9341 TFT.
 *
 * Migrated in CORE-002c-step4 (3/5) from the legacy `PartSimulationLogic`
 * shape to the narrow SDK `PartSimulation` contract. Every migrated part
 * is authored against `@velxio/sdk` and registered via
 * `PartRegistry.registerSdkPart` — no leakage of `pinManager`, `spi`,
 * `i2cBus`, or `cpu` from the host.
 *
 * Two parts stay on the legacy shape until the SDK offers their needed
 * surfaces:
 *   - `servo`  — RP2040 `onPinChangeWithTime` (nanosecond-accurate pulse
 *                measurement not expressible through `cyclesNow()`) and
 *                AVR-only `cpu.data[OCR1AL]` / `cpu.data[ICR1L]` register
 *                fallback when no wire is connected.
 *   - `buzzer` — reads `cpu.data[OCR2A]` and `cpu.data[TCCR2B]` to derive
 *                the tone frequency from Timer2 CTC-mode registers.
 *
 * Documented as step4 deviations in `CORE-002c-step4a` Done manifest —
 * both require AVR register-level access that the board-agnostic SDK
 * deliberately omits.
 */

import type { PartSimulation, PinState } from '@velxio/sdk';
import { definePartSimulation } from '@velxio/sdk';
import type { PartRegistry } from './PartSimulationRegistry';
import { RP2040Simulator } from '../RP2040Simulator';
import { emitPropertyChange } from './partUtils';

const isHigh = (state: PinState): boolean => state === 1;

/** Reference voltage for ADC injection. AVR is 5 V; RP2040 and the ESP32
 *  bridge run at 3.3 V. `handle.boardPlatform` is the SDK discriminator. */
const vccForPlatform = (platform: 'avr' | 'rp2040' | 'esp32' | 'unknown'): number =>
  platform === 'rp2040' || platform === 'esp32' ? 3.3 : 5.0;

// ─── RGB LED (PWM-aware) ─────────────────────────────────────────────────────

/** RGB LED — supports both digital and PWM (analogWrite). `onPwmChange`
 *  supersedes `onPinChange` whenever the host reports a non-zero duty. */
const rgbLedPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const el = element as HTMLElement & {
      ledRed: number;
      ledGreen: number;
      ledBlue: number;
    };
    const disposables: Array<{ dispose(): void }> = [];

    const channels: Array<{ pinName: string; prop: 'ledRed' | 'ledGreen' | 'ledBlue' }> = [
      { pinName: 'R', prop: 'ledRed' },
      { pinName: 'G', prop: 'ledGreen' },
      { pinName: 'B', prop: 'ledBlue' },
    ];

    for (const { pinName, prop } of channels) {
      disposables.push(
        handle.onPinChange(pinName, (s) => {
          el[prop] = isHigh(s) ? 255 : 0;
        }),
      );
      disposables.push(
        handle.onPwmChange(pinName, (duty) => {
          el[prop] = Math.round(duty * 255);
        }),
      );
    }

    return () => disposables.forEach((d) => d.dispose());
  },
});

// ─── Potentiometer (rotary) ──────────────────────────────────────────────────

const potentiometerPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const refVoltage = vccForPlatform(handle.boardPlatform);

    const onInput = () => {
      const rawStr = (element as HTMLElement & { value?: string }).value ?? '0';
      const raw = parseInt(rawStr, 10);
      const volts = (raw / 1023.0) * refVoltage;
      handle.setAnalogValue('SIG', volts);
      // Mirror to store so the SPICE netlist re-solves (op-amp comparators,
      // divider-driven circuits etc. depend on `value`).
      emitPropertyChange(handle.componentId, 'value', raw);
    };

    onInput();
    element.addEventListener('input', onInput);
    return () => element.removeEventListener('input', onInput);
  },
});

// ─── Slide Potentiometer ─────────────────────────────────────────────────────

const slidePotentiometerPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const el = element as HTMLElement & { min?: string | number; max?: string | number; value?: string | number };
    const refVoltage = vccForPlatform(handle.boardPlatform);
    // Component can be wired under either 'SIG' or 'OUT'. `setAnalogValue`
    // is a no-op for the unwired pin, so we pick whichever resolves.
    const sigPinName = handle.getArduinoPin('SIG') !== null ? 'SIG' : 'OUT';

    const onInput = () => {
      const min = Number(el.min ?? 0);
      const max = Number(el.max ?? 1023);
      const value = Number(el.value ?? 0);
      const normalized = (value - min) / (max - min || 1);
      handle.setAnalogValue(sigPinName, normalized * refVoltage);
      emitPropertyChange(handle.componentId, 'value', value);
    };

    onInput();
    element.addEventListener('input', onInput);
    return () => element.removeEventListener('input', onInput);
  },
});

// ─── Photoresistor Sensor ────────────────────────────────────────────────────

/** Photoresistor sensor — injects a static mid-range voltage on AO so
 *  `analogRead()` returns a sensible value. Users drive via slider or the
 *  sensor control panel (`lux` key, 0–1000). */
const photoresistorPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const aoPinName = handle.getArduinoPin('AO') !== null ? 'AO' : 'A0';
    const doPinName = handle.getArduinoPin('DO') !== null ? 'DO' : 'D0';

    const disposables: Array<{ dispose(): void }> = [];

    // Initial mid-range light (~500 lux, 2.5 V on 5 V reference).
    handle.setAnalogValue(aoPinName, 2.5);

    const onInput = () => {
      const val = (element as HTMLElement & { value?: number }).value;
      if (val === undefined) return;
      handle.setAnalogValue(aoPinName, (val / 1023.0) * 5.0);
      // Mirror the slider 0–1023 to lux 0–1000 so the SPICE photoresistor
      // handler can recompute R_ldr.
      emitPropertyChange(handle.componentId, 'lux', Math.round((val / 1023) * 1000));
    };
    element.addEventListener('input', onInput);
    disposables.push({
      dispose: () => element.removeEventListener('input', onInput),
    });

    // DO (digital output) — mirror to element's LED indicator when wired.
    disposables.push(
      handle.onPinChange(doPinName, (s) => {
        (element as HTMLElement & { ledDO: boolean }).ledDO = isHigh(s);
      }),
    );

    // SensorControlPanel: lux 0–1000 → volts 0–5.
    disposables.push(
      handle.onSensorControlUpdate((values) => {
        if ('lux' in values) {
          handle.setAnalogValue(aoPinName, ((values.lux as number) / 1000) * 5.0);
          emitPropertyChange(handle.componentId, 'lux', values.lux);
        }
      }),
    );

    return () => disposables.forEach((d) => d.dispose());
  },
});

// ─── Analog Joystick ─────────────────────────────────────────────────────────

/** Two axes (xValue/yValue 0-1023) + push button. Wokwi pins: VERT/HORZ/SEL
 *  (also legacy VRX/VRY/SW aliases). Axis values from the sensor panel are
 *  -512..512 with center=0 — converted to volts with center = VCC/2. */
const analogJoystickPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const el = element as HTMLElement & {
      xValue?: number;
      yValue?: number;
      pressed?: boolean;
    };
    const vcc = vccForPlatform(handle.boardPlatform);
    const centerV = vcc / 2;

    const pinXName =
      handle.getArduinoPin('VERT') !== null
        ? 'VERT'
        : handle.getArduinoPin('VRX') !== null
          ? 'VRX'
          : 'XOUT';
    const pinYName =
      handle.getArduinoPin('HORZ') !== null
        ? 'HORZ'
        : handle.getArduinoPin('VRY') !== null
          ? 'VRY'
          : 'YOUT';
    const pinSWName = handle.getArduinoPin('SEL') !== null ? 'SEL' : 'SW';
    const pinSW = handle.getArduinoPin(pinSWName);

    // Initialize center + button not pressed.
    handle.setAnalogValue(pinXName, centerV);
    handle.setAnalogValue(pinYName, centerV);
    if (pinSW !== null) handle.setPinState(pinSW, true); // HIGH = not pressed

    const onMove = () => {
      const vx = ((el.xValue ?? 512) / 1023.0) * vcc;
      const vy = ((el.yValue ?? 512) / 1023.0) * vcc;
      handle.setAnalogValue(pinXName, vx);
      handle.setAnalogValue(pinYName, vy);
    };

    const onPress = () => {
      if (pinSW !== null) handle.setPinState(pinSW, false); // Active LOW
      el.pressed = true;
    };
    const onRelease = () => {
      if (pinSW !== null) handle.setPinState(pinSW, true);
      el.pressed = false;
    };

    element.addEventListener('input', onMove);
    element.addEventListener('joystick-move', onMove);
    element.addEventListener('button-press', onPress);
    element.addEventListener('button-release', onRelease);

    const sensorDispose = handle.onSensorControlUpdate((values) => {
      if ('xAxis' in values) {
        handle.setAnalogValue(pinXName, (((values.xAxis as number) + 512) / 1023) * vcc);
      }
      if ('yAxis' in values) {
        handle.setAnalogValue(pinYName, (((values.yAxis as number) + 512) / 1023) * vcc);
      }
    });

    return () => {
      element.removeEventListener('input', onMove);
      element.removeEventListener('joystick-move', onMove);
      element.removeEventListener('button-press', onPress);
      element.removeEventListener('button-release', onRelease);
      sensorDispose.dispose();
    };
  },
});

// ─── LCD 1602 / 2002 / 2004 (HD44780 4-bit parallel) ─────────────────────────

function createLcdPart(cols: number, rows: number): PartSimulation {
  return definePartSimulation({
    attachEvents: (element, handle) => {
      const el = element as HTMLElement & {
        characters: Uint8Array;
        cursor: boolean;
        blink: boolean;
        cursorX: number;
        cursorY: number;
      };

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

      const disposables: Array<{ dispose(): void }> = [];

      disposables.push(handle.onPinChange('RS', (s) => { rsState = isHigh(s); }));
      disposables.push(handle.onPinChange('D4', (s) => { d4State = isHigh(s); }));
      disposables.push(handle.onPinChange('D5', (s) => { d5State = isHigh(s); }));
      disposables.push(handle.onPinChange('D6', (s) => { d6State = isHigh(s); }));
      disposables.push(handle.onPinChange('D7', (s) => { d7State = isHigh(s); }));
      disposables.push(
        handle.onPinChange('E', (s) => {
          const wasHigh = eState;
          eState = isHigh(s);
          if (wasHigh && !eState) onEnableFallingEdge();
        }),
      );

      refreshDisplay();

      return () => disposables.forEach((d) => d.dispose());
    },
  });
}

const lcd1602Part = createLcdPart(16, 2);
const lcd2004Part = createLcdPart(20, 4);
const lcd2002Part = createLcdPart(20, 2);

// ─── ILI9341 TFT Display (SPI) ───────────────────────────────────────────────

/** ILI9341 TFT display via hardware SPI. DC pin distinguishes commands
 *  (LOW) from data (HIGH). Uses `handle.registerSpiSlave` (step4a) — the
 *  SDK adapter calls `spi.completeTransfer(response)` for every byte so
 *  the CPU is unblocked immediately, same as the legacy intercept. */
const ili9341Part: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const el = element as HTMLElement & { canvas: HTMLCanvasElement | null };
    const SCREEN_W = 240;
    const SCREEN_H = 320;

    const initCanvas = (): CanvasRenderingContext2D | null => {
      const canvas = el.canvas;
      if (!canvas) return null;
      return canvas.getContext('2d');
    };

    let ctx = initCanvas();

    const onCanvasReady = () => {
      ctx = initCanvas();
    };
    element.addEventListener('canvas-ready', onCanvasReady);

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

    let colStart = 0;
    let colEnd = SCREEN_W - 1;
    let rowStart = 0;
    let rowEnd = SCREEN_H - 1;
    let curX = 0;
    let curY = 0;

    let currentCmd = -1;
    let dataBytes: number[] = [];
    let inRamWrite = false;
    let pixelHiByte = 0;
    let pixelByteCount = 0;

    let dcState = false; // LOW = command, HIGH = data

    const disposables: Array<{ dispose(): void }> = [];

    disposables.push(
      handle.onPinChange('D/C', (s) => {
        dcState = isHigh(s);
      }),
    );

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

    const processCommand = (cmd: number) => {
      currentCmd = cmd;
      dataBytes = [];
      inRamWrite = cmd === 0x2c;
      pixelByteCount = 0;

      if (cmd === 0x01) {
        // SWRESET — clear framebuffer
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
        case 0x2a: // CASET — column address set
          if (dataBytes.length === 2) colStart = (dataBytes[0] << 8) | dataBytes[1];
          if (dataBytes.length === 4) {
            colEnd = (dataBytes[2] << 8) | dataBytes[3];
            curX = colStart;
          }
          break;
        case 0x2b: // PASET — page address set
          if (dataBytes.length === 2) rowStart = (dataBytes[0] << 8) | dataBytes[1];
          if (dataBytes.length === 4) {
            rowEnd = (dataBytes[2] << 8) | dataBytes[3];
            curY = rowStart;
          }
          break;
        // All other commands (DISPON, MADCTL, COLMOD…) just buffer their
        // parameters — the display ignores them and stays in the SWRESET
        // geometry until CASET/PASET override it.
      }
    };

    disposables.push(
      handle.registerSpiSlave({
        onByte(master) {
          if (!dcState) {
            processCommand(master);
          } else {
            processData(master);
          }
          return 0xff; // open-drain default; driver is write-only
        },
      }),
    );

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      element.removeEventListener('canvas-ready', onCanvasReady);
      disposables.forEach((d) => d.dispose());
    };
  },
});

// ─── Legacy parts (AVR register-level access) ────────────────────────────────

/**
 * Register `servo` and `buzzer` on the legacy host shape. Both reach into
 * AVR `cpu.data[...]` registers that the board-agnostic SDK handle does
 * not expose, and `servo` additionally uses RP2040's `onPinChangeWithTime`
 * for nanosecond-accurate PIO pulse decoding. These deviations are
 * documented in the `CORE-002c-step4a` Done manifest under follow-ups.
 */
function registerLegacyComplexParts(registry: PartRegistry): void {
  // ─── Servo ─────────────────────────────────────────────────────────────────
  registry.register('servo', {
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
      const pinSIG =
        getArduinoPinHelper('PWM') ?? getArduinoPinHelper('SIG') ?? getArduinoPinHelper('1');
      const el = element as HTMLElement & { angle: number };

      // Arduino Servo.h actual pulse range (544µs = 0°, 2400µs = 180°)
      const MIN_PULSE_US = 544;
      const MAX_PULSE_US = 2400;
      const CPU_HZ = 16_000_000;

      // ── RP2040 path: nanosecond-accurate GPIO timing via onPinChangeWithTime
      if (avrSimulator instanceof RP2040Simulator && pinSIG !== null) {
        let riseTimeMs = -1;
        let observedMin = Infinity;
        const EXPECTED_SPREAD = MAX_PULSE_US - MIN_PULSE_US; // 1856

        avrSimulator.onPinChangeWithTime = (pin, state, timeMs) => {
          if (pin !== pinSIG) return;
          if (state) {
            riseTimeMs = timeMs;
          } else if (riseTimeMs >= 0) {
            const pulseUs = (timeMs - riseTimeMs) * 1000;
            riseTimeMs = -1;

            // Reject noise outside plausible servo range.
            if (pulseUs < 100 || pulseUs > 25000) return;

            if (pulseUs < observedMin) observedMin = pulseUs;

            if (pulseUs >= MIN_PULSE_US && pulseUs <= MAX_PULSE_US) {
              const angle = Math.round(((pulseUs - MIN_PULSE_US) / EXPECTED_SPREAD) * 180);
              el.angle = Math.max(0, Math.min(180, angle));
            } else if (observedMin < Infinity) {
              // Self-calibrated range: PIO clock divider may shift the window.
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

      // ── ESP32 bridge path: LEDC duty cycle over the WebSocket shim.
      if (pinSIG !== null && !(avrSimulator instanceof RP2040Simulator)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pinManager = (avrSimulator as any).pinManager as
          | import('../PinManager').PinManager
          | undefined;

        const hasCpuCycles =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          typeof (avrSimulator as any).getCurrentCycles === 'function' &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (avrSimulator as any).getCurrentCycles() >= 0;

        if (pinManager && !hasCpuCycles) {
          // ESP32 Servo.h uses 50Hz PWM with pulse 544-2400µs.
          // dutyCycle is 0.0-1.0 (fraction of PWM period = 20ms).
          const MIN_DC = MIN_PULSE_US / 20000;
          const MAX_DC = MAX_PULSE_US / 20000;
          const unsubscribe = pinManager.onPwmChange(pinSIG, (_pin, dutyCycle) => {
            if (dutyCycle < 0.01 || dutyCycle > 0.2) return;
            const angle = Math.round(((dutyCycle - MIN_DC) / (MAX_DC - MIN_DC)) * 180);
            el.angle = Math.max(0, Math.min(180, angle));
          });
          return () => {
            unsubscribe();
          };
        }
      }

      // ── AVR primary: cycle-accurate pulse-width measurement.
      if (pinSIG !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pinManager = (avrSimulator as any).pinManager as
          | import('../PinManager').PinManager
          | undefined;
        if (pinManager) {
          let riseTime = -1;

          const getCycles = () =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            typeof (avrSimulator as any).getCurrentCycles === 'function'
              ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ((avrSimulator as any).getCurrentCycles() as number)
              : // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (((avrSimulator as any).cpu?.cycles ?? 0) as number);

          const clockHz =
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

      // ── AVR register-level fallback when no wire is connected.
      // OCR1AL = 0x88, OCR1AH = 0x89, ICR1L = 0x86, ICR1H = 0x87.
      const OCR1AL = 0x88;
      const OCR1AH = 0x89;
      const ICR1L = 0x86;
      const ICR1H = 0x87;
      const SERVO_PERIOD_US = 20000;

      let rafIdPoll: number | null = null;
      let lastOcr1a = -1;

      const poll = () => {
        if (!avrSimulator.isRunning()) {
          rafIdPoll = requestAnimationFrame(poll);
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cpu = (avrSimulator as any).cpu;
        if (!cpu) {
          rafIdPoll = requestAnimationFrame(poll);
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
            // Prescaler 8 at 16MHz → 0.5µs per tick
            pulseUs = ocr1a * 0.5;
          }

          const clamped = Math.max(MIN_PULSE_US, Math.min(MAX_PULSE_US, pulseUs));
          const angle = Math.round(((clamped - MIN_PULSE_US) / (MAX_PULSE_US - MIN_PULSE_US)) * 180);
          el.angle = angle;
        }

        rafIdPoll = requestAnimationFrame(poll);
      };

      rafIdPoll = requestAnimationFrame(poll);

      return () => {
        if (rafIdPoll !== null) cancelAnimationFrame(rafIdPoll);
      };
    },
  });

  // ─── Buzzer ────────────────────────────────────────────────────────────────
  registry.register('buzzer', {
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
      const pinSIG =
        getArduinoPinHelper('1') ?? getArduinoPinHelper('+') ?? getArduinoPinHelper('POS');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pinManager = (avrSimulator as any).pinManager;

      let audioCtx: AudioContext | null = null;
      let oscillator: OscillatorNode | null = null;
      let gainNode: GainNode | null = null;
      let isSounding = false;
      const el = element as HTMLElement & { playing?: boolean };

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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        // until a user gesture has occurred.
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

      const unsubscribers: (() => void)[] = [];

      if (pinSIG !== null && pinManager) {
        unsubscribers.push(
          pinManager.onPwmChange(pinSIG, (_: number, dc: number) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cpu = (avrSimulator as any).cpu;
            if (dc > 0) {
              const freq = cpu ? getFrequency(cpu) : 440;
              startTone(Math.max(20, Math.min(20000, freq)));
            } else {
              stopTone();
            }
          }),
        );

        // tone() toggles digital HIGH/LOW — start on HIGH, let onPwmChange
        // with dc===0 do the stopping (square-wave pulses fire on every cycle).
        unsubscribers.push(
          pinManager.onPinChange(pinSIG, (_: number, state: boolean) => {
            if (!isSounding && state) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const cpu = (avrSimulator as any).cpu;
              const freq = cpu ? getFrequency(cpu) : 440;
              startTone(Math.max(20, Math.min(20000, freq)));
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
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

/**
 * Register every ComplexParts entry on the given registry. Called once at
 * boot by `src/builtin/registerCoreParts.ts`. Order preserved from the
 * pre-centralization layout so deterministic last-writer-wins semantics
 * hold for SDK-shaped overrides.
 */
export function registerComplexParts(registry: PartRegistry): void {
  registry.registerSdkPart('rgb-led', rgbLedPart);
  registry.registerSdkPart('potentiometer', potentiometerPart);
  registry.registerSdkPart('slide-potentiometer', slidePotentiometerPart);
  registry.registerSdkPart('photoresistor-sensor', photoresistorPart);
  registry.registerSdkPart('analog-joystick', analogJoystickPart);
  registry.registerSdkPart('lcd1602', lcd1602Part);
  registry.registerSdkPart('lcd2004', lcd2004Part);
  registry.registerSdkPart('lcd2002', lcd2002Part);
  registry.registerSdkPart('ili9341', ili9341Part);
  // board-ili9341-cap-touch → same SPI simulation.
  registry.registerSdkPart('ili9341-cap-touch', ili9341Part);

  registerLegacyComplexParts(registry);
}
