/**
 * Board buses F5 (D-010): the gallery's I2C examples read REAL parts.
 *
 * The store used to add a DS1307 (0x68), a temperature sensor (0x48) and an
 * EEPROM (0x50) to every AVR and RP2040 bus on each load, parts nobody put on
 * the canvas. They are gone, so every example that read one now carries the
 * part itself (evidence/examples-inventory.md, section 2.1). This suite runs
 * each of those examples the way the app does and checks the reading its
 * sketch prints:
 *
 *   - the firmware is the example's own sketch, as the example object hands it
 *     to the compiler, built by the production toolchain
 *     (fixtures/examples-i2c/<id>; rebuild with
 *     project/board-buses-2026-09/harness/compile-fixture.mjs --fqbn <fqbn>
 *     --board-kind <kind> --out <dir> <id>.ino). The first test proves each
 *     fixture sketch is byte for byte the example's code, so a template-literal
 *     escape that eats a backslash, or an edit nobody rebuilt, fails here;
 *   - the circuit is the example's own components and wires: every part pin
 *     lands where the example wires it, through boardPinToNumber, and the parts
 *     attach through PartSimulationRegistry exactly as the canvas attaches
 *     them (the 24C01 is the gallery chip's source, run from the WASM built
 *     from that same source, fixtures/chips-spi-chips);
 *   - the engine is the real one (avr8js behind AVRSimulator, rp2040js behind
 *     RP2040Simulator) on its production frame loop.
 *
 * Each example also runs once with its I2C parts left off the canvas: the
 * reading must be gone, which is what proves the part on the canvas, and not
 * something the store or the engine adds, is what answered.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AVRSimulator } from '../../simulation/AVRSimulator';
import { RP2040Simulator } from '../../simulation/RP2040Simulator';
import { PinManager } from '../../simulation/PinManager';
import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import '../../simulation/parts/ProtocolParts';
import '../../simulation/parts/CustomChipPart';
import { useSimulatorStore, getBoardSimulator } from '../../store/useSimulatorStore';
import { busRegistry } from '../../simulation/buses/registry';
import type { NetResolver, PinRef, ResolvedPin } from '../../simulation/buses/types';
import { exampleProjects, type ExampleProject } from '../../data/examples';
import { boardPinToNumber } from '../../utils/boardPinMapping';

// ── Frame clock ──────────────────────────────────────────────────────────────
const frameCallbacks = new Map<number, FrameRequestCallback>();
let frameId = 0;
let frameClockMs = 0;
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  frameCallbacks.set(++frameId, cb);
  return frameId;
});
vi.stubGlobal('cancelAnimationFrame', (id: number) => {
  frameCallbacks.delete(id);
});
if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
  vi.stubGlobal('document', { getElementById: () => null, activeElement: null });
}
function frame(): void {
  frameClockMs += 16;
  const due = [...frameCallbacks.values()];
  frameCallbacks.clear();
  for (const cb of due) cb(frameClockMs);
}

// The chip part prints its vx_log lines; keep them out of the output and
// count the "ready" line that says chip_setup ran.
const chipLines: Array<{ id: string; msg: string }> = [];
vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
  const m = /^\[chip:([^\]]+)\] (?:\[chip\] )?(.*)$/.exec(String(args[0] ?? ''));
  if (m) chipLines.push({ id: m[1], msg: m[2] });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixture = (id: string, ext: string) => here(`./fixtures/examples-i2c/${id}/${id}.ino${ext}`);
const GALLERY_EEPROM_C = here('../../components/customChips/examples/eeprom-24c01.c');
const EEPROM_WASM = readFileSync(here('./fixtures/chips-spi-chips/eeprom-24c01.wasm')).toString('base64');
const EEPROM_MANIFEST = JSON.parse(readFileSync(here('./fixtures/chips-spi-chips/manifest.json'), 'utf-8')) as Record<
  string,
  { sourceSha256: string }
>;

// Fixed wall clock: both RTC models answer the browser's time, so the reading
// a sketch prints is known to the second.
const NOW = new Date(2026, 8, 24, 13, 7, 42); // Thu 24/09/2026 13:07:42 local
const two = (n: number) => String(n).padStart(2, '0');

// ── The circuit, from the example's own wires ────────────────────────────────

/** The parts of these examples that sit on the I2C bus, by metadata id. Any
 *  other part must be one that has no bus role (checked below), so a bus part
 *  added to an example later cannot be silently left off this rig. */
