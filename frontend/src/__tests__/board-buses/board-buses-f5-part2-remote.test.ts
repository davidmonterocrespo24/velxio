/**
 * Board buses F5, second part: a QEMU board's I2C map follows the circuit on
 * its own, and a part the worker cannot host is named (project
 * board-buses-2026-09, STATUS "F5 primera parte: cierre", items 5 and 6).
 *
 * On the store's own boards with their real bridges and shims, as
 * board-buses-f5-remote-i2c.test.ts does for the first part:
 *  - a wire moved mid-run sends the new I2C half of the map with no sensor
 *    attach behind it (before, it waited for the next registerSensor);
 *  - an owner the fabric holds but that is on none of this board's buses
 *    travels as `{unplaced: [...]}`, which the worker reads as "answer
 *    nothing" (app/services/i2c_bus_table.py);
 *  - a target on a QEMU board with no worker model raises
 *    `bus-remote-responder-missing`; one with a model the worker has does not.
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

import { getEsp32Bridge, useSimulatorStore } from '../../store/useSimulatorStore';
import { attachI2cTarget, busRegistry } from '../../simulation/buses';
import type { BusDiagnostic, I2cTarget } from '../../simulation/buses';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
  busRegistry.resetDiagnostics();
});

const TARGET: I2cTarget = { start: () => true, write: () => true, read: () => 0xff, stop: () => {} };

function wireTo(boardId: string, owner: string, sda: string | null, scl: string | null): void {
  const wires = (
    [
      ['SDA', sda],
      ['SCL', scl],
    ] as const
  )
    .filter(([, pad]) => pad !== null)
    .map(([pinName, pad]) => ({
      id: `${owner}-${pinName}`,
      start: { componentId: owner, pinName, x: 0, y: 0 },
      end: { componentId: boardId, pinName: pad, x: 0, y: 0 },
      waypoints: [],
      color: '#0a0',
    }));
  useSimulatorStore.setState(
    (s) => ({ wires: [...s.wires.filter((w) => !w.id.startsWith(`${owner}-`)), ...wires] }) as never,
  );
}

function target(boardId: string, owner: string, sda: string | null, scl: string | null, remoteModel?: string) {
  wireTo(boardId, owner, sda, scl);
  busRegistry.netlistChanged();
  const handle = attachI2cTarget(
    { owner, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x76], remoteModel },
    TARGET,
  );
  cleanups.push(() => handle.dispose());
  return handle;
}

function startEsp32(id: string): ScriptedSocket {
  getEsp32Bridge(id)!.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return ws;
}

/** Long enough for the store's netlist microtask, the registry's flush and the send. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

const i2cMaps = (ws: ScriptedSocket, from: number) =>
  ws.sent
    .slice(from)
    .filter((m) => m.type === 'esp32_bus_map')
    .map((m) => m.data?.i2c);

describe('QEMU ESP32: the I2C map follows a wire moved mid-run', () => {
  it('sends the new placement with no sensor attach behind it', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    target(id, 'bmp-a', 'D21', 'D22', 'bmp280');
    const ws = startEsp32(id);
    await settle();
    const before = ws.sent.length;
    // Only the circuit changes: the part stays mounted and registers nothing.
    wireTo(id, 'bmp-a', 'D25', 'D26');
    await settle();
    expect(i2cMaps(ws, before)).toEqual([
      [{ owner: 'bmp-a', bus_id: null, sda: 25, scl: 26, addresses: [0x76] }],
    ]);
  });

  it('a wire pulled off mid-run silences the target in the worker', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    target(id, 'bmp-a', 'D21', 'D22', 'bmp280');
    const ws = startEsp32(id);
    await settle();
    const before = ws.sent.length;
    wireTo(id, 'bmp-a', null, null);
    await settle();
    expect(i2cMaps(ws, before)).toEqual([[{ unplaced: ['bmp-a'] }]]);
  });
});

describe('QEMU ESP32: owners on none of the board buses', () => {
  it('travel in the start map as one unplaced entry, after the placed ones', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    target(id, 'bmp-a', 'D21', 'D22', 'bmp280');
    target(id, 'loose', null, null, 'bmp280');
    const ws = startEsp32(id);
    const start = ws.sent.find((m) => m.type === 'start_esp32')?.data?.bus_map as { i2c: unknown[] };
    expect(start.i2c).toEqual([
      { owner: 'bmp-a', bus_id: null, sda: 21, scl: 22, addresses: [0x76] },
      { unplaced: ['loose'] },
    ]);
  });
});

describe('QEMU boards: a target the worker has no model of', () => {
  function diagnostics(): BusDiagnostic[] {
    const seen: BusDiagnostic[] = [];
    cleanups.push(busRegistry.onDiagnostic((d) => seen.push(d)));
    return seen;
  }

  it('ESP32: a tab-only target is named, a worker-modelled one is not', () => {
    const seen = diagnostics();
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    target(id, 'tab-only', 'D21', 'D22');
    target(id, 'bmp-a', 'D21', 'D22', 'bmp280');
    const missing = seen.filter((d) => d.code === 'bus-remote-responder-missing');
    expect(missing.map((d) => [d.owners[0], d.bus, d.boardId])).toEqual([['tab-only', 'i2c', id]]);
  });

  it('STM32: the same rule on its controllers', () => {
    const seen = diagnostics();
    const id = useSimulatorStore.getState().addBoard('stm32-bluepill', 0, 0);
    target(id, 'tab-only', 'PB7', 'PB6');
    target(id, 'mpu', 'PB11', 'PB10', 'mpu6050');
    const missing = seen.filter((d) => d.code === 'bus-remote-responder-missing');
    expect(missing.map((d) => d.owners[0])).toEqual(['tab-only']);
  });

  it('an Uno (controller in the tab) never names it', () => {
    const seen = diagnostics();
    const id = useSimulatorStore.getState().addBoard('arduino-uno', 0, 0);
    target(id, 'tab-only', 'A4', 'A5');
    expect(seen.filter((d) => d.code === 'bus-remote-responder-missing')).toEqual([]);
  });
});
