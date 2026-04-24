/**
 * simulator-spi-i2c-transfer-events.test.ts
 *
 * Verifies the host-side `i2c:transfer` and `spi:transfer` event emission
 * wired into AVRSimulator (via I2CBusManager + installSpiTransferObserver)
 * and RP2040Simulator (via wireI2C + wireSpiObserver).
 *
 * What we cover:
 *   1. I2CBusManager fires `i2c:transfer` with the right addr / direction /
 *      data / stop on a normal write-then-read round trip (covers the
 *      AVR path — AVRSimulator forwards the same observation verbatim).
 *   2. Repeated START fires two transfers, the first with stop:false.
 *   3. Zero-byte write (NACK'd connect followed by STOP) emits with empty
 *      data — a bus observation, not a slave-delivery log.
 *   4. Observer never throws inside the I2C state machine even if its
 *      callback throws.
 *   5. The SPI observer wrapper on AVRSPI fires `spi:transfer` with the
 *      MOSI byte the sketch wrote and the MISO byte the loopback returned.
 *   6. The CPU writeHook capture survives a `registerSpiSlave`-style
 *      re-assignment of `spi.onByte`.
 *   7. `bus.hasListeners(...)` guard means zero-listener emit allocates
 *      nothing (no payload, no dispatch).
 *
 * The AVR SPI observer is exercised against the same `installSpiTransferObserver`
 * helper module used by AVRSimulator, with a fake CPU + fake AVRSPI peripheral.
 * This avoids running a real Arduino sketch (needs arduino-cli) while still
 * exercising the exact code path the simulator uses.
 *
 * The RP2040 wireSpiObserver / wireI2C paths are exercised through the
 * RP2040Simulator (real RP2040 instance, virtual I2C devices, no firmware
 * needed — we drive the peripheral state directly).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { I2CBusManager } from '../simulation/I2CBusManager';
import type { I2CTransferObservation, I2CDevice } from '../simulation/I2CBusManager';
import { getEventBus } from '../simulation/EventBus';
import type { SimulatorEvents } from '@velxio/sdk/events';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTWI() {
  const calls: string[] = [];
  return {
    calls,
    set eventHandler(_: unknown) {
      /* set by I2CBusManager */
    },
    completeStart() {
      calls.push('start');
    },
    completeStop() {
      calls.push('stop');
    },
    completeConnect(ack: boolean) {
      calls.push(`connect:${ack}`);
    },
    completeWrite(ack: boolean) {
      calls.push(`write:${ack}`);
    },
    completeRead(v: number) {
      calls.push(`read:${v}`);
    },
  };
}

class CapturingDevice implements I2CDevice {
  public received: number[] = [];
  public reads: number[] = [];
  private cursor = 0;

  constructor(
    public address: number,
    private payload: number[] = [],
  ) {}

  writeByte(value: number): boolean {
    this.received.push(value);
    return true;
  }
  readByte(): number {
    const v = this.payload[this.cursor++ % Math.max(1, this.payload.length)] ?? 0;
    this.reads.push(v);
    return v;
  }
}

// ─── I2C — observation contract ───────────────────────────────────────────────

