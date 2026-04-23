import type { PartSimulation as SdkPartSimulation, SimulatorHandle } from '@velxio/sdk';
import { AVRSimulator } from '../AVRSimulator';
import { RP2040Simulator } from '../RP2040Simulator';

/** Any simulator that components can interact with (AVR, RP2040, or ESP32 bridge shim). */
export type AnySimulator =
  | {
      setPinState(pin: number, state: boolean): void;
      isRunning(): boolean;
      pinManager: import('../PinManager').PinManager;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    }
  | AVRSimulator
  | RP2040Simulator;

/**
 * Interface for simulation logic mapped to a specific wokwi-element
 */
export interface PartSimulationLogic {
  /**
   * Called when a digital pin connected to this part changes state.
   * Useful for output components (LEDs, buzzers, etc).
   *
   * @param pinName The name of the pin on the component that changed
   * @param state The new digital state (true = HIGH, false = LOW)
   * @param element The DOM element of the wokwi component
   */
  onPinStateChange?: (pinName: string, state: boolean, element: HTMLElement) => void;

  /**
   * Called when the simulation starts to attach events or setup periodic tasks.
   * Useful for input components (buttons, potentiometers) or complex components (servos).
   *
   * @param element The DOM element of the wokwi component
   * @param avrSimulator The running simulator instance
   * @param getArduinoPinHelper Function to find what Arduino pin is connected to a specific component pin
   * @param componentId The unique ID of this component instance (used by SensorUpdateRegistry)
   * @returns A cleanup function to remove event listeners when simulation stops
   */
  attachEvents?: (
    element: HTMLElement,
    simulator: AnySimulator,
    getArduinoPinHelper: (componentPinName: string) => number | null,
    componentId: string,
  ) => () => void;
}

/**
 * Handle returned by `register()`/`registerSdkPart()` — calling `dispose()`
 * removes the part again, but only if no later `register()` has replaced
 * it (last-writer-wins is intentional for plugin overrides).
 */
export interface PartSimulationHandle {
  dispose(): void;
}

class PartRegistry {
  private parts: Map<string, PartSimulationLogic> = new Map();

  /**
   * Register the legacy (host-shaped) part simulation. Returns a handle
   * for symmetry with the SDK contract — built-ins generally keep their
   * registration for the lifetime of the app and don't bother disposing.
   */
  register(metadataId: string, logic: PartSimulationLogic): PartSimulationHandle {
    const previous = this.parts.get(metadataId);
    this.parts.set(metadataId, logic);
    return {
      dispose: () => {
        if (this.parts.get(metadataId) !== logic) return;
        if (previous === undefined) {
          this.parts.delete(metadataId);
        } else {
          this.parts.set(metadataId, previous);
        }
      },
    };
  }

  get(metadataId: string): PartSimulationLogic | undefined {
    return this.parts.get(metadataId);
  }

  /** True if this id has a part registered. */
  has(metadataId: string): boolean {
    return this.parts.has(metadataId);
  }

  /** Stable list of every registered part id (sorted, for diagnostics). */
  list(): string[] {
    return [...this.parts.keys()].sort();
  }

  /** Number of registered parts. */
  size(): number {
    return this.parts.size;
  }

  /**
   * Register a SDK-shaped `PartSimulation` (the contract third-party
   * plugins consume). The SDK uses a smaller `attachEvents(element,
   * SimulatorHandle)` signature than the host's 4-arg legacy form, so
   * this method wraps it: the host packs `componentId`, `getArduinoPin`,
   * and the live simulator into a `SimulatorHandle` before invoking the
   * plugin's hook.
   *
   * Built-ins use the legacy `register()` directly. Plugins should never
   * touch `register()` — `ctx.simulator.parts.register()` (future
   * SDK-002 work) will route through here.
   */
  registerSdkPart(
    metadataId: string,
    sdkPart: SdkPartSimulation,
  ): PartSimulationHandle {
    const adapted: PartSimulationLogic = {};
    if (sdkPart.onPinStateChange) {
      adapted.onPinStateChange = sdkPart.onPinStateChange;
    }
    if (sdkPart.attachEvents) {
      const sdkAttach = sdkPart.attachEvents;
      adapted.attachEvents = (element, simulator, getArduinoPin, componentId) => {
        const handle: SimulatorHandle = {
          componentId,
          isRunning: () => simulator.isRunning(),
          setPinState: (pin, state) => simulator.setPinState(pin, state),
          getArduinoPin,
          onPinChange: (pinName, callback) => {
            // Resolve once at subscription time. If the pin isn't wired now,
            // the subscription is a no-op — plugins that need late-arriving
            // wires should re-subscribe on `events.on('wire:connect', …)`.
            const arduinoPin = getArduinoPin(pinName);
            if (arduinoPin === null) {
              return { dispose: () => {} };
            }
            const unsubscribe = simulator.pinManager.onPinChange(
              arduinoPin,
              (_pin, state) => callback(state),
            );
            return { dispose: unsubscribe };
          },
        };
        return sdkAttach(element, handle);
      };
    }
    return this.register(metadataId, adapted);
  }

  /** Test-only — drop every part. */
  __clearForTests(): void {
    this.parts.clear();
  }
}

export const PartSimulationRegistry = new PartRegistry();

// Import store explicitly inside a function to avoid circular dependencies if any,
// but since we just need it at runtime, we can import it at the top or dynamically.
import { useSimulatorStore } from '../../store/useSimulatorStore';

PartSimulationRegistry.register('raspberry-pi-3', {
  onPinStateChange: (pinName: string, state: boolean, _element: HTMLElement) => {
    // When Arduino changes a pin connected to Raspberry Pi, forward to backend
    useSimulatorStore.getState().sendRemotePinEvent(pinName, state ? 1 : 0);
  },
});
