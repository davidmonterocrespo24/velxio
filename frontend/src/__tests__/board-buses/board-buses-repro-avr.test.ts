/**
 * Board buses F0: reproduction of the "avr-oss-parts" findings
 * (project/board-buses-2026-09, evidence/f0-repro-areas.json).
 *
 * Everything under test is the real thing: avr8js through AVRSimulator, the
 * ILI9341 / microSD / SSD1306 / e-paper models from PartSimulationRegistry,
 * the store lifecycle (compileBoardProgram, startBoard, stopBoard, resetBoard)
 * and firmware built with the production toolchain (fixtures/avr-*, each
 * with its .ino and the command that rebuilds it). Two things stand in for
 * the browser: the canvas a part paints on (a context that keeps the pixels
 * so the test can read them) and the React effect that re-attaches parts,
 * which the Bench below runs on the same dependencies DynamicComponent
 * declares (hexEpoch and the part's own wires).
 *
 * Convention (TESTS.md): a test encodes the hardware-faithful behaviour.
 * `it.fails` marks a finding reproduced today; its sibling `setup:` test
 * proves the firmware, the wiring and the part work in the configuration
 * that does NOT trip the finding, so the `it.fails` cannot pass on a broken
 * setup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node environment, with the one browser global the ILI9341 model calls
// (window.setTimeout, its paint debounce). jsdom is not used: it serves
// modules through Vite's fs sandbox, which refuses the store's littlefs
// `?url` asset when node_modules is a symlink (as in this worktree).
vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

// Animation frames are queued, never run on their own: the CPU is stepped by
// the test, and a part's paint is flushed only when the test asks for it.
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  const id = nextFrame++;
  frames.set(id, cb);
  return id;
});
vi.stubGlobal('cancelAnimationFrame', (id: number) => {
  frames.delete(id);
});
function runFrames(): void {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(performance.now());
}

import { useSimulatorStore, getBoardSimulator, getBoardPinManager } from '../../store/useSimulatorStore';
import type { AVRSimulator } from '../../simulation/AVRSimulator';
import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import '../../simulation/parts';
import { traceDetailed } from '../../simulation/PinTrace';
import { buildFat16Image } from '../../utils/fatImage';
import { ensureUartBridge, getSimulatorBridges } from '../../simulation/customChips/simulatorBridges';
import { busRegistry } from '../../simulation/buses';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}/${name}.ino.hex`, import.meta.url)), 'utf-8');

// ── Bench: one board of the real store, parts mounted the way the canvas does ─

type BoardKind = 'arduino-uno' | 'arduino-nano' | 'arduino-mega' | 'attiny85';

interface PartSpec {
  id: string;
  metadataId: string;
  el: object;
  properties?: Record<string, unknown>;
}

interface Mounted extends PartSpec {
  cleanup?: () => void;
  attaches: number;
  fingerprint: string;
}

const wireFingerprint = (id: string): string =>
  useSimulatorStore
    .getState()
    .wires.filter((w) => w.start.componentId === id || w.end.componentId === id)
    .map((w) => w.id)
    .join(',');

let benchSeq = 0;
let liveBenches: Bench[] = [];

class Bench {
  readonly id: string;
  out = '';
  readonly parts: Mounted[] = [];
  private wireSeq = 0;
  private readonly unsubscribe: () => void;

  constructor(kind: BoardKind) {
    this.id = `${kind}-bb${++benchSeq}`;
    useSimulatorStore.getState().addBoard(kind, 0, 0, this.id);
    useSimulatorStore.getState().setActiveBoardId(this.id);
    this.sim.onSerialData = (ch: string) => {
      this.out += ch;
    };
    // DynamicComponent's attach effect depends on hexEpoch and on the part's
    // wire fingerprint (and deliberately NOT on `running`). React runs every
    // cleanup before any new attach, in tree order; so does remountAll.
    let epoch = useSimulatorStore.getState().hexEpoch;
    this.unsubscribe = useSimulatorStore.subscribe((s) => {
      if (s.hexEpoch !== epoch) {
        epoch = s.hexEpoch;
        this.remountAll();
        return;
      }
      for (const p of this.parts) {
        const fp = wireFingerprint(p.id);
        if (fp !== p.fingerprint) {
          p.fingerprint = fp;
          this.detach(p);
          this.attach(p);
        }
      }
    });
    liveBenches.push(this);
  }

  get sim(): AVRSimulator {
    return getBoardSimulator(this.id) as unknown as AVRSimulator;
  }

  get pins() {
    return getBoardPinManager(this.id)!;
  }

  /** Wire `comp.pin` to a pad of this board. */
  wire(comp: string, pin: string, boardPin: string): void {
    useSimulatorStore.getState().addWire({
      id: `${this.id}-w${++this.wireSeq}`,
      start: { componentId: comp, pinName: pin, x: 0, y: 0 },
      end: { componentId: this.id, pinName: boardPin, x: 0, y: 0 },
      waypoints: [],
      color: '#0a0',
    } as never);
  }

  /** Put the parts on the canvas (component list order = mount order). */
  mount(...specs: PartSpec[]): void {
    const st = useSimulatorStore.getState();
    st.setComponents([
      ...st.components,
      ...specs.map((s) => ({ id: s.id, metadataId: s.metadataId, x: 0, y: 0, properties: s.properties ?? {} })),
    ] as never);
    for (const s of specs) {
      const m: Mounted = { ...s, attaches: 0, fingerprint: wireFingerprint(s.id) };
      this.parts.push(m);
      this.attach(m);
    }
  }

  part(id: string): Mounted {
    return this.parts.find((p) => p.id === id)!;
  }

  private attach(p: Mounted): void {
    const logic = PartSimulationRegistry.get(p.metadataId)!;
    const getPin = (name: string) => traceDetailed(useSimulatorStore.getState(), p.id, name, 0).arduinoPin;
    p.cleanup = logic.attachEvents!(p.el as HTMLElement, this.sim as never, getPin, p.id) ?? undefined;
    p.attaches++;
  }

  private detach(p: Mounted): void {
    p.cleanup?.();
    p.cleanup = undefined;
  }

  private remountAll(): void {
    for (const p of this.parts) this.detach(p);
    for (const p of this.parts) this.attach(p);
  }

  /** A successful build: compileBoardProgram loads the image and bumps hexEpoch. */
  load(hex: string): void {
    useSimulatorStore.getState().compileBoardProgram(this.id, hex);
  }

  /** Run button. The frame loop it arms is dropped: the test steps the CPU. */
  run(): void {
    const first = nextFrame;
    useSimulatorStore.getState().startBoard(this.id);
    for (let id = first; id < nextFrame; id++) frames.delete(id);
  }

  /** Stop button: store stopBoard, which for an AVR is sim.reset(). */
  stop(): void {
    useSimulatorStore.getState().stopBoard(this.id);
  }

  /** Reset button: store resetBoard (sim.reset() plus a hexEpoch bump). */
  reset(): void {
    useSimulatorStore.getState().resetBoard(this.id);
  }

  /** Execute up to `budget` instructions, stopping once `done` holds (checked every `every` + 1). */
  step(budget: number, done: () => boolean, every = 0x3fff): void {
    const sim = this.sim;
    for (let i = 0; i < budget; i++) {
      sim.step();
      if ((i & every) === 0 && done()) return;
    }
  }

  /** Complete serial lines (a line still being printed is left out) from offset `from`. */
  lines(from = 0): string[] {
    const text = this.out.slice(from);
    return text
      .slice(0, text.lastIndexOf('\n') + 1)
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
  }

  /** Step until a line equal to `line` shows up after offset `from`. */
  stepToLine(line: string, budget: number, from = 0, every = 0x3f): void {
    this.step(budget, () => this.lines(from).includes(line), every);
  }

  dispose(): void {
    this.unsubscribe();
    for (const p of this.parts) this.detach(p);
    useSimulatorStore.getState().removeBoard(this.id);
  }
}