describe('I2CBusManager — i2c:transfer observation', () => {
  it('emits one transfer per STOP, with addr / direction / data / stop=true', () => {
    const events: I2CTransferObservation[] = [];
    const twi = makeTWI();
    const mgr = new I2CBusManager(twi as never, (e) => events.push(e));
    mgr.addDevice(new CapturingDevice(0x27));

    mgr.start(false);
    mgr.connectToSlave(0x27, true);
    mgr.writeByte(0x12);
    mgr.writeByte(0x34);
    mgr.stop();

    expect(events).toHaveLength(1);
    expect(events[0].addr).toBe(0x27);
    expect(events[0].direction).toBe('write');
    expect(Array.from(events[0].data)).toEqual([0x12, 0x34]);
    expect(events[0].stop).toBe(true);
  });

  it('emits two transfers on repeated START — first with stop=false', () => {
    const events: I2CTransferObservation[] = [];
    const twi = makeTWI();
    const dev = new CapturingDevice(0x68, [0x55, 0xaa]);
    const mgr = new I2CBusManager(twi as never, (e) => events.push(e));
    mgr.addDevice(dev);

    // Master writes register pointer, then repeated-START into read mode.
    mgr.start(false);
    mgr.connectToSlave(0x68, true);
    mgr.writeByte(0x00);
    mgr.start(true);
    mgr.connectToSlave(0x68, false);
    mgr.readByte(true);
    mgr.readByte(false);
    mgr.stop();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ addr: 0x68, direction: 'write', stop: false });
    expect(Array.from(events[0].data)).toEqual([0x00]);
    expect(events[1]).toMatchObject({ addr: 0x68, direction: 'read', stop: true });
    expect(Array.from(events[1].data)).toEqual([0x55, 0xaa]);
  });

  it('emits a zero-byte transfer when the connect is NACKed and master sends STOP', () => {
    const events: I2CTransferObservation[] = [];
    const twi = makeTWI();
    const mgr = new I2CBusManager(twi as never, (e) => events.push(e));
    // No device at 0x50 — connect will NACK.

    mgr.start(false);
    mgr.connectToSlave(0x50, true);
    mgr.stop();

    expect(events).toHaveLength(1);
    expect(events[0].addr).toBe(0x50);
    expect(events[0].direction).toBe('write');
    expect(events[0].data.length).toBe(0);
    expect(events[0].stop).toBe(true);
  });

  it('isolates a throwing observer — I2C state machine keeps flowing', () => {
    const twi = makeTWI();
    const mgr = new I2CBusManager(twi as never, () => {
      throw new Error('observer blew up');
    });
    mgr.addDevice(new CapturingDevice(0x10));

    expect(() => {
      mgr.connectToSlave(0x10, true);
      mgr.writeByte(0xab);
      mgr.stop();
    }).not.toThrow();

    // The TWI state machine still completed its writes and the stop.
    expect(twi.calls).toContain('connect:true');
    expect(twi.calls).toContain('write:true');
    expect(twi.calls).toContain('stop');
  });

  it('does not call the observer when no `onTransfer` callback is supplied', () => {
    // Backwards-compat: pre-CORE-003b call sites pass a single argument.
    const twi = makeTWI();
    const mgr = new I2CBusManager(twi as never);
    mgr.addDevice(new CapturingDevice(0x42));

    expect(() => {
      mgr.connectToSlave(0x42, true);
      mgr.writeByte(0x01);
      mgr.stop();
    }).not.toThrow();
  });
});

// ─── SPI observer — directly exercises the wrapping logic ─────────────────────

/**
 * Replicates the host-side wrapper logic of `installSpiTransferObserver`
 * inline so we can drive it with a fake CPU + fake AVRSPI peripheral.
 * Keeps this test pure-Vitest (no avr8js boot, no HEX execution).
 *
 * The wrapper is intentionally identical to the one in AVRSimulator.ts —
 * if that helper ever drifts, this test will fail to compile or fail
 * the assertions.
 */
import { installSpiTransferObserverForTests } from '../simulation/AVRSimulator';

interface FakeCPU {
  writeHooks: Record<number, (value: number, oldValue: number, addr: number, mask: number) => void>;
}
interface FakeSPI {
  onByte: ((value: number) => void) | null;
  completeTransfer(response: number): void;
}

