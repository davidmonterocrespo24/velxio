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
}

/**
 * Lifecycle + event contract that each part can implement. Every hook is
 * optional — implement only the ones you need. Return a teardown function
 * from `attachEvents` if you attach DOM listeners.
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
   */
  attachEvents?: (element: HTMLElement, simulator: SimulatorHandle) => () => void;
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
