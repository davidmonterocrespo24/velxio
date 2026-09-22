/**
 * Board buses perf baseline, OSS engines (project/board-buses-2026-09,
 * DESIGN section 11, D-007): what the SPI hot path costs today, so every
 * later phase can be measured against it with the same command.
 *
 * Opt-in: skipped unless BUS_PERF=1, so the deploy gate never pays for it
 * (the suite imports nothing heavy until it runs). The runner is
 * project/board-buses-2026-09/harness/bus-perf.mjs (three repetitions, JSON
 * into evidence/perf-baseline.json); by hand:
 *
 *   cd velxio/frontend && BUS_PERF=1 npx vitest run src/__tests__/board-buses/perf/bus-perf-oss.test.ts
 *
 * Everything under test is the real thing: avr8js through AVRSimulator and
 * rp2040js through RP2040Simulator, the OSS ILI9341 model from
 * PartSimulationRegistry, and Adafruit_ILI9341 firmware built with the
 * production toolchain (fixtures/perf-*, each with its .ino and the command
 * that rebuilds it) drawing full 240x320 RGB565 frames in a loop.
 *
 * Two workloads per board, both 153624 bus bytes per frame:
 *   fw-fillscreen  the firmware runs under the production frame loop
 *                  (AVRSimulator.start() with requestAnimationFrame pumped at
 *                  60 Hz; RP2040Simulator.runFrameForTime(1000 / 60), the body
 *                  of its rAF loop). It prints each frame's guest time, which
 *                  gives the frame boundaries. End to end: CPU emulation
 *                  dominates.
 *   reg-frame      the firmware boots to READY, then the bench stops the CPU
 *                  and writes the same frame into the SoC's own registers
 *                  (SPDR and PORTB on the AVR, SSPDR and SIO on the RP2040),
 *                  which is what the guest's stores do. No instruction runs, so
 *                  this is the bus path alone, with little noise.
 *
 * Two configurations of each:
 *   full  the part on the bus: engine SPI -> the simulator's .spi adapter ->
 *         spiChannel chain -> ILI9341 decoder, with its per-pixel flush
 *         debounce (performance.now + setTimeout).
 *   bare  no part; a byte counter where the part would be. `full - bare` is
 *         what the bus path and the decoder cost.
 *
 * Every timed frame is checked: in `full` the bottom row of the panel must
 * hold that frame's colour (blue and red alternate), in `bare` the counter
 * must see the frame's bytes. A path that stops drawing fails the bench
 * instead of reporting a fast number.
 *
 * Stand-ins, only for what node lacks: a canvas whose 2d context keeps the
 * framebuffer the part draws into, window.setTimeout for the part's flush
 * debounce, and a queued requestAnimationFrame the bench pumps itself.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FrameClock, PerfReport, loadNow, perfEnabled, result, type BenchSpec } from './perfKit';

const fixture = (name: string, ext: string) =>
  fileURLToPath(new URL(`./fixtures/${name}/${name}.ino.${ext}`, import.meta.url));

/** One rAF tick at 60 Hz, the rate the browser drives both frame loops at. */
const FRAME_MS = 1000 / 60;

const W = 240;
const H = 320;
/** 76800 RGB565 pixels. */
const PIXEL_BYTES = W * H * 2;
/**
 * Bus bytes per frame: drawPixel(0, 0) (CASET + 4, PASET + 4, RAMWR, one
 * pixel) and fillScreen (CASET + 4, PASET + 4, RAMWR, the pixels). The fixture
 * says why the drawPixel is there.
 */
const FRAME_BYTES = 13 + 11 + PIXEL_BYTES;

const BLUE565 = 0x001f;
const RED565 = 0xf800;
/** Frame n's colour on the wire, and as the part expands it into RGBA. */
const wireColour = (n: number) => (n & 1 ? RED565 : BLUE565);
const frameColour = (n: number): number[] => (n & 1 ? [248, 0, 0, 255] : [0, 0, 248, 255]);

// ── Canvas stand-in ──────────────────────────────────────────────────────────

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** The ILI9341 element as the part reads it: an id and a canvas whose context
 *  keeps the framebuffer the part allocates on it. */
function panelElement(id: string) {
  const created: Pixels[] = [];
  const ctx = {
    createImageData: (w: number, h: number): Pixels => {
      const d = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      created.push(d);
      return d;
    },
    putImageData: () => {},
    clearRect: () => {},
  };
  return {
    id,
    canvas: { getContext: () => ctx },
    addEventListener: () => {},
    removeEventListener: () => {},
    getAttribute: () => null,
    framebuffer: (): Pixels | null => created[created.length - 1] ?? null,
  };
}

