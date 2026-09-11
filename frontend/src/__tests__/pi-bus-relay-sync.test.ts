// @vitest-environment jsdom
/**
 * pi-bus-relay-sync.test.ts — the board side of the backend bus relay.
 *
 * A Linux guest reads its I2C / SPI parts through the backend, which answers
 * what it can without asking the tab (an absent address, a register-file
 * device it holds a copy of) and relays the rest. For that the backend needs
 * the bus map and fresh registers, and only a backend that relays should get
 * them. Pinned here:
 *
 *  - nothing is published until the backend announces `bus_relay`; then the
 *    map goes out once, a register-file device WITH its 256 registers and a
 *    device that must be asked WITHOUT, and the board is marked busRelay;
 *  - afterwards only changes travel: a device whose registers changed pushes
 *    its registers, a device added or removed republishes the map, an
 *    unchanged bus sends nothing (compared byte for byte: the ESP32 proxy's
 *    sampled hash would miss a measurement register);
 *  - a disconnect stops the sync;
 *  - the real bridge answers a relayed read and stays silent on a `noreply`
 *    write, which the backend holds no request open for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sent = {
  topology: [] as unknown[],
  regs: [] as Array<[number, number, string]>,
};

vi.mock('../simulation/RaspberryPi3Bridge', () => ({
  RaspberryPi3Bridge: class {
    boardId: string;
    boardKind: string;
    connected = false;
    onSerialData: unknown = null;
    onPinChange: unknown = null;
    onPinPull: unknown = null;
    onBusRequest: unknown = null;
    onBusRelay: ((v: number) => void) | null = null;
    onGpioPwm: unknown = null;
    onBooted: unknown = null;
    onDisconnected: (() => void) | null = null;
    onError: unknown = null;
    quietBootDefault = false;
    quietBootLabel = '';
    constructor(id: string, kind: string) {
      this.boardId = id;
      this.boardKind = kind;
    }
    connect() {}
    disconnect() {}
    sendPinEvent() {}
    sendBusTopology(t: unknown) {
      sent.topology.push(t);
    }
    sendBusRegs(bus: number, addr: number, regs: string) {
      sent.regs.push([bus, addr, regs]);
    }
  },
}));

import { useSimulatorStore, getBoardSimulator, getBoardBridge } from '../store/useSimulatorStore';
import type { PiBridgeShim } from '../simulation/PiBridgeShim';
import { VirtualBMP280, VirtualDS3231 } from '../simulation/I2CBusManager';
import { PartSimulationRegistry } from '../simulation/parts';

type MockBridge = { onBusRelay: ((v: number) => void) | null; onDisconnected: (() => void) | null };

function addPi() {
  const id = useSimulatorStore.getState().addBoard('raspberry-pi-4' as never, 100, 100);
  return {
    id,
    shim: getBoardSimulator(id) as PiBridgeShim,
    bridge: getBoardBridge(id) as unknown as MockBridge,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.topology.length = 0;
  sent.regs.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the bus map goes to a relaying backend, and only then', () => {
  it('nothing is published before bus_relay; once announced, the map and the busRelay flag', () => {
    const { id, shim, bridge } = addPi();
    shim.addI2CDevice(new VirtualBMP280(0x76));
    const cleanup = PartSimulationRegistry.get('mpu6050')!.attachEvents!(
      document.createElement('div'),
      shim as never,
      () => null,
      'mpu-1',
    );
    vi.advanceTimersByTime(1000);
    expect(sent.topology).toEqual([]);

    bridge.onBusRelay!(1);
    expect(sent.topology).toHaveLength(1);
    const topo = sent.topology[0] as { i2c: Array<{ bus: number; addr: number; regs: string | null }>; spi: { attached: boolean } };
    const byAddr = new Map(topo.i2c.map((d) => [d.addr, d]));
    expect(byAddr.get(0x76)?.bus).toBe(1);
    expect(byAddr.get(0x76)?.regs).toMatch(/^[0-9a-f]{512}$/);
    // 0xD0 is the BMP280 chip id register: its copy must say 0x58.
    expect(byAddr.get(0x76)?.regs?.slice(0xd0 * 2, 0xd0 * 2 + 2)).toBe('58');
    expect(byAddr.get(0x68)?.regs).toBeNull(); // the MPU6050 is asked, not copied
    expect(topo.spi.attached).toBe(false);
    expect(useSimulatorStore.getState().boards.find((b) => b.id === id)?.busRelay).toBe(true);
    cleanup();
  });
});

describe('afterwards only changes travel', () => {
  it('a register write pushes that device once; an idle bus sends nothing', () => {
    const { shim, bridge } = addPi();
    shim.addI2CDevice(new VirtualBMP280(0x76));
    bridge.onBusRelay!(1);
    vi.advanceTimersByTime(1000);
    expect(sent.regs).toEqual([]);

    // ctrl_meas (0xF4) is a plain read/write register on the model.
    expect(shim.i2cTransfer(0x76, [0xf4, 0x27], 0)).toEqual([]);
    vi.advanceTimersByTime(260);
    expect(sent.regs).toHaveLength(1);
    expect(sent.regs[0][0]).toBe(1);
    expect(sent.regs[0][1]).toBe(0x76);
    expect(sent.regs[0][2].slice(0xf4 * 2, 0xf4 * 2 + 2)).toBe('27');

    vi.advanceTimersByTime(1000);
    expect(sent.regs).toHaveLength(1);
  });

  it('a device added after the announcement republishes the map', () => {
    const { shim, bridge } = addPi();
    shim.addI2CDevice(new VirtualBMP280(0x76));
    bridge.onBusRelay!(1);
    expect(sent.topology).toHaveLength(1);
    shim.addI2CDevice(new VirtualDS3231());
    vi.advanceTimersByTime(260);
    expect(sent.topology).toHaveLength(2);
    const addrs = (sent.topology[1] as { i2c: Array<{ addr: number }> }).i2c.map((d) => d.addr).sort();
    expect(addrs).toEqual([0x68, 0x76]);
  });

  it('an SPI listener flips spi.attached in the next map', () => {
    const { shim, bridge } = addPi();
    bridge.onBusRelay!(1);
    shim.spi.onByte = () => {};
    vi.advanceTimersByTime(260);
    expect((sent.topology.at(-1) as { spi: { attached: boolean } }).spi.attached).toBe(true);
  });

  it('a disconnect stops the sync', () => {
    const { shim, bridge } = addPi();
    shim.addI2CDevice(new VirtualBMP280(0x76));
    bridge.onBusRelay!(1);
    bridge.onDisconnected!();
    shim.i2cTransfer(0x76, [0xf4, 0x55], 0);
    shim.addI2CDevice(new VirtualDS3231());
    vi.advanceTimersByTime(2000);
    expect(sent.regs).toEqual([]);
    expect(sent.topology).toHaveLength(1);
  });
});

describe('the real bridge and a noreply write', () => {
  it('answers a relayed read, stays silent on a noreply write, announces bus_relay', async () => {
    const { RaspberryPi3Bridge } = await vi.importActual<typeof import('../simulation/RaspberryPi3Bridge')>(
      '../simulation/RaspberryPi3Bridge',
    );
    const frames: unknown[] = [];
    class FakeWS {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_url: string) {
        sockets.push(this);
      }
      send(s: string) {
        frames.push(JSON.parse(s));
      }
      close() {}
    }
    const sockets: FakeWS[] = [];
    const realWS = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWS;
    try {
      const bridge = new RaspberryPi3Bridge('raspberry-pi-4', 'raspberry-pi-4');
      const relayed: number[] = [];
      bridge.onBusRequest = (_rid, line) => (line.includes(' RR ') ? 'I2C_DATA 1 68 68' : null);
      bridge.onBusRelay = (v) => relayed.push(v);
      bridge.connect();
      const ws = sockets[0];
      ws.onopen?.();
      frames.length = 0;
      const deliver = (type: string, data: unknown) => ws.onmessage?.({ data: JSON.stringify({ type, data }) });
      deliver('pi_bus_request', { rid: 7, line: 'I2C 1 68 RR 75 1' });
      deliver('pi_bus_request', { rid: 8, line: 'I2C 1 68 WR 6b 00', noreply: true });
      deliver('system', { event: 'bus_relay', version: 1 });
      expect(frames).toEqual([{ type: 'pi_bus_reply', data: { rid: 7, line: 'I2C_DATA 1 68 68' } }]);
      expect(relayed).toEqual([1]);
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = realWS;
    }
  });
});
