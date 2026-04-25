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
import { defineHighLevelPart, PLUGIN_PERMISSIONS } from '../src/index';
import type {
  Disposable,
  HighLevelPartSimulation,
  I2cSlaveHandler,
  I2CTransferEvent,
  PartI2CAPI,
  PartPinAPI,
  PartPinLevel,
  PartSerialAPI,
  PartSimulationAPI,
  PartSimulationRegistry,
  PluginPermission,
  SimulatorHandle,
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

  it('`serial.onRead` returns a Disposable and `serial.write` accepts Uint8Array | string', () => {
    const writes: Array<Uint8Array | string> = [];
    const serial: PartSerialAPI = {
      onRead: () => ({ dispose: () => {} }),
      write: (data) => {
        writes.push(data);
      },
    };
    expectTypeOf(serial.onRead).returns.toMatchTypeOf<Disposable>();
    expectTypeOf(serial.write).parameters.toMatchTypeOf<[Uint8Array | string]>();
    expectTypeOf(serial.write).returns.toBeVoid();
    serial.write('AT\r\n');
    serial.write(new Uint8Array([0x01, 0x02]));
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe('AT\r\n');
    expect(writes[1]).toBeInstanceOf(Uint8Array);
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
      registerSlave: () => ({ dispose: () => {} }),
    };
    i2c.onTransfer((ev) => calls.push(ev));
    expect(calls).toHaveLength(1);
    expect(calls[0].addr).toBe(0x68);
    expect(calls[0].direction).toBe('write');
    expect(calls[0].stop).toBe(true);
    expect(Array.from(calls[0].data)).toEqual([1, 2, 3]);
  });

  it('`i2c.registerSlave` accepts (addr, I2cSlaveHandler) and returns Disposable', () => {
    let lastAddr: number | null = null;
    let lastHandler: I2cSlaveHandler | null = null;
    const i2c: PartI2CAPI = {
      onTransfer: () => ({ dispose: () => {} }),
      registerSlave: (addr, handler) => {
        lastAddr = addr;
        lastHandler = handler;
        return { dispose: () => {} };
      },
    };
    expectTypeOf(i2c.registerSlave).parameters.toMatchTypeOf<
      [number, I2cSlaveHandler]
    >();
    expectTypeOf(i2c.registerSlave).returns.toMatchTypeOf<Disposable>();
    const handle = i2c.registerSlave(0x42, {
      writeByte: () => true,
      readByte: () => 0xff,
    });
    expect(lastAddr).toBe(0x42);
    expect(lastHandler).not.toBeNull();
    expect(typeof handle.dispose).toBe('function');
  });
});

describe('SimulatorHandle.injectSerialRx', () => {
  it('is declared on the SDK SimulatorHandle interface with the right signature', () => {
    // Structural pin: a stub satisfying the surface compiles.
    const stub: Pick<SimulatorHandle, 'injectSerialRx'> = {
      injectSerialRx: () => {},
    };
    expectTypeOf(stub.injectSerialRx).parameters.toMatchTypeOf<
      [Uint8Array | string]
    >();
    expectTypeOf(stub.injectSerialRx).returns.toBeVoid();
  });
});

describe('PLUGIN_PERMISSIONS — simulator.serial.write', () => {
  it('is part of the runtime enum', () => {
    expect(PLUGIN_PERMISSIONS).toContain('simulator.serial.write');
  });

  it('the literal narrows to PluginPermission', () => {
    const perm: PluginPermission = 'simulator.serial.write';
    expect(perm).toBe('simulator.serial.write');
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