beforeEach(() => {
  frames.clear();
  liveBenches = [];
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});
afterEach(() => {
  for (const b of liveBenches) b.dispose();
  liveBenches = [];
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

// ── Canvas stand-ins: keep every pixel a part paints ─────────────────────────

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function paintContext() {
  const created: Pixels[] = [];
  const painted: Pixels[] = [];
  const ctx = {
    fillStyle: '',
    createImageData: (w: number, h: number): Pixels => {
      const d = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      created.push(d);
      return d;
    },
    putImageData: (d: Pixels) => {
      painted.push(d);
    },
    clearRect: () => {},
    fillRect: () => {},
  };
  return { ctx, created, painted };
}

function tftElement(id: string) {
  const p = paintContext();
  return {
    id,
    canvas: { getContext: () => p.ctx },
    addEventListener: () => {},
    removeEventListener: () => {},
    getAttribute: () => null,
    /** The panel's framebuffer: the last one it created (SWRESET drops the old). */
    framebuffer: () => p.created[p.created.length - 1] ?? null,
  };
}

function oledElement(id: string) {
  return {
    id,
    imageData: { width: 128, height: 64, data: new Uint8ClampedArray(128 * 64 * 4) } as Pixels,
    redraw: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    getAttribute: () => null,
  };
}

/** GDDRAM as the panel shows it: byte (page, col) rebuilt from the lit pixels. */
function oledGddram(el: { imageData: Pixels }): number[] {
  const out: number[] = [];
  const px = el.imageData.data;
  for (let page = 0; page < 8; page++) {
    for (let col = 0; col < 128; col++) {
      let v = 0;
      for (let bit = 0; bit < 8; bit++) {
        if (px[((page * 8 + bit) * 128 + col) * 4] !== 0) v |= 1 << bit;
      }
      out.push(v);
    }
  }
  return out;
}

/** How many GDDRAM bytes hold each value, e.g. { '0x22': 1024 }. */
function histogram(bytes: number[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const v of bytes) {
    const k = `0x${v.toString(16).padStart(2, '0')}`;
    h[k] = (h[k] ?? 0) + 1;
  }
  return h;
}

function epaperElement(id: string) {
  const p = paintContext();
  return {
    id,
    busy: false,
    canvas: { getContext: () => p.ctx },
    addEventListener: () => {},
    removeEventListener: () => {},
    getAttribute: (n: string) => (n === 'panel-kind' ? 'epaper-1in54-bw' : null),
    painted: p.painted,
  };
}

function sdElement(id: string, files: Array<{ name: string; data: Uint8Array }>) {
  return { id, sdImageData: buildFat16Image(files) };
}

// ── Fixture avr-tft-sd: the picture on the card and what the panel must show ──

const IMG_X = 40;
const IMG_Y = 60;
const IMG_W = 32;
const IMG_H = 32;
/** Unique per pixel: R = x, G = y, so a shifted picture never matches. */
const imgColor = (x: number, y: number) => ((x & 31) << 11) | ((y & 63) << 5) | ((x + y) & 31);
const IMG_FILE = (() => {
  const b = new Uint8Array(IMG_W * IMG_H * 2);
  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const w = imgColor(x, y);
      const i = (y * IMG_W + x) * 2;
      b[i] = w & 0xff;
      b[i + 1] = w >> 8;
    }
  }
  return b;
})();
const IMG_SUM = (() => {
  let s = 0;
  for (let y = 0; y < IMG_H; y++) for (let x = 0; x < IMG_W; x++) s += imgColor(x, y);
  return s;
})();