/** Pixels of the bottom row that are not `rgba`: a fill runs top to bottom,
 *  so the bottom row is the last thing a finished frame wrote. */
function bottomRowErrors(fb: Pixels | null, rgba: number[]): number {
  if (!fb) return W;
  let wrong = 0;
  for (let x = 0; x < W; x++) {
    const i = ((H - 1) * W + x) * 4;
    if (rgba.some((v, k) => fb.data[i + k] !== v)) wrong++;
  }
  return wrong;
}

// ── Serial: READY, then "F <n> <us>" after each frame ────────────────────────

interface FrameLine {
  n: number;
  us: number;
}

function serialFrames(onReady: () => void, onFrame: (f: FrameLine) => void): (ch: string) => void {
  let line = '';
  return (ch: string) => {
    if (ch !== '\n') {
      line += ch;
      return;
    }
    const text = line.trim();
    line = '';
    if (text === 'READY') onReady();
    const m = /^F (\d+) (\d+)$/.exec(text);
    if (m) onFrame({ n: Number(m[1]), us: Number(m[2]) });
  };
}

// ── Boards ───────────────────────────────────────────────────────────────────

/** A loaded board: its SPI adapter, a production frame-loop tick, and the SoC
 *  registers a guest store reaches (for the reg-frame workload). */
interface Board {
  spi: { onByte: ((mosi: number) => void) | null };
  sim: unknown;
  /** Serial listener; installed before the first tick, as Run does. */
  setSerial(fn: (ch: string) => void): void;
  tick(): void;
  /** D/C pin for the part. */
  dc: number;
  regs: {
    dc(level: boolean): void;
    cs(level: boolean): void;
    /** One write of the SPI data register (and, on the RP2040, the RX drain
     *  spi_write_blocking does after it). */
    byte(v: number): void;
  };
}

interface BoardDef {
  board: string;
  engine: string;
  /** rAF ticks after which the bench gives up (a hung path fails, it does not stall). */
  maxTicks: number;
  fw: { warmupFrames: number; frames: number };
  reg: { warmupFrames: number; frames: number };
  load(): Promise<Board>;
}

/** Uno at 16 MHz, run by AVRSimulator.start()'s own rAF loop. */
const AVR_UNO: BoardDef = {
  board: 'avr-uno',
  engine: 'avr8js (AVRSimulator, ATmega328P 16 MHz)',
  maxTicks: 3000,
  fw: { warmupFrames: 1, frames: 6 },
  reg: { warmupFrames: 3, frames: 12 },
  async load() {
    const { AVRSimulator } = await import('../../../simulation/AVRSimulator');
    const { PinManager } = await import('../../../simulation/PinManager');
    const sim = new AVRSimulator(new PinManager());
    sim.loadHex(readFileSync(fixture('perf-avr-ili9341', 'hex'), 'utf-8'));
    let now = 0;
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    // ATmega328P data space: PORTB 0x25 (D9 = PB1 = D/C, D10 = PB2 = CS), SPDR 0x4E.
    const PORTB = 0x25;
    const SPDR = 0x4e;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cpu = (sim as any).cpu as { data: Uint8Array; writeData(addr: number, v: number): void };
    const portBit = (bit: number, level: boolean) =>
      cpu.writeData(PORTB, level ? cpu.data[PORTB] | (1 << bit) : cpu.data[PORTB] & ~(1 << bit));
    return {
      get spi() {
        return sim.spi!;
      },
      sim,
      dc: 9,
      setSerial(fn) {
        sim.onSerialData = fn;
        sim.start();
      },
      tick() {
        const cb = queue.shift();
        now += FRAME_MS;
        cb?.(now);
      },
      regs: {
        dc: (level) => portBit(1, level),
        cs: (level) => portBit(2, level),
        byte: (v) => cpu.writeData(SPDR, v),
      },
    };
  },
};

