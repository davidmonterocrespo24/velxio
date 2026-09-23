/**
 * Board buses: the "qemu" findings as seen from the browser
 * (project/board-buses-2026-09, evidence/f0-repro-areas.json).
 *
 * The boards here run in the backend QEMU worker: an ESP32 DevKit and an STM32
 * Blue Pill, built by the store's own addBoard, with the real Esp32Bridge /
 * Stm32Bridge behind the real Esp32BridgeShim / Stm32BridgeShim, and real parts
 * from PartSimulationRegistry (the OSS ILI9341, the OSS microSD card, a real
 * custom chip). What the worker would send arrives through the WebSocket
 * exactly as the backend relays it (`gpio_change`, then `spi_batch` with the
 * MOSI bytes in base64); what the tab sends back is read off the same socket.
 * The stand-ins are the socket, the canvas the panel paints on (a context that
 * keeps the pixels), window.setTimeout (the panel's paint debounce) and a
 * document with no elements in it (the chip part looks its element up there).
 *
 * WHAT THIS LANE IS SINCE F3. A part is on a bus because its pins are on that
 * bus's nets, and the bytes reach it from a controller PORT the engine adapter
 * publishes. The QEMU bridges have no port: Esp32BridgeShim.getBusBinding and
 * Stm32BridgeShim.getBusBinding hand the fabric the board's PINS and an empty
 * `spi` list until F4. So a device on a QEMU board is placed on the right bus
 * and its chip select follows the guest's `gpio_change`, and then it is handed
 * nothing: the MOSI bytes of a `spi_batch` reach no device in the tab, and no
 * device can answer MISO. That is what every case below states.
 *
 * The bytes in a `spi_batch` were clocked by the guest before the batch was
 * sent (esp32_worker.py batches them and returns _spi_response[0] at byte
 * time), so even a device that did get them could not answer them in time.
 * That is the shape of the F4 job: the responder has to live next to the
 * guest, and the browser device has to be fed as a block.
 *
 * Convention (TESTS.md), and how to tell the three states apart here:
 *  - `it.fails` + "F4, still broken": the hardware-faithful behaviour, not
 *    reached today. Its `setup` sibling proves the rig (board, wiring, fabric
 *    placement, chip select) so the it.fails can never pass on a broken rig.
 *  - `it.fails` + "F4, no longer reachable this way": the finding's own
 *    machinery (one esp32_spi_response per byte, applied to a later byte) is
 *    still in the product, but nothing drives it any more now that browser
 *    devices get no bytes on this lane. The case asserts BOTH halves, so it
 *    cannot pass by the lane staying dead.
 *  - plain `it` + "closed by F3": the finding's cause is gone; the case is the
 *    regression guard, and it asserts what replaced it, not an absence alone.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});
// The custom-chip part asks the document for its element (to paint a chip
// display). On this lane there is no element and no display.
vi.stubGlobal('document', { getElementById: () => null });

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
  readonly url: string;
  constructor(url: string) {
    this.url = url;
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

import {
  useSimulatorStore,
  getBoardSimulator,
  getEsp32Bridge,
} from '../../store/useSimulatorStore';
import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import '../../simulation/parts';
import { attachSpiDevice, busRegistry, isBusCapable } from '../../simulation/buses';
import type { EngineBinding } from '../../simulation/buses';
import { hostsChipsInWorker } from '../../simulation/customChips/simulatorBridges';
import { lineGaps } from '../../simulation/line/requestLine';

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

/** VSPI on an ESP32 DevKit: the pins every Arduino SPI sketch gets by default,
 *  and the pads they are silked as on the header. */
const TFT_CS = 15;
const TFT_DC = 2;
const ESP32_SPI = { SCK: 'D18', MOSI: 'D23', MISO: 'D19' };
const ESP32_PIN = { SCK: 18, MOSI: 23, MISO: 19 };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
});

/**
 * Wire a component's pins to a board's pads, as the canvas does. The fabric
 * walks these wires (PinTrace) to decide which bus the component is on, so a
 * part that is not wired is on no bus at all, here as in the app.
 */
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