/** Pixels of the picture window that differ from the card's picture. */
function pictureErrors(fb: Pixels | null): { wrong: number; first: string } {
  if (!fb) return { wrong: IMG_W * IMG_H, first: 'no framebuffer at all' };
  let wrong = 0;
  let first = '';
  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const c = imgColor(x, y);
      const exp = [((c >> 11) & 0x1f) * 8, ((c >> 5) & 0x3f) * 4, (c & 0x1f) * 8, 255];
      const i = ((IMG_Y + y) * fb.width + IMG_X + x) * 4;
      const got = [fb.data[i], fb.data[i + 1], fb.data[i + 2], fb.data[i + 3]];
      if (got.some((v, k) => v !== exp[k])) {
        wrong++;
        if (!first) first = `(${x},${y}) got rgba ${got.join(',')} want ${exp.join(',')}`;
      }
    }
  }
  return { wrong, first };
}
const PICTURE_OK = { wrong: 0, first: '' };

const TFT_SD_HEX = fixture('avr-tft-sd');
/**
 * Instructions for one boot. A good boot of avr-tft-sd is 7.5 M cycles (about
 * 4.7 M instructions); one that hangs (SD.begin retrying for 2 s) stops here.
 */
const TFT_SD_BUDGET = 8_000_000;

type TftSdPart = 'tft' | 'sd';

/** Uno (or Nano) + ILI9341 (CS D10, DC D9) + microSD (CS D4), both on D11/D12/D13. */
function tftSdBench(order: TftSdPart[], kind: BoardKind = 'arduino-uno') {
  const b = new Bench(kind);
  const tftId = `${b.id}-tft`;
  const sdId = `${b.id}-sd`;
  if (order.includes('tft')) {
    b.wire(tftId, 'VCC', '5V');
    b.wire(tftId, 'GND', 'GND.1');
    b.wire(tftId, 'SCK', '13');
    b.wire(tftId, 'MOSI', '11');
    b.wire(tftId, 'MISO', '12');
    b.wire(tftId, 'CS', '10');
    b.wire(tftId, 'D/C', '9');
  }
  if (order.includes('sd')) {
    b.wire(sdId, 'VCC', '5V');
    b.wire(sdId, 'GND', 'GND.2');
    b.wire(sdId, 'SCK', '13');
    b.wire(sdId, 'DI', '11');
    b.wire(sdId, 'DO', '12');
    b.wire(sdId, 'CS', '4');
  }
  const tft = tftElement(tftId);
  const specs: Record<TftSdPart, PartSpec> = {
    tft: { id: tftId, metadataId: 'ili9341', el: tft },
    sd: { id: sdId, metadataId: 'microsd-card', el: sdElement(sdId, [{ name: 'img.raw', data: IMG_FILE }]) },
  };
  b.mount(...order.map((k) => specs[k]));
  return { b, tft, tftId, sdId };
}

/** Boot once from where the output is now; returns that boot's lines. */
function bootTftSd(b: Bench): string[] {
  const from = b.out.length;
  b.step(TFT_SD_BUDGET, () => {
    const l = b.lines(from);
    return l.includes('DONE') || l.some((x) => x.endsWith(':FAIL'));
  });
  return b.lines(from);
}

const GOOD_BOOT_TAIL = ['SD:OK', `SUM:${IMG_SUM}`, 'DONE'];

