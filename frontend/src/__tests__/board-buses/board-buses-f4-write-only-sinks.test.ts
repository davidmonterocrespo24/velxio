/**
 * Board buses F4: "does this device ever answer" is the model's to say
 * (project/board-buses-2026-09, STATUS "F4 veredicto de cierre", defect 2a).
 *
 * The bus used to decide that a device drives MISO from its descriptor alone:
 * a declared `miso` pin that resolves on the board. The OSS ILI9341 declares
 * one, because the real panel has an SDO leg and users wire it (it shares SCK,
 * MOSI and MISO with the SD card or the touch controller on most modules), but
 * the model implements no read command and never answers. On a QEMU board,
 * which is every ESP32 in the OSS image, that made the registry name the panel
 * as a responder with no portable model: a false `bus-remote-responder-missing`
 * on a completely normal TFT + SD wiring, shown to every self-hoster.
 *
 * What decides it now is `SpiDevice.writeOnly`, a property of the model. The
 * pin stays declared, so the wiring checks about that leg still run.
 *
 * Rig: the one board-buses-repro-qemu-shim.test.ts uses. The real store, the
 * real Esp32Bridge behind the real shim, a scripted socket in place of the
 * WebSocket, and the real ILI9341 part from PartSimulationRegistry.
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
  receive(type: string, data: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}
vi.stubGlobal('WebSocket', ScriptedSocket);

import { useSimulatorStore, getBoardSimulator, getEsp32Bridge } from '../../store/useSimulatorStore';
import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import '../../simulation/parts';
import { attachSpiDevice, busRegistry } from '../../simulation/buses';
import type { BusDiagnostic, RemoteSpiMapEntry } from '../../simulation/buses';

// VSPI on an ESP32 DevKit, as every Arduino SPI sketch gets it by default.
const ESP32_SPI = { SCK: 'D18', MOSI: 'D23', MISO: 'D19' };
const TFT_CS = 15;
const TFT_DC = 2;
const SD_CS = 5;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
  busRegistry.resetDiagnostics();
});

function wire(boardId: string, componentId: string, pads: Record<string, string>): void {
  const wires = Object.entries(pads).map(([pinName, pad], i) => ({
    id: `${componentId}-w${i}`,
    start: { componentId, pinName, x: 0, y: 0 },
    end: { componentId: boardId, pinName: pad, x: 0, y: 0 },
    waypoints: [],
    color: '#0a0',
  }));
  useSimulatorStore.setState((s) => ({ wires: [...s.wires, ...wires] }) as never);
}

/** A canvas that keeps the last picture, so the test can see the panel paint. */
function tftElement(id: string) {
  let last: { data: Uint8ClampedArray } | null = null;
  const ctx = {
    fillStyle: '',
    createImageData: (w: number, h: number) => (last = { data: new Uint8ClampedArray(w * h * 4) }),
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
    painted: () => last !== null && last.data.some((v) => v !== 0),
  };
}

function qemuBoard() {
  const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
  const shim = getBoardSimulator(id);
  const bridge = getEsp32Bridge(id)!;
  return { id, shim, bridge };
}

function connect(bridge: { connect(): void }) {
  bridge.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return ws;
}

/** The REAL ILI9341 part, with the pads it is wired to on this canvas. */
function ili9341(boardId: string, shim: unknown, pads: Record<string, string>) {
  const tft = tftElement('tft1');
  wire(boardId, 'tft1', { ...pads, CS: `D${TFT_CS}`, 'D/C': `D${TFT_DC}` });
  const pinOf = (name: string) => (name === 'D/C' ? TFT_DC : name === 'CS' ? TFT_CS : null);
  cleanups.push(
    PartSimulationRegistry.get('ili9341')!.attachEvents!(
      tft as unknown as HTMLElement,
      shim as never,
      pinOf,
      'tft1',
    ),
  );
  return tft;
}

function collect(): BusDiagnostic[] {
  const seen: BusDiagnostic[] = [];
  cleanups.push(busRegistry.onDiagnostic((d) => seen.push(d)));
  return seen;
}

const missing = (seen: BusDiagnostic[]) =>
  seen.filter((d) => d.code === 'bus-remote-responder-missing').map((d) => d.owners.join(','));

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

/** The guest selects the panel and paints a few pixels, the way the worker
 *  relays it: CS edge, D/C edge, then the bytes clocked under it. */
function paint(ws: ScriptedSocket): void {
  ws.receive('gpio_change', { pin: TFT_CS, state: 0 });
  ws.receive('gpio_change', { pin: TFT_DC, state: 0 });
  ws.receive('spi_batch', { b64: b64([0x2a]) });
  ws.receive('gpio_change', { pin: TFT_DC, state: 1 });
  ws.receive('spi_batch', { b64: b64([0x00, 0x00, 0x00, 0x03]) });
  ws.receive('gpio_change', { pin: TFT_DC, state: 0 });
  ws.receive('spi_batch', { b64: b64([0x2b]) });
  ws.receive('gpio_change', { pin: TFT_DC, state: 1 });
  ws.receive('spi_batch', { b64: b64([0x00, 0x00, 0x00, 0x00]) });
  ws.receive('gpio_change', { pin: TFT_DC, state: 0 });
  ws.receive('spi_batch', { b64: b64([0x2c]) });
  ws.receive('gpio_change', { pin: TFT_DC, state: 1 });
  ws.receive('spi_batch', { b64: b64([0xf8, 0x00, 0xf8, 0x00, 0x07, 0xe0, 0x07, 0xe0]) });
  ws.receive('gpio_change', { pin: TFT_CS, state: 1 });
}

