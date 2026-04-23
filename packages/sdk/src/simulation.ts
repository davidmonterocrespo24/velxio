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
  get(componentId: string): PartSimulation | undefined;
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