describe('Uno + ILI9341 + microSD on one bus (the spitftbitmap sketch)', () => {
  for (const kind of ['arduino-uno', 'arduino-nano'] as const) {
    it(`ili9341-no-cs-gating, avr-reset-drops-spi-chain, avr-reset-orphans-spi-chain, avr-spi-chain-lost-on-stop-run, avr-stop-recreates-spi-usart setup: ${kind}, panel mounted first, the card read reaches the MCU and the picture lands exactly`, () => {
      const { b, tft } = tftSdBench(['tft', 'sd'], kind);
      b.load(TFT_SD_HEX);
      b.run();
      const l = bootTftSd(b);
      expect(l[0]).toBe('TFT');
      expect(l[1]).toMatch(/^IDLE:[0-9A-F]+$/);
      expect(l.slice(2)).toEqual(GOOD_BOOT_TAIL);
      expect(pictureErrors(tft.framebuffer())).toEqual(PICTURE_OK);
    });
  }

  it('ili9341-no-cs-gating: with the card mounted first, the panel ignores the card traffic clocked while its own CS is high', () => {
    // Mount order puts the panel above the card in the chain, so every card
    // byte reaches the ILI9341 model. The sketch sets the address window once
    // and reads the card in the middle of it, exactly like spitftbitmap.
    const { b, tft } = tftSdBench(['sd', 'tft']);
    b.load(TFT_SD_HEX);
    b.run();
    const l = bootTftSd(b);
    expect(l.slice(2)).toEqual(GOOD_BOOT_TAIL);
    expect(pictureErrors(tft.framebuffer())).toEqual(PICTURE_OK);
  });

  it('avr-loopback-echo-overrides-idle, avr-loopback-at-chain-bottom, avr-no-real-firmware-shared-bus setup: the card alone on the bus mounts and reads, and the sketch prints its idle probe', () => {
    const { b } = tftSdBench(['sd']);
    b.load(TFT_SD_HEX);
    b.run();
    const l = bootTftSd(b);
    expect(l[1]).toMatch(/^IDLE:[0-9A-F]+$/);
    expect(l.slice(2)).toEqual(GOOD_BOOT_TAIL);
  });

  it('avr-loopback-echo-overrides-idle, avr-loopback-at-chain-bottom, avr-no-real-firmware-shared-bus: a byte clocked with nobody selected reads the idle-high 0xFF, not the MOSI echo', () => {
    // SPI.transfer(0x5A) with the panel's CS and the card's CS both high.
    // Nothing drives MISO, so the line rests at its pull-up.
    const idle: Record<string, string> = {};
    for (const order of [['tft', 'sd'], ['sd']] as TftSdPart[][]) {
      const { b } = tftSdBench(order);
      b.load(TFT_SD_HEX);
      b.run();
      idle[order.join('+')] = bootTftSd(b)[1] ?? 'no IDLE line';
      b.dispose();
      liveBenches = liveBenches.filter((x) => x !== b);
      useSimulatorStore.setState({ components: [], wires: [] } as never);
    }
    expect(idle).toEqual({ 'tft+sd': 'IDLE:FF', sd: 'IDLE:FF' });
  });
});

describe('Uno + ILI9341 + microSD: attach-order permutations', () => {
  // The same circuit and the same firmware must give the same result whatever
  // order the parts were mounted or re-attached in (TESTS.md L8, and the
  // wire-edit remount of L4). Checked per scenario: the card's answers are
  // what the MCU reads (SUM) and the panel decodes its own bytes, each once,
  // and nothing else (the picture is exact).
  // `gated` marks the two orders that used to put the panel above the card in
  // the chain, so it decoded the card's bytes: the ili9341-no-cs-gating
  // reproduction. On the fabric a device only ever hears its own chip select,
  // so every order holds and the finding's name stays in the title.
  const scenarios: Array<{ name: string; order: TftSdPart[]; edit?: TftSdPart; gated: boolean }> = [
    { name: 'panel, card', order: ['tft', 'sd'], gated: false },
    { name: 'card, panel', order: ['sd', 'tft'], gated: true },
    { name: 'panel, card, then a wire edit re-attaches the panel', order: ['tft', 'sd'], edit: 'tft', gated: true },
    { name: 'card, panel, then a wire edit re-attaches the card', order: ['sd', 'tft'], edit: 'sd', gated: false },
  ];
  for (const s of scenarios) {
    const title = `no-attach-order-permutation-tests, avr-no-real-firmware-shared-bus${s.gated ? ', ili9341-no-cs-gating' : ''}: ${s.name} gives the card read and the exact picture`;
    it(title, () => {
      const { b, tft, tftId, sdId } = tftSdBench(s.order);
      b.load(TFT_SD_HEX);
      if (s.edit === 'tft') b.wire(tftId, 'LED', '5V');
      if (s.edit === 'sd') b.wire(sdId, 'CD', 'GND.3');
      if (s.edit) expect(b.part(s.edit === 'tft' ? tftId : sdId).attaches).toBe(3);
      b.run();
      const l = bootTftSd(b);
      expect(l.slice(2)).toEqual(GOOD_BOOT_TAIL);
      expect(pictureErrors(tft.framebuffer())).toEqual(PICTURE_OK);
    });
  }
});

