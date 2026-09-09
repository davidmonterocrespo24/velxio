/**
 * PinManager - Manages Arduino pin states and notifies listeners
 *
 * Maps AVR PORT registers to Arduino pin numbers.
 *
 * Arduino Uno / Nano (ATmega328P):
 * - PORTB (0x25) → Digital pins 8-13
 * - PORTC (0x28) → Analog pins A0-A5 (14-19)
 * - PORTD (0x2B) → Digital pins 0-7
 *
 * Arduino Mega 2560 (ATmega2560): uses explicit per-bit pin maps
 * for non-linear port ↔ Arduino-pin relationships.
 *
 * Also supports:
 * - Analog voltage injection (for potentiometers, sensors)
 * - PWM duty cycle tracking (for servos, RGB LEDs, buzzers)
 */

import { requestElectricalResolve } from './spice/electricalResolveHook';
import type { PadDrive, PadEvent, PadPull, PadState } from './line/padEvent';
import { PadBus } from './line/padBus';

export type PinState = boolean;
export type PinChangeCallback = (pin: number, state: PinState) => void;
export type AnalogCallback = (pin: number, voltage: number) => void;
// timeMs (optional) is the precise simulated time of the duty-cycle change
// (cpu.cycles / 16000). Parts that schedule audio/output use it for
// sample-accurate timing instead of the per-frame delivery instant.
export type PwmCallback = (pin: number, dutyCycle: number, timeMs?: number) => void;

export class PinManager {
  private listeners: Map<number, Set<PinChangeCallback>> = new Map();
  private pwmListeners: Map<number, Set<PwmCallback>> = new Map();
  private analogListeners: Map<number, Set<AnalogCallback>> = new Map();
  private pinStates: Map<number, boolean> = new Map();
  private pwmValues: Map<number, number> = new Map();
  // Pins the MCU has driven (digitalWrite / PWM / port-listener fire).
  // Consumed by collectPinStates.ts to emit a SPICE V-source only for
  // real outputs — leaving INPUT pins floating so external sensors
  // (NTC + divider on A0, photoresistor, etc.) don't get clamped to
  // the MCU's idle V-source.
  private outputPins: Set<number> = new Set();
  // Internal pull config the MCU programmed per pin: 0=none, 1=up, 2=down.
  // Used by the SPICE collector to add a weak pull resistor so INPUT_PULLUP
  // inputs read the right idle level (the ESP32's internal pulls live inside
  // QEMU and are otherwise invisible to the netlist).
  private pinPulls: Map<number, 0 | 1 | 2> = new Map();

  // ── Pad drive state (the line contract, simulation/line) ─────────────────
  //
  // What the MCU is DOING to each pad — driving low, driving high, or
  // released — as opposed to `pinStates`, which is the level the wire holds
  // and which the host also writes. A line-owning sensor waits for the guest
  // to RELEASE its wire, a direction change that moves no level, and only
  // this channel carries it. Fed by the simulators through `reportPad`;
  // consumed through `onPadChange`. Never fired by host-side writes.
  private readonly pads = new PadBus();

  /** Subscribe to guest drive-state changes on one pad. */
  onPadChange(pin: number, callback: (e: PadEvent) => void): () => void {
    return this.pads.onPad(pin, callback);
  }

  /** The pad's current drive state (released with no pull until reported). */
  getPad(pin: number): Readonly<PadState> {
    return this.pads.get(pin);
  }

  /**
   * SIMULATOR -> listeners. Report what the guest did to a pad. Fires only on
   * a real change of drive or pull. Does NOT touch `pinStates` or fire
   * `onPinChange` — the level channel keeps its own semantics, and the two
   * must not double fire for a plain digitalWrite.
   */
  reportPad(pin: number, drive: PadDrive, pull: PadPull, cycle: number): void {
    this.pads.report(pin, drive, pull, cycle);
  }

  // ── Digital pin API ──────────────────────────────────────────────────────

  /**
   * Register callback for digital pin state changes.
   * Returns unsubscribe function.
   */
  onPinChange(arduinoPin: number, callback: PinChangeCallback): () => void {
    if (!this.listeners.has(arduinoPin)) {
      this.listeners.set(arduinoPin, new Set());
    }
    this.listeners.get(arduinoPin)!.add(callback);
    return () => {
      this.listeners.get(arduinoPin)?.delete(callback);
    };
  }

