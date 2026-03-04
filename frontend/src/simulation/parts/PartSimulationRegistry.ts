import { AVRSimulator } from '../AVRSimulator';
import { RP2040Simulator } from '../RP2040Simulator';

export type AnySimulator = AVRSimulator | RP2040Simulator;

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
     * @returns A cleanup function to remove event listeners when simulation stops
     */
    attachEvents?: (
        element: HTMLElement,
        simulator: AnySimulator,
        getArduinoPinHelper: (componentPinName: string) => number | null
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