describe('Uno + ILI9341 + microSD: Stop/Run, Reset, reload', () => {
  for (const kind of ['arduino-uno', 'arduino-nano'] as const) {
    it(`avr-reset-drops-spi-chain, avr-reset-orphans-spi-chain, avr-spi-chain-lost-on-stop-run, avr-stop-recreates-spi-usart: ${kind}, Stop then Run with no recompile boots the same (card read, picture repainted)`, () => {
      const { b, tft } = tftSdBench(['tft', 'sd'], kind);
      b.load(TFT_SD_HEX);
      b.run();
      const first = bootTftSd(b);
      b.stop();
      tft.framebuffer()?.data.fill(0); // only what the second boot draws counts
      b.run();
      const second = bootTftSd(b);
      expect(second).toEqual(first);
      expect(pictureErrors(tft.framebuffer())).toEqual(PICTURE_OK);
    });
  }

  it('avr-reset-drops-spi-chain, avr-reset-orphans-spi-chain: Reset bumps hexEpoch, every part re-attaches, and the second boot matches the first', () => {
    const { b, tft } = tftSdBench(['tft', 'sd']);
    b.load(TFT_SD_HEX);
    b.run();
    const first = bootTftSd(b);
    b.reset();
    tft.framebuffer()?.data.fill(0);
    b.run();
    const second = bootTftSd(b);
    expect(second).toEqual(first);
    expect(pictureErrors(tft.framebuffer())).toEqual(PICTURE_OK);
  });

  it('avr-reset-drops-spi-chain, avr-spi-chain-lost-on-stop-run: a recompile (reload) rebuilds the peripherals, re-attaches the parts, and boots the same', () => {
    const { b, tft } = tftSdBench(['tft', 'sd']);
    b.load(TFT_SD_HEX);
    b.run();
    const first = bootTftSd(b);
    b.stop();
    tft.framebuffer()?.data.fill(0);
    b.load(TFT_SD_HEX);
    b.run();
    const second = bootTftSd(b);
    expect(second).toEqual(first);
    expect(pictureErrors(tft.framebuffer())).toEqual(PICTURE_OK);
  });
});

// ── A custom SPI chip and the card on one bus ───────────────────────────────

const CHIP_SD_HEX = fixture('avr-chip-sd');
const chipFile = (f: string) => fileURLToPath(new URL(`./fixtures/avr-chip-sd/${f}`, import.meta.url));
const SPI_WORD = {
  wasmBase64: readFileSync(chipFile('spi-word.wasm')).toString('base64'),
  chipJson: readFileSync(chipFile('spi-word.chip.json'), 'utf-8'),
};
const CHIP_SD_GOOD = ['CHIP:320', 'SD:OK', `SUM:${IMG_SUM}`, 'CHIP:320', 'DONE'];

type ChipSdPart = 'chip' | 'sd';

/** Uno + spi-word chip (CS D7) + microSD (CS D4), both on D11/D12/D13. */
function chipSdBench(order: ChipSdPart[]) {
  const b = new Bench('arduino-uno');
  const chipId = `${b.id}-chip`;
  const sdId = `${b.id}-sd`;
  b.wire(chipId, 'VCC', '5V');
  b.wire(chipId, 'GND', 'GND.1');
  b.wire(chipId, 'SCK', '13');
  b.wire(chipId, 'MOSI', '11');
  b.wire(chipId, 'MISO', '12');
  b.wire(chipId, 'CS', '7');
  b.wire(sdId, 'VCC', '5V');
  b.wire(sdId, 'GND', 'GND.2');
  b.wire(sdId, 'SCK', '13');
  b.wire(sdId, 'DI', '11');
  b.wire(sdId, 'DO', '12');
  b.wire(sdId, 'CS', '4');
  const specs: Record<ChipSdPart, PartSpec> = {
    chip: { id: chipId, metadataId: 'custom-chip', el: { id: chipId }, properties: { ...SPI_WORD } },
    sd: { id: sdId, metadataId: 'microsd-card', el: sdElement(sdId, [{ name: 'img.raw', data: IMG_FILE }]) },
  };
  b.mount(...order.map((k) => specs[k]));
  return { b };
}

/**
 * The chip's WASM instance comes up asynchronously after each attach, and it
 * is on the bus once chip_setup has called vx_spi_attach.
 *
 * What is waited on is the fabric, not the old per-simulator SPI bridge: a
 * chip is a device of the board's bus now, registered under
 * '<componentId>:spi<handle>' with the pins of its own config, so being on the
 * bus is what "ready" means and where it sits is part of the claim.
 */
async function chipReady(b: Bench): Promise<void> {
  const owner = `${b.id}-chip:spi0`;
  for (let i = 0; i < 400 && !busRegistry.placement(owner); i++) await new Promise((r) => setTimeout(r, 5));
  expect(busRegistry.placement(owner), 'the chip on the board SPI bus').toMatchObject({
    boardId: b.id,
    sckPin: 13,
  });
}

function bootChipSd(b: Bench): string[] {
  const from = b.out.length;
  // A good boot is 0.73 M cycles; a hung one (SD.begin retrying) stops here.
  b.step(2_000_000, () => {
    const l = b.lines(from);
    return l.includes('DONE') || l.includes('SD:FAIL');
  });
  return b.lines(from);
}

describe('Uno + custom SPI chip + microSD on one bus', () => {
  for (const order of [['chip', 'sd'], ['sd', 'chip']] as ChipSdPart[][]) {
    it(`avr-no-real-firmware-shared-bus, avr-spi-chain-lost-on-stop-run setup: mounted ${order.join(', ')}, the chip and the card each answer their own reads`, async () => {
      const { b } = chipSdBench(order);
      b.load(CHIP_SD_HEX);
      await chipReady(b);
      b.run();
      expect(bootChipSd(b)).toEqual(CHIP_SD_GOOD);
    });
  }

  it('avr-spi-chain-lost-on-stop-run, avr-reset-drops-spi-chain, avr-reset-orphans-spi-chain, avr-stop-recreates-spi-usart: after Stop then Run the chip still answers (not the MOSI echo) and the card still mounts', async () => {
    const { b } = chipSdBench(['chip', 'sd']);
    b.load(CHIP_SD_HEX);
    await chipReady(b);
    b.run();
    const first = bootChipSd(b);
    b.stop();
    b.run();
    expect(bootChipSd(b)).toEqual(first);
  });
});