/** Pico at 125 MHz, run by RP2040Simulator.runFrameForTime (its rAF body). */
const RP2040_PICO: BoardDef = {
  board: 'rp2040-pico',
  engine: 'rp2040js (RP2040Simulator, 125 MHz)',
  maxTicks: 8000,
  fw: { warmupFrames: 1, frames: 4 },
  reg: { warmupFrames: 3, frames: 12 },
  async load() {
    const { RP2040Simulator } = await import('../../../simulation/RP2040Simulator');
    const { PinManager } = await import('../../../simulation/PinManager');
    const sim = new RP2040Simulator(new PinManager());
    sim.loadBinary(readFileSync(fixture('perf-rp2040-ili9341', 'bin')).toString('base64'));
    // SPI0 SSPDR, and the SIO set/clear registers for GP20 (D/C) and GP17 (CS).
    const SSPDR = 0x4003_c008;
    const SIO_OUT_SET = 0xd000_0014;
    const SIO_OUT_CLR = 0xd000_0018;
    const soc = () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sim as any).rp2040 as { writeUint32(a: number, v: number): void; readUint32(a: number): number };
    return {
      get spi() {
        return sim.spi;
      },
      sim,
      dc: 20,
      setSerial(fn) {
        sim.onSerialData = fn;
      },
      tick() {
        sim.runFrameForTime(FRAME_MS);
      },
      regs: {
        dc: (level) => soc().writeUint32(level ? SIO_OUT_SET : SIO_OUT_CLR, 1 << 20),
        cs: (level) => soc().writeUint32(level ? SIO_OUT_SET : SIO_OUT_CLR, 1 << 17),
        byte: (v) => {
          const rp = soc();
          rp.writeUint32(SSPDR, v);
          rp.readUint32(SSPDR);
        },
      },
    };
  },
};

const BOARDS = [AVR_UNO, RP2040_PICO];

// ── One bench ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let parts: any;

type Workload = 'fw-fillscreen' | 'reg-frame';

/** Put the part on the bus (full) or a byte counter where it would be (bare). */
function mount(board: Board, config: 'full' | 'bare', id: string) {
  const el = panelElement(id);
  const count = { n: 0 };
  let cleanup: (() => void) | undefined;
  if (config === 'full') {
    cleanup = parts.PartSimulationRegistry.get('ili9341').attachEvents(
      el,
      board.sim,
      (name: string) => (name === 'D/C' ? board.dc : null),
      id,
    );
  } else {
    // What the adapter does with nobody listening stays (AVR: its loopback;
    // RP2040: the idle 0xFF); the counter only sits in front of it.
    const under = board.spi.onByte;
    board.spi.onByte = (v: number) => {
      count.n++;
      under?.(v);
    };
  }
  return { el, count, cleanup };
}

/** Boot to READY under the production loop; `onFrame` then sees each F line. */
function boot(board: Board, maxTicks: number, onReady: () => void, onFrame: (f: FrameLine) => void, until: () => boolean) {
  let ready = false;
  board.setSerial(
    serialFrames(() => {
      ready = true;
      onReady();
    }, onFrame),
  );
  for (let t = 0; t < maxTicks && !until(); t++) board.tick();
  expect(ready, 'the firmware printed READY').toBe(true);
}

