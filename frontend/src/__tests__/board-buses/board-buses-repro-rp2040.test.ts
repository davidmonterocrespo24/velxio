/**
 * Board buses F0: RP2040 reproductions.
 *
 * Every case drives the real rp2040js core through RP2040Simulator with a
 * firmware fixture built by the production toolchain (fixtures/rp2040-*,
 * rebuild with project/board-buses-2026-09/harness/compile-fixture.mjs) or the
 * MicroPython v1.20.0 UF2 the app ships, and the real parts from
 * PartSimulationRegistry: microSD, ILI9341, e-paper, and custom chips built
 * from fixtures/rp2040-chips/*.c with wasi-sdk (the backend's compile flags,
 * fixtures/rp2040-chips/build.sh) and loaded through the real CustomChipPart.
 *
 * Each test states the hardware-faithful result. A test marked it.fails
 * reproduces a finding of evidence/f0-repro-areas.json ("rp2040"): it fails
 * today for the reason the finding gives, and its sibling "setup" test proves
 * the firmware booted, the part attached and the bytes reached the engine, so
 * an it.fails can never pass on a broken rig. A plain it() naming a finding
 * is a sub-claim that did not hold; it stays as a regression guard.
 *
 * What stands in for the browser is only what node lacks: a canvas stub for
 * the e-paper (to see the frame it paints), a queued requestAnimationFrame, an
 * empty document, and a fetch that serves the bundled MicroPython UF2 and the
 * littlefs WASM from disk instead of the network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RP2040Simulator } from '../../simulation/RP2040Simulator';
import { PinManager } from '../../simulation/PinManager';
import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import '../../simulation/parts/ProtocolParts';
import '../../simulation/parts/ComplexParts';
import '../../simulation/parts/EPaperPart';
import '../../simulation/parts/CustomChipPart';
import { attachSpiDevice } from '../../simulation/buses';
import { ChipInstance, getI2CBus } from '../../simulation/customChips';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { busRegistry } from '../../simulation/buses';
import { buildFat16Image } from '../../utils/fatImage';

// ── Rig ──────────────────────────────────────────────────────────────────────

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const fixturePath = (dir: string, file: string) => here(`./fixtures/${dir}/${file}`);
const firmware = (name: string) => readFileSync(fixturePath(name, `${name}.ino.bin`)).toString('base64');

type PinMap = Record<string, number>;
const pinsOf = (map: PinMap) => (name: string): number | null => map[name] ?? null;

interface Board {
  sim: RP2040Simulator;
  /** This board's id in the store: what its wires and its bus fabric use. */
  id: string;
  /** Everything the console received since the last `newBoot()`. */
  out: () => string;
  /** Start a new output window (after a reset, the program prints again). */
  newBoot: () => void;
}

/** The store's board id for each simulator the rig booted. */
const boardIds = new WeakMap<RP2040Simulator, string>();
let boardSeq = 0;

/**
 * The store id of this simulator's board, putting the Pico on the canvas the
 * first time somebody asks for it: the store knows it (that is what the nets
 * are walked against) and its engine is bound to that board's bus fabric, so
 * a part registered with attachSpiDevice lands on the bus its wires say.
 *
 * On demand, because a part can be wired before the sketch is loaded, and on
 * the canvas the board is there either way: its ports exist from the
 * simulator's constructor and outlive every firmware load (F2-SPEC).
 */
function boardIdOf(sim: RP2040Simulator): string {
  const known = boardIds.get(sim);
  if (known) return known;
  const id = `pico-bb${++boardSeq}`;
  boardIds.set(sim, id);
  useSimulatorStore.setState((s) => ({
    boards: [...s.boards, { id, boardKind: 'raspberry-pi-pico', x: 0, y: 0 }],
  }) as never);
  busRegistry.bindEngine(id, sim.getBusBinding());
  return id;
}

function wrap(sim: RP2040Simulator): Board {
  let out = '';
  let from = 0;
  sim.onSerialData = (ch) => {
    out += ch;
  };
  const id = boardIdOf(sim);
  return { sim, id, out: () => out.slice(from), newBoot: () => (from = out.length) };
}