// ── The custom-chip UART dispatcher across Stop/Run ─────────────────────────

const OLED_HEX = fixture('avr-oled-spi');

/** A UART chip's receive side: what CustomChipPart installs (ensureUartBridge + a listener). */
function chipUartTap(b: Bench): { heard: () => string } {
  let heard = '';
  ensureUartBridge(b.sim);
  getSimulatorBridges(b.sim).uartListeners.add((byte: number) => {
    heard += String.fromCharCode(byte);
  });
  return { heard: () => heard };
}

describe('Uno: the custom-chip UART dispatcher across Stop/Run', () => {
  it('avr-stop-recreates-spi-usart setup: a UART chip hears the sketch Serial on the first Run', () => {
    const b = new Bench('arduino-uno');
    b.load(OLED_HEX);
    const tap = chipUartTap(b);
    b.run();
    b.stepToLine('F:2', 2_000_000);
    expect(b.lines()).toContain('F:2');
    expect(tap.heard()).toContain('READY');
    expect(tap.heard()).toContain('F:2');
  });

  it.fails('avr-stop-recreates-spi-usart: after Stop then Run the UART chip still hears the sketch Serial', () => {
    const b = new Bench('arduino-uno');
    b.load(OLED_HEX);
    const tap = chipUartTap(b);
    b.run();
    b.stepToLine('F:2', 2_000_000);
    b.stop();
    b.run();
    const from = b.out.length;
    const heardBefore = tap.heard().length;
    b.stepToLine('F:2', 2_000_000, from);
    expect(b.lines(from)).toContain('F:2');
    expect(tap.heard().slice(heardBefore)).toContain('READY');
  });
});

// ── Arduino Mega: interrupt vectors after Stop/Run and Reset ────────────────

const MEGA_HEX = fixture('avr-mega-lifecycle');
const MEGA_SPI_HEX = fixture('avr-mega-spi-isr');
const MEGA_GOOD = ['BOOT', 'TWI:OK', 'T:1', 'T:2', 'T:3', 'T:4', 'T:5', 'DONE'];

/**
 * Boot once; stops at DONE, at the SPI result, or once the sketch is plainly
 * restarting in a loop. Returns the start of the output as lines, the one
 * being printed included: a sketch that restarts inside Serial.println never
 * finishes a line, and that is exactly what must show up in a failure.
 */
function bootMega(b: Bench, budget = 6_000_000): string[] {
  const from = b.out.length;
  b.step(budget, () => {
    const t = b.out.slice(from);
    return /DONE\r?\n|SPI_ISR:\d+\r?\n/.test(t) || t.split('BOOT').length > 3 || t.length > 200;
  }, 0x3ff);
  return b.out
    .slice(from, from + 80)
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
}

/**
 * A Mega with the DS1307 the sketch talks to, on its own SDA/SCL (20/21). The
 * store no longer puts a demo RTC on every AVR bus (D-010), so the part is on
 * the canvas the way a user wires it; without it Wire reads TWI:FAIL.
 */
function megaBench(): Bench {
  const b = new Bench('arduino-mega');
  const id = `${b.id}-rtc`;
  b.wire(id, 'SDA', '20');
  b.wire(id, 'SCL', '21');
  b.wire(id, '5V', '5V');
  b.wire(id, 'GND', 'GND.1');
  b.mount({ id, metadataId: 'ds1307', el: {} });
  return b;
}

describe('Arduino Mega: peripherals rebuilt by Stop/Run and Reset keep the ATmega2560 vectors', () => {
  it('mega-reset-uno-spi-config, avr-mega-reset-uno-vectors, avr-mega-tiny-reset-wrong-config setup: first Run boots once, Wire answers, millis() ticks', () => {
    const b = megaBench();
    b.load(MEGA_HEX);
    b.run();
    expect(bootMega(b)).toEqual(MEGA_GOOD);
  });

  it('mega-reset-uno-spi-config, avr-mega-reset-uno-vectors setup: a recompile (reload) rebuilds with the Mega vectors and boots the same', () => {
    const b = megaBench();
    b.load(MEGA_HEX);
    b.run();
    bootMega(b);
    b.stop();
    b.load(MEGA_HEX);
    b.run();
    expect(bootMega(b)).toEqual(MEGA_GOOD);
  });

  for (const how of ['Stop', 'Reset'] as const) {
    it(`avr-mega-reset-uno-vectors, avr-mega-tiny-reset-wrong-config, mega-reset-uno-spi-config: after ${how} then Run the Mega boots once and millis(), Serial and Wire keep working`, () => {
      const b = megaBench();
      b.load(MEGA_HEX);
      b.run();
      bootMega(b);
      if (how === 'Stop') b.stop();
      else b.reset();
      b.run();
      expect(bootMega(b)).toEqual(MEGA_GOOD);
    });
  }

  it('mega-reset-uno-spi-config, avr-mega-reset-uno-vectors setup: first Run, every SPI transfer-complete reaches SPI_STC_vect', () => {
    const b = new Bench('arduino-mega');
    b.load(MEGA_SPI_HEX);
    b.run();
    expect(bootMega(b, 1_000_000)).toEqual(['BOOT', 'SPI_ISR:8']);
  });

  it('mega-reset-uno-spi-config, avr-mega-reset-uno-vectors, avr-mega-tiny-reset-wrong-config: after Stop then Run every SPI transfer-complete still reaches SPI_STC_vect', () => {
    const b = new Bench('arduino-mega');
    b.load(MEGA_SPI_HEX);
    b.run();
    bootMega(b, 1_000_000);
    b.stop();
    b.run();
    expect(bootMega(b, 1_000_000)).toEqual(['BOOT', 'SPI_ISR:8']);
  });
});