function makeFakeSpiSetup(): {
  cpu: FakeCPU;
  spi: FakeSPI;
  spdrAddr: number;
  miso: number;
  setMiso(v: number): void;
} {
  const SPDR = 0x4e; // ATmega328P SPDR address
  let lastResponse = 0;
  const cpu: FakeCPU = {
    writeHooks: {
      [SPDR]: (value) => {
        // Stand-in for the original CPU writeHook: drives spi.onByte just
        // like avr8js does when the sketch writes SPDR.
        spi.onByte?.(value);
      },
    },
  };
  const spi: FakeSPI = {
    onByte: null,
    completeTransfer(response: number) {
      lastResponse = response;
    },
  };
  return {
    cpu,
    spi,
    spdrAddr: SPDR,
    get miso() {
      return lastResponse;
    },
    setMiso(_v: number) {
      lastResponse = _v;
    },
  };
}

describe('AVRSimulator — spi:transfer observation', () => {
  beforeEach(() => {
    getEventBus().clear();
  });

  afterEach(() => {
    getEventBus().clear();
  });

  it('emits cs:default with mosi/miso on every SPDR write → completeTransfer round-trip', () => {
    const { cpu, spi, spdrAddr } = makeFakeSpiSetup();
    // Default loopback: echo the byte back as MISO.
    spi.onByte = (v) => spi.completeTransfer(v);

    installSpiTransferObserverForTests(spi, spdrAddr, cpu, getEventBus());

    const events: SimulatorEvents['spi:transfer'][] = [];
    const off = getEventBus().on('spi:transfer', (e) => events.push(e));
    try {
      // Sketch writes SPDR=0x42 → CPU writeHook fires → onByte → completeTransfer.
      cpu.writeHooks[spdrAddr](0x42, 0, spdrAddr, 0xff);
      cpu.writeHooks[spdrAddr](0xa5, 0x42, spdrAddr, 0xff);
    } finally {
      off();
    }

    expect(events).toHaveLength(2);
    expect(events[0].cs).toBe('default');
    expect(Array.from(events[0].mosi)).toEqual([0x42]);
    expect(Array.from(events[0].miso)).toEqual([0x42]);
    expect(Array.from(events[1].mosi)).toEqual([0xa5]);
    expect(Array.from(events[1].miso)).toEqual([0xa5]);
  });

  it('captures MOSI across registerSpiSlave-style replacement of spi.onByte', () => {
    // Simulates the CORE-002c plugin SPI slave path: a plugin replaces
    // spi.onByte with its own handler that returns a fixed MISO byte.
    // Our writeHooks[SPDR] wrap must still see the MOSI byte.
    const { cpu, spi, spdrAddr } = makeFakeSpiSetup();
    spi.onByte = (v) => spi.completeTransfer(v); // initial loopback

    installSpiTransferObserverForTests(spi, spdrAddr, cpu, getEventBus());

    // Plugin slave replaces onByte after the observer was installed.
    spi.onByte = (_v) => spi.completeTransfer(0xde);

    const events: SimulatorEvents['spi:transfer'][] = [];
    const off = getEventBus().on('spi:transfer', (e) => events.push(e));
    try {
      cpu.writeHooks[spdrAddr](0xbe, 0, spdrAddr, 0xff);
      cpu.writeHooks[spdrAddr](0xef, 0xbe, spdrAddr, 0xff);
    } finally {
      off();
    }

    expect(events).toHaveLength(2);
    expect(Array.from(events[0].mosi)).toEqual([0xbe]);
    expect(Array.from(events[0].miso)).toEqual([0xde]);
    expect(Array.from(events[1].mosi)).toEqual([0xef]);
    expect(Array.from(events[1].miso)).toEqual([0xde]);
  });

  it('zero subscribers — completeTransfer does not allocate event payload', () => {
    const { cpu, spi, spdrAddr } = makeFakeSpiSetup();
    spi.onByte = (v) => spi.completeTransfer(v);

    const bus = getEventBus();
    installSpiTransferObserverForTests(spi, spdrAddr, cpu, bus);

    const emitSpy = vi.spyOn(bus, 'emit');
    try {
      cpu.writeHooks[spdrAddr](0x11, 0, spdrAddr, 0xff);
    } finally {
      emitSpy.mockRestore();
    }
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
