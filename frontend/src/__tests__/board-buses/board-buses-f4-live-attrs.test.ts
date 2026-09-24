/**
 * Board buses F4: the live inputs of a hosted responder, as the tab sends them
 * (project/board-buses-2026-09, F4).
 *
 * A responder with a portable model runs beside a guest the tab does not hold
 * (a QEMU worker, a Raspberry Pi guest). The bus map ships the model once per
 * membership change, and it is heavy: the artifact, and for a card its whole
 * image. The inputs of a touch panel, an ADC or a thermocouple move at the
 * rate of a finger, a circuit solve or a slider, so they travel on their own:
 * a device declares `remoteAttrs()`, calls `BusHandle.attrsChanged()` when
 * they may have moved, and the registry hands the host `{owner, attrs}`.
 *
 * Pinned here: what the registry sends and when (only a placed device with a
 * model, only when something changed, never "already sent" when a map carried
 * something newer), and the three wires it goes out on: `esp32_bus_attrs`,
 * `stm32_bus_attrs` and the Pi relay's `pi_bus_attrs`. The six real parts that
 * use it are pinned in the overlay
 * (pro/frontend/src/pro/__tests__/board-buses-live-inputs.test.ts).
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

import { useSimulatorStore, getEsp32Bridge } from '../../store/useSimulatorStore';
import { Stm32Bridge } from '../../simulation/Stm32Bridge';
import { RemoteSpiLane, attachSpiDevice, busRegistry } from '../../simulation/buses';
import type { BusHandle, RemoteSpiMapEntry } from '../../simulation/buses';

const ESP32_SPI = { SCK: 'D18', MOSI: 'D23', MISO: 'D19', CS: 'D15' };
const WASM_B64 = 'AGFzbQEAAAA=';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
});

function wire(boardId: string, componentId: string): void {
  const wires = Object.entries(ESP32_SPI).map(([pinName, pad], i) => ({
    id: `${componentId}-w${i}`,
    start: { componentId, pinName, x: 0, y: 0 },
    end: { componentId: boardId, pinName: pad, x: 0, y: 0 },
    waypoints: [],
    color: '#0a0',
  }));
  useSimulatorStore.setState((s) => ({ wires: [...s.wires, ...wires] }) as never);
}

/** A responder whose one input is `level`, changed through `set`. */
function responder(
  boardId: string | null,
  owner: string,
  opts: { model?: boolean } = {},
): { set(v: number): void; quiet(v: number): void; handle: BusHandle } {
  if (boardId) wire(boardId, owner);
  let level = 1;
  const handle = attachSpiDevice(
    {
      owner,
      pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' },
      ...(opts.model === false ? {} : { remoteModel: () => ({ wasmB64: WASM_B64 }) }),
      remoteAttrs: () => ({ level }),
    },
    { transfer: () => 0x01 },
  );
  cleanups.push(() => handle.dispose());
  return {
    handle,
    set(v: number) {
      level = v;
      handle.attrsChanged();
    },
    /** Move the input without telling the handle. */
    quiet(v: number) {
      level = v;
    },
  };
}

function listen(): Array<[string, string, Record<string, number>]> {
  const out: Array<[string, string, Record<string, number>]> = [];
  cleanups.push(busRegistry.onSpiAttrsChange((b, o, a) => out.push([b, o, a])));
  return out;
}

function qemuBoard() {
  const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
  getEsp32Bridge(id)!.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return { id, ws };
}

// ── The registry ────────────────────────────────────────────────────────────

