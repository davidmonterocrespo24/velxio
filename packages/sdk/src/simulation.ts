/**
 * Simulation extension surface.
 *
 * `PartSimulation` is what a plugin implements to make a component interactive
 * under a running microcontroller simulation. It replaces the ad-hoc
 * `PartSimulationLogic` interface that used to live in the Core.
 *
 * The host calls `onPinStateChange` when a connected MCU pin toggles, and
 * `attachEvents` once when the simulator starts (return a teardown fn).
 */

import type { PinState } from './events';
import type { Disposable } from './components';
export type { PinState };

/**
 * Narrow simulator handle passed to parts. Plugins MUST NOT cast this to the
 * full host type — it is intentionally small so we can stabilize the contract
 * independent of the Core's internal simulator implementation.
 */
export interface SimulatorHandle {
  /** True if the sim loop is currently running. */
  isRunning(): boolean;
  /**
   * Force-set a pin on the MCU side. Use sparingly — plugins that mutate MCU
   * state need the `simulator.pins.write` permission.
   */
  setPinState(pin: number, state: boolean): void;
  /**
   * Resolve a component-side pin name to the Arduino-board pin number it
   * is wired to, or `null` when no wire exists.
   */
  getArduinoPin(componentPinName: string): number | null;
  /** The stable id of the component instance this call is for. */
  readonly componentId: string;
  /**
   * Subscribe to digital pin transitions on this component's own pin
   * (resolved via the handle's `componentId` + `getArduinoPin(pinName)`).
   *
   * Returns a `Disposable` — call `.dispose()` to unsubscribe. The subscription
   * is auto-released when the host tears the part down (parent `attachEvents`
   * cleanup), but plugins that wire ad-hoc subscriptions in long-lived
   * activation hooks should manage the disposable themselves.
   *
   * If the pin is not wired (`getArduinoPin(pinName) === null`), the callback
   * is never invoked and `dispose()` is a no-op. The subscription is **not**
   * retroactively wired if the user later connects a wire — plugins that
   * need that should re-subscribe on `events.on('wire:connect', …)`.
   *
   * Why this is on the handle (and not raw `PinManager.onPinChange`):
   *   1. Plugins author against component-pin **names** (`'DOUT'`, `'CS'`),
   *      not against board pin numbers — the host owns the wire-graph
   *      lookup and the API mirrors that.
   *   2. The PinManager surface intentionally stays out of the SDK to keep
   *      the contract minimal and to centralize permission gating.
   */
  onPinChange(pinName: string, callback: (state: PinState) => void): Disposable;

  /**
   * Subscribe to PWM duty-cycle changes on one of this component's pins.
   *
   * The callback fires every time the MCU writes a new OCR value (for AVR) or
   * the platform's PWM peripheral updates the channel backing this pin. `duty`
   * is a float in `[0, 1]` — 0 is "always low", 1 is "always high", 0.5 is
   * 50% duty cycle.
   *
   * Permission: `simulator.pwm.read` (Low risk — read-only observer).
   *
   * Returns a `Disposable`. If the component pin isn't wired when `onPwmChange`
   * is called, the subscription is a **no-op** and `dispose()` does nothing.
   * Same late-arriving-wire rule as `onPinChange`.
   *
   * Design note: the frequency of the PWM signal is not part of the callback.
   * Callers that need it should read it at `attach` time from their component
   * metadata — the host does not track a per-pin frequency independently of
   * duty. This keeps the callback tight for hot-path consumers (servos fire
   * at 50 Hz, RGB LEDs at up to 100 kHz).
   */
  onPwmChange(pinName: string, callback: (duty: number) => void): Disposable;