// ── ATtiny85: the USI I2C bridge across Stop/Run ────────────────────────────

const TINY_HEX = fixture('avr-tiny-oled');

function tinyBench() {
  const b = new Bench('attiny85');
  const id = `${b.id}-oled`;
  const oled = oledElement(id);
  b.wire(id, 'SDA', 'PB0');
  b.wire(id, 'SCL', 'PB2');
  b.wire(id, 'VCC', 'VCC');
  b.wire(id, 'GND', 'GND');
  b.mount({ id, metadataId: 'ssd1306-i2c-4pin', el: oled });
  return { b, oled };
}

/** Boot once; the sketch reports on PB3 (all ACKed) or PB4 (a NACK). A good boot is 1.9 M cycles. */
function bootTiny(b: Bench): { acked: boolean; nacked: boolean } {
  b.step(4_000_000, () => b.pins.getPinState(3) || b.pins.getPinState(4));
  return { acked: b.pins.getPinState(3), nacked: b.pins.getPinState(4) };
}

describe('ATtiny85 + SSD1306 over the USI', () => {
  it('avr-mega-tiny-reset-wrong-config setup: first Run, every I2C transaction is ACKed and the panel fills', () => {
    const { b, oled } = tinyBench();
    b.load(TINY_HEX);
    b.run();
    expect(bootTiny(b)).toEqual({ acked: true, nacked: false });
    expect(histogram(oledGddram(oled))).toEqual({ '0x81': 1024 });
  });

  it('avr-mega-tiny-reset-wrong-config: after Stop then Run the USI bridge still carries the sketch to the OLED', () => {
    const { b, oled } = tinyBench();
    b.load(TINY_HEX);
    b.run();
    bootTiny(b);
    b.stop();
    oled.imageData.data.fill(0); // only what the second boot draws counts
    b.run();
    expect(bootTiny(b)).toEqual({ acked: true, nacked: false });
    expect(histogram(oledGddram(oled))).toEqual({ '0x81': 1024 });
  });
});

// ── Chip select tied to a rail, and CS/DC state on (re)attach ───────────────

const OLED_CS_LOW_HEX = fixture('avr-oled-spi-cs-low');
const EPD_HEX = fixture('avr-epaper');

/** avr-oled-spi fills frame n with this byte. */
const oledPattern = (n: number) => (0x11 * ((n % 15) + 1)) & 0xff;
const hex2 = (v: number) => `0x${v.toString(16).padStart(2, '0')}`;

/**
 * Uno + 7-pin SSD1306 with its CS on `cs` (protocol auto-detected), or with CS
 * left unwired (`null`, protocol then pinned by `properties`).
 */
function oledSpiBench(cs: string | null, properties: Record<string, unknown> = {}) {
  const b = new Bench('arduino-uno');
  const id = `${b.id}-oled`;
  const oled = oledElement(id);
  b.wire(id, 'GND', 'GND.1');
  b.wire(id, 'VIN', '5V');
  b.wire(id, 'CLK', '13');
  b.wire(id, 'DATA', '11');
  b.wire(id, 'DC', '9');
  b.wire(id, 'RST', '8');
  if (cs !== null) b.wire(id, 'CS', cs);
  b.mount({ id, metadataId: 'ssd1306', el: oled, properties });
  return { b, oled, id };
}

/** Uno + 1.54" SSD1681 e-paper with its CS on `cs` (BUSY left unwired). */
function epaperBench(cs: string) {
  const b = new Bench('arduino-uno');
  const id = `${b.id}-epd`;
  const epd = epaperElement(id);
  b.wire(id, 'GND', 'GND.1');
  b.wire(id, 'VCC', '5V');
  b.wire(id, 'SCK', '13');
  b.wire(id, 'SDI', '11');
  b.wire(id, 'DC', '9');
  b.wire(id, 'RST', '8');
  b.wire(id, 'CS', cs);
  b.mount({ id, metadataId: 'epaper-1in54-bw', el: epd });
  return { b, epd };
}

/** Pixels of an e-paper refresh that differ from avr-epaper's refresh n. */
function epaperErrors(epd: { painted: Pixels[] }, n: number): number | string {
  const frame = epd.painted[epd.painted.length - 1];
  if (!frame) return 'the panel never refreshed';
  const v = n & 1 ? 0x0f : 0xf0;
  let wrong = 0;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) {
      const white = (v & (0x80 >> (x & 7))) !== 0;
      const r = frame.data[(y * 200 + x) * 4];
      if (r !== (white ? 0xf4 : 0x20)) wrong++;
    }
  }
  return wrong;
}

