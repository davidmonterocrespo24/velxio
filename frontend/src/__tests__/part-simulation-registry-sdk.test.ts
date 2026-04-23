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
});
