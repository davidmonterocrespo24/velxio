/**
 * Board buses F0: reproduction of the "qemu" findings that live in the browser
 * (project/board-buses-2026-09, evidence/f0-repro-areas.json).
 *
 * An ESP32 board on the backend QEMU engine: the store's own addBoard builds
 * the real Esp32Bridge and Esp32BridgeShim, the real ILI9341 model from
 * PartSimulationRegistry attaches to the shim's `spi` adapter, and the real
 * custom-chips SPI node (simulatorBridges.ensureSpiBridge, the call a Grove
 * module's browser copy makes on every board) joins the same chain. What the
 * worker would send arrives through the WebSocket exactly as the backend
 * relays it (`gpio_change`, then `spi_batch` with the MOSI bytes in base64);
 * what the tab sends back is read off the same socket. The socket is the only
 * stand-in, plus the canvas the panel paints on (a context that keeps the
 * pixels) and window.setTimeout (its paint debounce).
 *
 * The bytes in a `spi_batch` were clocked by the guest before the batch was
 * sent (esp32_worker.py batches them and returns _spi_response[0] at byte
 * time), so no answer the tab gives for them can reach those transfers.
 *
 * Convention (TESTS.md): `it.fails` marks a finding reproduced today, stating
 * the hardware-faithful behaviour; its `setup` sibling proves the rig works.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});

/** The socket the bridge opens. Records every frame the tab sends. */
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
  constructor(readonly url: string) {
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
  /** One event as the backend relays a worker line: {type, data: {...}}. */
  receive(type: string, data: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}
vi.stubGlobal('WebSocket', ScriptedSocket);

import { useSimulatorStore, getBoardSimulator, getEsp32Bridge } from '../../store/useSimulatorStore';
import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import '../../simulation/parts';
import { ensureSpiBridge, hostsChipsInWorker } from '../../simulation/customChips/simulatorBridges';

// ── Rig ──────────────────────────────────────────────────────────────────────

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function tftElement(id: string) {
  const created: Pixels[] = [];
  const ctx = {
    fillStyle: '',
    createImageData: (w: number, h: number): Pixels => {
      const d = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      created.push(d);
      return d;
    },
    putImageData: () => {},
    clearRect: () => {},
    fillRect: () => {},
  };
  return {
    id,
    canvas: { getContext: () => ctx },
    addEventListener: () => {},
    removeEventListener: () => {},
    getAttribute: () => null,
    framebuffer: () => created[created.length - 1] ?? null,
  };
}

const TFT_CS = 15;
const TFT_DC = 2;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
});

/** An ESP32 DevKit on the QEMU engine, connected, with the given parts. */
function qemuBoard(opts: { tft?: boolean; chipsBridge?: boolean }) {
  const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
  const shim = getBoardSimulator(id) as unknown as { spi: unknown };
  const bridge = getEsp32Bridge(id)!;
  let tft: ReturnType<typeof tftElement> | null = null;
  if (opts.tft) {
    tft = tftElement('tft1');
    const pinOf = (name: string) => (name === 'D/C' ? TFT_DC : name === 'CS' ? TFT_CS : null);
    const off = PartSimulationRegistry.get('ili9341')!.attachEvents!(
      tft as unknown as HTMLElement,
      shim as never,
      pinOf,
      'tft1',
    );
    cleanups.push(off);
  }
  if (opts.chipsBridge) ensureSpiBridge(shim);
  bridge.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return { ws, tft, bridge, shim };
}

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

/** What the worker sends for one DC-framed stretch of bus traffic: the pin
 *  change first (it flushes its batch before every gpio_change), then the
 *  bytes the guest clocked under that DC level. */
function replay(ws: ScriptedSocket, dc: 0 | 1, bytes: number[]): void {
  ws.receive('gpio_change', { pin: TFT_DC, state: dc });
  ws.receive('spi_batch', { b64: b64(bytes) });
}

/** One full RGB565 row (240 pixels) at y = 0: CASET, PASET, RAMWR, pixels. */
const ROW = Array.from({ length: 240 }, (_, i) => ((i * 0x0841) ^ 0xf81f) & 0xffff);
function drawRow(ws: ScriptedSocket): number {
  ws.receive('gpio_change', { pin: TFT_CS, state: 0 });
  replay(ws, 0, [0x2a]);
  replay(ws, 1, [0x00, 0x00, 0x00, 0xef]);
  replay(ws, 0, [0x2b]);
  replay(ws, 1, [0x00, 0x00, 0x00, 0x00]);
  replay(ws, 0, [0x2c]);
  const px = ROW.flatMap((c) => [c >> 8, c & 0xff]);
  replay(ws, 1, px);
  ws.receive('gpio_change', { pin: TFT_CS, state: 1 });
  return 1 + 4 + 1 + 4 + 1 + px.length;
}

function rowOnPanel(tft: ReturnType<typeof tftElement>): number[] {
  const fb = tft.framebuffer();
  if (!fb) return [];
  const out: number[] = [];
  for (let x = 0; x < 240; x++) {
    const i = x * 4;
    out.push(((fb.data[i] >> 3) << 11) | ((fb.data[i + 1] >> 2) << 5) | (fb.data[i + 2] >> 3));
  }
  return out;
}