describe('Uno + SPI panels: CS tied to GND', () => {
  it('cs-tied-to-gnd-never-selected setup: SSD1306 in SPI mode with CS on D10 shows the frames', () => {
    const { b, oled } = oledSpiBench('10');
    b.load(OLED_HEX);
    b.run();
    b.stepToLine('F:2', 2_000_000);
    runFrames();
    expect(histogram(oledGddram(oled))).toEqual({ [hex2(oledPattern(2))]: 1024 });
  });

  it('cs-tied-to-gnd-never-selected: SSD1306 in SPI mode with CS wired to GND is always selected and shows the frames', () => {
    const { b, oled } = oledSpiBench('GND.2');
    b.load(OLED_HEX);
    b.run();
    b.stepToLine('F:2', 2_000_000);
    expect(b.lines()).toContain('F:2');
    runFrames();
    expect(histogram(oledGddram(oled))).toEqual({ [hex2(oledPattern(2))]: 1024 });
  });

  it('cs-tied-to-gnd-never-selected setup: e-paper with CS on D10 shows each refresh', () => {
    const { b, epd } = epaperBench('10');
    b.load(EPD_HEX);
    b.run();
    b.stepToLine('R:2', 4_000_000);
    runFrames();
    expect(epaperErrors(epd, 2)).toBe(0);
  });

  it('cs-tied-to-gnd-never-selected: e-paper with CS wired to GND is always selected and shows each refresh', () => {
    const { b, epd } = epaperBench('GND.2');
    b.load(EPD_HEX);
    b.run();
    b.stepToLine('R:2', 4_000_000);
    expect(b.lines()).toContain('R:2');
    runFrames();
    expect(epaperErrors(epd, 2)).toBe(0);
  });
});

describe('Uno + SSD1306 (SPI): CS and DC state when the part (re)attaches', () => {
  it('spi-part-state-not-seeded-on-reattach setup: a wire edit re-attaches the panel, and frames show when CS falls after the attach', () => {
    const { b, oled, id } = oledSpiBench('10');
    b.load(OLED_HEX);
    b.wire(id, 'GND', 'GND.3'); // edit before Run: the firmware has not touched CS yet
    expect(b.part(id).attaches).toBe(3); // mount, hexEpoch, wire edit
    b.run();
    b.stepToLine('F:2', 2_000_000);
    runFrames();
    expect(histogram(oledGddram(oled))).toEqual({ [hex2(oledPattern(2))]: 1024 });
  });

  it('spi-part-state-not-seeded-on-reattach: a panel re-attached mid-frame, while the sketch holds CS low and DC high, keeps decoding', () => {
    const { b, oled, id } = oledSpiBench('10');
    b.load(OLED_HEX);
    b.run();
    b.stepToLine('F:2', 2_000_000);
    // Into frame 3's pixel data: DC just went high, CS has been low since setup().
    b.step(200_000, () => b.pins.getPinState(9), 0);
    b.step(3_000, () => false);
    expect(b.pins.getPinState(9)).toBe(true);
    expect(b.pins.getPinState(10)).toBe(false);
    b.wire(id, 'GND', 'GND.3'); // the user edits one of the panel's wires
    expect(b.part(id).attaches).toBe(3);
    // The rest of frame 3 is pixel data for the re-attached panel.
    b.stepToLine('F:3', 2_000_000);
    runFrames();
    const third = histogram(oledGddram(oled))[hex2(oledPattern(3))] ?? 0;
    expect(third, 'bytes of frame 3 decoded as data after the re-attach').toBeGreaterThan(0);
    // And every frame after it.
    b.stepToLine('F:5', 2_000_000);
    runFrames();
    expect(histogram(oledGddram(oled))).toEqual({ [hex2(oledPattern(5))]: 1024 });
  });

  it('spi-part-state-not-seeded-on-reattach setup: the CS-low-from-reset sketch fills the panel when the panel does not gate on CS', () => {
    // Same firmware as the it.fails below, panel pinned to SPI with its CS
    // unwired, which the model treats as always selected: the frames, DC and
    // RST all work, so only the CS level tracking is left to fail below.
    const { b, oled } = oledSpiBench(null, { protocol: 'spi' });
    b.load(OLED_CS_LOW_HEX);
    b.run();
    b.stepToLine('F:2', 2_000_000);
    runFrames();
    expect(histogram(oledGddram(oled))).toEqual({ [hex2(oledPattern(2))]: 1024 });
  });

  it('spi-part-state-not-seeded-on-reattach: a panel whose CS the sketch pulls low straight out of reset (no edge, only a level) is selected', () => {
    // avr-oled-spi-cs-low differs from avr-oled-spi only in never driving CS
    // high first; the setup test above runs this firmware with CS ungated.
    const { b, oled } = oledSpiBench('10');
    b.load(OLED_CS_LOW_HEX);
    b.run();
    b.stepToLine('F:2', 2_000_000);
    expect(b.lines()).toContain('F:2');
    expect(b.pins.getPinState(10)).toBe(false);
    runFrames();
    expect(histogram(oledGddram(oled))).toEqual({ [hex2(oledPattern(2))]: 1024 });
  });
});