  /**
   * Subscribe to every byte the MCU's hardware SPI peripheral transmits.
   *
   * The callback receives each byte *after* the MCU has completed its shift
   * out — the part is expected to respond on the MISO/MOSI pair in the next
   * transaction (which the host arranges separately for you; plugins are
   * currently observation-only).
   *
   * Permission: `simulator.spi.read` (Low risk — read-only observer).
   *
   * Returns a `Disposable`. Subscriptions stack — multiple parts can observe
   * the same bus. Host guarantees fault-isolated dispatch: a throwing listener
   * does not block the others.
   *
   * Today the platform has a single hardware SPI bus per MCU (AVR SPI0, RP2040
   * SPI0), so there is no bus selector. If multi-bus support is added later,
   * the signature will grow an optional `busId` parameter — existing callers
   * will be the default bus and keep working.
   *
   * If the running board has no SPI peripheral (ESP32 software SPI,
   * not-yet-started simulation), the subscription is a no-op and `dispose()`
   * does nothing.
   */
  onSpiTransmit(callback: (byte: number) => void): Disposable;

  /**
   * Schedule a pin transition on this component's pin at a precise future
   * cycle count — the MCU's scheduler runs the change between instructions,
   * giving cycle-accurate protocol timing (DHT22 handshake, HC-SR04 echo
   * pulse, IR receiver NEC decode).
   *
   * `cyclesFromNow` is **relative** to `cyclesNow()`; plugins never need to
   * call `cyclesNow()` themselves just to add to it. A negative or zero
   * value is treated as "as soon as possible".
   *
   * Permission: `simulator.pins.write` (same gate as `setPinState` — this is
   * a temporal variant of that capability, not a new one).
   *
   * No-op when the pin isn't wired or the board doesn't support scheduling
   * (e.g. ESP32 — scheduling is an AVR-specific cycle-accurate feature).
   */
  schedulePinChange(pinName: string, state: boolean, cyclesFromNow: number): void;

  /**
   * Register this component as a virtual I²C slave at `addr`. The host routes
   * every `Wire.beginTransmission(addr)` / `Wire.requestFrom(addr, n)` to the
   * registered `handler`, which participates in the bus protocol synchronously
   * (return `true` from `writeByte` for ACK, return bytes from `readByte`).
   *
   * Permission: `simulator.i2c.write` (High risk — the slave drives the bus,
   * which affects MCU-visible state in a way observation can't).
   *
   * Returns a `Disposable`. Calling `dispose()` removes the slave from the
   * bus — subsequent `connectToSlave(addr, ...)` will NACK as if no device
   * were there. Two slaves at the same address is "last writer wins" (the
   * later `registerI2cSlave` displaces the earlier one until it disposes).
   *
   * If the running board doesn't have an I²C bus (not-yet-started simulation,
   * platforms without TWI peripheral), the registration is a no-op and
   * `dispose()` does nothing.
   */
  registerI2cSlave(addr: number, handler: I2cSlaveHandler): Disposable;

  /**
   * Current MCU cycle count — monotonically non-decreasing throughout the
   * simulation run, reset to 0 on simulator reset. Used by timing-sensitive
   * parts (HC-SR04 distance calculation, DHT22 bit timing, IR decode) that
   * need a common time base.
   *
   * O(1), no permission required (read-only getter, no observation capability).
   *
   * Returns 0 when the simulation isn't running — same contract as
   * `getCurrentCycles()` on the host.
   */
  cyclesNow(): number;

  /**
   * MCU clock frequency in Hz. Stable for the lifetime of the simulator run
   * (no support for DVFS / clock scaling in any current board). Used with
   * `cyclesNow()` to convert cycles to wall-clock time for protocol timing.
   *
   * Examples: 16_000_000 for AVR/Arduino Uno, 133_000_000 for RP2040,
   * 240_000_000 for ESP32.
   *
   * O(1), no permission required.
   */
  clockHz(): number;

  /**
   * Inject an analog voltage on the ADC channel backing a component pin.
   * The value is in **volts** — the host converts to the right raw ADC
   * sample depending on the board (10-bit AVR, 12-bit RP2040, 12-bit ESP32
   * at 3.3 V reference). Plugins stay board-agnostic.
   *
   * Permission: `simulator.analog.write` (High risk — the plugin can drive
   * any ADC reading the sketch makes, same class of capability as
   * `simulator.pins.write`).
   *
   * No-op when the pin isn't wired to an analog-capable pin or the running
   * board lacks an ADC surface. Values outside the board's Vref range are
   * clamped by the host adapter; plugins do not need to clamp themselves.
   *
   * Example (potentiometer at 2.5 V on A0):
   * ```ts
   * handle.setAnalogValue('SIG', 2.5);
   * ```
   */
  setAnalogValue(pinName: string, volts: number): void;