const misoFrames = (ws: ScriptedSocket) => ws.sent.filter((m) => m.type === 'esp32_spi_response');

// ── esp32-qemu-miso-ws-flood, qemu-shim-miso-ws-per-byte ─────────────────────

describe('QEMU ESP32 shim: MISO answers for bytes the guest already clocked', () => {
  it('esp32-qemu-miso-ws-flood, qemu-shim-miso-ws-per-byte setup: the replayed batches reach the ILI9341 and it draws the row exactly', () => {
    const { ws, tft } = qemuBoard({ tft: true });
    const clocked = drawRow(ws);
    expect(clocked).toBe(491);
    expect(rowOnPanel(tft!)).toEqual(ROW);
  });

  it.fails('esp32-qemu-miso-ws-flood, qemu-shim-miso-ws-per-byte: replaying a write-only row into the ILI9341 sends at most one esp32_spi_response, not one per byte', () => {
    const { ws } = qemuBoard({ tft: true });
    drawRow(ws);
    expect(misoFrames(ws).length).toBeLessThanOrEqual(1);
  });
});

// ── qemu-chip-node-floods-spi-response ───────────────────────────────────────

describe('QEMU ESP32 shim: the custom-chips SPI node with no chip on the bus', () => {
  it('qemu-chip-node-floods-spi-response setup: the board hosts its chips in the worker, and with the chips bridge installed the batches still reach the ILI9341 and the row is exact', () => {
    const { ws, tft, shim } = qemuBoard({ tft: true, chipsBridge: true });
    expect(hostsChipsInWorker(shim)).toBe(true);
    drawRow(ws);
    expect(rowOnPanel(tft!)).toEqual(ROW);
  });

  it.fails('qemu-chip-node-floods-spi-response: on a board whose chips run in the worker, the browser chips node sends no esp32_spi_response per replayed byte', () => {
    const { ws } = qemuBoard({ chipsBridge: true });
    drawRow(ws);
    expect(misoFrames(ws).length).toBeLessThanOrEqual(1);
  });
});

// ── worker-i2c-slaves-ignore-bus-id (the browser half) ───────────────────────

/** The field a sensor record uses for its I2C controller (Wire = 0, Wire1 =
 *  1); nothing sends it today. Same name as the worker tests use
 *  (test/backend/unit/test_board_buses_repro_worker.py). */
const I2C_BUS_KEY = 'bus';

/** A BMP280 part (ProtocolParts 'bmp280') on the board, SDA/SCL on `sda`/`scl`. */
function mountBmp280(shim: unknown, id: string, temperature: number, sda: number, scl: number) {
  const el = { id, address: '0x76', temperature: String(temperature), pressure: '1013.25' };
  const pinOf = (name: string) => (name === 'SDA' ? sda : name === 'SCL' ? scl : null);
  return PartSimulationRegistry.get('bmp280')!.attachEvents!(
    el as unknown as HTMLElement,
    shim as never,
    pinOf,
    id,
  );
}

/** The sensor records the worker boots with: start_esp32's `sensors`. */
function bootSensors(id: string): Array<Record<string, unknown>> {
  getEsp32Bridge(id)!.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  const start = ws.sent.find((m) => m.type === 'start_esp32');
  return ((start?.data?.sensors as Array<Record<string, unknown>>) ?? []).filter(
    (s) => s.sensor_type === 'bmp280',
  );
}

describe('QEMU ESP32 board: two I2C sensors at one address on Wire and Wire1', () => {
  it('worker-i2c-slaves-ignore-bus-id setup: one BMP280 reaches the worker as a bmp280 record at 0x76 with its reading', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    cleanups.push(mountBmp280(getBoardSimulator(id), 'bmp-a', 20, 21, 22));
    const recs = bootSensors(id);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ addr: 0x76, temperature: 20 });
  });

  it.fails('worker-i2c-slaves-ignore-bus-id: a BMP280 on Wire (21/22) and one on Wire1 (25/26) reach the worker as two devices, each with its controller', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const shim = getBoardSimulator(id);
    cleanups.push(mountBmp280(shim, 'bmp-a', 20, 21, 22));
    cleanups.push(mountBmp280(shim, 'bmp-b', 30, 25, 26));
    const recs = bootSensors(id);
    expect(recs.map((r) => [r[I2C_BUS_KEY], r.temperature])).toEqual([
      [0, 20],
      [1, 30],
    ]);
    expect(new Set(recs.map((r) => r.pin)).size).toBe(2);
  });

  it.fails('worker-i2c-slaves-ignore-bus-id: deleting the Wire1 BMP280 leaves the Wire one on the board for the next Run', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const shim = getBoardSimulator(id);
    cleanups.push(mountBmp280(shim, 'bmp-a', 20, 21, 22));
    const offB = mountBmp280(shim, 'bmp-b', 30, 25, 26);
    offB();
    const recs = bootSensors(id);
    expect(recs.map((r) => r.temperature)).toEqual([20]);
  });
});