describe('a write-only panel with its MISO wired, on a QEMU board', () => {
  it('is not reported as a responder the worker cannot host, and still paints', async () => {
    const { id, shim, bridge } = qemuBoard();
    const seen = collect();
    const tft = ili9341(id, shim, ESP32_SPI);
    const ws = connect(bridge);
    paint(ws);
    // The panel's paint is debounced on a timer.
    await new Promise((r) => setTimeout(r, 150));
    expect(busRegistry.placement('tft1')?.boardId, 'the panel is on the board bus').toBe(id);
    expect(tft.painted(), 'the bytes reached the panel').toBe(true);
    expect(missing(seen)).toEqual([]);
  });

  it('is not reported beside a card and a touch controller on the same three wires', () => {
    // The wiring the defect was found on: a TFT module whose SDO is on the bus
    // it shares with its touch controller and an SD slot. The card carries a
    // portable model; the touch here does NOT, so it is the only one named.
    const { id, shim, bridge } = qemuBoard();
    const seen = collect();
    ili9341(id, shim, ESP32_SPI);
    wire(id, 'sd1', { ...ESP32_SPI, CS: `D${SD_CS}` });
    const sd = attachSpiDevice(
      {
        owner: 'sd1',
        pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' },
        remoteModel: () => ({ wasmB64: 'AGFzbQEAAAA=' }),
      },
      { transfer: () => 0xff },
    );
    cleanups.push(() => sd.dispose());
    wire(id, 'touch1', { ...ESP32_SPI, CS: 'D4' });
    const touch = attachSpiDevice(
      { owner: 'touch1', pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } },
      { transfer: () => 0x00 },
    );
    cleanups.push(() => touch.dispose());
    const ws = connect(bridge);
    for (const cs of [TFT_CS, SD_CS, 4]) {
      ws.receive('gpio_change', { pin: cs, state: 0 });
      ws.receive('gpio_change', { pin: cs, state: 1 });
    }
    expect(missing(seen)).toEqual(['touch1']);
    // And the panel does not travel to the worker either: it has nothing to
    // answer with, so the responders in the map are the card alone. The map
    // may end with the sinks the tab keeps (no `owner`), and the panel belongs
    // there: its pixels are drawn in this tab.
    const maps = ws.sent
      .filter((m) => m.type === 'start_esp32' || m.type === 'esp32_bus_map')
      .map((m) =>
        ((m.type === 'start_esp32'
          ? (m.data?.bus_map as { spi?: unknown[] })?.spi
          : m.data?.spi) ?? []) as Array<Partial<RemoteSpiMapEntry>>,
      );
    const last = maps.at(-1) ?? [];
    expect(last.filter((e) => e.owner !== undefined).map((e) => e.owner)).toEqual(['sd1']);
  });

  it('is not told to wire a MISO it would never drive', () => {
    // Most ILI9341 builds leave SDO open. "Wire it or the chip never answers"
    // is advice about an answer this model does not have.
    const { id, shim } = qemuBoard();
    const seen = collect();
    ili9341(id, shim, { SCK: ESP32_SPI.SCK, MOSI: ESP32_SPI.MOSI });
    expect(busRegistry.placement('tft1')?.boardId).toBe(id);
    expect(seen.filter((d) => d.code === 'spi-wiring')).toEqual([]);
  });
});

describe('a responder with no portable model is still named', () => {
  it('even when it happens to answer nothing: the model says what it is, not its bytes', () => {
    // A responder whose first bytes are idle (a card before CMD0, a touch
    // controller between conversions) is still a responder. Only a model that
    // declares itself write-only is taken off the list; silence is not a
    // declaration.
    const { id, bridge } = qemuBoard();
    const seen = collect();
    wire(id, 'adc1', { ...ESP32_SPI, CS: `D${SD_CS}` });
    const adc = attachSpiDevice(
      { owner: 'adc1', pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } },
      { transfer: () => null },
    );
    cleanups.push(() => adc.dispose());
    const ws = connect(bridge);
    ws.receive('gpio_change', { pin: SD_CS, state: 0 });
    expect(missing(seen)).toEqual(['adc1']);
  });

  it('and a device that leaves out writeOnly is a candidate driver, on a local engine too', () => {
    // The default has to be the safe side: a responder mistaken for a sink
    // reads idle silently, a sink mistaken for a responder only warns.
    const id = useSimulatorStore.getState().addBoard('raspberry-pi-pico', 0, 0);
    const seen = collect();
    wire(id, 'adc1', { SCK: 'GP18', MOSI: 'GP19', MISO: 'GP16' });
    const adc = attachSpiDevice(
      { owner: 'adc1', pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO' } },
      { transfer: () => 0x5a },
    );
    cleanups.push(() => adc.dispose());
    wire(id, 'tft1', { SCK: 'GP18', MOSI: 'GP19', MISO: 'GP16' });
    const tft = attachSpiDevice(
      { owner: 'tft1', pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO' } },
      { writeOnly: true, transfer: () => 0x00 },
    );
    cleanups.push(() => tft.dispose());
    // Both are selected (no CS line): only the one that can answer drives, so
    // there is no contention and the answer is the ADC's.
    const contention = seen.filter((d) => d.code === 'spi-contention');
    expect(contention).toEqual([]);
    const bus = busRegistry.fabric(id).busFor(18);
    expect(bus.frame(0x00, 8)).toBe(0x5a);
    expect(seen.filter((d) => d.code === 'spi-contention')).toEqual([]);
  });
});