/**
 * Wire a component to its board, as the canvas does. `pins` maps the
 * component's own pin names to the Pico's GPIOs. The wires are what the
 * fabric walks, so a device that is not wired here is on no bus at all,
 * whatever it was handed at attach time.
 */
function wireTo(sim: RP2040Simulator, id: string, pins: PinMap): void {
  const boardId = boardIdOf(sim);
  const wires = Object.entries(pins).map(([pinName, gpio], i) => ({
    id: `${id}-w${i}`,
    start: { componentId: id, pinName, x: 0, y: 0 },
    end: { componentId: boardId, pinName: `GP${gpio}`, x: 0, y: 0 },
    waypoints: [],
    color: '#0a0',
  }));
  useSimulatorStore.setState((s) => ({
    wires: [...s.wires.filter((w) => !w.id.startsWith(`${id}-w`)), ...wires],
  }) as never);
}

/**
 * Wire a part to its board and give it the component id the fabric
 * identifies it by.
 */
function wirePart(sim: RP2040Simulator, tag: string, pins: PinMap): string {
  const id = `${boardIdOf(sim)}-${tag}`;
  wireTo(sim, id, pins);
  return id;
}

function boot(name: string): Board {
  const sim = new RP2040Simulator(new PinManager());
  sim.loadBinary(firmware(name));
  return wrap(sim);
}

/** Run the board in 10 ms frames (the production scheduler, on simulated
 *  time) until `done` holds or `maxMs` of guest time has passed. */
function runUntil(board: Board, done: (out: string) => boolean, maxMs = 1500): void {
  for (let t = 0; t < maxMs; t += 10) {
    board.sim.runFrameForTime(10);
    if (done(board.out())) return;
  }
}
const untilDone = (board: Board, maxMs?: number) => runUntil(board, (o) => o.includes('DONE'), maxMs);

/** What the store's Stop does to an RP2040 board (stopBoard): reset() and a
 *  hard pin reset, and no part re-attaches. For an Arduino sketch that did not
 *  change, Run then just starts the CPU. A MicroPython Run reloads the
 *  firmware first (loadMicroPython), so there this is reset() alone. */
function stopRun(board: Board): void {
  board.sim.reset();
  board.sim.pinManager.hardResetPinStates();
  board.newBoot();
}


// ── Parts ────────────────────────────────────────────────────────────────────

const CARD_TEXT = 'BUS OK 2040';

/** SPI0 on the Pico's default Arduino pins; the CS is the sketch's. */
const SPI0_CARD = { SCK: 18, DI: 19, DO: 16 };
/** SPI1 (rp2040-sd-spi1 wires the card to GP10/11/12, CS GP13). */
const SPI1_CARD = { SCK: 10, DI: 11, DO: 12 };

/** The real microSD part, holding a FAT16 card with hello.txt. */
function attachCard(sim: RP2040Simulator, cs: number, bus = SPI0_CARD): () => void {
  const id = wirePart(sim, 'sd', { ...bus, CS: cs });
  const img = buildFat16Image([{ name: 'hello.txt', data: new TextEncoder().encode(CARD_TEXT) }]);
  const el = { id, sdImageData: img } as unknown as HTMLElement;
  return PartSimulationRegistry.get('microsd-card')!.attachEvents!(el, sim as never, pinsOf({ CS: cs }), id);
}

/** The real ILI9341 part, on SPI0 with its chip select on GP13 (the burst's,
 *  so the panel is selected for a transaction some test actually clocks). No
 *  canvas here, which only matters to pixel writes; the bus path is the same
 *  code. */