const BUS_PARTS = new Set(['ssd1306', 'ds1307', 'ds3231', 'custom-chip']);
const PASSIVE_PARTS = new Set(['led', 'resistor', 'potentiometer']);
const typeOf = (c: { type: string }) => c.type.replace(/^(wokwi|velxio)-/, '');
const isBoardRef = (id: string) => id === 'arduino-uno' || id === 'raspberry-pi-pico';

/**
 * Where each component pin of an example lands: a board pad, the ground or
 * supply rail, or nothing. Wires are walked as nets, so a chip pin strapped to
 * the chip's own GND (the 24C01's A0-A2 and WP) lands where that GND does.
 */
function landings(ex: ExampleProject, kind: string): Map<string, ResolvedPin> {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k) ?? k;
    if (p === k) return k;
    const r = find(p);
    parent.set(k, r);
    return r;
  };
  const key = (e: { componentId: string; pinName: string }) =>
    `${isBoardRef(e.componentId) ? 'BOARD' : e.componentId}:${e.pinName}`;
  for (const w of ex.wires) {
    for (const e of [w.start, w.end]) if (!parent.has(key(e))) parent.set(key(e), key(e));
    parent.set(find(key(w.start)), find(key(w.end)));
  }
  const netOf = new Map<string, ResolvedPin>();
  for (const k of [...parent.keys()]) {
    if (!k.startsWith('BOARD:')) continue;
    const pad = k.slice('BOARD:'.length);
    const n = boardPinToNumber(kind, pad);
    if (n === null) throw new Error(`${ex.id}: the board has no pad ${pad}`);
    const land: ResolvedPin =
      n >= 0 ? { kind: 'board', boardId: kind, pin: n } : { kind: 'rail', rail: /^GND/.test(pad) ? 'gnd' : 'vcc' };
    netOf.set(find(k), land);
  }
  const out = new Map<string, ResolvedPin>();
  for (const k of parent.keys()) {
    if (k.startsWith('BOARD:')) continue;
    out.set(k, netOf.get(find(k)) ?? { kind: 'floating' });
  }
  return out;
}

class ExampleCircuit implements NetResolver {
  readonly kind: string;
  readonly pins: Map<string, ResolvedPin>;
  constructor(kind: string, pins: Map<string, ResolvedPin>) {
    this.kind = kind;
    this.pins = pins;
  }
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.pins.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }
  boardKind(boardId: string): string | undefined {
    return boardId === this.kind ? this.kind : undefined;
  }
  boards(): string[] {
    return [this.kind];
  }
}

// ── Rig ──────────────────────────────────────────────────────────────────────
type Board = AVRSimulator | RP2040Simulator;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      /* a part that throws on teardown must not hide the next test */
    }
  }
  frameCallbacks.clear();
  chipLines.length = 0;
  vi.useRealTimers();
  useSimulatorStore.setState({ components: [] } as never);
  busRegistry.clear();
});

function exampleById(id: string): ExampleProject {
  const ex = exampleProjects.find((e) => e.id === id);
  if (!ex) throw new Error(`no example ${id}`);
  return ex;
}