describe('live inputs: what the registry sends', () => {
  it('names the board the device is on, its owner and every input', () => {
    const { id } = qemuBoard();
    const heard = listen();
    const r = responder(id, 'adc1');
    r.set(7);
    expect(heard).toEqual([[id, 'adc1', { level: 7 }]]);
  });

  it('sends nothing when nothing changed', () => {
    const { id } = qemuBoard();
    const heard = listen();
    const r = responder(id, 'adc1');
    r.set(7);
    r.set(7);
    r.handle.attrsChanged();
    expect(heard).toHaveLength(1);
  });

  it('sends nothing for a device that is on no bus', () => {
    // No host could be running it: its wires reach no controller.
    qemuBoard();
    const heard = listen();
    responder(null, 'loose').set(7);
    expect(heard).toEqual([]);
  });

  it('sends nothing for a device with no portable model', () => {
    // Nothing hosts it; the bus reports it as missing instead.
    const { id } = qemuBoard();
    const heard = listen();
    responder(id, 'adc1', { model: false }).set(7);
    expect(heard).toEqual([]);
  });

  it('sends nothing through a handle that was disposed', () => {
    const { id } = qemuBoard();
    const heard = listen();
    const r = responder(id, 'adc1');
    r.handle.dispose();
    r.set(7);
    expect(heard).toEqual([]);
  });

  it('counts a map as sent, so a value the map superseded is sent again', () => {
    // 5 goes as an update, 9 only inside a map, then 5 again. The host holds
    // 9 at that point; skipping the last update as "already sent" would leave
    // it there.
    const { id } = qemuBoard();
    const heard = listen();
    const r = responder(id, 'adc1');
    r.set(5);
    r.quiet(9);
    // A map goes out (an artifact that landed late republishes every board)
    // and carries 9.
    const maps: string[] = [];
    cleanups.push(busRegistry.onSpiMapChange((b) => maps.push(b)));
    busRegistry.spiModelsChanged();
    expect(maps).toContain(id);
    expect(busRegistry.remoteSpiMap(id)[0].model.attrs).toEqual({ level: 9 });
    r.set(5);
    expect(heard.map((h) => h[2].level)).toEqual([5, 5]);
  });

  it('carries the inputs of NOW in the map itself', () => {
    const { id } = qemuBoard();
    const r = responder(id, 'adc1');
    r.set(42);
    const entry = busRegistry.remoteSpiMap(id).find((e) => e.owner === 'adc1')!;
    expect(entry.model.attrs).toEqual({ level: 42 });
  });
});

// ── On the wire ─────────────────────────────────────────────────────────────

describe('live inputs: the QEMU ESP32 socket', () => {
  it('goes out as esp32_bus_attrs', () => {
    const { id, ws } = qemuBoard();
    responder(id, 'adc1').set(3);
    expect(ws.sent.filter((m) => m.type === 'esp32_bus_attrs')).toEqual([
      { type: 'esp32_bus_attrs', data: { owner: 'adc1', attrs: { level: 3 } } },
    ]);
  });

  it('lands in the map the next start replays, while the socket is closed', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const r = responder(id, 'adc1');
    r.set(3);
    getEsp32Bridge(id)!.connect();
    const ws = ScriptedSocket.last!;
    ws.open();
    const start = ws.sent.find((m) => m.type === 'start_esp32')!;
    const spi = (start.data!.bus_map as { spi: RemoteSpiMapEntry[] }).spi;
    expect(spi.find((e) => e.owner === 'adc1')!.model.attrs).toEqual({ level: 3 });
  });
});

describe('live inputs: the STM32 socket', () => {
  it('goes out as stm32_bus_attrs, and the stored map takes it for the next start', () => {
    const bridge = new Stm32Bridge('stm-1', 'blue-pill' as never);
    bridge.sendBusMap([{ owner: 'adc1', model: { attrs: { level: 1 } } }]);
    bridge.sendBusAttrs('adc1', { level: 4 });
    bridge.connect();
    const ws = ScriptedSocket.last!;
    ws.open();
    const start = ws.sent.find((m) => m.type === 'start_stm32');
    expect(
      ((start?.data?.bus_map as { spi: Array<{ model: { attrs: unknown } }> })?.spi ?? [])[0]
        ?.model.attrs,
    ).toEqual({ level: 4 });
    bridge.sendBusAttrs('adc1', { level: 5 });
    expect(ws.sent.filter((m) => m.type === 'stm32_bus_attrs')).toEqual([
      { type: 'stm32_bus_attrs', data: { owner: 'adc1', attrs: { level: 5 } } },
    ]);
    bridge.disconnect();
  });
});

describe('live inputs: the lane', () => {
  it('hands the attrs to its sender and survives a sender that throws', () => {
    const got: unknown[] = [];
    const lane = new RemoteSpiLane('b', 'esp32', () => {}, (o, a) => got.push([o, a]));
    lane.pushAttrs('x', { v: 1 });
    expect(got).toEqual([['x', { v: 1 }]]);
    const broken = new RemoteSpiLane('b', 'esp32', () => {}, () => {
      throw new Error('socket gone');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => broken.pushAttrs('x', { v: 1 })).not.toThrow();
    warn.mockRestore();
  });
});
