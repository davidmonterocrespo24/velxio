/**
 * Board buses F5: the I2C half of a QEMU board's bus map, as the tab sends it
 * (project/board-buses-2026-09, F5-SPEC "Motores", finding
 * worker-i2c-slaves-ignore-bus-id, browser half).
 *
 * An ESP32 or STM32 on QEMU answers every I2C event from models in its worker,
 * so what the tab owes the worker is the circuit: which controller each I2C
 * target is wired to. The worker keeps its targets by (controller, address)
 * and places each one by the map (app/services/i2c_bus_table.py,
 * test/backend/unit/test_board_buses_f5_worker_i2c.py).
 *
 * Pinned here, on the store's own boards with their real bridges and shims:
 *  - the map rides in the start config and names every target the fabric
 *    placed, by owner, with its SDA and SCL pins;
 *  - an STM32 target's controller is named from the pin table; an ESP32's is
 *    left to the worker (the GPIO matrix picks Wire1's pins at run time), so
 *    its entry carries the pad instead;
 *  - a target whose SCL is not the bus's clock is on no bus, and its entry
 *    says so;
 *  - a target that arrives or leaves mid-run sends the I2C half alone, never
 *    the SPI half again;
 *  - the QEMU boards publish their I2C controllers to the fabric as ports.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});
vi.stubGlobal('document', { getElementById: () => null });

class ScriptedSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: ScriptedSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  sent: Array<{ type: string; data?: Record<string, unknown> }> = [];
  constructor(_url: string) {
    ScriptedSocket.last = this;
  }
  send(frame: string): void {
    this.sent.push(JSON.parse(frame));
  }
  close(): void {
    this.readyState = ScriptedSocket.CLOSED;
  }
  open(): void {
    this.readyState = ScriptedSocket.OPEN;
    this.onopen?.();
  }
}
vi.stubGlobal('WebSocket', ScriptedSocket);

import {
  getBoardSimulator,
  getEsp32Bridge,
  getStm32Bridge,
  useSimulatorStore,
} from '../../store/useSimulatorStore';
import { attachI2cTarget, busRegistry } from '../../simulation/buses';
import type { I2cTarget } from '../../simulation/buses';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
});

const TARGET: I2cTarget = {
  start: () => true,
  write: () => true,
  read: () => 0xff,
  stop: () => {},
};

/** An I2C target `owner` at `address`, its SDA and SCL wired to the board
 *  pads named `sda` / `scl`. */
function target(boardId: string, owner: string, sda: string, scl: string, address = 0x76) {
  const wires = [
    ['SDA', sda],
    ['SCL', scl],
  ].map(([pinName, pad], i) => ({
    id: `${owner}-w${i}`,
    start: { componentId: owner, pinName, x: 0, y: 0 },
    end: { componentId: boardId, pinName: pad, x: 0, y: 0 },
    waypoints: [],
    color: '#0a0',
  }));
  useSimulatorStore.setState((s) => ({ wires: [...s.wires, ...wires] }) as never);
  busRegistry.netlistChanged();
  const handle = attachI2cTarget({ owner, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [address] }, TARGET);
  cleanups.push(() => handle.dispose());
  return handle;
}

function startEsp32(id: string): ScriptedSocket {
  getEsp32Bridge(id)!.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return ws;
}

function startStm32(id: string): ScriptedSocket {
  getStm32Bridge(id)!.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return ws;
}

const busMapOf = (ws: ScriptedSocket, type: string) =>
  ws.sent.find((m) => m.type === type)?.data?.bus_map as { spi: unknown[]; i2c?: unknown[] };