function attachTft(sim: RP2040Simulator, dc: number): () => void {
  const id = wirePart(sim, 'tft', { SCK: 18, MOSI: 19, MISO: 16, CS: 13, 'D/C': dc });
  const el = {
    id,
    canvas: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLElement;
  return PartSimulationRegistry.get('ili9341')!.attachEvents!(
    el,
    sim as never,
    pinsOf({ 'D/C': dc }),
    id,
  );
}

type Picture = { width: number; height: number; data: Uint8ClampedArray };

interface Panel {
  /** Refreshes the controller performed (each raises BUSY). */
  refreshes: () => number;
  /** The last frame painted to the canvas, RGBA. */
  painted: () => Picture | null;
  leave: () => void;
}

/** The real e-paper part (1.54" SSD1681) with a canvas stub that keeps what
 *  it paints. BUSY rising is how the part says the panel refreshed. */
function attachEpaper(sim: RP2040Simulator): Panel {
  const id = wirePart(sim, 'epd', { SCK: 18, SDI: 19, CS: 20, DC: 21, RST: 22, BUSY: 26 });
  let refreshes = 0;
  let painted: Picture | null = null;
  const ctx = {
    fillStyle: '',
    fillRect: () => {},
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: (img: Picture) => {
      painted = img;
    },
  };
  const el = {
    id,
    canvas: { getContext: () => ctx },
    getAttribute: (k: string) => (k === 'panel-kind' ? 'epaper-1in54-bw' : null),
    addEventListener: () => {},
    removeEventListener: () => {},
    set busy(v: boolean) {
      if (v) refreshes++;
    },
  } as unknown as HTMLElement;
  const leave = PartSimulationRegistry.get('epaper-1in54-bw')!.attachEvents!(
    el,
    sim as never,
    pinsOf({ CS: 20, DC: 21, RST: 22, BUSY: 26 }),
    id,
  );
  return {
    refreshes: () => refreshes,
    painted: () => {
      runFrames();
      return painted;
    },
    leave,
  };
}

/** Top half black, bottom half white: the frame rp2040-spi0-bus draws. */
function isFirmwareFrame(img: Picture | null): boolean {
  if (!img || img.width !== 200 || img.height !== 200) return false;
  const red = (x: number, y: number) => img.data[(y * 200 + x) * 4];
  return red(0, 0) === 0x20 && red(199, 99) === 0x20 && red(0, 100) === 0xf4 && red(199, 199) === 0xf4;
}

/** Chips started, by component id. CustomChipPart instantiates the WASM
 *  asynchronously; a chip is on its buses once its start() has run. */
const chipStarts = new Map<string, number>();
const realChipStart = ChipInstance.prototype.start;

interface Chip {
  leave: () => void;
  /** Resolves once this attach has instantiated and started the chip. */
  ready: Promise<void>;
}

/** A custom chip loaded the way the canvas loads one: a store component with
 *  its WASM and chip.json, attached through the real CustomChipPart. */
function attachChip(sim: RP2040Simulator, id: string, wasmFile: string, pins: string[], wiring: PinMap): Chip {
  const wasmBase64 = readFileSync(fixturePath('rp2040-chips', wasmFile)).toString('base64');
  const component = {
    id,
    metadataId: 'custom-chip',
    x: 0,
    y: 0,
    properties: { wasmBase64, chipJson: JSON.stringify({ name: id, pins }) },
  };
  useSimulatorStore.setState((s) => ({
    components: [...s.components.filter((c) => c.id !== id), component as never],
  }));
  // A chip is on the SPI bus its own pins are wired to (vx_spi_attach hands
  // the fabric the pin names of its config), so the wires go in the store
  // like any part's, not just into the getPin this attach is handed.
  wireTo(sim, id, wiring);
  const before = chipStarts.get(id) ?? 0;
  const leave = PartSimulationRegistry.get('custom-chip')!.attachEvents!(
    {} as HTMLElement,
    sim as never,
    pinsOf(wiring),
    id,
  );
  const ready = (async () => {
    for (let i = 0; i < 600 && (chipStarts.get(id) ?? 0) <= before; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if ((chipStarts.get(id) ?? 0) <= before) throw new Error(`chip ${id} never started`);
  })();
  return { leave, ready };
}

const SPI_CHIP_PINS = ['CS', 'SCK', 'MOSI', 'MISO', 'GND', 'VCC'];
const SPI_CHIP_WIRING = { CS: 14, SCK: 18, MOSI: 19, MISO: 16 };
const I2C_CHIP_PINS = ['SDA', 'SCL', 'GND', 'VCC'];
const UART_CHIP_PINS = ['RX', 'TX', 'GND', 'VCC'];

// ── Browser stand-ins ────────────────────────────────────────────────────────

let rafQueue = new Map<number, (t: number) => void>();
let rafId = 0;
/** Run the animation frames queued so far, once (a frame that re-queues
 *  itself, like the chip tick, waits for the next call). */
function runFrames(): void {
  const due = rafQueue;
  rafQueue = new Map();
  for (const cb of due.values()) cb(0);
}

const MICROPYTHON_UF2 = readFileSync(here('../../../public/firmware/micropython-rp2040.uf2'));
const LITTLEFS_WASM = readFileSync(here('../../../node_modules/littlefs/dist/littlefs.wasm'));
const saved: Record<string, unknown> = {};

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const k of ['requestAnimationFrame', 'cancelAnimationFrame', 'document', 'fetch']) saved[k] = g[k];
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    rafQueue.set(++rafId, cb);
    return rafId;
  };
  g.cancelAnimationFrame = (h: number) => rafQueue.delete(h);
  g.document = { getElementById: () => null, activeElement: null };
  ChipInstance.prototype.start = function (this: ChipInstance) {
    realChipStart.call(this);
    const id = (this as unknown as { componentId: string }).componentId;
    chipStarts.set(id, (chipStarts.get(id) ?? 0) + 1);
  };
  g.fetch = async (url: unknown) =>
    String(url).includes('littlefs')
      ? new Response(LITTLEFS_WASM, { headers: { 'content-type': 'application/wasm' } })
      : new Response(MICROPYTHON_UF2);
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [k, v] of Object.entries(saved)) g[k] = v;
  ChipInstance.prototype.start = realChipStart;
});