  /**
   * Subscribe to value updates from the `SensorControlPanel` (the user-facing
   * debug panel where sliders, toggles and joysticks feed values into
   * simulated sensors). The callback receives a `Record<string, number |
   * boolean>` whose keys are whatever the component declares — e.g. DHT22
   * uses `{ temperature, humidity }`, tilt-switch `{ toggle }`, MPU6050
   * `{ accelX, accelY, accelZ, gyroX, gyroY, gyroZ }`.
   *
   * Permission: `simulator.sensors.read` (Low risk — read-only observation
   * of user input; no MCU-side effect without a separate `setAnalogValue`
   * or `setPinState` call).
   *
   * Returns a `Disposable` that unregisters the listener from the panel.
   * Exactly one listener per component instance — a later `onSensorControl-
   * Update` call replaces the previous. The control panel itself is opt-in
   * UI; until the user opens it, the callback is never invoked.
   */
  onSensorControlUpdate(
    handler: (values: Record<string, number | boolean>) => void,
  ): Disposable;

  /**
   * Register this component as a virtual SPI slave on the MCU's hardware SPI
   * bus. Unlike `onSpiTransmit` (observer only), a slave **responds** with
   * the next byte to be shifted back to the master — required for chips
   * that drive MISO (ILI9341 TFT readback, microSD card, flash memory).
   *
   * Permission: `simulator.spi.write` (High risk — the slave feeds bytes
   * back to the master, which the sketch interprets as real device data).
   *
   * Not stackable: a single SPI bus has exactly one active slave (selected
   * via CS lines that the host doesn't yet model per-slave). A second
   * `registerSpiSlave` call displaces the previous slave — the previous
   * handler receives a `stop()` call (if defined) before the replacement
   * takes over, and a warning is logged.
   *
   * No-op when the running board has no SPI peripheral (ESP32 software
   * SPI, simulation not yet started).
   *
   * Example (ILI9341 shim):
   * ```ts
   * handle.registerSpiSlave({
   *   onByte(master) {
   *     cmdBuffer.push(master);
   *     return statusByte; // shifted back to MOSI on the next transfer
   *   },
   *   stop() { resetChipSelect(); },
   * });
   * ```
   */
  registerSpiSlave(handler: SpiSlaveHandler): Disposable;

  /**
   * Identifies the board family the current simulator belongs to. Useful
   * for parts that need board-specific calibration (e.g. servo PWM decode
   * on AVR vs RP2040 vs ESP32 bridge). Read-only, no permission required
   * — this is a passive identifier, not an observation capability.
   *
   * Plugins SHOULD prefer feature-probing via the handle's typed methods
   * (no-op Disposables on unsupported surfaces) over branching on
   * `boardPlatform`. Use this only when the behavior genuinely differs
   * by board (PWM frequency interpretation, ADC reference voltage).
   */
  readonly boardPlatform: 'avr' | 'rp2040' | 'esp32' | 'unknown';
}

/**
 * Handler for a virtual I²C slave registered via
 * `SimulatorHandle.registerI2cSlave`. The host invokes these synchronously
 * from within the TWI transaction state machine — implementations must
 * return promptly and not do async work.
 */
export interface I2cSlaveHandler {
  /**
   * Called when the MCU writes a byte after addressing this slave for write.
   * Return `true` to ACK (the master will keep sending), `false` to NACK
   * (the master will stop).
   */
  writeByte(value: number): boolean;
  /**
   * Called when the MCU requests a byte from this slave in read mode. Return
   * the data byte (0–255). If the register pointer is out of range the
   * slave may return `0xff` (the canonical open-drain default).
   */
  readByte(): number;
  /** Optional: called on a bus STOP condition so the slave can reset per-transaction state (register pointer, etc.). */
  stop?(): void;
}