  /**
   * Update port register and notify digital pin listeners.
   *
   * @param portName  Human-readable port name for log output (e.g. 'PORTB').
   * @param newValue  New 8-bit port value.
   * @param oldValue  Previous 8-bit port value (default 0).
   * @param pinMap    Optional per-bit Arduino pin numbers (length 8).
   *                  Use -1 for bits that are not exposed as Arduino pins.
   *                  When omitted the legacy Uno/Nano fixed offsets are used:
   *                  PORTB→8, PORTC→14, PORTD→0.
   * @param ddrMask   Optional DDR register value (8 bits). When provided,
   *                  a pin is added to `outputPins` only if its DDR bit is
   *                  1 (the AVR is actively driving it as OUTPUT). Without
   *                  this guard, the PORTx write that activates INPUT_PULLUP
   *                  (DDR=0, PORT=1) falsely marks the pin as MCU output
   *                  and emits an ideal V-source on the SPICE side, fighting
   *                  the real external circuit (button, sensor, pull-down).
   */
  updatePort(
    portName: string,
    newValue: number,
    oldValue: number = 0,
    pinMap?: number[],
    ddrMask?: number,
    cycle: number = -1,
  ) {
    const legacyOffsets: Record<string, number> = { PORTB: 8, PORTC: 14, PORTD: 0 };

    // AVR internal pull-up: a pin configured as INPUT (DDR bit 0) with its PORT
    // bit set enables the ~35k internal pull-up. Surface it as a pin pull so the
    // SPICE netlist stamps the pull resistor and an INPUT_PULLUP input reads the
    // correct idle level (HIGH) under spice-driven inputs — without this, the
    // canonical button-to-GND would float LOW. AVR has no internal pull-down.
    // Runs over all 8 bits (not just changed ones) so DDR/PORT edits both apply.
    //
    // The same pass reports each pad's DRIVE state: DDR set means the MCU is
    // driving the PORT bit's level, DDR clear means the pad is released and the
    // PORT bit is its pull-up. `reportPad` fires only on a real change, so the
    // release of a line (DDR 1 -> 0, PORT unchanged) reaches the line contract
    // even though no level moved — the event a value-only listener never saw.
    if (ddrMask !== undefined) {
      for (let bit = 0; bit < 8; bit++) {
        const mask = 1 << bit;
        const arduinoPin = pinMap ? pinMap[bit] : (legacyOffsets[portName] ?? 0) + bit;
        if (arduinoPin < 0) continue;
        const isInput = (ddrMask & mask) === 0;
        const portBit = (newValue & mask) !== 0;
        this.setPinPull(arduinoPin, isInput && portBit ? 1 : 0);
        this.reportPad(
          arduinoPin,
          isInput ? 'z' : portBit ? 'high' : 'low',
          isInput && portBit ? 1 : 0,
          cycle,
        );
      }
    }

    for (let bit = 0; bit < 8; bit++) {
      const mask = 1 << bit;
      const oldState = (oldValue & mask) !== 0;
      const newState = (newValue & mask) !== 0;

      if (oldState !== newState) {
        const arduinoPin = pinMap ? pinMap[bit] : (legacyOffsets[portName] ?? 0) + bit;
        if (arduinoPin < 0) continue; // unmapped bit

        this.pinStates.set(arduinoPin, newState);
        // Only mark as MCU-output if DDR bit is set (or DDR unknown → legacy).
        if (ddrMask === undefined || (ddrMask & mask) !== 0) {
          this.outputPins.add(arduinoPin);
        }

        const callbacks = this.listeners.get(arduinoPin);
        if (callbacks) {
          callbacks.forEach((cb) => cb(arduinoPin, newState));
        }
      }
    }
  }

  getPinState(arduinoPin: number): boolean {
    return this.pinStates.get(arduinoPin) || false;
  }

  /**
   * Set a single pin state and notify listeners.
   * Alias for triggerPinChange — used by ESP32-C3, RISC-V, and RP2040 simulators.
   *
   * `source` distinguishes MCU GPIO writes (mark pin as output for SPICE)
   * from external actors like buttons or sensor parts (don't mark).
   */
  setPinState(pin: number, state: boolean, source: 'mcu' | 'external' = 'external'): void {
    this.triggerPinChange(pin, state, source);
  }