async function runBench(def: BoardDef, workload: Workload, config: 'full' | 'bare') {
  const board = await def.load();
  const bench = `${def.board}.ili9341.${workload}`;
  const { el, count, cleanup } = mount(board, config, `${bench}-tft`);
  const plan = workload === 'fw-fillscreen' ? def.fw : def.reg;
  const total = plan.warmupFrames + plan.frames;
  const clock = new FrameClock();
  const frames: number[] = [];
  /** Per frame: bottom-row pixels that did not take the frame's colour. */
  const misdrawn: number[] = [];
  let lastCount = 0;
  let loadStart: number[] = [];

  const lap = (n: number, guestUs?: number) => {
    clock.lap({ guestUs, bytes: config === 'bare' ? count.n - lastCount : undefined });
    lastCount = count.n;
    frames.push(n);
    // After the lap: a few microseconds against a frame of tens of ms.
    if (config === 'full') misdrawn.push(bottomRowErrors(el.framebuffer(), frameColour(n)));
  };

  if (workload === 'fw-fillscreen') {
    boot(
      board,
      def.maxTicks,
      () => {
        loadStart = loadNow();
        clock.start();
        lastCount = count.n;
      },
      (f) => {
        if (frames.length < total) lap(f.n, f.us);
      },
      () => frames.length >= total,
    );
  } else {
    let ready = false;
    boot(board, def.maxTicks, () => (ready = true), () => {}, () => ready);
    // The CPU stops here. Each frame is the firmware's frame, written into the
    // registers the way its stores write them.
    const r = board.regs;
    const segment = (cmd: number, data: number[]) => {
      r.dc(false);
      r.byte(cmd);
      r.dc(true);
      for (const b of data) r.byte(b);
    };
    loadStart = loadNow();
    clock.start();
    lastCount = count.n;
    for (let n = 0; n < total; n++) {
      const c = wireColour(n);
      const hi = c >> 8;
      const lo = c & 0xff;
      r.cs(false);
      segment(0x2a, [0, 0, 0, 0]);
      segment(0x2b, [0, 0, 0, 0]);
      segment(0x2c, [hi, lo]);
      segment(0x2a, [0, 0, 0, W - 1]);
      segment(0x2b, [0, 0, (H - 1) >> 8, (H - 1) & 0xff]);
      segment(0x2c, []);
      for (let p = 0; p < W * H; p++) {
        r.byte(hi);
        r.byte(lo);
      }
      r.cs(true);
      lap(n);
    }
  }
  const loadEnd = loadNow();
  cleanup?.();

  expect(frames.length, `${bench}: frames finished`).toBe(total);
  expect(frames, 'consecutive frames').toEqual(frames.map((_, i) => frames[0] + i));

  let verified: string;
  if (config === 'full') {
    expect(misdrawn, `${bench}: bottom-row pixels off colour, per frame`).toEqual(frames.map(() => 0));
    verified = `each of the ${total} frames reached the panel (bottom row in the frame's colour, blue/red alternating)`;
  } else {
    const measured = clock.samples.slice(plan.warmupFrames).map((s) => s.bytes ?? 0);
    const mean = measured.reduce((a, v) => a + v, 0) / measured.length;
    // Firmware frames are cut where the F line leaves the UART, a few bytes
    // into the next frame on a buffered port, so single frames may differ by a
    // handful of bytes; their mean is the frame. Register frames are exact.
    const slack = workload === 'fw-fillscreen' ? 64 : 1;
    expect(Math.abs(mean - FRAME_BYTES), `${bench}: bus bytes per frame ${measured.join('/')}`).toBeLessThan(slack);
    verified = `bus bytes counted per frame: ${[...new Set(measured)].join(', ')} (nominal ${FRAME_BYTES})`;
  }

  const spec: BenchSpec = {
    bench,
    config,
    engine: def.engine,
    part: config === 'full' ? 'ili9341 (OSS ComplexParts)' : 'none (byte counter)',
    drive: workload === 'fw-fillscreen' ? 'firmware' : 'registers',
    path:
      (workload === 'fw-fillscreen'
        ? 'Adafruit_ILI9341 fillScreen under the production frame loop: '
        : 'firmware frame written into the SPI data register, CPU stopped: ') +
      (config === 'full'
        ? 'engine SPI -> simulator .spi adapter -> spiChannel chain -> ILI9341 decoder (+ flush debounce per pixel)'
        : 'engine SPI -> simulator .spi adapter -> byte counter'),
    pixelBytesPerFrame: PIXEL_BYTES,
    warmupFrames: plan.warmupFrames,
  };
  return result(spec, clock.samples, FRAME_BYTES, verified, { start: loadStart, end: loadEnd });
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!perfEnabled)('bus perf baseline: OSS engines, ILI9341 240x320 RGB565 frames', () => {
  const report = new PerfReport('oss');
  const log = console.log;

  beforeAll(async () => {
    // The part's flush debounce calls window.setTimeout once per pixel.
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
    // The frame loops log once a second of guest time; keep the output to the results.
    console.log = () => {};
    parts = await import('../../../simulation/parts/PartSimulationRegistry');
    await import('../../../simulation/parts/ComplexParts');
  });

  afterAll(() => {
    console.log = log;
    vi.unstubAllGlobals();
    report.write();
  });

  for (const def of BOARDS) {
    for (const workload of ['fw-fillscreen', 'reg-frame'] as const) {
      for (const config of ['bare', 'full'] as const) {
        it(`${def.board}.ili9341.${workload}.${config}`, async () => {
          report.add(await runBench(def, workload, config));
        }, 600_000);
      }
    }
  }

  it('bare and full run the same guest program', () => {
    for (const def of BOARDS) {
      const bench = `${def.board}.ili9341.fw-fillscreen`;
      const [bare, full] = ['bare', 'full'].map((c) => report.results.find((r) => r.name === `${bench}.${c}`));
      if (!bare || !full) continue;
      expect(full.guestUsPerFrame, `${bench}: guest time per frame`).toBe(bare.guestUsPerFrame);
    }
  });
});