async function bootPython(main: string): Promise<Board> {
  const sim = new RP2040Simulator(new PinManager());
  const board = wrap(sim);
  await sim.loadMicroPython([{ name: 'main.py', content: main }]);
  return board;
}

const cardMounted = (out: string) => out.includes('SD:OK') && out.includes(`READ:${CARD_TEXT}`);

// ── SPI0: who answers MISO ───────────────────────────────────────────────────

describe('RP2040 SPI0: the selected device answers MISO, whatever else shares the bus', () => {
  it('rp2040-first-answer-wins setup: the card mounts over SPI0 when it is alone', () => {
    const board = boot('rp2040-spi0-bus');
    attachCard(board.sim, 17);
    untilDone(board);
    expect(board.out()).toContain('READY');
    expect(board.out()).toContain('SD:CMD0:1');
    expect(board.out()).toContain('SD:OK');
    expect(board.out()).toContain(`READ:${CARD_TEXT}`);
  });

  it('rp2040-first-answer-wins setup: the card mounts when it attached after the ILI9341 (card at the chain head)', () => {
    const board = boot('rp2040-spi0-bus');
    attachTft(board.sim, 15);
    attachCard(board.sim, 17);
    untilDone(board);
    expect(cardMounted(board.out())).toBe(true);
  });

  it(
    'rp2040-first-answer-wins, rp2040-first-answer-vs-idle-before-forward, rp2040-first-answer-wins-vs-chain-contract, ' +
      'rp2040-first-answer-wins-contradicts-chain-contract, rp2040-first-answer-wins-vs-idle-before-forward: ' +
      'the card mounts when an ILI9341 attached after it (so it idles 0xFF at the head, then forwards)',
    () => {
      const board = boot('rp2040-spi0-bus');
      attachCard(board.sim, 17);
      attachTft(board.sim, 15);
      untilDone(board);
      expect(board.out()).toContain('DONE');
      expect(board.out()).toContain('SD:CMD0:1');
      expect(board.out()).toContain('SD:OK');
      expect(board.out()).toContain(`READ:${CARD_TEXT}`);
    },
  );

  it(
    'rp2040-first-answer-wins-vs-chain-contract, rp2040-first-answer-wins-contradicts-chain-contract (re-entrancy sub-claim): ' +
      'a device beside an answering ILI9341 hears a 64-byte SPI.transfer(buf, n) in order',
    () => {
      // This used to be a tap spliced into the part chain, where the claim was
      // that a listener BELOW the panel still heard the burst. There is no
      // chain now, and no below: the two devices share the burst's chip select
      // and the fabric hands the frames to both. The panel is a sink, so the
      // probe is the only one driving MISO and there is no contention. What
      // still has to hold is the order and the count: 64 frames, in the order
      // the sketch clocked them, none swallowed by the buffered path.
      const board = boot('rp2040-spi0-bus');
      const heard: number[] = [];
      const id = wirePart(board.sim, 'probe', { SCK: 18, MOSI: 19, MISO: 16, CS: 13 });
      const probe = attachSpiDevice(
        { owner: id, pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } },
        {
          transfer: (mosi: number) => {
            heard.push(mosi & 0xff);
            return null;
          },
        },
      );
      attachTft(board.sim, 15);
      untilDone(board);
      probe.dispose();
      const sent = Array.from({ length: 64 }, (_, i) => ((i * 7) ^ 0x5a) & 0xff);
      expect(board.out()).toContain('BURST:IDLE:64');
      expect(heard).toEqual(sent);
    },
  );
});