  /**
   * Directly fire pin change callbacks for a specific pin.
   * Used by RP2040Simulator which has individual GPIO listeners instead of PORT registers.
   */
  triggerPinChange(pin: number, state: boolean, source: 'mcu' | 'external' = 'external'): void {
    // A full-netlist re-solve is only needed when this edge RE-CLASSIFIES the
    // pin (first MCU write → the netlist must grow a V-source for it). Once
    // the pin is a known output, per-edge voltage updates flow through
    // connectMcuEdgesToService (per-pin coalesced alterSource — no rebuild).
    // Requesting a full tick on EVERY edge froze the browser on multiplexed
    // circuits: a 7-segment clock over QEMU emits thousands of GPIO edges per
    // second, and back-to-back rebuild+solve+publish cycles starved the main
    // thread until the sim WebSocket timed out.
    const newlyClassified = source === 'mcu' && !this.outputPins.has(pin);
    const current = this.pinStates.get(pin);
    if (current === state) {
      if (source === 'mcu') this.outputPins.add(pin);
      if (newlyClassified) requestElectricalResolve();
      return;
    }
    this.pinStates.set(pin, state);
    if (source === 'mcu') this.outputPins.add(pin);
    const callbacks = this.listeners.get(pin);
    if (callbacks) {
      callbacks.forEach((cb) => cb(pin, state));
    }
    // WS-backed boards (ESP32 / STM32 / Raspberry Pi) reach the electrical sim
    // ONLY through here; the first write per pin triggers the rebuild that
    // emits its V-source, after which connectMcuEdgesToService owns updates.
    // Gated to 'mcu' so the solver's own input feedback (source 'external')
    // can't create a solve loop.
    if (newlyClassified) requestElectricalResolve();
  }

  /** Pins the MCU has actively driven this session. */
  getOutputPins(): ReadonlySet<number> {
    return this.outputPins;
  }

  /**
   * Record the internal pull the MCU programmed for a pin (from the guest's
   * IO_MUX / pad config): 0 = none, 1 = pull-up, 2 = pull-down. The SPICE
   * collector reads this back via `getPinPull` to stamp a weak resistor.
   */
  /** Fired on pull-state TRANSITIONS (not repeats). Simulators use it to
   * seed the pin input to the pull's resting level the moment the firmware
   * enables it — closing the boot window where INPUT_PULLUP read LOW until
   * the first SPICE solve (~400 ms): 8/8 setup() reads plus the first two
   * loop() passes returned 0 in the deterministic repro, which is exactly
   * the phantom emergency-stop latch of the 2026-07 audit. */
  onPullChange: ((pin: number, pull: 0 | 1 | 2) => void) | null = null;

  setPinPull(pin: number, pull: 0 | 1 | 2): void {
    const prev = this.pinPulls.get(pin) ?? 0;
    if (pull === 0) this.pinPulls.delete(pin);
    else this.pinPulls.set(pin, pull);
    if (prev !== pull) this.onPullChange?.(pin, pull);
  }

  /** Internal pull config for a pin: 0 = none, 1 = pull-up, 2 = pull-down. */
  getPinPull(pin: number): 0 | 1 | 2 {
    return this.pinPulls.get(pin) ?? 0;
  }

  /**
   * Drop only the MCU-output classification (SPICE side). Used by
   * paths that need to forget which pins were driven this session
   * without disturbing the cached pin states or notifying listeners.
   * For the user-facing Stop / Reset / firmware-reload flows use
   * `hardResetPinStates` — those are cold boots and the next Run
   * must start from setup() with every visual cleared.
   */
  resetPinStates(): void {
    this.outputPins.clear();
  }