/** The engine binding the fabric got for this board. */
function bindingOf(boardId: string): EngineBinding | null {
  const sim = getBoardSimulator(boardId);
  return isBusCapable(sim) ? sim.getBusBinding() : null;
}

/**
 * An ESP32 DevKit on the QEMU engine, connected, with an ILI9341 wired to VSPI
 * (CS GPIO15, D/C GPIO2) when asked for. The panel is a real part: it registers
 * itself on the bus its wires say, exactly as it does in the app.
 */
function qemuBoard(opts: { tft?: boolean }) {
  const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
  const shim = getBoardSimulator(id) as unknown as { spi: unknown };
  const bridge = getEsp32Bridge(id)!;
  let tft: ReturnType<typeof tftElement> | null = null;
  if (opts.tft) {
    tft = tftElement('tft1');
    wire(id, 'tft1', { ...ESP32_SPI, CS: `D${TFT_CS}`, 'D/C': `D${TFT_DC}` });
    const pinOf = (name: string) => (name === 'D/C' ? TFT_DC : name === 'CS' ? TFT_CS : null);
    const off = PartSimulationRegistry.get('ili9341')!.attachEvents!(
      tft as unknown as HTMLElement,
      shim as never,
      pinOf,
      'tft1',
    );
    cleanups.push(off);
  }
  bridge.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return { id, ws, tft, bridge, shim };
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

/**
 * A responder wired to the same bus as the panel: it counts the frames it is
 * handed and answers a byte for each, which is what an SD card, a touch
 * controller or an ADC does. Not a stand-in for a part: it is a device of the
 * fabric like any other, registered through the public attachSpiDevice, and it
 * is here to make "the guest's bytes reached the devices on this bus" and "the
 * tab answered MISO" observable in one place.
 */
function responder(boardId: string, owner: string, cs: number) {
  const seen: number[] = [];
  wire(boardId, owner, { ...ESP32_SPI, CS: `D${cs}` });
  const handle = attachSpiDevice(
    { owner, pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } },
    {
      transfer: (mosi: number) => {
        seen.push(mosi);
        return 0x01;
      },
      peekMiso: () => 0x01,
    },
  );
  cleanups.push(() => handle.dispose());
  return { seen };
}

// ── The lane itself: pins bound, no controller ──────────────────────────────

describe('QEMU ESP32 board: what the bus fabric is given', () => {
  it('the fabric gets the board pins and no SPI controller port (F4 adds the port)', () => {
    const { id } = qemuBoard({ tft: true });
    const binding = bindingOf(id);
    expect(binding, 'the QEMU shim binds the board').not.toBeNull();
    expect(binding!.spi, 'SPI controller ports on the QEMU lane').toEqual([]);
    expect(typeof binding!.pins.peekPinState).toBe('function');
  });
});

// ── esp32-qemu-miso-ws-flood, qemu-shim-miso-ws-per-byte ─────────────────────

