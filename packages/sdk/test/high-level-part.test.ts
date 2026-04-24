/**
 * Tests for `defineHighLevelPart` + `PartSimulationAPI` SDK contract
 * (SDK-003b step 2).
 *
 * The SDK side is pure types + an identity helper — we pin the runtime
 * contract (identity, structural shape) here and rely on `expectTypeOf`
 * for the type surface. Host wiring + runtime behavior lives in
 * `frontend/src/__tests__/plugin-host-sdk003b-high-level.test.ts`.
 */
import { describe, expect, it, expectTypeOf, vi } from 'vitest';
import { defineHighLevelPart } from '../src/index';
import type {
  Disposable,
  HighLevelPartSimulation,
  I2CTransferEvent,
  PartI2CAPI,
  PartPinAPI,
  PartPinLevel,
  PartSerialAPI,
  PartSimulationAPI,
  PartSimulationRegistry,
} from '../src/index';

describe('defineHighLevelPart', () => {
  it('returns the same object reference (identity helper)', () => {
    const literal: HighLevelPartSimulation = {
      pins: ['SIG'] as const,
      attach: () => () => {},
    };
    const result = defineHighLevelPart(literal);
    expect(result).toBe(literal);
  });

  it('preserves the narrow literal type for inference', () => {
    const part = defineHighLevelPart({
      pins: ['A', 'B'] as const,
      attach: (_el, api) => {
        // `api` must have the right shape at the call site — this is
        // the actual user-visible type surface we're pinning here.
        expectTypeOf(api).toMatchTypeOf<PartSimulationAPI>();
        expectTypeOf(api.pin('A')).toMatchTypeOf<PartPinAPI>();
        return () => {};
      },
    });
    expectTypeOf(part).toMatchTypeOf<HighLevelPartSimulation>();
  });
});

describe('PartSimulationAPI type shape', () => {
  it('`pin(name)` returns a PartPinAPI with state / onChange / set', () => {
    // Structural test only — construct a stub that matches the shape.
    const pinApi: PartPinAPI = {
      state: 'floating',
      onChange: () => ({ dispose: () => {} }),
      set: () => {},
    };
    expectTypeOf(pinApi.state).toEqualTypeOf<PartPinLevel>();
    expectTypeOf(pinApi.onChange).parameters.toMatchTypeOf<
      [(level: PartPinLevel) => void]
    >();
    expectTypeOf(pinApi.onChange).returns.toMatchTypeOf<Disposable>();
  });

  it('`serial.onRead` returns a Disposable', () => {
    const serial: PartSerialAPI = {
      onRead: () => ({ dispose: () => {} }),
    };
    expectTypeOf(serial.onRead).returns.toMatchTypeOf<Disposable>();
  });

  it('`i2c.onTransfer` delivers an I2CTransferEvent', () => {
    const calls: I2CTransferEvent[] = [];
    const i2c: PartI2CAPI = {
      onTransfer: (fn) => {
        fn({
          addr: 0x68,
          direction: 'write',
          data: new Uint8Array([1, 2, 3]),
          stop: true,
        });
        return { dispose: () => {} };
      },
    };
    i2c.onTransfer((ev) => calls.push(ev));
    expect(calls).toHaveLength(1);
    expect(calls[0].addr).toBe(0x68);
    expect(calls[0].direction).toBe('write');
    expect(calls[0].stop).toBe(true);
    expect(Array.from(calls[0].data)).toEqual([1, 2, 3]);
  });
});

describe('PartSimulationRegistry.registerHighLevel', () => {
  it('is declared on the SDK registry interface', () => {
    // Pin the interface has the method — a structural cast catches
    // accidental removals in review.
    const stub: Pick<PartSimulationRegistry, 'registerHighLevel'> = {
      registerHighLevel: () => ({ dispose: () => {} }),
    };
    expect(typeof stub.registerHighLevel).toBe('function');
  });

  it('returns a Disposable', () => {
    const fakeRegistry: Pick<PartSimulationRegistry, 'registerHighLevel'> = {
      registerHighLevel: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const handle = fakeRegistry.registerHighLevel!('test.led', {
      pins: ['A'],
      attach: () => () => {},
    });
    expectTypeOf(handle).toMatchTypeOf<Disposable>();
    expect(typeof handle.dispose).toBe('function');
  });
});

describe('HighLevelPartSimulation contract', () => {
  it('attach receives element + api and returns a teardown fn', () => {
    const teardown = vi.fn();
    const part = defineHighLevelPart({
      pins: ['SIG'],
      attach: (element, api) => {
        // Element may be null (see interface docstring).
        expect(element === null || element instanceof Object).toBe(true);
        expect(api).toBeDefined();
        return teardown;
      },
    });
    const fakeElement = null;
    const fakeApi: PartSimulationAPI = {
      pin: () => ({
        state: 'floating',
        onChange: () => ({ dispose: () => {} }),
        set: () => {},
      }),
    };
    const result = part.attach(fakeElement, fakeApi);
    expect(typeof result).toBe('function');
    result();
    expect(teardown).toHaveBeenCalledOnce();
  });
});