// ── SPI1 ─────────────────────────────────────────────────────────────────────

describe('RP2040 SPI1: a part wired to the second controller hears it', () => {
  it('rp2040-spi1-unreachable, rp-spi1-no-adapter setup: the SD init traffic leaves the core on SPI1', () => {
    const board = boot('rp2040-sd-spi1');
    attachCard(board.sim, 13, SPI1_CARD);
    const spi1 = (board.sim as unknown as { rp2040: { spi: Array<{ onTransmit: (v: number) => void }> } }).rp2040
      .spi[1];
    const engine = spi1.onTransmit;
    let clocked = 0;
    spi1.onTransmit = (v: number) => {
      clocked++;
      engine(v);
    };
    untilDone(board);
    expect(board.out()).toContain('READY');
    expect(board.out()).toContain('DONE');
    // 10 wake-up clocks, CMD0 and CMD8 frames with their reply bytes.
    expect(clocked).toBeGreaterThanOrEqual(30);
  });

  it(
    'rp2040-spi1-unreachable, rp-spi1-no-adapter: a microSD card on the SPI1 pins (GP10/11/12, CS GP13) answers CMD0 and CMD8',
    () => {
      const board = boot('rp2040-sd-spi1');
      attachCard(board.sim, 13, SPI1_CARD);
      untilDone(board);
      expect(board.out()).toContain('SD:CMD0:1');
      expect(board.out()).toContain('SD:CMD8:1:AA');
    },
  );
});

// ── e-paper on RP2040 ────────────────────────────────────────────────────────

