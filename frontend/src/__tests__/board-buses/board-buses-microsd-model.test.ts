/**
 * Board buses F4: the portable microSD model in the BROWSER host.
 *
 * F4 moves every responder next to the CPU that reads it, because QEMU asks
 * for a byte synchronously and a card hosted in the tab always answers too
 * late. The card is therefore one compiled model,
 * simulation/buses/models/microsd.c, and the browser runs the SAME artifact as
 * the worker rather than a twin of it. Three hand-kept twins exist today and
 * had already drifted (ProtocolParts.ts, pro esp32sim/SdSpiCard.ts and the
 * worker's esp32_sd_slave.py); this file is what says the portable one is
 * good enough to retire them.
 *
 * Two altitudes:
 *
 *  - PARITY: the same real Arduino SD.h firmware the JS card is proved with
 *    (microsd-real-firmware.test.ts) mounts a FAT16 image served by the WASM
 *    model, reads a file, writes a new one and reads it back; and the card's
 *    blob then lists the written file, which is the claim
 *    sd-card-panel-live.test.ts makes about the panel.
 *  - CONFORMANCE: the table in fixtures/microsd-model/sd-script.json, written
 *    from the SD spec and replayed here and, against the same .wasm, by
 *    velxio/test/backend/unit/test_microsd_wasm_model.py. A model that
 *    answered differently in one host is the per-engine divergence this whole
 *    project exists to remove.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AVRSimulator } from '../../simulation/AVRSimulator';
import { PinManager } from '../../simulation/PinManager';
import { ChipInstance } from '../../simulation/customChips/ChipRuntime';
import { buildFat16Image, readFat16Image } from '../../utils/fatImage';
import { busRegistry, boardPinsFromPinManager } from '../../simulation/buses';
import type {
  EngineBinding,
  NetResolver,
  SpiControllerConfig,
  SpiControllerPort,
  SpiRouting,
} from '../../simulation/buses';

// ── The model under test ─────────────────────────────────────────────────────

const model = (p: string) =>
  fileURLToPath(new URL(`../../simulation/buses/models/${p}`, import.meta.url));
// The built artifact ships from public/, the way the pro responders of this
// phase do: the browser fetches it by path and hands the same bytes to the
// worker. Read here from disk, because a node test has no server.
const WASM = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../public/bus-chips/microsd.wasm', import.meta.url))),
);
const MANIFEST = JSON.parse(readFileSync(model('manifest.json'), 'utf-8')) as Record<
  string,
  { sourceSha256: string }
>;

const fixture = (p: string) =>
  fileURLToPath(new URL(`./fixtures/microsd-model/${p}`, import.meta.url));

interface Step {
  why: string;
  cs?: 'low' | 'high';
  mosi?: Array<string | { byte: string; times: number }>;
  clock?: number;
  expect?: Array<{ at: number; is: string }>;
}
interface Script {
  why: string;
  attrs: Record<string, number>;
  noCard?: boolean;
  steps: Step[];
  after: { writes: Array<{ offset: number; hex: string }>; dirty: Record<string, [number, number]> };
}
const TABLE = JSON.parse(readFileSync(fixture('sd-script.json'), 'utf-8')) as {
  card: { blob: string; sectors: number; rule: string };
  scripts: Record<string, Script>;
};

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** The table's card image, built from the rule the table states. The Python
 *  replayer builds it from the same rule; the read rows carry the bytes it
 *  produces, so two replayers that disagree fail instead of comparing nothing. */
function buildCard(): Uint8Array {
  const out = new Uint8Array(TABLE.card.sectors * 512);
  for (let s = 0; s < TABLE.card.sectors; s++) {
    for (let o = 0; o < 512; o++) out[s * 512 + o] = (s * 37 + o) & 0xff;
  }
  return out;
}