describe('QEMU ESP32 shim: MISO answers for bytes the guest already clocked', () => {
  it('esp32-qemu-miso-ws-flood, qemu-shim-miso-ws-per-byte setup: the ILI9341 is on the board bus its wires say, and the guest chip select selects it', () => {
    const { id, ws } = qemuBoard({ tft: true });
    expect(busRegistry.placement('tft1')).toEqual({
      boardId: id,
      sckPin: ESP32_PIN.SCK,
      selected: false,
    });
    ws.receive('gpio_change', { pin: TFT_CS, state: 0 });
    expect(busRegistry.placement('tft1')!.selected, 'CS low selects the panel').toBe(true);
    ws.receive('gpio_change', { pin: TFT_CS, state: 1 });
    expect(busRegistry.placement('tft1')!.selected, 'CS high deselects it').toBe(false);
  });

  // F4, still broken. The batch holds the bytes the guest clocked while the
  // panel's CS was low; on a board with a controller port (any in-browser
  // engine) that same row lands on the glass. Here it reaches no device at
  // all, because the QEMU bridge publishes no port for the fabric to clock.
  it.fails(
    'esp32-qemu-miso-ws-flood, qemu-shim-miso-ws-per-byte: the row the guest clocked into a selected ILI9341 reaches the panel',
    () => {
      const { ws, tft } = qemuBoard({ tft: true });
      expect(drawRow(ws)).toBe(491);
      expect(rowOnPanel(tft!)).toEqual(ROW);
    },
  );

  // F4, no longer reachable this way. The finding is the answer channel:
  // Esp32BridgeShim's legacy .spi facade hands every completeTransfer to
  // Esp32Bridge.setSpiResponse, which is one esp32_spi_response WebSocket
  // message per MOSI byte, applied by the worker to whatever byte it is
  // clocking when it arrives. That code is untouched; what changed with F3 is
  // that no device is on that facade any more, so nothing drives it and the
  // flood does not happen today. Both halves are asserted together, so this
  // cannot pass just because the lane is dead: a responder must be handed the
  // bytes AND the tab must not answer them one socket message at a time.
  it.fails(
    'esp32-qemu-miso-ws-flood, qemu-shim-miso-ws-per-byte: a responder on the bus is handed the guest bytes without the tab answering one WebSocket message per byte',
    () => {
      const { id, ws } = qemuBoard({});
      const sd = responder(id, 'sd1', TFT_CS);
      const clocked = drawRow(ws);
      expect(sd.seen.length, 'frames the responder was handed').toBe(clocked);
      expect(misoFrames(ws).length, 'esp32_spi_response frames the tab sent').toBe(0);
    },
  );
});

// ── qemu-chip-node-floods-spi-response ───────────────────────────────────────

/** The real spi-probe chip of the chips fixtures (built by
 *  fixtures/chips-spi-chips/build.sh, checked in board-buses-repro-chips-spi). */
const probeWasm = readFileSync(
  fileURLToPath(new URL('./fixtures/chips-spi-chips/spi-probe.wasm', import.meta.url)),
).toString('base64');
const PROBE_JSON = JSON.stringify({ pins: ['CS', 'SCK', 'MOSI', 'MISO', 'GROW', 'VCC', 'GND'] });
const CHIP_CS = 5;

/** Drop a real custom chip on the canvas, wired to the board's SPI pins, and
 *  attach it with the real part, as DynamicComponent does. */
function attachChip(boardId: string, shim: unknown, id: string) {
  const pins: Record<string, number> = { CS: CHIP_CS, ...ESP32_PIN };
  useSimulatorStore.setState((s) => ({
    components: [
      ...s.components,
      {
        id,
        metadataId: 'custom-chip',
        x: 0,
        y: 0,
        properties: { wasmBase64: probeWasm, chipJson: PROBE_JSON, attrs: {} },
      },
    ],
  }) as never);
  wire(boardId, id, { ...ESP32_SPI, CS: `D${CHIP_CS}` });
  const off = PartSimulationRegistry.get('custom-chip')!.attachEvents!(
    { id } as unknown as HTMLElement,
    shim as never,
    (pin: string) => (pin in pins ? pins[pin] : null),
    id,
  );
  cleanups.push(off);
}