/** Put the example on a board and run it until `done` or `maxFrames`. */
async function runExample(
  id: string,
  opts: { parts: boolean; done: (out: string) => boolean; maxFrames: number },
): Promise<string> {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  const ex = exampleById(id);
  const kind = ex.boardType ?? 'arduino-uno';
  const circuit = new ExampleCircuit(kind, landings(ex, kind));
  busRegistry.setResolver(circuit);

  const sim: Board = kind === 'arduino-uno' ? new AVRSimulator(new PinManager(), 'uno') : new RP2040Simulator(new PinManager());
  busRegistry.bindBoard(kind, sim);
  cleanups.push(() => busRegistry.unbindBoard(kind));
  cleanups.push(() => sim.stop());
  if (sim instanceof AVRSimulator) sim.loadHex(readFileSync(fixture(id, '.hex'), 'utf-8'));
  else sim.loadBinary(readFileSync(fixture(id, '.bin')).toString('base64'));

  const parts = ex.components.filter((c) => BUS_PARTS.has(typeOf(c)));
  useSimulatorStore.setState({
    components: parts.map((c) => ({
      id: c.id,
      metadataId: typeOf(c),
      x: c.x,
      y: c.y,
      // The chip runs the WASM built from the source the example ships.
      properties: typeOf(c) === 'custom-chip' ? { ...c.properties, wasmBase64: EEPROM_WASM } : c.properties,
    })),
  } as never);
  busRegistry.netlistChanged();

  if (opts.parts) {
    for (const c of parts) {
      const t = typeOf(c);
      const getPin = (name: string): number | null => {
        const land = circuit.pins.get(`${c.id}:${name}`);
        return land?.kind === 'board' ? land.pin : null;
      };
      const el = {
        id: c.id,
        canvas: null,
        getAttribute: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as HTMLElement;
      const before = chipLines.filter((l) => l.id === c.id).length;
      cleanups.push(PartSimulationRegistry.get(t)!.attachEvents!(el, sim as never, getPin, c.id));
      if (t === 'custom-chip') {
        await vi.waitFor(() => {
          if (!chipLines.filter((l) => l.id === c.id).slice(before).some((l) => /ready/i.test(l.msg))) {
            throw new Error(`${c.id} not ready`);
          }
        });
      }
    }
  }

  let out = '';
  sim.onSerialData = (ch: string) => {
    out += ch;
  };
  sim.start();
  for (let i = 0; i < opts.maxFrames && !opts.done(out); i++) frame();
  sim.stop();
  return out;
}

// ── What each example must read ──────────────────────────────────────────────

interface Row {
  id: string;
  /** The reading the sketch prints once its parts answer. */
  expect: string[];
  /** When the run has printed enough to judge it. */
  done: RegExp;
  maxFrames: number;
}

const HMS = `${two(NOW.getHours())}:${two(NOW.getMinutes())}:${two(NOW.getSeconds())}`;
const ROWS: Row[] = [
  {
    id: 'i2c-scanner',
    expect: [
      'Device found at 0x3C  (SSD1306 OLED)',
      'Device found at 0x50  (EEPROM)',
      'Device found at 0x68  (DS1307 RTC)',
      'Scan complete. 3 device(s) found.',
    ],
    done: /device\(s\) found\.\r\n/,
    maxFrames: 400,
  },
  {
    id: 'i2c-eeprom-rw',
    expect: ['Read  reg[0] = 10  [OK]', 'Read  reg[7] = 80  [OK]', 'All tests PASSED!'],
    done: /(PASSED|FAILED)\.?!?\r\n/,
    maxFrames: 400,
  },
  {
    id: 'multi-protocol',
    expect: [
      'Found device at 0x50',
      'Found device at 0x68',
      '2 device(s) on I2C bus.',
      'Wrote 42, read 42 [OK]',
      'Wrote 99, read 99 [OK]',
      `[RTC] ${HMS}`,
    ],
    done: /\[RTC\] .*\r\n/,
    maxFrames: 600,
  },
  {
    id: 'pico-i2c-rtc-read',
    expect: [
      `Time: ${HMS}  Date: Thu ${two(NOW.getDate())}/${two(NOW.getMonth() + 1)}/20${two(NOW.getFullYear() % 100)}`,
    ],
    done: /(Time: |RTC not responding).*\r\n/,
    maxFrames: 400,
  },
  {
    id: 'pico-i2c-eeprom-rw',
    expect: ['[0] = 0xDE OK', '[7] = 0xBE OK', 'Result: 8/8 passed'],
    done: /Result: .*\r\n/,
    maxFrames: 1200,
  },
  {
    id: 'pico-multi-protocol',
    expect: ['Found device at 0x50', 'Found device at 0x68', 'Total devices: 2', 'Wrote 0x42, Read 0x42', 'RTC responded OK'],
    done: /\[SPI\]/,
    maxFrames: 1200,
  },
  {
    id: 'pico-i2c-scanner',
    expect: ['Device found at 0x50 (EEPROM)', 'Device found at 0x68 (DS1307/DS3231 RTC)', 'Scan complete. Found 2 device(s).'],
    done: /Scan complete\..*\r\n/,
    maxFrames: 600,
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('D-010: the I2C examples carry the parts they read', () => {
  it('each fixture is the example sketch, byte for byte, as the compiler is handed it', () => {
    for (const row of ROWS) {
      const sketch = readFileSync(fixture(row.id, ''), 'utf-8');
      expect(sketch, `${row.id}: rebuild fixtures/examples-i2c/${row.id}`).toBe(exampleById(row.id).code);
    }
  });

  it('the EEPROM chip is the gallery 24C01, and the WASM the rig runs was built from that source', () => {
    const gallery = readFileSync(GALLERY_EEPROM_C, 'utf-8');
    expect(createHash('sha256').update(gallery).digest('hex')).toBe(EEPROM_MANIFEST['eeprom-24c01'].sourceSha256);
    for (const row of ROWS) {
      for (const c of exampleById(row.id).components.filter((x) => typeOf(x) === 'custom-chip')) {
        expect(c.properties.sourceC, `${row.id}/${c.id}`).toBe(gallery);
        expect(JSON.parse(c.properties.chipJson).pins).toEqual(['A0', 'A1', 'A2', 'GND', 'VCC', 'WP', 'SCL', 'SDA']);
      }
    }
  });

  it('every part of these examples is either on this rig or has no bus role', () => {
    for (const row of ROWS) {
      for (const c of exampleById(row.id).components) {
        const t = typeOf(c);
        if (t === 'arduino-uno') continue;
        expect(BUS_PARTS.has(t) || PASSIVE_PARTS.has(t), `${row.id}: ${c.type}`).toBe(true);
      }
    }
  });

  it("every bus part's SDA and SCL land on the board's Wire pads, and its supply on a rail", () => {
    const WIRE: Record<string, { sda: number; scl: number }> = {
      'arduino-uno': { sda: 18, scl: 19 }, // A4 / A5 (TWI)
      'raspberry-pi-pico': { sda: 4, scl: 5 }, // GP4 / GP5 (I2C0, Wire)
    };
    for (const row of ROWS) {
      const ex = exampleById(row.id);
      const kind = ex.boardType ?? 'arduino-uno';
      const pins = landings(ex, kind);
      for (const c of ex.components.filter((x) => BUS_PARTS.has(typeOf(x)))) {
        const at = (n: string) => pins.get(`${c.id}:${n}`);
        const sda = typeOf(c) === 'ssd1306' ? 'DATA' : 'SDA';
        const scl = typeOf(c) === 'ssd1306' ? 'CLK' : 'SCL';
        expect(at(sda), `${row.id}/${c.id} SDA`).toEqual({ kind: 'board', boardId: kind, pin: WIRE[kind].sda });
        expect(at(scl), `${row.id}/${c.id} SCL`).toEqual({ kind: 'board', boardId: kind, pin: WIRE[kind].scl });
        expect(at('GND'), `${row.id}/${c.id} GND`).toEqual({ kind: 'rail', rail: 'gnd' });
        if (typeOf(c) === 'custom-chip') {
          for (const strap of ['A0', 'A1', 'A2', 'WP']) {
            expect(at(strap), `${row.id}/${c.id} ${strap} (0x50, writes allowed)`).toEqual({ kind: 'rail', rail: 'gnd' });
          }
        }
      }
    }
  });

  for (const row of ROWS) {
    it(`${row.id}: prints the reading of the parts on its canvas`, async () => {
      const out = await runExample(row.id, { parts: true, done: (o) => row.done.test(o), maxFrames: row.maxFrames });
      for (const line of row.expect) expect(out, `${row.id} printed ${JSON.stringify(out.slice(-400))}`).toContain(line);
    });

    it(`${row.id}: with its I2C parts off the canvas, nothing answers`, async () => {
      const out = await runExample(row.id, { parts: false, done: (o) => row.done.test(o), maxFrames: row.maxFrames });
      for (const line of row.expect) expect(out).not.toContain(line);
    });
  }
});

// ── The store itself adds nothing ────────────────────────────────────────────
// The rig above loads firmware straight into the simulator. These go through
// the store's own load paths, the ones that used to add the demo devices: an
// empty canvas must leave an empty bus on every one of them.

/** Run a board the store built until `done` or `maxFrames`. */
function runStoreBoard(sim: Board, done: RegExp, maxFrames: number): string {
  let out = '';
  sim.onSerialData = (ch: string) => {
    out += ch;
  };
  sim.start();
  for (let i = 0; i < maxFrames && !done.test(out); i++) frame();
  sim.stop();
  return out;
}

describe('D-010: no store load path puts a device on an empty I2C bus', () => {
  const EEPROM_HEX = () => readFileSync(fixture('i2c-eeprom-rw', '.hex'), 'utf-8');
  const RTC_BIN = () => readFileSync(fixture('pico-i2c-rtc-read', '.bin')).toString('base64');

  function storeBoard(kind: 'arduino-uno' | 'raspberry-pi-pico', active: boolean): { id: string; sim: Board } {
    const st = useSimulatorStore.getState();
    const id = st.addBoard(kind as never, 0, 0);
    if (active) st.setActiveBoardId(id);
    const sim = getBoardSimulator(id) as Board;
    cleanups.push(() => useSimulatorStore.getState().removeBoard(id));
    return { id, sim };
  }

  it('compileBoardProgram on an Uno: the EEPROM sketch reads an empty bus', () => {
    const { id, sim } = storeBoard('arduino-uno', false);
    useSimulatorStore.getState().compileBoardProgram(id, EEPROM_HEX());
    const out = runStoreBoard(sim, /(PASSED|FAILED)\.?!?\r\n/, 400);
    expect(out).toContain('Read  reg[0] = 255  [FAIL] expected 10');
    expect(out).toContain('8 test(s) FAILED.');
  });

  it('loadHex on the active Uno: the EEPROM sketch reads an empty bus', () => {
    const { sim } = storeBoard('arduino-uno', true);
    useSimulatorStore.getState().loadHex(EEPROM_HEX());
    const out = runStoreBoard(sim, /(PASSED|FAILED)\.?!?\r\n/, 400);
    expect(out).toContain('8 test(s) FAILED.');
  });

  it('compileBoardProgram on a Pico: the RTC sketch finds nothing at 0x68', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const { id, sim } = storeBoard('raspberry-pi-pico', false);
    useSimulatorStore.getState().compileBoardProgram(id, RTC_BIN());
    const out = runStoreBoard(sim, /(Time: |RTC not responding).*\r\n/, 400);
    expect(out).toContain('RTC not responding!');
    expect(out).not.toContain('Time: ');
  });

  it('loadBinary on the active Pico: the RTC sketch finds nothing at 0x68', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const { sim } = storeBoard('raspberry-pi-pico', true);
    useSimulatorStore.getState().loadBinary(RTC_BIN());
    const out = runStoreBoard(sim, /(Time: |RTC not responding).*\r\n/, 400);
    expect(out).toContain('RTC not responding!');
    expect(out).not.toContain('Time: ');
  });
});
