import type {
  I2cSlaveHandler,
  PartSimulation as SdkPartSimulation,
  SimulatorHandle,
  SpiSlaveHandler,
} from '@velxio/sdk';
import { AVRSimulator } from '../AVRSimulator';
import { RP2040Simulator } from '../RP2040Simulator';
import { setAdcVoltage } from './partUtils';
import {
  registerSensorUpdate,
  unregisterSensorUpdate,
} from '../SensorUpdateRegistry';

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

export class PartRegistry {
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
            if (arduinoPin === null || !simulator.pinManager) {
              return { dispose: () => {} };
            }
            const unsubscribe = simulator.pinManager.onPinChange(
              arduinoPin,
              // PinManager fires `(pin, boolean)`, but the SDK contract types
              // the callback as `(state: PinState)` where `PinState = 0 | 1 |
              // 'z' | 'x'`. Coerce at the boundary so plugins author against
              // the public type.
              (_pin, state) => callback(state ? 1 : 0),
            );
            return { dispose: unsubscribe };
          },
          onPwmChange: (pinName, callback) => {
            // Same late-arriving-wire rule as `onPinChange`: resolve once,
            // no-op Disposable when the wire isn't present.
            const arduinoPin = getArduinoPin(pinName);
            if (arduinoPin === null || !simulator.pinManager) {
              return { dispose: () => {} };
            }
            const unsubscribe = simulator.pinManager.onPwmChange(
              arduinoPin,
              (_pin, duty) => callback(duty),
            );
            return { dispose: unsubscribe };
          },
          onSpiTransmit: (callback) => {
            // AVRSPI exposes a single `onTransmit` property rather than a
            // subscriber list, so we build a small fan-out over it. If the
            // host simulator doesn't own an SPI peripheral (ESP32, or the
            // sim hasn't started yet), the subscription degrades to a no-op.
            const spi = simulator.spi as
              | { onTransmit?: ((value: number) => void) | null }
              | null
              | undefined;
            if (!spi) {
              return { dispose: () => {} };
            }
            const previous = spi.onTransmit ?? null;
            const wrapped = (byte: number) => {
              if (previous) {
                try {
                  previous(byte);
                } catch {
                  // Previous subscriber threw — isolate so `callback` still fires.
                }
              }
              try {
                callback(byte);
              } catch {
                // Plugin callback threw — isolate so subsequent bytes keep flowing.
              }
            };
            spi.onTransmit = wrapped;
            return {
              dispose: () => {
                // Only restore if we're still the active handler. A later
                // `onSpiTransmit` call layers its own wrapper around ours;
                // skipping the restore when that happened avoids tearing
                // down the later subscriber mid-stream.
                if (spi.onTransmit === wrapped) {
                  spi.onTransmit = previous;
                }
              },
            };
          },
          schedulePinChange: (pinName, state, cyclesFromNow) => {
            const arduinoPin = getArduinoPin(pinName);
            if (arduinoPin === null) return;
            if (typeof simulator.schedulePinChange !== 'function') return;
            if (typeof simulator.getCurrentCycles !== 'function') return;
            const delta = Math.max(0, cyclesFromNow | 0);
            const now = simulator.getCurrentCycles() as number;
            simulator.schedulePinChange(arduinoPin, state, now + delta);
          },
          registerI2cSlave: (addr, handler) => {
            // AVR exposes the bus via `i2cBus.addDevice(device)` where device
            // matches the `I2CDevice` interface — superset of the SDK's
            // `I2cSlaveHandler`. Adapt by pinning `address`.
            const bus = simulator.i2cBus as
              | {
                  addDevice(d: { address: number } & I2cSlaveHandler): void;
                  removeDevice(a: number): void;
                }
              | null
              | undefined;
            if (!bus) {
              return { dispose: () => {} };
            }
            const device = {
              address: addr,
              writeByte: handler.writeByte.bind(handler),
              readByte: handler.readByte.bind(handler),
              stop: handler.stop ? handler.stop.bind(handler) : undefined,
            };
            bus.addDevice(device);
            return {
              dispose: () => {
                bus.removeDevice(addr);
              },
            };
          },
          cyclesNow: () =>
            typeof simulator.getCurrentCycles === 'function'
              ? (simulator.getCurrentCycles() as number)
              : 0,
          clockHz: () =>
            typeof simulator.getClockHz === 'function'
              ? (simulator.getClockHz() as number)
              : 16_000_000,
          setAnalogValue: (pinName, volts) => {
            // Resolve once. `setAdcVoltage` already knows the per-board
            // dispatch (AVR via ADC channelValues, RP2040 via setADCValue,
            // ESP32 via the shim's setAdcVoltage). Unwired or non-analog
            // pins return false and we no-op.
            const arduinoPin = getArduinoPin(pinName);
            if (arduinoPin === null) return;
            try {
              setAdcVoltage(simulator, arduinoPin, volts);
            } catch {
              // Swallow board-specific errors so a plugin's setAnalogValue
              // call cannot crash the simulator loop. Plugins author
              // against the contract, not a specific board's quirks.
            }
          },
          onSensorControlUpdate: (handler) => {
            // One listener per componentId (the SensorControlPanel keys by
            // componentId). Wrap the plugin callback in try/catch so a
            // throwing listener doesn't tear down the panel's dispatch
            // loop or leak into the UI.
            const guarded = (values: Record<string, number | boolean>) => {
              try {
                handler(values);
              } catch {
                // Isolate: panel keeps dispatching for other components.
              }
            };
            registerSensorUpdate(componentId, guarded);
            return {
              dispose: () => unregisterSensorUpdate(componentId),
            };
          },
          registerSpiSlave: (handler: SpiSlaveHandler) => {
            // The AVR `AVRSPI` peripheral exposes `onByte` (single slot,
            // not a subscriber list) + `completeTransfer(responseByte)`.
            // A slave differs from `onSpiTransmit` (observer) because it
            // MUST drive MISO back to the master — the sketch reads the
            // response as real device data.
            //
            // Not stackable: one active slave per bus (no per-CS routing
            // today). A second `registerSpiSlave` call displaces the
            // first — the old handler's `stop()` is invoked (if defined)
            // on install, so the displaced plugin's dispose later becomes
            // an idempotent no-op.
            type OnByte = (value: number) => void;
            type SlaveMarker = OnByte & { __velxioSpiSlaveStop?: () => void };
            const spi = simulator.spi as
              | {
                  onByte?: SlaveMarker | null;
                  completeTransfer?: (response: number) => void;
                }
              | null
              | undefined;
            if (!spi || typeof spi.completeTransfer !== 'function') {
              return { dispose: () => {} };
            }
            const previousOnByte = spi.onByte ?? null;
            let active = true;
            const stopOnce = () => {
              if (!active) return;
              active = false;
              try {
                handler.stop?.();
              } catch {
                // Isolate teardown: a throwing stop() must not affect
                // restore of the previous handler.
              }
            };
            const ourOnByte: SlaveMarker = (master: number) => {
              if (!active) {
                // We were displaced but the host still has a stale
                // binding — defensive no-op with default 0xff response.
                spi.completeTransfer!(0xff);
                return;
              }
              let response = 0xff;
              try {
                const ret = handler.onByte(master);
                if (Number.isFinite(ret)) response = (ret | 0) & 0xff;
              } catch {
                // Plugin threw — send open-drain default, keep the bus
                // alive. Silence beats bringing down the SPI stream.
              }
              spi.completeTransfer!(response);
            };
            ourOnByte.__velxioSpiSlaveStop = stopOnce;
            // Signal displacement to a previously-registered plugin slave
            // so its owning handler can release CS-driven state. Legacy
            // (non-plugin) AVR slave code has no marker and is preserved
            // untouched — its dispose flow runs through the
            // `previousOnByte` restore below, unchanged.
            if (previousOnByte && previousOnByte.__velxioSpiSlaveStop) {
              try {
                previousOnByte.__velxioSpiSlaveStop();
              } catch {
                // Isolate — install proceeds regardless.
              }
            }
            spi.onByte = ourOnByte;
            return {
              dispose: () => {
                // Idempotent: displacement already called stopOnce if it
                // fired; self-dispose runs it exactly once the first time.
                stopOnce();
                if (spi.onByte === ourOnByte) {
                  spi.onByte = previousOnByte;
                }
              },
            };
          },
          boardPlatform: (simulator instanceof RP2040Simulator
            ? 'rp2040'
            : simulator instanceof AVRSimulator
              ? 'avr'
              : typeof (simulator as { setAdcVoltage?: unknown }).setAdcVoltage ===
                  'function'
                ? 'esp32'
                : 'unknown') as SimulatorHandle['boardPlatform'],
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

// All built-in seeding (including `raspberry-pi-3` and the seven parts files)
// lives in `src/builtin/registerCoreParts.ts`. This module is pure contract
// + lookup; kept side-effect-free on purpose so the registry can be imported
// by tests and host code without dragging the whole parts catalog with it.