/**
 * Handler for a virtual SPI slave registered via
 * `SimulatorHandle.registerSpiSlave`. The host invokes `onByte` from
 * within the MCU's SPI transfer state machine, synchronously — the
 * return value is shifted back to the master on the same transfer.
 */
export interface SpiSlaveHandler {
  /**
   * Called for every byte the MCU shifts out on MOSI. `master` is the
   * outgoing byte. The return value is the byte the host presents on
   * MISO for the same transfer — return `0xff` (the open-drain default)
   * if the slave has nothing to send.
   */
  onByte(master: number): number;
  /**
   * Optional: called when a burst terminates (today: when a subsequent
   * `registerSpiSlave` displaces this one, so the outgoing slave can
   * reset CS-driven state). Future hardware CS modelling will invoke
   * this on the CS-HIGH transition.
   */
  stop?(): void;
}

/**
 * Delegated DOM event kinds a worker plugin can subscribe to for its
 * component's root element. The host installs a single listener per kind
 * on the main thread, captures the position in the component's local SVG
 * coordinate space, and forwards a `DelegatedPartEvent` over RPC to the
 * plugin's `onEvent` callback.
 *
 * Why these six and not the full DOM catalog: they cover the interactive
 * patterns every built-in sensor part uses today (pushbutton click,
 * potentiometer drag, slide-switch hover-hint, context-menu block).
 * Opening the list further grows the worker-host trust surface — CORE-006b
 * step5 starts conservative.
 */
export type PartEventKind =
  | 'click'
  | 'mousedown'
  | 'mouseup'
  | 'mouseenter'
  | 'mouseleave'
  | 'contextmenu';

/**
 * One delegated UI event forwarded from the main thread to a worker
 * plugin's `PartSimulation.onEvent` handler. `x` / `y` are in the
 * component's local coordinate space (relative to the top-left of the
 * element the host attached listeners to) so the plugin can do hit-
 * testing without needing access to the live DOM or the canvas CTM.
 *
 * `button` matches the DOM convention (0 = main / left, 2 = secondary /
 * right). `shiftKey`, `altKey`, `ctrlKey`, `metaKey` follow the standard
 * `MouseEvent` booleans.
 *
 * The payload is intentionally flat and JSON-serialisable so it can
 * survive `postMessage` / `structuredClone` without loss.
 */
export interface DelegatedPartEvent {
  readonly type: PartEventKind;
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly pluginId?: string;
}

/**
 * Lifecycle + event contract that each part can implement. Every hook is
 * optional — implement only the ones you need.
 *
 * Two ways to receive user interaction:
 *
 *   1. **Main-thread `attachEvents`** — the historical form. Receives a
 *      live DOM element and the `SimulatorHandle`; plugin wires its own
 *      DOM listeners and returns a teardown function. Works only for
 *      plugins loaded in-process; worker-sandboxed plugins cannot use
 *      this (DOM isn't reachable across `postMessage`).
 *
 *   2. **Declarative `events` + `onEvent`** — worker-safe alternative.
 *      The plugin declares the event kinds it cares about and the host
 *      installs a single delegated listener per kind on the main thread,
 *      forwarding payloads to `onEvent` as `DelegatedPartEvent`. No DOM
 *      access in the plugin; each payload is a plain JSON object.
 *
 * Authors pick whichever fits their runtime. If both are supplied the
 * host installs the delegated listeners AND calls `attachEvents`; the
 * two mechanisms do not interfere.
 */
export interface PartSimulation {
  /**
   * Fired when a pin on the component changes due to an MCU write, an SPI
   * peer, or another plugin. `element` is the DOM host for the component.
   */
  onPinStateChange?: (pinName: string, state: boolean, element: HTMLElement) => void;

  /**
   * Called once when the sim starts. Attach DOM listeners and kick off any
   * periodic work. Return a teardown function — the host calls it on stop.
   *
   * Main-thread-only. Plugins running inside the worker sandbox should
   * use `events` + `onEvent` instead.
   */
  attachEvents?: (element: HTMLElement, simulator: SimulatorHandle) => () => void;