function stepMosi(step: Step): Uint8Array {
  const parts: number[] = [];
  for (const chunk of step.mosi ?? []) {
    if (typeof chunk === 'string') {
      for (let i = 0; i < chunk.length; i += 2) parts.push(parseInt(chunk.slice(i, i + 2), 16));
    } else {
      const b = parseInt(chunk.byte, 16);
      for (let i = 0; i < chunk.times; i++) parts.push(b);
    }
  }
  for (let i = 0; i < (step.clock ?? 0); i++) parts.push(0xff);
  return Uint8Array.from(parts);
}

/** Every expectation of one step the answer did not meet, so a broken model
 *  names all its divergences at once instead of only the first. */
function checkStep(step: Step, miso: Uint8Array, label: string): string[] {
  const bad: string[] = [];
  for (const exp of step.expect ?? []) {
    const got = hex(miso.slice(exp.at, exp.at + exp.is.length / 2));
    if (got !== exp.is) {
      bad.push(`${label}: at ${exp.at} got ${got || '<short>'}, table says ${exp.is} (${step.why})`);
    }
  }
  return bad;
}

// ── A board for the model to sit on ──────────────────────────────────────────
// The fabric, the registry and the chip runtime are the real ones; the engine
// is a stub controller port, because what this half of the file is about is
// the MODEL's answers and not an engine's byte path. The engine path is proved
// below with a real AVR running real SD.h firmware.

const BOARD = 'uno-1';
const CARD_ID = 'sd-1';
/** The Uno's SPI pads, and the chip select the tests drive. */
const WIRING: Record<string, number> = { SCK: 13, DI: 11, DO: 12, CS: 10 };

const circuit: NetResolver = {
  resolve: (ref) =>
    ref.kind === 'board'
      ? { kind: 'board', boardId: ref.boardId, pin: ref.pin }
      : ref.componentId === CARD_ID && WIRING[ref.pinName] !== undefined
        ? { kind: 'board', boardId: BOARD, pin: WIRING[ref.pinName] }
        : { kind: 'floating' },
  boardKind: () => 'arduino-uno',
  boards: () => [BOARD],
};

class StubPort implements SpiControllerPort {
  readonly bus = 'spi' as const;
  readonly unit = 0;
  readonly name = 'SPI';
  private handler: ((mosi: number, bits: number) => number) | null = null;
  setFrameHandler(h: ((mosi: number, bits: number) => number) | null): void {
    this.handler = h;
  }
  config(): SpiControllerConfig {
    return { enabled: true, mode: 0, bitOrder: 'msb', bits: 8 };
  }
  routing(): SpiRouting | 'static' {
    return 'static';
  }
  /** The engine clocks one frame. */
  xfer(mosi: number): number {
    if (!this.handler) throw new Error('the fabric bound no frame handler');
    return this.handler(mosi, 8);
  }
}

interface Rig {
  chip: ChipInstance;
  port: StubPort;
  /** MISO the soft-SPI decoder put on the wire, for the bit-banged path. */
  misoBit: () => boolean;
  select(active: boolean): void;
  pins: PinManager;
}

async function rig(script: Script): Promise<Rig> {
  const pins = new PinManager();
  const port = new StubPort();
  let driven = false;
  const binding: EngineBinding = {
    pins: boardPinsFromPinManager(pins, (pin, level) => {
      if (pin === WIRING.DO) driven = level;
    }),
    spi: [port],
  };
  busRegistry.setResolver(circuit);
  busRegistry.bindEngine(BOARD, binding);
  // Chip select rests high, as its own pull-up holds it: without this the
  // fabric reads an undriven pin and calls the card deselected for a different
  // reason than the one under test.
  pins.triggerPinChange(WIRING.CS, true);

  const chip = await ChipInstance.create({
    wasm: WASM,
    componentId: CARD_ID,
    pinManager: pins,
    wires: new Map(Object.entries(WIRING)),
    attrs: new Map(Object.entries(script.attrs ?? {})),
    blobs: script.noCard ? null : new Map([[TABLE.card.blob, buildCard()]]),
  });
  chip.start();
  return {
    chip,
    port,
    pins,
    misoBit: () => driven,
    select: (active: boolean) => pins.triggerPinChange(WIRING.CS, !active),
  };
}