describe('RP2040 e-paper: the panel shares SPI0 and survives Stop/Run', () => {
  it('epaper-rp2040-direct-onTransmit, epaper-rp2040-overwrites-ontransmit setup: the panel alone shows the frame', () => {
    const board = boot('rp2040-spi0-bus');
    const panel = attachEpaper(board.sim);
    untilDone(board);
    expect(board.out()).toContain('EPD:SENT');
    expect(panel.refreshes()).toBe(1);
    expect(isFirmwareFrame(panel.painted())).toBe(true);
    panel.leave();
  });

  it(
    'epaper-rp2040-direct-onTransmit, epaper-rp2040-overwrites-ontransmit: a card attached before the e-paper still mounts, and the panel still refreshes',
    () => {
      const board = boot('rp2040-spi0-bus');
      attachCard(board.sim, 17);
      const panel = attachEpaper(board.sim);
      untilDone(board);
      expect(board.out()).toContain('DONE');
      expect(panel.refreshes()).toBe(1);
      expect(board.out()).toContain('SD:CMD0:1');
      expect(cardMounted(board.out())).toBe(true);
      panel.leave();
    },
  );

  it(
    'epaper-rp2040-direct-onTransmit, epaper-rp2040-overwrites-ontransmit: an e-paper attached before the card still refreshes, and the card still mounts',
    () => {
      const board = boot('rp2040-spi0-bus');
      const panel = attachEpaper(board.sim);
      attachCard(board.sim, 17);
      untilDone(board);
      expect(board.out()).toContain('DONE');
      expect(cardMounted(board.out())).toBe(true);
      expect(panel.refreshes()).toBe(1);
      panel.leave();
    },
  );

  it('epaper-rp2040-direct-onTransmit: after Stop and Run (reset() with no re-attach) the panel refreshes again', () => {
    const board = boot('rp2040-spi0-bus');
    const panel = attachEpaper(board.sim);
    untilDone(board);
    expect(panel.refreshes()).toBe(1);
    stopRun(board);
    untilDone(board);
    expect(board.out()).toContain('EPD:SENT');
    expect(panel.refreshes()).toBe(2);
    panel.leave();
  });

  it('epaper-rp2040-direct-onTransmit (contrast): a card on the .spi adapter survives the same Stop and Run', () => {
    const board = boot('rp2040-spi0-bus');
    attachCard(board.sim, 17);
    untilDone(board);
    expect(cardMounted(board.out())).toBe(true);
    stopRun(board);
    untilDone(board);
    expect(cardMounted(board.out())).toBe(true);
  });
});

// ── MicroPython reset ────────────────────────────────────────────────────────

/** machine.SPI(0) talking to the card on CS GP17: CMD0, then R1 from the first
 *  byte on (the part answers after one fill byte). */
const PY_CMD0 = `
from machine import SPI, Pin
cs = Pin(17, Pin.OUT, value=1)
spi = SPI(0, baudrate=1000000, sck=Pin(18), mosi=Pin(19), miso=Pin(16))
spi.write(b'\\xff' * 10)
cs.value(0)
spi.write(b'\\xff\\x40\\x00\\x00\\x00\\x00\\x95')
r = 0xff
for i in range(10):
    r = spi.read(1, 0xff)[0]
    if not r & 0x80:
        break
cs.value(1)
spi.write(b'\\xff')
print('R1:%02x' % r)
print('DONE')
`;

describe('RP2040 MicroPython: SPI0 parts keep the bus across reset()', () => {
  it('rp2040-micropython-reset-loopback setup: the card answers CMD0 on the first boot', async () => {
    const board = await bootPython(PY_CMD0);
    attachCard(board.sim, 17);
    untilDone(board, 3000);
    expect(board.out()).toContain('R1:01');
  });

  // The simulator contract: a part keeps its bus across reset(). The app hid
  // this defect, because every MicroPython Run (single and Run All) calls
  // loadMicroPython again, which rewired SPI0 to the part adapter; only reset()
  // left the loopback. Every rebuild now clocks into the same SPI port (F2).
  it('rp2040-micropython-reset-loopback: after reset() the same card still answers CMD0', async () => {
    const board = await bootPython(PY_CMD0);
    attachCard(board.sim, 17);
    untilDone(board, 3000);
    expect(board.out()).toContain('R1:01');
    stopRun(board);
    untilDone(board, 3000);
    expect(board.out()).toContain('DONE');
    expect(board.out()).toContain('R1:01');
  });
});

// ── Custom chips and the SPI bus ─────────────────────────────────────────────