  /**
   * Event kinds the host should delegate to this part. When set, the host
   * attaches one listener per kind on the part's root element and forwards
   * matching events to `onEvent`.
   *
   * Has no effect unless `onEvent` is also provided — the host does not
   * install listeners it has nowhere to route.
   */
  readonly events?: ReadonlyArray<PartEventKind>;

  /**
   * Worker-safe event sink. Called by the host for every DOM event of a
   * kind listed in `events`. The payload is a plain JSON object; plugins
   * MUST NOT hold a reference past the call (the host is free to reuse
   * the allocation).
   *
   * Exceptions thrown from `onEvent` are caught, logged via the host
   * logger, and swallowed — a buggy plugin never blocks sibling parts.
   */
  onEvent?: (event: DelegatedPartEvent) => void;
}

/**
 * Per-component registry entry. Plugins call `registry.register(id, logic)`
 * from `activate()`.
 */
export interface PartSimulationRegistry {
  register(componentId: string, simulation: PartSimulation): {
    dispose(): void;
  };
  /**
   * Compact high-level authoring shape: the plugin declares the set of pins
   * the component cares about, and an `attach(element, api)` that receives
   * a richer `PartSimulationAPI` instead of the raw `SimulatorHandle`.
   *
   * The host builds the `PartSimulationAPI` by composing `SimulatorHandle`
   * with the plugin's event subscriptions (`serial:tx` / `i2c:transfer`),
   * registers the result as an ordinary `PartSimulation` under the hood,
   * and returns a `Disposable` that tears the whole thing down.
   *
   * Permission requirements:
   *   - always: `simulator.pins.read` (same as `register()`)
   *   - `api.pin(n).set(...)` call-time: `simulator.pins.write`
   *
   * See `defineHighLevelPart` for the authoring helper.
   */
  registerHighLevel(
    componentId: string,
    definition: HighLevelPartSimulation,
  ): import('./components').Disposable;
  get(componentId: string): PartSimulation | undefined;
}

/**
 * Three-valued pin level as seen by a high-level part. `'floating'` is the
 * initial value before the first transition is observed, and also covers
 * high-Z (`'z'`) and unknown (`'x'`) raw `PinState`s when translated.
 */
export type PartPinLevel = 'low' | 'high' | 'floating';

/**
 * I2C transaction observed on the bus, delivered to a high-level part's
 * `api.i2c.onTransfer` listener. Payload shape mirrors the `i2c:transfer`
 * event from the bus catalog — re-exported here for discoverability from
 * authoring code that only imports `@velxio/sdk`.
 */
export interface I2CTransferEvent {
  readonly addr: number;
  readonly direction: 'read' | 'write';
  readonly data: Uint8Array;
  readonly stop: boolean;
}

/**
 * Per-pin view given to high-level parts. `state` is the last level the
 * host observed (initialized to `'floating'`); `onChange` fires on every
 * transition with the new level. `set(...)` forces the pin from the part's
 * side — e.g. a pushbutton releasing the pin to HIGH — and is gated on
 * `simulator.pins.write` at call time (throws `PermissionDeniedError`).
 *
 * `onChange` returns a `Disposable`; keep the handle and call `dispose()`
 * in the attach teardown. The host also auto-disposes every subscription
 * when the part is torn down.
 */
export interface PartPinAPI {
  readonly state: PartPinLevel;
  onChange(fn: (state: PartPinLevel) => void): import('./components').Disposable;
  set(state: 'low' | 'high'): void;
}

/**
 * Serial helper surface. Today the host only exposes the observe side
 * (`onRead` receives every byte the MCU transmits on UART0/TX). The write
 * side (`api.serial.write(data)`) that would inject bytes into the MCU's
 * RX pipe is reserved for a future ticket — this interface matches the
 * planned shape so plugins authored against today's surface keep working.
 *
 * `onRead` returns a `Disposable` — same teardown contract as `PartPinAPI.onChange`.
 */
export interface PartSerialAPI {
  onRead(fn: (data: Uint8Array) => void): import('./components').Disposable;
}

