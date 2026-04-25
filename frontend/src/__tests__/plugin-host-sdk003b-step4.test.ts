// @vitest-environment jsdom
/**
 * SDK-003b step 4 — host wiring of `api.serial.write` and
 * `api.i2c.registerSlave`.
 *
 * These two surfaces extend the high-level `PartSimulationAPI` with
 * write-side capabilities:
 *   - `serial.write(data)` injects bytes into the MCU's UART RX as if
 *     the user had typed in the Serial Monitor.
 *   - `i2c.registerSlave(addr, handler)` installs a virtual I²C device
 *     on the bus at a 7-bit address.
 *
 * Both are gated at call time (NOT at register time): authoring a
 * high-level part keeps the existing `simulator.pins.read` floor; the
 * write-side methods demand the stricter `simulator.serial.write` and
 * `simulator.i2c.write` permissions respectively.
 *
 * Coverage (mirrors the Ready-spec SDK-003b-step4):
 *   1. `serial.write` without permission throws PermissionDeniedError
 *      and never reaches the simulator.
 *   2. `serial.write(string)` with permission decodes via charCodeAt
 *      and forwards to `simulator.serialWrite` (AVR path).
 *   3. `serial.write(Uint8Array)` with permission + `serialWriteByte`
 *      available calls byte-by-byte (RP2040 path).
 *   4. `serial.write` is a silent no-op when the simulator exposes
 *      neither `serialWrite` nor `serialWriteByte`.
 *   5. `i2c.registerSlave` without permission throws
 *      PermissionDeniedError and never touches the bus.
 *   6. `i2c.registerSlave` with permission installs the device on
 *      `simulator.i2cBus` and returns a Disposable that removes it.
 *   7. Teardown of the high-level API releases any slave the author
 *      forgot to dispose explicitly.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  defineHighLevelPart,
  PermissionDeniedError,
  type EventBusReader,
  type I2cSlaveHandler,
  type PluginManifest,
  type PluginPermission,
  type SimulatorEventListener,
  type SimulatorEventName,
} from '@velxio/sdk';

import { createPluginContext } from '../plugin-host/createPluginContext';
import { PartSimulationRegistry as hostPartRegistry } from '../simulation/parts/PartSimulationRegistry';
import { PinManager } from '../simulation/PinManager';

function manifest(
  perms: PluginPermission[] = [],
  extras: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'sdk003b.step4.test',
    name: 'SDK-003b Step 4 Test',
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'plugin used by serial.write + i2c.registerSlave tests',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: perms,
    pricing: { model: 'free' },
    refundPolicy: 'none',
    ...extras,
  } as PluginManifest;
}

function uniqueId(prefix: string): string {
  return `sdk003b.step4.${prefix}.${Math.random().toString(36).slice(2, 8)}`;
}

function buildFakeEvents() {
  const listeners = new Map<SimulatorEventName, Set<(payload: unknown) => void>>();
  const bus: EventBusReader = {
    on<K extends SimulatorEventName>(event: K, fn: SimulatorEventListener<K>) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const wrapper = fn as (payload: unknown) => void;
      set.add(wrapper);
      return () => {
        set!.delete(wrapper);
      };
    },
    hasListeners: (event) => (listeners.get(event)?.size ?? 0) > 0,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
  };
  return { bus };
}

interface FakeBus {
  addDevice: ReturnType<typeof vi.fn>;
  removeDevice: ReturnType<typeof vi.fn>;
  devices: Map<number, { address: number } & I2cSlaveHandler>;
}

interface FakeSimOptions {
  serialWrite?: (s: string) => void;
  serialWriteByte?: (b: number) => void;
  i2cBus?: FakeBus | null;
}

function buildFakeBus(): FakeBus {
  const devices = new Map<number, { address: number } & I2cSlaveHandler>();
  const addDevice = vi.fn((d: { address: number } & I2cSlaveHandler) => {
    devices.set(d.address, d);
  });
  const removeDevice = vi.fn((addr: number) => {
    devices.delete(addr);
  });
  return { addDevice, removeDevice, devices };
}

function buildFakeSim(pinManager: PinManager, opts: FakeSimOptions = {}) {
  return {
    setPinState: (pin: number, state: boolean) =>
      pinManager.setPinState(pin, state),
    isRunning: () => true,
    pinManager,
    serialWrite: opts.serialWrite,
    serialWriteByte: opts.serialWriteByte,
    i2cBus: opts.i2cBus ?? null,
  } as never;
}

describe('SDK-003b step 4 — serial.write', () => {
  it('throws PermissionDeniedError when the plugin lacks simulator.serial.write', () => {
    const id = uniqueId('serial-no-perm');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']), // NO simulator.serial.write
      { events: buildFakeEvents().bus },
    );
    const serialWriteSpy = vi.fn();
    let captured: unknown;
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          try {
            api.serial!.write('AT\r\n');
          } catch (err) {
            captured = err;
          }
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(new PinManager(), { serialWrite: serialWriteSpy }),
      () => null,
      'comp-1',
    );
    expect(captured).toBeInstanceOf(PermissionDeniedError);
    expect(serialWriteSpy).not.toHaveBeenCalled();
  });

  it('forwards a string through simulator.serialWrite (AVR path)', () => {
    const id = uniqueId('serial-string');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read', 'simulator.serial.write']),
      { events: buildFakeEvents().bus },
    );
    const serialWriteSpy = vi.fn();
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          api.serial!.write('AT\r\n');
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(new PinManager(), { serialWrite: serialWriteSpy }),
      () => null,
      'comp-1',
    );
    expect(serialWriteSpy).toHaveBeenCalledTimes(1);
    expect(serialWriteSpy).toHaveBeenCalledWith('AT\r\n');
  });

  it('forwards a Uint8Array through simulator.serialWrite via TextDecoder("latin1") (AVR path)', () => {
    const id = uniqueId('serial-bytes-avr');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read', 'simulator.serial.write']),
      { events: buildFakeEvents().bus },
    );
    const serialWriteSpy = vi.fn();
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          // 0x01..0xFF round-trips through latin1 (1:1 byte-preserving).
          api.serial!.write(new Uint8Array([0x48, 0x69, 0xff]));
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(new PinManager(), { serialWrite: serialWriteSpy }),
      () => null,
      'comp-1',
    );
    expect(serialWriteSpy).toHaveBeenCalledTimes(1);
    const text = serialWriteSpy.mock.calls[0][0] as string;
    // Latin-1 decode is 1:1 — every codepoint matches the input byte.
    expect(text.length).toBe(3);
    expect(text.charCodeAt(0)).toBe(0x48);
    expect(text.charCodeAt(1)).toBe(0x69);
    expect(text.charCodeAt(2)).toBe(0xff);
  });

  it('prefers byte-level dispatch via simulator.serialWriteByte when present (RP2040 path)', () => {
    const id = uniqueId('serial-bytes-rp');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read', 'simulator.serial.write']),
      { events: buildFakeEvents().bus },
    );
    const serialWriteByteSpy = vi.fn();
    const serialWriteSpy = vi.fn();
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          api.serial!.write(new Uint8Array([0x10, 0x20, 0x30]));
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(new PinManager(), {
        serialWrite: serialWriteSpy,
        serialWriteByte: serialWriteByteSpy,
      }),
      () => null,
      'comp-1',
    );
    expect(serialWriteByteSpy).toHaveBeenCalledTimes(3);
    expect(serialWriteByteSpy.mock.calls[0][0]).toBe(0x10);
    expect(serialWriteByteSpy.mock.calls[1][0]).toBe(0x20);
    expect(serialWriteByteSpy.mock.calls[2][0]).toBe(0x30);
    // String fallback must not also fire when byte fn handled the call.
    expect(serialWriteSpy).not.toHaveBeenCalled();
  });

  it('prefers byte-level dispatch for strings too — converts via charCodeAt (RP2040 path)', () => {
    const id = uniqueId('serial-string-rp');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read', 'simulator.serial.write']),
      { events: buildFakeEvents().bus },
    );
    const serialWriteByteSpy = vi.fn();
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          api.serial!.write('AB');
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(new PinManager(), { serialWriteByte: serialWriteByteSpy }),
      () => null,
      'comp-1',
    );
    expect(serialWriteByteSpy).toHaveBeenCalledTimes(2);
    expect(serialWriteByteSpy.mock.calls[0][0]).toBe(0x41); // 'A'
    expect(serialWriteByteSpy.mock.calls[1][0]).toBe(0x42); // 'B'
  });

  it('is a silent no-op when neither serialWrite nor serialWriteByte is exposed', () => {
    const id = uniqueId('serial-no-uart');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read', 'simulator.serial.write']),
      { events: buildFakeEvents().bus },
    );
    let threw: unknown;
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          try {
            api.serial!.write('hello');
            api.serial!.write(new Uint8Array([1, 2, 3]));
          } catch (err) {
            threw = err;
          }
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    expect(() =>
      adapted.attachEvents!(
        document.createElement('div'),
        // Neither serialWrite nor serialWriteByte present.
        buildFakeSim(new PinManager()),
        () => null,
        'comp-1',
      ),
    ).not.toThrow();
    expect(threw).toBeUndefined();
  });
});

describe('SDK-003b step 4 — i2c.registerSlave', () => {
  it('throws PermissionDeniedError when the plugin lacks simulator.i2c.write', () => {
    const id = uniqueId('i2c-no-perm');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read']), // NO simulator.i2c.write
      { events: buildFakeEvents().bus },
    );
    const bus = buildFakeBus();
    let captured: unknown;
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          try {
            api.i2c!.registerSlave(0x42, {
              writeByte: () => true,
              readByte: () => 0xff,
            });
          } catch (err) {
            captured = err;
          }
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(new PinManager(), { i2cBus: bus }),
      () => null,
      'comp-1',
    );
    expect(captured).toBeInstanceOf(PermissionDeniedError);
    expect(bus.addDevice).not.toHaveBeenCalled();
  });

  it('installs the device on simulator.i2cBus and dispose() removes it', () => {
    const id = uniqueId('i2c-install');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read', 'simulator.i2c.write']),
      { events: buildFakeEvents().bus },
    );
    const bus = buildFakeBus();
    const handler: I2cSlaveHandler = {
      writeByte: () => true,
      readByte: () => 0x55,
    };
    let slaveDispose: (() => void) | undefined;
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          const d = api.i2c!.registerSlave(0x68, handler);
          slaveDispose = () => d.dispose();
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(new PinManager(), { i2cBus: bus }),
      () => null,
      'comp-1',
    );
    expect(bus.addDevice).toHaveBeenCalledTimes(1);
    expect(bus.devices.has(0x68)).toBe(true);
    expect(bus.devices.get(0x68)!.address).toBe(0x68);
    // The adapter wraps the handler methods (binds `this`); verify they
    // route to the original by exercising one.
    expect(bus.devices.get(0x68)!.readByte(true)).toBe(0x55);

    slaveDispose!();
    expect(bus.removeDevice).toHaveBeenCalledTimes(1);
    expect(bus.removeDevice).toHaveBeenCalledWith(0x68);
    expect(bus.devices.has(0x68)).toBe(false);
  });

  it('teardown of the API releases slaves the author forgot to dispose', () => {
    const id = uniqueId('i2c-teardown');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read', 'simulator.i2c.write']),
      { events: buildFakeEvents().bus },
    );
    const bus = buildFakeBus();
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          // NB: deliberately ignore the returned Disposable to simulate
          // an author who forgets to track it. The teardown contract is
          // that internal bookkeeping still releases the slave.
          api.i2c!.registerSlave(0x42, {
            writeByte: () => true,
            readByte: () => 0xff,
          });
          api.i2c!.registerSlave(0x50, {
            writeByte: () => true,
            readByte: () => 0xaa,
          });
          return () => {
            /* author teardown forgets the slaves */
          };
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    const cleanup = adapted.attachEvents!(
      document.createElement('div'),
      buildFakeSim(new PinManager(), { i2cBus: bus }),
      () => null,
      'comp-1',
    );
    expect(bus.devices.size).toBe(2);
    cleanup!();
    // Both slaves removed even though the author never disposed them.
    expect(bus.removeDevice).toHaveBeenCalledTimes(2);
    expect(bus.devices.size).toBe(0);
  });

  it('is a silent no-op when the simulator exposes no i2cBus', () => {
    const id = uniqueId('i2c-no-bus');
    const { context } = createPluginContext(
      manifest(['simulator.pins.read', 'simulator.i2c.write']),
      { events: buildFakeEvents().bus },
    );
    let threw: unknown;
    let returnedHandle: { dispose: () => void } | undefined;
    context.partSimulations.registerHighLevel(
      id,
      defineHighLevelPart({
        pins: [],
        attach: (_el, api) => {
          try {
            returnedHandle = api.i2c!.registerSlave(0x42, {
              writeByte: () => true,
              readByte: () => 0xff,
            });
          } catch (err) {
            threw = err;
          }
          return () => {};
        },
      }),
    );
    const adapted = hostPartRegistry.get(id)!;
    expect(() =>
      adapted.attachEvents!(
        document.createElement('div'),
        // No i2cBus on the simulator.
        buildFakeSim(new PinManager()),
        () => null,
        'comp-1',
      ),
    ).not.toThrow();
    expect(threw).toBeUndefined();
    expect(returnedHandle).toBeDefined();
    // The returned no-op handle still satisfies the Disposable contract.
    expect(() => returnedHandle!.dispose()).not.toThrow();
  });
});