const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe('QEMU ESP32: the I2C half of the start map', () => {
  it('names each placed target with its pins, and leaves the controller to the worker', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    target(id, 'bmp-a', 'D21', 'D22');
    target(id, 'bmp-b', 'D25', 'D26');
    const ws = startEsp32(id);
    expect(busMapOf(ws, 'start_esp32').i2c).toEqual([
      { owner: 'bmp-a', bus_id: null, sda: 21, scl: 22, addresses: [0x76] },
      { owner: 'bmp-b', bus_id: null, sda: 25, scl: 26, addresses: [0x76] },
    ]);
  });

  it('marks a target whose SCL is not the bus clock as on no bus', () => {
    // SDA on Wire's pad, SCL on another pin: the chip never sees Wire's clock.
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    target(id, 'bmp-a', 'D21', 'D26');
    const ws = startEsp32(id);
    expect(busMapOf(ws, 'start_esp32').i2c).toEqual([
      { owner: 'bmp-a', bus_id: null, sda: null, scl: null, addresses: [0x76] },
    ]);
  });

  it('setup: publishes the board I2C controllers to the fabric as ports', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    target(id, 'bmp-a', 'D21', 'D22');
    const binding = (getBoardSimulator(id) as unknown as {
      getBusBinding(): { i2c?: Array<{ unit: number; name: string }> };
    }).getBusBinding();
    expect(binding.i2c?.map((p) => [p.unit, p.name])).toEqual([
      [0, 'I2C0'],
      [1, 'I2C1'],
    ]);
    expect(busRegistry.fabric(id).i2cBuses.get(21)?.controllerName).toBe('I2C0');
  });
});

describe('QEMU STM32: the I2C half of the start map', () => {
  it('names the controller from the pin table: PB7 is I2C1 (0), PB11 is I2C2 (1)', () => {
    const id = useSimulatorStore.getState().addBoard('stm32-bluepill', 0, 0);
    target(id, 'mpu-a', 'PB7', 'PB6', 0x68);
    target(id, 'mpu-b', 'PB11', 'PB10', 0x68);
    const ws = startStm32(id);
    expect(busMapOf(ws, 'start_stm32').i2c).toEqual([
      { owner: 'mpu-a', bus_id: 0, sda: 23, scl: 22, addresses: [0x68] },
      { owner: 'mpu-b', bus_id: 1, sda: 27, scl: 26, addresses: [0x68] },
    ]);
  });
});

describe('QEMU ESP32: a target that arrives or leaves mid-run', () => {
  it('sends the I2C half alone, with the SPI half untouched', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const ws = startEsp32(id);
    const before = ws.sent.length;
    const shim = getBoardSimulator(id) as unknown as {
      registerSensor(t: string, p: number, props: Record<string, unknown>): boolean;
      unregisterSensor(p: number): void;
    };
    const handle = target(id, 'bmp-a', 'D21', 'D22');
    shim.registerSensor('bmp280', 276, { addr: 0x76, owner: 'bmp-a' });
    await flush();
    const maps = ws.sent.slice(before).filter((m) => m.type === 'esp32_bus_map');
    expect(maps).toEqual([
      {
        type: 'esp32_bus_map',
        data: { i2c: [{ owner: 'bmp-a', bus_id: null, sda: 21, scl: 22, addresses: [0x76] }] },
      },
    ]);
    // Leaving: the next look finds it gone and says so, once.
    handle.dispose();
    shim.unregisterSensor(276);
    await flush();
    const after = ws.sent.slice(before).filter((m) => m.type === 'esp32_bus_map');
    expect(after.map((m) => m.data)).toEqual([maps[0].data, { i2c: [] }]);
  });

  it('sends nothing when the I2C half did not change', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    target(id, 'bmp-a', 'D21', 'D22');
    const ws = startEsp32(id);
    const before = ws.sent.length;
    const shim = getBoardSimulator(id) as unknown as {
      registerSensor(t: string, p: number, props: Record<string, unknown>): boolean;
    };
    shim.registerSensor('dht22', 4, {});
    await flush();
    expect(ws.sent.slice(before).filter((m) => m.type === 'esp32_bus_map')).toEqual([]);
  });
});