describe('RP2040 custom chips: a chip joins SPI0 without taking it', () => {
  it('rp2-sethandler-clobbers-spi-chain setup: the SPI chip alone answers its id', async () => {
    const board = boot('rp2040-spi0-bus');
    await attachChip(board.sim, 'chip-spi', 'spi-id.wasm', SPI_CHIP_PINS, SPI_CHIP_WIRING).ready;
    untilDone(board);
    expect(board.out()).toContain('CHIP1:A5');
    expect(board.out()).toContain('CHIP2:A5');
  });

  it(
    'rp2-sethandler-clobbers-spi-chain: an I2C-only chip on the board leaves the SPI card alone (the card still mounts)',
    async () => {
      const board = boot('rp2040-spi0-bus');
      attachCard(board.sim, 17);
      await attachChip(board.sim, 'chip-i2c', 'i2c-beef.wasm', I2C_CHIP_PINS, { SDA: 4, SCL: 5 }).ready;
      untilDone(board);
      expect(board.out()).toContain('DONE');
      expect(board.out()).toContain('SD:CMD0:1');
      expect(cardMounted(board.out())).toBe(true);
    },
  );

  it('rp2-sethandler-clobbers-spi-chain: an SPI chip and the card both answer on the shared bus', async () => {
    const board = boot('rp2040-spi0-bus');
    attachCard(board.sim, 17);
    await attachChip(board.sim, 'chip-spi', 'spi-id.wasm', SPI_CHIP_PINS, SPI_CHIP_WIRING).ready;
    untilDone(board);
    expect(board.out()).toContain('CHIP1:A5');
    expect(cardMounted(board.out())).toBe(true);
    expect(board.out()).toContain('CHIP2:A5');
  });

  it(
    'rp2-sethandler-clobbers-spi-chain: a chip mounted before the firmware loaded answers once it runs (mount, load, re-attach as hexEpoch does)',
    async () => {
      const sim = new RP2040Simulator(new PinManager());
      const first = attachChip(sim, 'chip-spi', 'spi-id.wasm', SPI_CHIP_PINS, SPI_CHIP_WIRING);
      await first.ready;
      sim.loadBinary(firmware('rp2040-spi0-bus'));
      first.leave();
      await attachChip(sim, 'chip-spi', 'spi-id.wasm', SPI_CHIP_PINS, SPI_CHIP_WIRING).ready;
      const board = wrap(sim);
      untilDone(board);
      expect(board.out()).toContain('DONE');
      expect(board.out()).toContain('CHIP1:A5');
    },
  );

  it('rp2-sethandler-clobbers-spi-chain: after Stop and Run the chip still answers its id', async () => {
    const board = boot('rp2040-spi0-bus');
    await attachChip(board.sim, 'chip-spi', 'spi-id.wasm', SPI_CHIP_PINS, SPI_CHIP_WIRING).ready;
    untilDone(board);
    expect(board.out()).toContain('CHIP1:A5');
    stopRun(board);
    untilDone(board);
    expect(board.out()).toContain('DONE');
    expect(board.out()).toContain('CHIP1:A5');
  });

  it(
    'rp2-sethandler-clobbers-spi-chain: after Reset (reset() and every part re-attaches) the chip still answers its id',
    async () => {
      const board = boot('rp2040-spi0-bus');
      const first = attachChip(board.sim, 'chip-spi', 'spi-id.wasm', SPI_CHIP_PINS, SPI_CHIP_WIRING);
      await first.ready;
      untilDone(board);
      expect(board.out()).toContain('CHIP1:A5');
      stopRun(board);
      first.leave();
      await attachChip(board.sim, 'chip-spi', 'spi-id.wasm', SPI_CHIP_PINS, SPI_CHIP_WIRING).ready;
      untilDone(board);
      expect(board.out()).toContain('DONE');
      expect(board.out()).toContain('CHIP1:A5');
    },
  );
});

// ── I2C bus choice ───────────────────────────────────────────────────────────