/** Walk a script: chip select edges as the fabric reports them, bytes through
 *  the controller port. */
function play(r: Rig, script: Script): string[] {
  const bad: string[] = [];
  let selected = false;
  script.steps.forEach((step, i) => {
    if (step.cs) {
      selected = step.cs === 'low';
      r.select(selected);
    }
    const mosi = stepMosi(step);
    if (mosi.length === 0) return;
    expect(selected, `step ${i} clocks bytes with chip select released`).toBe(true);
    const miso = Uint8Array.from(mosi, (b) => r.port.xfer(b));
    bad.push(...checkStep(step, miso, `step ${i}`));
  });
  return bad;
}

// ── The real-firmware rig ────────────────────────────────────────────────────

const HEX = readFileSync(
  fileURLToPath(new URL('../fixtures/microsd-rw/microsd-rw.ino.hex', import.meta.url)),
  'utf-8',
);

function runUntil(sim: AVRSimulator, budget: number, pred: () => boolean): void {
  for (let i = 0; i < budget; i++) {
    sim.step();
    if ((i & 0x3ff) === 0 && pred()) return;
  }
}

/** Run the SD.h fixture sketch against the WASM card on a real AVR. */
async function runFirmware(): Promise<{ out: string; chip: ChipInstance; image: Uint8Array }> {
  const pins = new PinManager();
  const sim = new AVRSimulator(pins, 'uno');
  sim.loadHex(HEX);
  busRegistry.setResolver(circuit);
  busRegistry.bindEngine(BOARD, sim.getBusBinding()!);
  const image = buildFat16Image([
    { name: 'hello.txt', data: new TextEncoder().encode('SD WORKS 123') },
  ]);
  const chip = await ChipInstance.create({
    wasm: WASM,
    componentId: CARD_ID,
    pinManager: pins,
    wires: new Map(Object.entries(WIRING)),
    blobs: new Map([['card', image]]),
  });
  chip.start();

  let out = '';
  sim.onSerialData = (ch) => {
    out += ch;
  };
  runUntil(sim, 60_000_000, () => out.includes('DONE') || out.includes('FAIL'));
  return { out, chip, image };
}