  /**
   * Hard reset for resetBoard / firmware reload: wipe every cached
   * state AND notify listeners that previously-HIGH pins are now LOW,
   * so stateful displays redraw cleanly to all-off. Reset implies the
   * MCU is restarting from 0 — there's no "resume" race to worry
   * about; the firmware will re-drive every pin from setup() once it
   * boots.
   */
  hardResetPinStates(): void {
    const wereHigh: number[] = [];
    for (const [pin, state] of this.pinStates) {
      if (state) wereHigh.push(pin);
    }
    // Cutting power also stops the PWM peripherals. Their duty is a
    // SEPARATE channel from pinStates and used to survive the reset: on a
    // board whose PWM lives in hardware (ESP32 LEDC reports `ledc_duty`
    // and never toggles the pad at bit rate) nothing here was ever HIGH,
    // so the notify below reached no one and an RGB LED left the run
    // still glowing at its last colour. Notify duty 0 for every pin that
    // was driving, which is what the parts read as "off" — the servo
    // ignores out-of-range duties and holds its angle, as a real one does
    // when the supply drops.
    const wereDriven: number[] = [];
    for (const [pin, duty] of this.pwmValues) {
      if (duty > 0) wereDriven.push(pin);
    }
    this.pinStates.clear();
    this.outputPins.clear();
    this.pinPulls.clear();
    this.pwmValues.clear();
    this.pwmFreqs.clear();
    // A cold boot releases every pad; the firmware re-configures each one from
    // setup(), and the next `reportPad` must see that as a change.
    this.pads.clear();
    for (const pin of wereHigh) {
      const callbacks = this.listeners.get(pin);
      if (callbacks) {
        callbacks.forEach((cb) => cb(pin, false));
      }
    }
    for (const pin of wereDriven) {
      const callbacks = this.pwmListeners.get(pin);
      if (callbacks) {
        callbacks.forEach((cb) => (cb.length >= 3 ? cb(pin, 0, undefined) : cb(pin, 0)));
      }
    }
  }

  // ── PWM duty cycle API ───────────────────────────────────────────────────

  /**
   * Register callback for PWM duty cycle changes on a pin.
   * dutyCycle is 0.0–1.0.
   */
  onPwmChange(pin: number, callback: PwmCallback): () => void {
    if (!this.pwmListeners.has(pin)) {
      this.pwmListeners.set(pin, new Set());
    }
    this.pwmListeners.get(pin)!.add(callback);
    return () => {
      this.pwmListeners.get(pin)?.delete(callback);
    };
  }

  /**
   * Called by AVRSimulator when an OCR register changes (polled sub-frame).
   * timeMs is the precise simulated time of the change for accurate audio.
   */
  updatePwm(pin: number, dutyCycle: number, timeMs?: number): void {
    this.pwmValues.set(pin, dutyCycle);
    if (dutyCycle > 0) this.outputPins.add(pin);
    const callbacks = this.pwmListeners.get(pin);
    if (callbacks) {
      // Backward-compatible dispatch: the original PwmCallback contract is
      // (pin, dutyCycle). Only listeners that actually declare a 3rd parameter
      // (the buzzer, which needs the precise onset time for sample-accurate
      // audio) receive timeMs. Plain 2-arg listeners — and the existing tests
      // that assert toHaveBeenCalledWith(pin, dutyCycle) — see an unchanged
      // 2-arg call instead of a spurious trailing arg.
      callbacks.forEach((cb) => (cb.length >= 3 ? cb(pin, dutyCycle, timeMs) : cb(pin, dutyCycle)));
    }
  }

  getPwmValue(pin: number): number {
    return this.pwmValues.get(pin) ?? 0;
  }

  /** Last known PWM carrier frequency per pin, in Hz. Written by the LEDC
   *  duty handler when the engine reports it; 0 = never reported. Kept as a
   *  side table rather than a new callback parameter so the many existing
   *  two- and three-arg PWM listeners stay untouched. */
  private pwmFreqs: Map<number, number> = new Map();

  setPwmFreq(pin: number, freqHz: number): void {
    this.pwmFreqs.set(pin, freqHz);
  }

  getPwmFreq(pin: number): number {
    return this.pwmFreqs.get(pin) ?? 0;
  }

  // ── Analog voltage API ───────────────────────────────────────────────────

  /**
   * Register callback when external code sets an analog voltage on a pin.
   */
  onAnalogChange(pin: number, callback: AnalogCallback): () => void {
    if (!this.analogListeners.has(pin)) {
      this.analogListeners.set(pin, new Set());
    }
    this.analogListeners.get(pin)!.add(callback);
    return () => {
      this.analogListeners.get(pin)?.delete(callback);
    };
  }

  /**
   * Inject a simulated analog voltage (0–5V) on an Arduino pin.
   * Notifies any registered analog listeners.
   */
  setAnalogVoltage(arduinoPin: number, voltage: number): void {
    const callbacks = this.analogListeners.get(arduinoPin);
    if (callbacks) {
      callbacks.forEach((cb) => cb(arduinoPin, voltage));
    }
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  getListenersCount(): number {
    let count = 0;
    this.listeners.forEach((set) => (count += set.size));
    return count;
  }

  clearAllListeners() {
    this.listeners.clear();
    this.pwmListeners.clear();
    this.analogListeners.clear();
    this.outputPins.clear();
  }
}
