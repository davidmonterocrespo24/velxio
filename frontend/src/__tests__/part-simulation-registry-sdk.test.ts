// @vitest-environment jsdom
/**
 * Contract tests for PartSimulationRegistry's SDK surfaces.
 *
 * Covers:
 *   - legacy `register()` returning a dispose handle with last-writer-wins
 *   - `registerSdkPart()` bridging 2-arg SimulatorHandle signature to the
 *     host's 4-arg legacy form
 *   - has/list/size/__clearForTests bookkeeping
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { PinManager } from '../simulation/PinManager';
import type { PartSimulation as SdkPartSimulation, SimulatorHandle } from '@velxio/sdk';

describe('PartSimulationRegistry — SDK contract', () => {
  beforeEach(() => {
    PartSimulationRegistry.__clearForTests();
  });

  describe('register() + dispose', () => {
    it('registers a legacy part and retrieves it with get()', () => {
      const logic = { onPinStateChange: vi.fn() };
      PartSimulationRegistry.register('my-part', logic);
      expect(PartSimulationRegistry.get('my-part')).toBe(logic);
    });

    it('last-writer-wins when the same id is registered twice', () => {
      const a = { onPinStateChange: vi.fn() };
      const b = { onPinStateChange: vi.fn() };
      PartSimulationRegistry.register('x', a);
      PartSimulationRegistry.register('x', b);
      expect(PartSimulationRegistry.get('x')).toBe(b);
    });

    it('dispose removes the part when no previous entry existed', () => {
      const logic = { onPinStateChange: vi.fn() };
      const handle = PartSimulationRegistry.register('once', logic);
      handle.dispose();
      expect(PartSimulationRegistry.get('once')).toBeUndefined();
    });

    it('dispose restores the previous part when shadowing', () => {
      const base = { onPinStateChange: vi.fn() };
      const shadow = { onPinStateChange: vi.fn() };
      PartSimulationRegistry.register('layered', base);
      const h2 = PartSimulationRegistry.register('layered', shadow);
      expect(PartSimulationRegistry.get('layered')).toBe(shadow);
      h2.dispose();
      expect(PartSimulationRegistry.get('layered')).toBe(base);
    });

    it('dispose is a no-op if someone else has taken the slot', () => {
      const a = { onPinStateChange: vi.fn() };
      const b = { onPinStateChange: vi.fn() };
      const ha = PartSimulationRegistry.register('race', a);
      PartSimulationRegistry.register('race', b); // b wins
      ha.dispose(); // must NOT clobber b
      expect(PartSimulationRegistry.get('race')).toBe(b);
    });
  });

  describe('has / list / size', () => {
    it('has() reflects registration state', () => {
      expect(PartSimulationRegistry.has('p')).toBe(false);
      PartSimulationRegistry.register('p', {});
      expect(PartSimulationRegistry.has('p')).toBe(true);
    });

    it('list() returns a sorted copy of ids', () => {
      PartSimulationRegistry.register('z', {});
      PartSimulationRegistry.register('a', {});
      PartSimulationRegistry.register('m', {});
      expect(PartSimulationRegistry.list()).toEqual(['a', 'm', 'z']);
    });

    it('size() tracks the map cardinality', () => {
      expect(PartSimulationRegistry.size()).toBe(0);
      PartSimulationRegistry.register('p1', {});
      PartSimulationRegistry.register('p2', {});
      expect(PartSimulationRegistry.size()).toBe(2);
    });
  });

  describe('registerSdkPart() adapter', () => {
    it('forwards onPinStateChange untouched', () => {
      const onChange = vi.fn();
      const sdkPart: SdkPartSimulation = { onPinStateChange: onChange };
      PartSimulationRegistry.registerSdkPart('sdk-part', sdkPart);

      const adapted = PartSimulationRegistry.get('sdk-part')!;
      const element = document.createElement('div');
      adapted.onPinStateChange!('A', true, element);

      expect(onChange).toHaveBeenCalledWith('A', true, element);
    });

    it('wraps attachEvents into the 2-arg SimulatorHandle form', () => {
      const sdkAttach = vi.fn((_el: HTMLElement, _handle: SimulatorHandle) => {
        return () => {};
      });
      const sdkPart: SdkPartSimulation = { attachEvents: sdkAttach };
      PartSimulationRegistry.registerSdkPart('sdk-attach', sdkPart);

      const adapted = PartSimulationRegistry.get('sdk-attach')!;
      const element = document.createElement('div');
      const fakeSim = {
        setPinState: vi.fn(),
        isRunning: () => true,
        pinManager: {} as never,
      } as never;
      const getPin = vi.fn(() => 13);

      const cleanup = adapted.attachEvents!(element, fakeSim, getPin, 'comp-1');
      expect(sdkAttach).toHaveBeenCalledTimes(1);
      const [passedElement, passedHandle] = sdkAttach.mock.calls[0];
      expect(passedElement).toBe(element);
      expect(passedHandle.componentId).toBe('comp-1');
      expect(passedHandle.isRunning()).toBe(true);
      expect(passedHandle.getArduinoPin('D13')).toBe(13);
      expect(getPin).toHaveBeenCalledWith('D13');

      expect(typeof cleanup).toBe('function');
    });

    it('the synthesized SimulatorHandle.setPinState forwards to the host simulator', () => {
      const setPinState = vi.fn();
      const sdkAttach = vi.fn((_el: HTMLElement, handle: SimulatorHandle) => {
        handle.setPinState(7, true);
        return () => {};
      });
      PartSimulationRegistry.registerSdkPart('sdk-setpin', { attachEvents: sdkAttach });

      const adapted = PartSimulationRegistry.get('sdk-setpin')!;
      const fakeSim = {
        setPinState,
        isRunning: () => false,
        pinManager: {} as never,
      } as never;
      adapted.attachEvents!(document.createElement('div'), fakeSim, () => null, 'c');

      expect(setPinState).toHaveBeenCalledWith(7, true);
    });

    it('omits unset hooks — only the populated ones land on the adapter', () => {
      const sdkPart: SdkPartSimulation = { onPinStateChange: () => {} };
      // attachEvents is NOT defined on the SDK part
      PartSimulationRegistry.registerSdkPart('only-change', sdkPart);
      const adapted = PartSimulationRegistry.get('only-change')!;
      expect(typeof adapted.onPinStateChange).toBe('function');
      expect(adapted.attachEvents).toBeUndefined();
    });

    it('returns a handle whose dispose() cleans up the SDK-registered part', () => {
      const handle = PartSimulationRegistry.registerSdkPart('disposable', {
        onPinStateChange: vi.fn(),
      });
      expect(PartSimulationRegistry.has('disposable')).toBe(true);
      handle.dispose();
      expect(PartSimulationRegistry.has('disposable')).toBe(false);
    });
  });

  describe('SimulatorHandle.onPinChange', () => {
    /**
     * Build a fake simulator wrapping a real PinManager so the new
     * onPinChange path actually flows through the host pin-change
     * pipeline (no mocks in the wire).
     */
    function buildFakeSim(pinManager: PinManager) {
      return {
        setPinState: (pin: number, state: boolean) => pinManager.setPinState(pin, state),
        isRunning: () => true,
        pinManager,
      } as never;
    }

    it('subscribes via the resolved arduino pin and fires on pin changes', () => {
      const pinManager = new PinManager();
      // SDK contract: the callback receives `PinState` (`0 | 1 | 'z' | 'x'`),
      // not a raw PinManager boolean. The host adapter coerces at the
      // boundary so plugins author against the public type.
      const observed: import('@velxio/sdk').PinState[] = [];
      let capturedHandle: SimulatorHandle | undefined;

      PartSimulationRegistry.registerSdkPart('pin-sub', {
        attachEvents: (_el, handle) => {
          capturedHandle = handle;
          handle.onPinChange('DOUT', (state) => observed.push(state));
          return () => {};
        },
      });

      const adapted = PartSimulationRegistry.get('pin-sub')!;
      adapted.attachEvents!(
        document.createElement('div'),
        buildFakeSim(pinManager),
        (name) => (name === 'DOUT' ? 5 : null),
        'comp-1',
      );

      expect(capturedHandle).toBeDefined();
      pinManager.triggerPinChange(5, true);
      pinManager.triggerPinChange(5, false);
      expect(observed).toEqual([1, 0]);
    });

    it('returns a Disposable whose dispose() removes the subscription', () => {
      const pinManager = new PinManager();
      const cb = vi.fn();
      let disposable: { dispose: () => void } | undefined;

      PartSimulationRegistry.registerSdkPart('pin-dispose', {
        attachEvents: (_el, handle) => {
          disposable = handle.onPinChange('DOUT', (s) => cb(s));
          return () => {};
        },
      });

      PartSimulationRegistry.get('pin-dispose')!.attachEvents!(
        document.createElement('div'),
        buildFakeSim(pinManager),
        () => 9,
        'comp-1',
      );

      pinManager.triggerPinChange(9, true);
      expect(cb).toHaveBeenCalledTimes(1);

      disposable!.dispose();
      pinManager.triggerPinChange(9, false);
      // No further calls after dispose
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('returns a no-op Disposable when the pin name is not wired', () => {
      const pinManager = new PinManager();
      const cb = vi.fn();
      let disposable: { dispose: () => void } | undefined;

      PartSimulationRegistry.registerSdkPart('pin-unwired', {
        attachEvents: (_el, handle) => {
          disposable = handle.onPinChange('DOUT', cb);
          return () => {};
        },
      });

      PartSimulationRegistry.get('pin-unwired')!.attachEvents!(
        document.createElement('div'),
        buildFakeSim(pinManager),
        () => null, // not wired
        'comp-1',
      );

      // No subscription exists — triggering any pin should not call cb
      pinManager.triggerPinChange(0, true);
      pinManager.triggerPinChange(13, true);
      expect(cb).not.toHaveBeenCalled();
      expect(pinManager.getListenersCount()).toBe(0);

      // Dispose on a no-op handle must be safe
      expect(() => disposable!.dispose()).not.toThrow();
    });

    it('keeps multi-pin subscriptions independent', () => {
      const pinManager = new PinManager();
      const cbA = vi.fn();
      const cbB = vi.fn();

      PartSimulationRegistry.registerSdkPart('pin-multi', {
        attachEvents: (_el, handle) => {
          handle.onPinChange('A', cbA);
          handle.onPinChange('B', cbB);
          return () => {};
        },
      });

      PartSimulationRegistry.get('pin-multi')!.attachEvents!(
        document.createElement('div'),
        buildFakeSim(pinManager),
        (name) => (name === 'A' ? 2 : name === 'B' ? 7 : null),
        'comp-1',
      );

      pinManager.triggerPinChange(2, true);
      expect(cbA).toHaveBeenCalledTimes(1);
      expect(cbB).not.toHaveBeenCalled();

      pinManager.triggerPinChange(7, true);
      expect(cbA).toHaveBeenCalledTimes(1);
      expect(cbB).toHaveBeenCalledTimes(1);
    });

    it('translates the (pin, state) PinManager callback to (state) for the plugin', () => {
      const pinManager = new PinManager();
      const cb = vi.fn();

      PartSimulationRegistry.registerSdkPart('pin-shape', {
        attachEvents: (_el, handle) => {
          handle.onPinChange('DOUT', cb);
          return () => {};
        },
      });

      PartSimulationRegistry.get('pin-shape')!.attachEvents!(
        document.createElement('div'),
        buildFakeSim(pinManager),
        () => 11,
        'comp-1',
      );

      pinManager.triggerPinChange(11, true);
      // Plugin callback receives ONLY the coerced `PinState` — not (pin, state).
      // PinManager fires `boolean`; the adapter maps `true → 1` / `false → 0`
      // so plugins see the SDK's public `PinState` union (`0 | 1 | 'z' | 'x'`).
      expect(cb).toHaveBeenCalledWith(1);
      expect(cb.mock.calls[0]).toHaveLength(1);
    });

    it('resolves the pin once at subscription time (not on every dispatch)', () => {
      const pinManager = new PinManager();
      const cb = vi.fn();
      const getPin = vi.fn((name: string) => (name === 'DOUT' ? 4 : null));

      PartSimulationRegistry.registerSdkPart('pin-resolve-once', {
        attachEvents: (_el, handle) => {
          handle.onPinChange('DOUT', cb);
          return () => {};
        },
      });

      PartSimulationRegistry.get('pin-resolve-once')!.attachEvents!(
        document.createElement('div'),
        buildFakeSim(pinManager),
        getPin,
        'comp-1',
      );

      // getArduinoPin called exactly once at subscription
      expect(getPin).toHaveBeenCalledTimes(1);

      pinManager.triggerPinChange(4, true);
      pinManager.triggerPinChange(4, false);
      pinManager.triggerPinChange(4, true);

      // Still only the original resolve call — not re-resolved per dispatch
      expect(getPin).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledTimes(3);
    });
  });

  // ── CORE-002c-step3 surfaces ──────────────────────────────────────────────

  /**
   * Helper — build a fake host simulator that wraps a real PinManager and
   * optionally carries mocked spi / i2cBus / schedule / cycles surfaces.
   * Keeps the test cases tight while preserving the "no mocks in the wire"
   * rule for the pin-manager path.
   */
  function buildRichFakeSim(overrides: {
    pinManager: PinManager;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spi?: { onTransmit?: ((value: number) => void) | null } | null | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    i2cBus?: any;
    schedulePinChange?: (pin: number, state: boolean, atCycle: number) => void;
    getCurrentCycles?: () => number;
    getClockHz?: () => number;
  }) {
    return {
      setPinState: (pin: number, state: boolean) =>
        overrides.pinManager.setPinState(pin, state),
      isRunning: () => true,
      pinManager: overrides.pinManager,
      spi: overrides.spi,
      i2cBus: overrides.i2cBus,
      schedulePinChange: overrides.schedulePinChange,
      getCurrentCycles: overrides.getCurrentCycles,
      getClockHz: overrides.getClockHz,
    } as never;
  }

  describe('SimulatorHandle.onPwmChange', () => {
    it('fires the callback with the raw duty cycle when the MCU updates PWM', () => {
      const pinManager = new PinManager();
      const observed: number[] = [];

      PartSimulationRegistry.registerSdkPart('pwm-sub', {
        attachEvents: (_el, handle) => {
          handle.onPwmChange('SIG', (duty) => observed.push(duty));
          return () => {};
        },
      });

      PartSimulationRegistry.get('pwm-sub')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager }),
        (name) => (name === 'SIG' ? 9 : null),
        'comp-1',
      );

      pinManager.updatePwm(9, 0.5);
      pinManager.updatePwm(9, 0.75);
      expect(observed).toEqual([0.5, 0.75]);
    });

    it('returns a Disposable whose dispose() detaches the subscription', () => {
      const pinManager = new PinManager();
      const cb = vi.fn();
      let disposable: { dispose: () => void } | undefined;

      PartSimulationRegistry.registerSdkPart('pwm-dispose', {
        attachEvents: (_el, handle) => {
          disposable = handle.onPwmChange('SIG', cb);
          return () => {};
        },
      });

      PartSimulationRegistry.get('pwm-dispose')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager }),
        () => 9,
        'comp-1',
      );

      pinManager.updatePwm(9, 0.2);
      expect(cb).toHaveBeenCalledTimes(1);
      disposable!.dispose();
      pinManager.updatePwm(9, 0.8);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('is a no-op Disposable when the pin is unwired', () => {
      const pinManager = new PinManager();
      const cb = vi.fn();
      let disposable: { dispose: () => void } | undefined;

      PartSimulationRegistry.registerSdkPart('pwm-unwired', {
        attachEvents: (_el, handle) => {
          disposable = handle.onPwmChange('SIG', cb);
          return () => {};
        },
      });

      PartSimulationRegistry.get('pwm-unwired')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager }),
        () => null,
        'comp-1',
      );

      pinManager.updatePwm(0, 0.5);
      pinManager.updatePwm(9, 0.9);
      expect(cb).not.toHaveBeenCalled();
      expect(() => disposable!.dispose()).not.toThrow();
    });
  });

  describe('SimulatorHandle.onSpiTransmit', () => {
    it('fires for every SPI byte transmitted by the MCU', () => {
      const pinManager = new PinManager();
      const spi: { onTransmit?: ((value: number) => void) | null } = {
        onTransmit: null,
      };
      const observed: number[] = [];

      PartSimulationRegistry.registerSdkPart('spi-sub', {
        attachEvents: (_el, handle) => {
          handle.onSpiTransmit((byte) => observed.push(byte));
          return () => {};
        },
      });

      PartSimulationRegistry.get('spi-sub')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager, spi }),
        () => null,
        'comp-1',
      );

      // Simulate AVR SPI byte shift-out.
      spi.onTransmit!(0x42);
      spi.onTransmit!(0xab);
      expect(observed).toEqual([0x42, 0xab]);
    });

    it('layers multiple subscribers — all of them see every byte', () => {
      const pinManager = new PinManager();
      const spi: { onTransmit?: ((value: number) => void) | null } = {
        onTransmit: null,
      };
      const a: number[] = [];
      const b: number[] = [];

      PartSimulationRegistry.registerSdkPart('spi-multi', {
        attachEvents: (_el, handle) => {
          handle.onSpiTransmit((byte) => a.push(byte));
          handle.onSpiTransmit((byte) => b.push(byte));
          return () => {};
        },
      });

      PartSimulationRegistry.get('spi-multi')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager, spi }),
        () => null,
        'comp-1',
      );

      spi.onTransmit!(0x10);
      spi.onTransmit!(0x20);
      expect(a).toEqual([0x10, 0x20]);
      expect(b).toEqual([0x10, 0x20]);
    });

    it('dispose restores the previous onTransmit slot', () => {
      const pinManager = new PinManager();
      const spi: { onTransmit?: ((value: number) => void) | null } = {
        onTransmit: null,
      };
      let disposable: { dispose: () => void } | undefined;

      PartSimulationRegistry.registerSdkPart('spi-dispose', {
        attachEvents: (_el, handle) => {
          disposable = handle.onSpiTransmit(() => {});
          return () => {};
        },
      });

      PartSimulationRegistry.get('spi-dispose')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager, spi }),
        () => null,
        'comp-1',
      );

      expect(typeof spi.onTransmit).toBe('function');
      disposable!.dispose();
      expect(spi.onTransmit).toBeNull();
    });

    it('fault-isolates plugin callbacks — a throwing listener does not break siblings', () => {
      const pinManager = new PinManager();
      const spi: { onTransmit?: ((value: number) => void) | null } = {
        onTransmit: null,
      };
      const observed: number[] = [];

      PartSimulationRegistry.registerSdkPart('spi-fault', {
        attachEvents: (_el, handle) => {
          handle.onSpiTransmit(() => {
            throw new Error('bad plugin');
          });
          handle.onSpiTransmit((byte) => observed.push(byte));
          return () => {};
        },
      });

      PartSimulationRegistry.get('spi-fault')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager, spi }),
        () => null,
        'comp-1',
      );

      expect(() => spi.onTransmit!(0x55)).not.toThrow();
      expect(observed).toEqual([0x55]);
    });

    it('is a no-op Disposable when the simulator has no SPI peripheral', () => {
      const pinManager = new PinManager();
      let disposable: { dispose: () => void } | undefined;

      PartSimulationRegistry.registerSdkPart('spi-none', {
        attachEvents: (_el, handle) => {
          disposable = handle.onSpiTransmit(vi.fn());
          return () => {};
        },
      });

      PartSimulationRegistry.get('spi-none')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager, spi: null }),
        () => null,
        'comp-1',
      );

      expect(() => disposable!.dispose()).not.toThrow();
    });
  });

  describe('SimulatorHandle.schedulePinChange', () => {
    it('forwards to host schedulePinChange with absolute (now + delta) cycle', () => {
      const pinManager = new PinManager();
      const schedulePinChange = vi.fn();
      const getCurrentCycles = vi.fn(() => 1000);

      PartSimulationRegistry.registerSdkPart('sched-basic', {
        attachEvents: (_el, handle) => {
          handle.schedulePinChange('ECHO', true, 500);
          return () => {};
        },
      });

      PartSimulationRegistry.get('sched-basic')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager, schedulePinChange, getCurrentCycles }),
        (name) => (name === 'ECHO' ? 8 : null),
        'comp-1',
      );

      expect(schedulePinChange).toHaveBeenCalledWith(8, true, 1500);
    });

    it('clamps negative deltas to 0 (fire as soon as possible)', () => {
      const pinManager = new PinManager();
      const schedulePinChange = vi.fn();

      PartSimulationRegistry.registerSdkPart('sched-neg', {
        attachEvents: (_el, handle) => {
          handle.schedulePinChange('ECHO', false, -100);
          return () => {};
        },
      });

      PartSimulationRegistry.get('sched-neg')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({
          pinManager,
          schedulePinChange,
          getCurrentCycles: () => 500,
        }),
        () => 8,
        'comp-1',
      );

      expect(schedulePinChange).toHaveBeenCalledWith(8, false, 500);
    });

    it('is a no-op when the pin is unwired', () => {
      const pinManager = new PinManager();
      const schedulePinChange = vi.fn();

      PartSimulationRegistry.registerSdkPart('sched-unwired', {
        attachEvents: (_el, handle) => {
          handle.schedulePinChange('ECHO', true, 500);
          return () => {};
        },
      });

      PartSimulationRegistry.get('sched-unwired')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({
          pinManager,
          schedulePinChange,
          getCurrentCycles: () => 0,
        }),
        () => null,
        'comp-1',
      );

      expect(schedulePinChange).not.toHaveBeenCalled();
    });

    it('is a no-op when the host has no schedulePinChange surface', () => {
      const pinManager = new PinManager();

      expect(() => {
        PartSimulationRegistry.registerSdkPart('sched-nohost', {
          attachEvents: (_el, handle) => {
            handle.schedulePinChange('ECHO', true, 500);
            return () => {};
          },
        });
        PartSimulationRegistry.get('sched-nohost')!.attachEvents!(
          document.createElement('div'),
          buildRichFakeSim({ pinManager }),
          () => 8,
          'comp-1',
        );
      }).not.toThrow();
    });
  });

  describe('SimulatorHandle.registerI2cSlave', () => {
    /** Tiny in-memory bus that mirrors the shape of I2CBusManager. */
    function makeFakeBus() {
      const devices = new Map<
        number,
        { address: number; writeByte(v: number): boolean; readByte(): number; stop?(): void }
      >();
      return {
        addDevice: vi.fn((d: { address: number; writeByte(v: number): boolean; readByte(): number; stop?(): void }) => {
          devices.set(d.address, d);
        }),
        removeDevice: vi.fn((a: number) => {
          devices.delete(a);
        }),
        devices,
      };
    }

    it('adds a slave with the given address and routes writeByte/readByte', () => {
      const pinManager = new PinManager();
      const bus = makeFakeBus();
      const handler: I2cSlaveHandler = {
        writeByte: vi.fn(() => true),
        readByte: vi.fn(() => 0x42),
        stop: vi.fn(),
      };

      PartSimulationRegistry.registerSdkPart('i2c-slave', {
        attachEvents: (_el, handle) => {
          handle.registerI2cSlave(0x3c, handler);
          return () => {};
        },
      });

      PartSimulationRegistry.get('i2c-slave')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager, i2cBus: bus }),
        () => null,
        'comp-1',
      );

      expect(bus.addDevice).toHaveBeenCalledTimes(1);
      const dev = bus.devices.get(0x3c)!;
      expect(dev.address).toBe(0x3c);
      dev.writeByte(0x11);
      expect(handler.writeByte).toHaveBeenCalledWith(0x11);
      expect(dev.readByte()).toBe(0x42);
      dev.stop?.();
      expect(handler.stop).toHaveBeenCalled();
    });

    it('dispose() removes the slave from the bus', () => {
      const pinManager = new PinManager();
      const bus = makeFakeBus();
      let disposable: { dispose: () => void } | undefined;

      PartSimulationRegistry.registerSdkPart('i2c-dispose', {
        attachEvents: (_el, handle) => {
          disposable = handle.registerI2cSlave(0x48, {
            writeByte: () => true,
            readByte: () => 0,
          });
          return () => {};
        },
      });

      PartSimulationRegistry.get('i2c-dispose')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager, i2cBus: bus }),
        () => null,
        'comp-1',
      );

      expect(bus.devices.has(0x48)).toBe(true);
      disposable!.dispose();
      expect(bus.removeDevice).toHaveBeenCalledWith(0x48);
      expect(bus.devices.has(0x48)).toBe(false);
    });

    it('is a no-op Disposable when the host has no i2cBus', () => {
      const pinManager = new PinManager();
      let disposable: { dispose: () => void } | undefined;

      PartSimulationRegistry.registerSdkPart('i2c-none', {
        attachEvents: (_el, handle) => {
          disposable = handle.registerI2cSlave(0x68, {
            writeByte: () => true,
            readByte: () => 0,
          });
          return () => {};
        },
      });

      PartSimulationRegistry.get('i2c-none')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager }),
        () => null,
        'comp-1',
      );

      expect(() => disposable!.dispose()).not.toThrow();
    });

    it('handlers without a stop method work (stop is optional)', () => {
      const pinManager = new PinManager();
      const bus = makeFakeBus();

      PartSimulationRegistry.registerSdkPart('i2c-no-stop', {
        attachEvents: (_el, handle) => {
          handle.registerI2cSlave(0x27, {
            writeByte: () => true,
            readByte: () => 0xff,
          });
          return () => {};
        },
      });

      PartSimulationRegistry.get('i2c-no-stop')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager, i2cBus: bus }),
        () => null,
        'comp-1',
      );

      const dev = bus.devices.get(0x27)!;
      expect(dev.stop).toBeUndefined();
    });
  });

  describe('SimulatorHandle.cyclesNow + clockHz', () => {
    it('cyclesNow() reads getCurrentCycles() each call (observes cycle progress)', () => {
      const pinManager = new PinManager();
      let cycles = 0;
      const samples: number[] = [];

      PartSimulationRegistry.registerSdkPart('cyc-basic', {
        attachEvents: (_el, handle) => {
          samples.push(handle.cyclesNow());
          cycles = 500;
          samples.push(handle.cyclesNow());
          cycles = 1234;
          samples.push(handle.cyclesNow());
          return () => {};
        },
      });

      PartSimulationRegistry.get('cyc-basic')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({
          pinManager,
          getCurrentCycles: () => cycles,
        }),
        () => null,
        'comp-1',
      );

      expect(samples).toEqual([0, 500, 1234]);
    });

    it('cyclesNow() returns 0 when the host has no getCurrentCycles', () => {
      const pinManager = new PinManager();
      let observed = -1;

      PartSimulationRegistry.registerSdkPart('cyc-none', {
        attachEvents: (_el, handle) => {
          observed = handle.cyclesNow();
          return () => {};
        },
      });

      PartSimulationRegistry.get('cyc-none')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager }),
        () => null,
        'comp-1',
      );

      expect(observed).toBe(0);
    });

    it('clockHz() reads getClockHz() when present', () => {
      const pinManager = new PinManager();
      let observed = 0;

      PartSimulationRegistry.registerSdkPart('clk-basic', {
        attachEvents: (_el, handle) => {
          observed = handle.clockHz();
          return () => {};
        },
      });

      PartSimulationRegistry.get('clk-basic')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({
          pinManager,
          getClockHz: () => 133_000_000,
        }),
        () => null,
        'comp-1',
      );

      expect(observed).toBe(133_000_000);
    });

    it('clockHz() falls back to 16 MHz (AVR default) when the host has no getClockHz', () => {
      const pinManager = new PinManager();
      let observed = 0;

      PartSimulationRegistry.registerSdkPart('clk-default', {
        attachEvents: (_el, handle) => {
          observed = handle.clockHz();
          return () => {};
        },
      });

      PartSimulationRegistry.get('clk-default')!.attachEvents!(
        document.createElement('div'),
        buildRichFakeSim({ pinManager }),
        () => null,
        'comp-1',
      );

      expect(observed).toBe(16_000_000);
    });
  });
});