describe('QEMU ESP32 shim: a custom chip on the board SPI pins', () => {
  it('qemu-chip-node-floods-spi-response setup: the chip goes to the worker, as a custom-chip record carrying the SPI pins it is wired to', () => {
    const { id, ws, shim } = qemuBoard({});
    expect(hostsChipsInWorker(shim)).toBe(true);
    attachChip(id, shim, 'chip1');
    const rec = ws.sent.find(
      (m) => m.type === 'esp32_sensor_attach' && m.data?.sensor_type === 'custom-chip',
    );
    expect(rec, 'the chip reached the worker').toBeTruthy();
    expect(rec!.data!.pin_map).toMatchObject({ CS: CHIP_CS, SCK: ESP32_PIN.SCK });
  });

  // Closed by F3. There is no browser chips SPI node any more: a chip joins
  // a board's bus from its own vx_spi_attach, and on a board that hosts its
  // chips in the worker no browser instance exists at all. So the chip
  // registers no device in the tab's fabric and nothing answers, per byte or
  // otherwise, the bytes the guest already clocked.
  it('qemu-chip-node-floods-spi-response: a chip hosted in the worker puts no device in the tab and answers no replayed byte', () => {
    const { id, ws, shim } = qemuBoard({});
    attachChip(id, shim, 'chip1');
    expect(busRegistry.placement('chip1'), 'no browser device for a worker-hosted chip').toBeNull();
    drawRow(ws);
    expect(misoFrames(ws)).toEqual([]);
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

  it.fails(
    'worker-i2c-slaves-ignore-bus-id: a BMP280 on Wire (21/22) and one on Wire1 (25/26), both at 0x76, reach the worker as two devices with their own readings',
    () => {
      const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
      const shim = getBoardSimulator(id);
      cleanups.push(mountBmp280(shim, 'bmp-a', 20, 21, 22));
      cleanups.push(mountBmp280(shim, 'bmp-b', 30, 25, 26));
      const recs = bootSensors(id);
      expect(recs.map((r) => r.temperature).sort()).toEqual([20, 30]);
      expect(new Set(recs.map((r) => r.pin)).size).toBe(2);
    },
  );

  // Depends on the record field the fix picks (I2C_BUS_KEY): if it names the
  // controller some other way, rename the constant rather than read this as
  // still failing. On an ESP32 the GPIO matrix picks the controller at run
  // time (Wire.begin(25, 26) is legal), so a fix that sends the SDA/SCL pins
  // and lets the worker resolve the controller makes this contract moot:
  // delete it then, the test above still covers the two records.
  it.fails(
    'worker-i2c-slaves-ignore-bus-id: each of the two records names the I2C controller its SDA/SCL are wired to (Wire = 0, Wire1 = 1)',
    () => {
      const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
      const shim = getBoardSimulator(id);
      cleanups.push(mountBmp280(shim, 'bmp-a', 20, 21, 22));
      cleanups.push(mountBmp280(shim, 'bmp-b', 30, 25, 26));
      const recs = bootSensors(id);
      expect(Object.fromEntries(recs.map((r) => [r.temperature, r[I2C_BUS_KEY]]))).toEqual({
        20: 0,
        30: 1,
      });
    },
  );

  it.fails(
    'worker-i2c-slaves-ignore-bus-id: deleting the Wire1 BMP280 leaves the Wire one on the board for the next Run',
    () => {
      const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
      const shim = getBoardSimulator(id);
      cleanups.push(mountBmp280(shim, 'bmp-a', 20, 21, 22));
      const offB = mountBmp280(shim, 'bmp-b', 30, 25, 26);
      offB();
      const recs = bootSensors(id);
      expect(recs.map((r) => r.temperature)).toEqual([20]);
    },
  );
});

// ── stm32-no-client-miso-and-epaper-swallow (the browser half) ───────────────

/** SPI1 on the Blue Pill, as every SD library uses it: SCK PA5, MISO PA6,
 *  MOSI PA7, NSS PA4. The worker numbers pins port * 16 + n. */
const STM32_SD = { SCK: 'PA5', DI: 'PA7', DO: 'PA6', CS: 'PA4' };
const STM32_SD_CS = 4;
/** SD.begin()'s first frame: CMD0 (GO_IDLE_STATE), then one 0xFF clock for R1. */
const CMD0_AND_R1 = [0x40, 0x00, 0x00, 0x00, 0x00, 0x95, 0xff];

/**
 * A Blue Pill on the STM32 QEMU engine, started by the store's own startBoard
 * (the Run path), with or without an OSS microSD card on the canvas, wired to
 * SPI1 and attached with the real part. The worker's side of SD.begin() is
 * replayed in guest order. Returns what the tab sent to the backend (all of
 * it, and the part sent at Run, before the guest clocks a byte), where the
 * fabric placed the card and whether its chip select followed the guest, and
 * what the user was told (notes in the serial monitor, part gaps for the
 * circuit check).
 */
async function stm32SdBegin(card: boolean) {
  const store = useSimulatorStore.getState();
  const id = store.addBoard('stm32-bluepill', 0, 0);
  const shim = getBoardSimulator(id);
  if (card) {
    store.addComponent({ id: 'sd1', metadataId: 'microsd-card', x: 0, y: 0, properties: {} });
    cleanups.push(() => useSimulatorStore.getState().removeComponent('sd1'));
    wire(id, 'sd1', STM32_SD);
    const pinOf = (name: string) => (name === 'CS' ? STM32_SD_CS : null);
    cleanups.push(
      PartSimulationRegistry.get('microsd-card')!.attachEvents!(
        { id: 'sd1' } as unknown as HTMLElement,
        shim as never,
        pinOf,
        'sd1',
      ),
    );
  }
  const gapsBefore = lineGaps().length;
  useSimulatorStore.getState().startBoard(id);
  const ws = ScriptedSocket.last!;
  ws.open();
  // Anything the tab defers a tick at Run still counts as sent at Run.
  await new Promise((r) => setTimeout(r, 20));
  const sentAtRun = ws.sent.length;
  ws.receive('gpio_change', { pin: STM32_SD_CS, state: 1 });
  ws.receive('gpio_change', { pin: STM32_SD_CS, state: 0 });
  const selected = busRegistry.placement('sd1')?.selected ?? null;
  ws.receive('spi_batch', { b64: b64(CMD0_AND_R1) });
  ws.receive('gpio_change', { pin: STM32_SD_CS, state: 1 });
  await new Promise((r) => setTimeout(r, 20)); // the serial batcher's flush
  const board = useSimulatorStore.getState().boards.find((b) => b.id === id)!;
  return {
    boardId: id,
    sent: ws.sent.map((m) => JSON.stringify(m)),
    sentAtRun: ws.sent.slice(0, sentAtRun).map((m) => JSON.stringify(m)),
    placement: busRegistry.placement('sd1'),
    selected,
    notes: board.serialOutput,
    gaps: lineGaps().length - gapsBefore,
  };
}

describe('QEMU STM32 board: a browser SPI part that answers (microSD card)', () => {
  it('stm32-no-client-miso-and-epaper-swallow setup: on a started Blue Pill the card sits on SPI1 and the guest chip select selects it, and the board has no SPI controller port', async () => {
    const run = await stm32SdBegin(true);
    expect(run.sent.some((f) => f.includes('"start_stm32"'))).toBe(true);
    expect(run.placement).toEqual({ boardId: run.boardId, sckPin: 5, selected: false });
    expect(run.selected, 'CS low selects the card').toBe(true);
    expect(bindingOf(run.boardId)!.spi, 'SPI controller ports on the STM32 lane').toEqual([]);
  });

  // F4, still broken, and now for one reason instead of two. The card is on
  // the bus and selected, and CMD0 still reaches nobody: the STM32 worker runs
  // the controller and the tab has no port to be clocked from. Either fix
  // closes this: the card reaching the backend at Run, before the guest clocks
  // (a worker-side responder, as the ESP32 start path does with sdCsPin), or a
  // note / part gap saying it cannot answer on this engine. Forwarding
  // per-byte answers does NOT count, which is why only frames sent at Run are
  // compared: an answer leaves after the byte it answers was clocked, so the
  // worker applies it a byte late (TestBrowserMiso in the STM32 worker tests)
  // and SD.begin() still fails.
  it.fails(
    'stm32-no-client-miso-and-epaper-swallow: a microSD card on an STM32 QEMU board is not dropped silently: the backend is handed the card at Run, or the user is told it cannot answer on this engine',
    async () => {
      const without = await stm32SdBegin(false);
      while (cleanups.length) cleanups.pop()!();
      const withCard = await stm32SdBegin(true);
      const aboutTheCard = withCard.sentAtRun.filter((f) => !without.sentAtRun.includes(f));
      const told = /\[Velxio\]/.test(withCard.notes) || withCard.gaps > 0;
      expect(
        aboutTheCard.length > 0 || told,
        `frames only the card run sent at Run: ${aboutTheCard.length}, notes: ${JSON.stringify(withCard.notes)}, part gaps: ${withCard.gaps}`,
      ).toBe(true);
    },
  );
});
