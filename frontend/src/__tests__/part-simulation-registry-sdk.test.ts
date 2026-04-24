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
});