/**
 * I2C helper surface. `onTransfer` fires for every transaction the host
 * observes on the bus; the part is responsible for filtering by address
 * if it only cares about its own. Like `serial`, the write side is
 * reserved for a future ticket.
 */
export interface PartI2CAPI {
  onTransfer(fn: (event: I2CTransferEvent) => void): import('./components').Disposable;
}

/**
 * High-level API handed to a `HighLevelPartSimulation.attach(element, api)`
 * callback. Strictly richer than `SimulatorHandle` but built on top of it
 * — the host constructs this per-attachment, closing over the handle, the
 * event bus, and a small bit of tracked state (current pin levels).
 *
 * Callers MUST NOT stash `api` past the return of `attach(...)` — the
 * closures it carries reference simulator state that is torn down between
 * runs. Every ephemeral subscription (`onChange`, `onRead`, `onTransfer`)
 * returns a `Disposable` whose `dispose()` the plugin is expected to call
 * in the teardown function that `attach` returns.
 */
export interface PartSimulationAPI {
  /**
   * Look up the high-level surface for one of the pins declared in
   * `HighLevelPartSimulation.pins`. Calling `pin(name)` with a name that
   * wasn't declared throws — declare every pin you intend to touch.
   */
  pin(name: string): PartPinAPI;
  readonly serial?: PartSerialAPI;
  readonly i2c?: PartI2CAPI;
}

/**
 * High-level authoring shape for a part simulation. Declare the pins you
 * care about so the host can pre-wire state tracking + permission gating,
 * and implement a single `attach(element, api)` that returns a teardown
 * function. `attach` is called once per simulation start.
 *
 * ```ts
 * import { defineHighLevelPart } from '@velxio/sdk';
 * export const button = defineHighLevelPart({
 *   pins: ['SIG', 'GND'],
 *   attach(element, api) {
 *     const onDown = () => api.pin('SIG').set('low');
 *     const onUp = () => api.pin('SIG').set('high');
 *     element?.addEventListener('mousedown', onDown);
 *     element?.addEventListener('mouseup', onUp);
 *     return () => {
 *       element?.removeEventListener('mousedown', onDown);
 *       element?.removeEventListener('mouseup', onUp);
 *     };
 *   },
 * });
 * ```
 *
 * Register via `ctx.partSimulations.registerHighLevel(id, def)`.
 */
export interface HighLevelPartSimulation {
  /**
   * The component-side pin names this part cares about. Every entry gets
   * its current state tracked and exposed via `api.pin(name).state`.
   * Pin names that aren't listed here throw at `api.pin(name)` call time —
   * authors should declare everything they intend to touch.
   */
  readonly pins: ReadonlyArray<string>;
  /**
   * Attach DOM listeners / start per-part work. Return a teardown function;
   * the host calls it on simulator stop and on plugin unload. `element`
   * may be `null` during tests or when the component hasn't mounted yet.
   */
  attach(element: HTMLElement | null, api: PartSimulationAPI): () => void;
}

/**
 * Identity helper for `HighLevelPartSimulation` records with full type
 * inference and no runtime wrapper. Mirrors `definePartSimulation`.
 */
export function defineHighLevelPart<T extends HighLevelPartSimulation>(part: T): T {
  return part;
}

/**
 * A subscription callback for observing pin state from userland.
 * Use via `ctx.simulator.onPinChange()`.
 */
export type PinChangeListener = (ev: {
  readonly componentId: string;
  readonly pinName: string;
  readonly state: PinState;
  readonly timestamp: number;
}) => void;

/**
 * Identity helper for authoring `PartSimulation` records with full type
 * inference and without a runtime wrapper. Mirrors `definePlugin` /
 * `defineComponent` so authors can use a uniform style:
 *
 * ```ts
 * import { definePartSimulation } from '@velxio/sdk';
 * export const ledPart = definePartSimulation({
 *   onPinStateChange(pinName, state, element) { ... },
 * });
 * ```
 */
export function definePartSimulation<T extends PartSimulation>(part: T): T {
  return part;
}
