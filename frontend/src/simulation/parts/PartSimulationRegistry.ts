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

class PartRegistry {
  private parts: Map<string, PartSimulationLogic> = new Map();

  register(metadataId: string, logic: PartSimulationLogic) {
    this.parts.set(metadataId, logic);
  }

  get(metadataId: string): PartSimulationLogic | undefined {
    return this.parts.get(metadataId);
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