describe('RP2040 I2C: a chip answers on the controller its SDA/SCL are wired to', () => {
  it('rp2040-i2c-bus0-hardcoded setup: a chip on GP4/GP5 answers on Wire (I2C0)', async () => {
    const board = boot('rp2040-i2c-wire1');
    await attachChip(board.sim, 'chip-i2c', 'i2c-beef.wasm', I2C_CHIP_PINS, { SDA: 4, SCL: 5 }).ready;
    untilDone(board);
    expect(board.out()).toContain('WIRE0:ACK:BEEF');
    expect(board.out()).toContain('WIRE1:NACK');
  });

  it.fails('rp2040-i2c-bus0-hardcoded: a chip on GP26/GP27 answers on Wire1 (I2C1), not on Wire', async () => {
    const board = boot('rp2040-i2c-wire1');
    await attachChip(board.sim, 'chip-i2c', 'i2c-beef.wasm', I2C_CHIP_PINS, { SDA: 26, SCL: 27 }).ready;
    untilDone(board);
    expect(board.out()).toContain('DONE');
    expect(board.out()).toContain('WIRE1:ACK:BEEF');
    expect(board.out()).toContain('WIRE0:NACK');
  });

  it('rp2040-i2c-bus0-hardcoded setup: on the XIAO RP2040, Wire is I2C1 (the same chip model on bus 1 answers)', async () => {
    const board = boot('rp2040-xiao-i2c');
    const chip = await ChipInstance.create({
      wasm: new Uint8Array(readFileSync(fixturePath('rp2040-chips', 'i2c-beef.wasm'))),
      componentId: 'chip-i2c-bus1',
      pinManager: board.sim.pinManager,
      i2cBus: getI2CBus(board.sim, 1) as never,
      wires: new Map([
        ['SDA', 6],
        ['SCL', 7],
      ]),
    });
    chip.start();
    untilDone(board);
    expect(board.out()).toContain('READY');
    expect(board.out()).toContain('WIRE:ACK:BEEF');
    chip.dispose();
  });

  it.fails(
    'rp2040-i2c-bus0-hardcoded: on the XIAO RP2040 a chip on the Grove I2C socket (D4/D5 = GP6/GP7) answers on Wire',
    async () => {
      const board = boot('rp2040-xiao-i2c');
      await attachChip(board.sim, 'chip-i2c', 'i2c-beef.wasm', I2C_CHIP_PINS, { SDA: 6, SCL: 7 }).ready;
      untilDone(board);
      expect(board.out()).toContain('DONE');
      expect(board.out()).toContain('WIRE:ACK:BEEF');
    },
  );
});

// ── UART lumping ─────────────────────────────────────────────────────────────
//
// The finding's MicroPython half (a chip on machine.UART(0) is deaf, since
// loadMicroPython never wires uart[0].onByte) has no test here: on rp2040js
// the MicroPython v1.20 UART(0, 115200, tx=Pin(0), rx=Pin(1)) constructor never
// returns, chip or no chip, with the CPU busy the whole time. It needs the
// engine fixed first.

describe('RP2040 UART: a chip hears and answers only on the UART it is wired to', () => {
  it('rp2040-uart-lumped-and-uart0-only-rx setup: the UART chip is alive and replies to a PING', async () => {
    const board = boot('rp2040-uart-chip');
    await attachChip(board.sim, 'chip-uart', 'uart-pong.wasm', UART_CHIP_PINS, { RX: 8, TX: 9 }).ready;
    untilDone(board);
    expect(board.out()).toContain('READY');
    expect(board.out()).toContain('DONE');
    // Its reply reached the core, on one UART or the other.
    expect(board.out()).toMatch(/PONG\d/);
  });

  it.fails(
    'rp2040-uart-lumped-and-uart0-only-rx: a chip on UART1 (Serial2, GP8/GP9) hears only Serial2 and its reply arrives on Serial2',
    async () => {
      const board = boot('rp2040-uart-chip');
      await attachChip(board.sim, 'chip-uart', 'uart-pong.wasm', UART_CHIP_PINS, { RX: 8, TX: 9 }).ready;
      untilDone(board);
      expect(board.out()).toContain('DONE');
      expect(board.out()).toContain('REPLY:PONG1');
      expect(board.out()).toContain('U0RX:NONE');
    },
  );
});
