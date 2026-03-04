/**
 * PinManager - Manages Arduino pin states and notifies listeners
 *
 * Maps AVR PORT registers to Arduino pin numbers:
 * - PORTB (0x25) → Digital pins 8-13
 * - PORTC (0x28) → Analog pins A0-A5 (14-19)
 * - PORTD (0x2B) → Digital pins 0-7
 *
 * Also supports:
 * - Analog voltage injection (for potentiometers, sensors)
 * - PWM duty cycle tracking (for servos, RGB LEDs, buzzers)
 */

export type PinState = boolean;
export type PinChangeCallback = (pin: number, state: PinState) => void;
export type AnalogCallback = (pin: number, voltage: number) => void;
export type PwmCallback = (pin: number, dutyCycle: number) => void;

export class PinManager {
  private listeners: Map<number, Set<PinChangeCallback>> = new Map();
  private pwmListeners: Map<number, Set<PwmCallback>> = new Map();
  private analogListeners: Map<number, Set<AnalogCallback>> = new Map();
  private pinStates: Map<number, boolean> = new Map();
  private pwmValues: Map<number, number> = new Map();

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
   */
  updatePort(portName: 'PORTB' | 'PORTC' | 'PORTD', newValue: number, oldValue: number = 0) {
    const pinOffset = {
      'PORTB': 8,
      'PORTC': 14,
      'PORTD': 0,
    }[portName];

    for (let bit = 0; bit < 8; bit++) {
      const mask = 1 << bit;
      const oldState = (oldValue & mask) !== 0;
      const newState = (newValue & mask) !== 0;

      if (oldState !== newState) {
        const arduinoPin = pinOffset + bit;
        this.pinStates.set(arduinoPin, newState);

        const callbacks = this.listeners.get(arduinoPin);
        if (callbacks) {
          callbacks.forEach(cb => cb(arduinoPin, newState));
        }

        console.log(`Pin ${arduinoPin} (${portName}${bit}): ${oldState ? 'HIGH' : 'LOW'} → ${newState ? 'HIGH' : 'LOW'}`);
      }
    }
  }

  getPinState(arduinoPin: number): boolean {
    return this.pinStates.get(arduinoPin) || false;
  }

  /**
   * Directly fire pin change callbacks for a specific pin.
   * Used by RP2040Simulator which has individual GPIO listeners instead of PORT registers.
   */
  triggerPinChange(pin: number, state: boolean): void {
    const current = this.pinStates.get(pin);
    if (current === state) return; // no change
    this.pinStates.set(pin, state);
    const callbacks = this.listeners.get(pin);
    if (callbacks) {
      callbacks.forEach(cb => cb(pin, state));
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
   * Called by AVRSimulator each frame when an OCR register changes.
   */
  updatePwm(pin: number, dutyCycle: number): void {
    this.pwmValues.set(pin, dutyCycle);
    const callbacks = this.pwmListeners.get(pin);
    if (callbacks) {
      callbacks.forEach(cb => cb(pin, dutyCycle));
    }
  }

  getPwmValue(pin: number): number {
    return this.pwmValues.get(pin) ?? 0;
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
      callbacks.forEach(cb => cb(arduinoPin, voltage));
    }
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  getListenersCount(): number {
    let count = 0;
    this.listeners.forEach(set => count += set.size);
    return count;
  }

  clearAllListeners() {
    this.listeners.clear();
    this.pwmListeners.clear();
    this.analogListeners.clear();
  }
}