describe('the portable microSD model, browser host', () => {
  // No board and no device of this file left on the fabric for the next one,
  // even when an assertion above throws.
  afterEach(() => busRegistry.clear());

  it('the committed wasm was built from the committed source', () => {
    // The model is product code, not a fixture: a stale .wasm means this suite
    // and the worker's are agreeing about a binary nobody can rebuild.
    const sha = createHash('sha256').update(readFileSync(model('microsd.c'))).digest('hex');
    expect(sha).toBe(MANIFEST.microsd.sourceSha256);
  });

  describe('parity with the JS card it replaces', () => {
    it('real SD.h firmware mounts it, reads a file, writes one and reads it back', async () => {
      const { out } = await runFirmware();
      expect(out).toContain('READ:SD WORKS 123'); // the file the image shipped with
      expect(out).toContain('RBACK:written-123'); // written this run, and read back
      expect(out).toContain('DONE');
      expect(out).not.toContain('FAIL');
    });

    it('the card blob lists the file the sketch wrote, which is what the panel reads', async () => {
      const { chip } = await runFirmware();
      // The panel lists a card by parsing its image; here that image is the
      // blob, which is the whole reason the vx_blob_* ABI exists.
      const files = readFat16Image(chip.blobBytes('card')!);
      const names = files.map((f) => f.name.toUpperCase());
      expect(names).toContain('OUT.TXT');
      expect(names).toContain('HELLO.TXT');
      const written = files.find((f) => f.name.toUpperCase() === 'OUT.TXT')!;
      expect(new TextDecoder().decode(written.data)).toBe('written-123');
    });

    it('reports the spans the guest wrote, so the panel is told what changed', async () => {
      const { chip, image } = await runFirmware();
      const dirty = chip.takeBlobDirty();
      const span = dirty.get('card');
      expect(span, 'the run wrote to the card').toBeDefined();
      expect(span![0]).toBeGreaterThanOrEqual(0);
      expect(span![1]).toBeLessThanOrEqual(image.length);
      // A second drain has nothing left: the host ships each span once.
      expect(chip.takeBlobDirty().size).toBe(0);
    });

    it('a slot with no card image fails to mount instead of pretending', async () => {
      const pins = new PinManager();
      const sim = new AVRSimulator(pins, 'uno');
      sim.loadHex(HEX);
      busRegistry.setResolver(circuit);
      busRegistry.bindEngine(BOARD, sim.getBusBinding()!);
      const chip = await ChipInstance.create({
        wasm: WASM,
        componentId: CARD_ID,
        pinManager: pins,
        wires: new Map(Object.entries(WIRING)),
        blobs: null,
      });
      chip.start();
      let out = '';
      sim.onSerialData = (ch) => {
        out += ch;
      };
      runUntil(sim, 60_000_000, () => out.includes('DONE') || out.includes('FAIL'));
      expect(out).toContain('FAIL');
      expect(out).not.toContain('READ:');
    });
  });

  describe('the cross-host table', () => {
    it('a standard-capacity card answers every row', async () => {
      const r = await rig(TABLE.scripts.sdsc);
      expect(play(r, TABLE.scripts.sdsc)).toEqual([]);
    });

    it('the write in that table landed in the blob, and only there', async () => {
      const script = TABLE.scripts.sdsc;
      const r = await rig(script);
      expect(play(r, script)).toEqual([]);
      // The whole card, not just the written sectors: a model that wrote one
      // byte too far, or into a second copy of the image, differs here.
      const expected = buildCard();
      for (const w of script.after.writes) {
        expected.set(Uint8Array.from(Buffer.from(w.hex, 'hex')), w.offset);
      }
      expect(hex(r.chip.blobBytes('card')!)).toBe(hex(expected));
      expect(Object.fromEntries(r.chip.takeBlobDirty())).toEqual(script.after.dirty);
    });

    it('a high-capacity card addresses in blocks', async () => {
      const r = await rig(TABLE.scripts.sdhc);
      expect(play(r, TABLE.scripts.sdhc)).toEqual([]);
    });

    it('a slot with no card image drives nothing', async () => {
      const r = await rig(TABLE.scripts.empty);
      expect(play(r, TABLE.scripts.empty)).toEqual([]);
      expect(r.chip.blobBytes('card')).toBeNull();
    });
  });

  describe('the bit-banged master', () => {
    it('reads R1 through the peek path, a byte ahead of the clock', async () => {
      // A software master asks the bus what the card will shift out NEXT and
      // puts those bits on MISO before it samples them. The card has to be
      // right on that path too, not only on transfer(): shiftIn() reads the
      // line, never the byte the fabric returns.
      const r = await rig(TABLE.scripts.sdsc);
      r.select(true);
      const cmd0 = [0x40, 0x00, 0x00, 0x00, 0x00, 0x95];
      const seen: number[] = [];
      const shift = (mosi: number): number => {
        let inByte = 0;
        for (let bit = 7; bit >= 0; bit--) {
          r.pins.triggerPinChange(WIRING.DI, ((mosi >> bit) & 1) === 1);
          r.pins.triggerPinChange(WIRING.SCK, true);
          inByte = (inByte << 1) | (r.misoBit() ? 1 : 0);
          r.pins.triggerPinChange(WIRING.SCK, false);
        }
        return inByte & 0xff;
      };
      for (const b of [...cmd0, 0xff, 0xff, 0xff]) seen.push(shift(b));
      // Same offsets as the hardware path: the fill byte, then R1 idle.
      expect(seen[6]).toBe(0xff);
      expect(seen[7]).toBe(0x01);
    });
  });
});
