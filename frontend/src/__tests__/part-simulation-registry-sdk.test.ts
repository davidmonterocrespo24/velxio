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

  // ── CORE-002c-step4a surfaces ─────────────────────────────────────────────

  /**
   * Helper — builds a fake simulator that optionally carries an ESP32-style
   * `setAdcVoltage` shim, an SPI slave slot (`onByte` + `completeTransfer`),
   * and the other step3 overrides. Keeps the step4a tests tight.
   */
  function buildStep4aFakeSim(overrides: {
    pinManager: PinManager;
    setAdcVoltage?: (pin: number, volts: number) => boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spi?: any;
  }) {
    return {
      setPinState: (pin: number, state: boolean) =>
        overrides.pinManager.setPinState(pin, state),
      isRunning: () => true,
      pinManager: overrides.pinManager,
      setAdcVoltage: overrides.setAdcVoltage,
      spi: overrides.spi,
    } as never;
  }

  describe('SimulatorHandle.setAnalogValue', () => {
    it('delegates to the host setAdcVoltage helper with the resolved arduino pin', () => {
      const pinManager = new PinManager();
      const shim = vi.fn(() => true);

      PartSimulationRegistry.registerSdkPart('analog-esp32', {
        attachEvents: (_el, handle) => {
          handle.setAnalogValue('SIG', 2.5);
          handle.setAnalogValue('SIG', 1.25);
          return () => {};
        },
      });

      PartSimulationRegistry.get('analog-esp32')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager, setAdcVoltage: shim }),
        (name) => (name === 'SIG' ? 34 : null),
        'comp-1',
      );

      expect(shim).toHaveBeenCalledTimes(2);
      expect(shim).toHaveBeenNthCalledWith(1, 34, 2.5);
      expect(shim).toHaveBeenNthCalledWith(2, 34, 1.25);
    });

    it('is a no-op when the component pin is unwired', () => {
      const pinManager = new PinManager();
      const shim = vi.fn(() => true);

      PartSimulationRegistry.registerSdkPart('analog-unwired', {
        attachEvents: (_el, handle) => {
          handle.setAnalogValue('SIG', 1.0);
          return () => {};
        },
      });

      PartSimulationRegistry.get('analog-unwired')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager, setAdcVoltage: shim }),
        () => null,
        'comp-1',
      );

      expect(shim).not.toHaveBeenCalled();
    });

    it('swallows errors from the host ADC helper (fault isolation)', () => {
      const pinManager = new PinManager();
      const shim = vi.fn(() => {
        throw new Error('boom');
      });

      PartSimulationRegistry.registerSdkPart('analog-throw', {
        attachEvents: (_el, handle) => {
          handle.setAnalogValue('SIG', 0.1);
          return () => {};
        },
      });

      expect(() =>
        PartSimulationRegistry.get('analog-throw')!.attachEvents!(
          document.createElement('div'),
          buildStep4aFakeSim({ pinManager, setAdcVoltage: shim }),
          () => 34,
          'comp-1',
        ),
      ).not.toThrow();
      expect(shim).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the running board has no ADC surface (AVR pin out of range, no shim)', () => {
      const pinManager = new PinManager();

      PartSimulationRegistry.registerSdkPart('analog-no-adc', {
        attachEvents: (_el, handle) => {
          // Pin 3 is a PWM pin on AVR, not analog — setAdcVoltage returns
          // false and we no-op. Critically, this must NOT throw.
          handle.setAnalogValue('SIG', 5.0);
          return () => {};
        },
      });

      expect(() =>
        PartSimulationRegistry.get('analog-no-adc')!.attachEvents!(
          document.createElement('div'),
          buildStep4aFakeSim({ pinManager }),
          () => 3,
          'comp-1',
        ),
      ).not.toThrow();
    });
  });

  describe('SimulatorHandle.onSensorControlUpdate', () => {
    it('registers a listener keyed by componentId and receives dispatched values', async () => {
      const { dispatchSensorUpdate } = await import(
        '../simulation/SensorUpdateRegistry'
      );
      const pinManager = new PinManager();
      const observed: Record<string, number | boolean>[] = [];

      PartSimulationRegistry.registerSdkPart('sensor-basic', {
        attachEvents: (_el, handle) => {
          handle.onSensorControlUpdate((values) => observed.push(values));
          return () => {};
        },
      });

      PartSimulationRegistry.get('sensor-basic')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager }),
        () => null,
        'sensor-1',
      );

      dispatchSensorUpdate('sensor-1', { temperature: 25, humidity: 50 });
      dispatchSensorUpdate('sensor-1', { temperature: 28, humidity: 45 });

      expect(observed).toEqual([
        { temperature: 25, humidity: 50 },
        { temperature: 28, humidity: 45 },
      ]);
    });

    it('dispose() unregisters the listener', async () => {
      const { dispatchSensorUpdate } = await import(
        '../simulation/SensorUpdateRegistry'
      );
      const pinManager = new PinManager();
      const cb = vi.fn();
      let disposable: { dispose: () => void } | undefined;

      PartSimulationRegistry.registerSdkPart('sensor-dispose', {
        attachEvents: (_el, handle) => {
          disposable = handle.onSensorControlUpdate(cb);
          return () => {};
        },
      });

      PartSimulationRegistry.get('sensor-dispose')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager }),
        () => null,
        'sensor-2',
      );

      dispatchSensorUpdate('sensor-2', { tilt: true });
      expect(cb).toHaveBeenCalledTimes(1);

      disposable!.dispose();
      dispatchSensorUpdate('sensor-2', { tilt: false });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('fault-isolates a throwing listener — the panel dispatch loop keeps going', async () => {
      const { dispatchSensorUpdate } = await import(
        '../simulation/SensorUpdateRegistry'
      );
      const pinManager = new PinManager();

      PartSimulationRegistry.registerSdkPart('sensor-throw', {
        attachEvents: (_el, handle) => {
          handle.onSensorControlUpdate(() => {
            throw new Error('plugin is buggy');
          });
          return () => {};
        },
      });

      PartSimulationRegistry.get('sensor-throw')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager }),
        () => null,
        'sensor-3',
      );

      expect(() =>
        dispatchSensorUpdate('sensor-3', { value: 1 }),
      ).not.toThrow();
    });

    it('routes values only to the registered componentId (isolation across components)', async () => {
      const { dispatchSensorUpdate } = await import(
        '../simulation/SensorUpdateRegistry'
      );
      const pinManager = new PinManager();
      const cbA = vi.fn();
      const cbB = vi.fn();

      PartSimulationRegistry.registerSdkPart('sensor-iso-a', {
        attachEvents: (_el, handle) => {
          handle.onSensorControlUpdate(cbA);
          return () => {};
        },
      });
      PartSimulationRegistry.registerSdkPart('sensor-iso-b', {
        attachEvents: (_el, handle) => {
          handle.onSensorControlUpdate(cbB);
          return () => {};
        },
      });

      PartSimulationRegistry.get('sensor-iso-a')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager }),
        () => null,
        'sensor-A',
      );
      PartSimulationRegistry.get('sensor-iso-b')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager }),
        () => null,
        'sensor-B',
      );

      dispatchSensorUpdate('sensor-A', { v: 1 });
      dispatchSensorUpdate('sensor-B', { v: 2 });

      expect(cbA).toHaveBeenCalledWith({ v: 1 });
      expect(cbB).toHaveBeenCalledWith({ v: 2 });
      expect(cbA).toHaveBeenCalledTimes(1);
      expect(cbB).toHaveBeenCalledTimes(1);
    });
  });

  describe('SimulatorHandle.registerSpiSlave', () => {
    function makeFakeSpi() {
      return {
        onByte: null as ((v: number) => void) | null,
        completeTransfer: vi.fn(),
      };
    }

    it('wraps spi.onByte and feeds handler.onByte return values back via completeTransfer', () => {
      const pinManager = new PinManager();
      const spi = makeFakeSpi();
      const received: number[] = [];
      const handler = {
        onByte: vi.fn((master: number) => {
          received.push(master);
          return 0xaa;
        }),
      };

      PartSimulationRegistry.registerSdkPart('spi-slave-basic', {
        attachEvents: (_el, handle) => {
          handle.registerSpiSlave(handler);
          return () => {};
        },
      });

      PartSimulationRegistry.get('spi-slave-basic')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager, spi }),
        () => null,
        'comp-1',
      );

      expect(typeof spi.onByte).toBe('function');
      spi.onByte!(0x11);
      spi.onByte!(0x22);

      expect(received).toEqual([0x11, 0x22]);
      expect(spi.completeTransfer).toHaveBeenNthCalledWith(1, 0xaa);
      expect(spi.completeTransfer).toHaveBeenNthCalledWith(2, 0xaa);
    });

    it('defaults to 0xff open-drain when the plugin onByte throws', () => {
      const pinManager = new PinManager();
      const spi = makeFakeSpi();
      const handler = {
        onByte: () => {
          throw new Error('plugin crashed');
        },
      };

      PartSimulationRegistry.registerSdkPart('spi-slave-throw', {
        attachEvents: (_el, handle) => {
          handle.registerSpiSlave(handler);
          return () => {};
        },
      });

      PartSimulationRegistry.get('spi-slave-throw')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager, spi }),
        () => null,
        'comp-1',
      );

      expect(() => spi.onByte!(0x55)).not.toThrow();
      expect(spi.completeTransfer).toHaveBeenCalledWith(0xff);
    });

    it('dispose() restores the previous onByte slot and calls stop()', () => {
      const pinManager = new PinManager();
      const prevHandler = vi.fn();
      const spi: ReturnType<typeof makeFakeSpi> & {
        onByte: ((v: number) => void) | null;
      } = makeFakeSpi();
      spi.onByte = prevHandler as (v: number) => void;

      let disposable: { dispose: () => void } | undefined;
      const stop = vi.fn();

      PartSimulationRegistry.registerSdkPart('spi-slave-dispose', {
        attachEvents: (_el, handle) => {
          disposable = handle.registerSpiSlave({
            onByte: () => 0x00,
            stop,
          });
          return () => {};
        },
      });

      PartSimulationRegistry.get('spi-slave-dispose')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager, spi }),
        () => null,
        'comp-1',
      );

      expect(spi.onByte).not.toBe(prevHandler);
      disposable!.dispose();
      expect(spi.onByte).toBe(prevHandler);
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('displacement: a second registerSpiSlave replaces the first and the first sees nothing further', () => {
      const pinManager = new PinManager();
      const spi = makeFakeSpi();
      const firstBytes: number[] = [];
      const secondBytes: number[] = [];
      const firstStop = vi.fn();

      PartSimulationRegistry.registerSdkPart('spi-slave-replace', {
        attachEvents: (_el, handle) => {
          handle.registerSpiSlave({
            onByte: (b) => {
              firstBytes.push(b);
              return 0x11;
            },
            stop: firstStop,
          });
          handle.registerSpiSlave({
            onByte: (b) => {
              secondBytes.push(b);
              return 0x22;
            },
          });
          return () => {};
        },
      });

      PartSimulationRegistry.get('spi-slave-replace')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager, spi }),
        () => null,
        'comp-1',
      );

      spi.onByte!(0xab);
      expect(firstBytes).toEqual([]);
      expect(secondBytes).toEqual([0xab]);
      expect(spi.completeTransfer).toHaveBeenLastCalledWith(0x22);
      // Displacement invoked the first slave's stop() so the displaced
      // plugin can release CS-driven state (spec: step4a).
      expect(firstStop).toHaveBeenCalledTimes(1);
    });

    it('is a no-op Disposable when the host has no spi peripheral', () => {
      const pinManager = new PinManager();
      let disposable: { dispose: () => void } | undefined;

      PartSimulationRegistry.registerSdkPart('spi-slave-none', {
        attachEvents: (_el, handle) => {
          disposable = handle.registerSpiSlave({
            onByte: () => 0,
          });
          return () => {};
        },
      });

      PartSimulationRegistry.get('spi-slave-none')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager }),
        () => null,
        'comp-1',
      );

      expect(() => disposable!.dispose()).not.toThrow();
    });
  });

  describe('SimulatorHandle.boardPlatform', () => {
    it('reports esp32 when the host exposes a setAdcVoltage shim (bridge path)', () => {
      const pinManager = new PinManager();
      let observed: SimulatorHandle['boardPlatform'] | undefined;

      PartSimulationRegistry.registerSdkPart('board-esp32', {
        attachEvents: (_el, handle) => {
          observed = handle.boardPlatform;
          return () => {};
        },
      });

      PartSimulationRegistry.get('board-esp32')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({
          pinManager,
          setAdcVoltage: () => true,
        }),
        () => null,
        'comp-1',
      );

      expect(observed).toBe('esp32');
    });

    it('reports unknown for a plain fake simulator with no board-specific markers', () => {
      const pinManager = new PinManager();
      let observed: SimulatorHandle['boardPlatform'] | undefined;

      PartSimulationRegistry.registerSdkPart('board-unknown', {
        attachEvents: (_el, handle) => {
          observed = handle.boardPlatform;
          return () => {};
        },
      });

      PartSimulationRegistry.get('board-unknown')!.attachEvents!(
        document.createElement('div'),
        buildStep4aFakeSim({ pinManager }),
        () => null,
        'comp-1',
      );

      expect(observed).toBe('unknown');
    });
  });
});
