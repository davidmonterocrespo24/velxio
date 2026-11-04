/**
 * Board buses F0, area chips-spi: custom-chip SPI in the browser host.
 *
 * Every case runs a real engine (avr8js behind AVRSimulator, rp2040js behind
 * RP2040Simulator) on a real sketch built with the production toolchain
 * (fixtures/chips-spi-console, a serial-driven SPI master), with the real
 * custom-chip part ('custom-chip' in PartSimulationRegistry: CustomChipPart ->
 * ChipRuntime -> the bus fabric) loading real chip WASM (the
 * gallery sources, and two probe chips, under fixtures/chips-spi-chips) and
 * the real microSD and e-paper parts. Nothing on the byte path is mocked; the
 * only stubs are requestAnimationFrame (driven here as the frame clock, so the
 * simulators run their own production frame loops) and a document with no
 * elements (the chip part looks for its canvas element, which a node test does
 * not have).
 *
 * Convention (project/board-buses-2026-09/TESTS.md): a finding that
 * reproduces is an it.fails stating the hardware-faithful behaviour, next to a
 * "setup" it() proving the rig itself works; a finding that does not reproduce
 * stays a plain it() as a regression guard.
 *
 * Pins. Uno: hardware SPI is D11 MOSI, D12 MISO, D13 SCK. Pico: SPI0 is GP16
 * MISO, GP18 SCK, GP19 MOSI (arduino-pico defaults).
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
import '../../simulation/parts/EPaperPart';
import '../../simulation/parts/ComplexParts';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { busRegistry } from '../../simulation/buses/registry';
import { syntheticNetPin } from '../../simulation/customChips/syntheticPins';
import type { BusDiagnostic, NetResolver, PinRef, ResolvedPin } from '../../simulation/buses/types';

// ── Frame clock ──────────────────────────────────────────────────────────────
// Both simulators run their production loop off requestAnimationFrame; here
// every frame() is 1 ms of guest time.
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
  frameClockMs += 1;
  const due = [...frameCallbacks.values()];
  frameCallbacks.clear();
  for (const cb of due) cb(frameClockMs);
}

// ── Chip log ─────────────────────────────────────────────────────────────────
// CustomChipPart prints the chip's vx_log lines as "[chip:<id>] [chip] <msg>".
const chipLines: Array<{ id: string; msg: string }> = [];
const realLog = console.log.bind(console);
vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
  const s = String(args[0] ?? '');
  const m = /^\[chip:([^\]]+)\] (?:\[chip\] )?(.*)$/.exec(s);
  if (m) chipLines.push({ id: m[1], msg: m[2] });
  else if (process.env.CHIPS_SPI_VERBOSE) realLog(...args);
});
const chipLog = (id: string) => chipLines.filter((l) => l.id === id).map((l) => l.msg);

// ── Fixtures ─────────────────────────────────────────────────────────────────
const fixture = (p: string) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const gallery = (p: string) =>
  fileURLToPath(new URL(`../../components/customChips/examples/${p}`, import.meta.url));
const UNO_HEX = readFileSync(fixture('chips-spi-console/uno/spi-console.ino.hex'), 'utf-8');
const PICO_BIN = readFileSync(fixture('chips-spi-console/pico/spi-console.ino.bin')).toString('base64');
const wasm = (name: string) => readFileSync(fixture(`chips-spi-chips/${name}.wasm`)).toString('base64');
const galleryJson = (name: string) => readFileSync(gallery(`${name}.chip.json`), 'utf-8');
const PROBE_JSON = JSON.stringify({ pins: ['CS', 'SCK', 'MOSI', 'MISO', 'GROW', 'VCC', 'GND'] });
const DUAL_JSON = JSON.stringify({ pins: ['CS', 'SCK', 'MOSI', 'VCC', 'GND'] });

// ── Serial console to the sketch ─────────────────────────────────────────────
type Board = AVRSimulator | RP2040Simulator;

class SketchConsole {
  private out = '';
  private readonly sim: Board;
  constructor(sim: Board) {
    this.sim = sim;
    sim.onSerialData = (ch: string) => {
      this.out += ch;
    };
  }

  get length(): number {
    return this.out.length;
  }

  /** Run frames until the sketch prints `text` somewhere after offset `from`. */
  waitFor(text: string, from = 0, maxFrames = 3000): void {
    const seen = () => this.out.indexOf(text, from) >= 0;
    for (let i = 0; i < maxFrames && !seen(); i++) frame();
    if (!seen()) throw new Error(`sketch never printed ${text}; got ${JSON.stringify(this.out.slice(from))}`);
  }

  /** Type one command line; returns the sketch's answer (the text after '='). */
  cmd(line: string, maxFrames = 400): string {
    const mark = this.out.length;
    const text = `${line}\n`;
    if (this.sim instanceof RP2040Simulator) {
      // The PL011 RX FIFO is 32 deep: hand the line over in slices.
      for (let i = 0; i < text.length; i += 16) {
        this.sim.serialWrite(text.slice(i, i + 16));
        frame();
      }
    } else {
      this.sim.serialWrite(text);
    }
    for (let i = 0; i < maxFrames; i++) {
      const m = /=([^\r\n]*)\r?\n/.exec(this.out.slice(mark));
      if (m) return m[1].trim();
      frame();
    }
    throw new Error(`no answer to "${line}"; got ${JSON.stringify(this.out.slice(mark))}`);
  }

  /** Hardware SPI transfer inside one transaction; returns the MISO bytes. */
  spi(bytes: string): number[] {
    return this.cmd(`t ${bytes}`)
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => parseInt(h, 16));
  }
}

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');

/**
 * The card's answer to the command whose six bytes were just clocked: the
 * first byte after them that is not the idle line. A card sends N_CR fill
 * bytes first (one to eight, and this model sends one), so a host polls for
 * the answer instead of reading a fixed offset, and so does this.
 */
function sdAnswer(bytes: number[]): number[] {
  const at = bytes.findIndex((b, i) => i >= 6 && b !== 0xff);
  return at < 0 ? [] : bytes.slice(at);
}

/** SD SPI-mode handshake: CMD0 (answers R1 = 01) then CMD8 (echoes R7 01 00 00 01 AA). */
function sdHandshake(con: SketchConsole, cs: number): { r1: number; r7: string } {
  con.cmd(`h ${cs}`);
  con.spi('FF FF FF FF FF FF FF FF FF FF');
  con.cmd(`l ${cs}`);
  const r1 = sdAnswer(con.spi('40 00 00 00 00 95 FF FF'))[0] ?? 0xff;
  con.cmd(`h ${cs}`);
  con.spi('FF');
  con.cmd(`l ${cs}`);
  const r7 = hex(sdAnswer(con.spi('48 00 00 01 AA 87 FF FF FF FF FF FF')).slice(0, 5));
  con.cmd(`h ${cs}`);
  con.spi('FF');
  return { r1, r7 };
}
const SD_OK = { r1: 0x01, r7: '01 00 00 01 aa' };

/**
 * Drive every chip select HIGH, as a sketch does in setup(). The line has to
 * be seen high before a falling edge can select anything: the pin model has
 * no pull-up level of its own, so an undriven CS reads low.
 */
function deselect(con: SketchConsole, ...pins: number[]): void {
  for (const p of pins) con.cmd(`h ${p}`);
}

/** One CS-framed exchange with the probe chip: returns what the sketch read. */
function probeExchange(con: SketchConsole, cs: number, bytes: string): string {
  con.cmd(`h ${cs}`);
  con.cmd(`l ${cs}`);
  const miso = hex(con.spi(bytes));
  con.cmd(`h ${cs}`);
  return miso;
}

// ── The circuit ──────────────────────────────────────────────────────────────
// The rig plugs a part in with a pin map instead of store wires, so the same
// map is the circuit the bus fabric reads: which board each part sits on and
// which pad each of its pins reaches. In the app both come from the netlist;
// here they come from the one place the test states them.

class Circuit implements NetResolver {
  private readonly pins = new Map<string, ResolvedPin>();
  private readonly kinds = new Map<string, string>();

  board(boardId: string, kind: string): void {
    this.kinds.set(boardId, kind);
  }

  /** Plug a component's pins into a board (a negative pad is a ground rail). */
  wire(boardId: string, componentId: string, pins: Record<string, number>): void {
    for (const [name, pin] of Object.entries(pins)) {
      this.pins.set(
        `${componentId}:${name}`,
        pin >= 0 ? { kind: 'board', boardId, pin } : { kind: 'rail', rail: 'gnd' },
      );
    }
    busRegistry.netlistChanged();
  }

  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.pins.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }

  boardKind(boardId: string): string | undefined {
    return this.kinds.get(boardId);
  }

  boards(): string[] {
    return [...this.kinds.keys()];
  }

  clear(): void {
    this.pins.clear();
    this.kinds.clear();
  }
}

let circuit = new Circuit();
/** The board a simulator is, so a helper that is handed the simulator alone
 *  (as a part's attachEvents is) can still say where its part is plugged in. */
const boardOf = new WeakMap<object, string>();
let boardSeq = 0;

// ── Boards and parts ─────────────────────────────────────────────────────────
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
  useSimulatorStore.setState({ components: [] } as never);
  useElectricalStore.getState().reset();
  busRegistry.clear();
  circuit = new Circuit();
  busRegistry.setResolver(circuit);
});
busRegistry.setResolver(circuit);

/** Put a board on the canvas: the fabric binds its engine and keeps it until
 *  the test ends, the way the store's simulator map does. */
function board<T extends object>(sim: T, kind: string): string {
  const id = `${kind}-${++boardSeq}`;
  circuit.board(id, kind);
  boardOf.set(sim, id);
  busRegistry.bindBoard(id, sim);
  cleanups.push(() => busRegistry.unbindBoard(id));
  return id;
}

function uno(): { sim: AVRSimulator; con: SketchConsole } {
  const sim = new AVRSimulator(new PinManager(), 'uno');
  board(sim, 'arduino-uno');
  sim.loadHex(UNO_HEX);
  const con = new SketchConsole(sim);
  cleanups.push(() => sim.stop());
  return { sim, con };
}

function pico(opts: { load?: boolean } = {}): { sim: RP2040Simulator; con: SketchConsole } {
  const sim = new RP2040Simulator(new PinManager());
  board(sim, 'raspberry-pi-pico');
  if (opts.load !== false) sim.loadBinary(PICO_BIN);
  const con = new SketchConsole(sim);
  cleanups.push(() => sim.stop());
  return { sim, con };
}

/** Press Run: the production frame loop starts and the sketch reaches setup()'s READY. */
function run(sim: Board, con: SketchConsole): void {
  const mark = con.length;
  sim.start();
  con.waitFor('READY', mark);
}

/** The hardware SPI pads of each board in this rig (the pins the sketch's
 *  SPI.transfer() clocks), by the pin names the part in question uses. */
const HW_SPI: Record<string, { sck: number; mosi: number; miso: number }> = {
  'arduino-uno': { sck: 13, mosi: 11, miso: 12 },
  'raspberry-pi-pico': { sck: 18, mosi: 19, miso: 16 },
};

/** Plug a part's bus pins into the board's hardware SPI pads, under the names
 *  that part gives them, plus whatever else the test wires by hand. */
function wireToSpi(
  sim: Board,
  id: string,
  names: { sck: string; mosi: string; miso?: string },
  rest: Record<string, number> = {},
): void {
  const boardId = boardOf.get(sim)!;
  const pads = HW_SPI[boardId.replace(/-\d+$/, '')];
  const pins: Record<string, number> = { [names.sck]: pads.sck, [names.mosi]: pads.mosi, ...rest };
  if (names.miso) pins[names.miso] = pads.miso;
  circuit.wire(boardId, id, pins);
}

function attachSd(sim: Board, cs: number, id = 'sd1'): () => void {
  wireToSpi(sim, id, { sck: 'SCK', mosi: 'DI', miso: 'DO' }, { CS: cs });
  const off = PartSimulationRegistry.get('microsd-card')!.attachEvents!(
    partElement(id),
    sim as never,
    (pin) => (pin === 'CS' ? cs : null),
    id,
  );
  cleanups.push(off);
  return off;
}

/**
 * Drop a custom chip on the canvas: the component goes into the store with
 * its compiled WASM, and the real part attaches it to the board, exactly as
 * DynamicComponent does. Resolves once chip_setup has run (every chip here
 * logs "... ready" at the end of it).
 */
async function attachChip(
  sim: Board,
  id: string,
  wasmName: string,
  chipJson: string,
  pins: Record<string, number>,
  attrs: Record<string, number> = {},
): Promise<() => void> {
  const others = useSimulatorStore.getState().components.filter((c) => c.id !== id);
  useSimulatorStore.setState({
    components: [
      ...others,
      {
        id,
        metadataId: 'custom-chip',
        x: 0,
        y: 0,
        properties: { wasmBase64: wasm(wasmName), chipJson, attrs },
      },
    ],
  } as never);
  circuit.wire(boardOf.get(sim)!, id, pins);
  const before = chipLog(id).length;
  const off = PartSimulationRegistry.get('custom-chip')!.attachEvents!(
    { id } as unknown as HTMLElement,
    sim as never,
    (pin) => (pin in pins ? pins[pin] : null),
    id,
  );
  cleanups.push(off);
  await vi.waitFor(() => {
    if (!chipLog(id).slice(before).some((m) => /ready$/.test(m))) throw new Error(`${id} not ready`);
  });
  return off;
}

// Probe chip wiring. Uno: CS D9 on the hardware SPI pins. Pico: CS GP20 on SPI0.
const UNO_PROBE = { CS: 9, SCK: 13, MOSI: 11, MISO: 12 };
const PICO_PROBE = { CS: 20, SCK: 18, MOSI: 19, MISO: 16 };

// ── The fixtures are what they claim to be ──────────────────────────────────

describe('chips-spi fixtures', () => {
  it('every chip WASM was built from the source it names (rebuild with fixtures/chips-spi-chips/build.sh)', () => {
    const manifest = JSON.parse(readFileSync(fixture('chips-spi-chips/manifest.json'), 'utf-8')) as Record<
      string,
      { sourceSha256: string }
    >;
    const sources: Record<string, string> = {
      'spi-probe': fixture('chips-spi-chips/spi-probe.c'),
      'spi-dual': fixture('chips-spi-chips/spi-dual.c'),
      sn74hc595: gallery('sn74hc595.c'),
      mcp3008: gallery('mcp3008.c'),
      'eeprom-24c01': gallery('eeprom-24c01.c'),
    };
    for (const [name, path] of Object.entries(sources)) {
      const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
      expect(manifest[name]?.sourceSha256, `${name}.wasm is stale`).toBe(sha);
    }
  });
});


/** A part's host element: the parts here only read attributes and listen for canvas-ready. */
function partElement(id: string, attrs: Record<string, string> = {}): HTMLElement {
  return {
    id,
    canvas: null,
    getAttribute: (k: string) => attrs[k] ?? null,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLElement;
}

/** RCLK pulse: the 74HC595 copies its shift register to Q0..Q7 on the rising edge. */
function latch(con: SketchConsole, rclk: number): void {
  con.cmd(`l ${rclk}`);
  con.cmd(`h ${rclk}`);
  con.cmd(`l ${rclk}`);
}

/** Read eight board pins as a byte (bit i = pins[i]), the way the sketch sees them. */
function readPins(con: SketchConsole, pins: number[]): number {
  return parseInt(con.cmd(`q ${pins.join(' ')}`), 16);
}

/** MCP3008 single-ended read, datasheet framing: 01, SGL|CH<<4, 00 inside one CS frame. */
function mcp3008Read(con: SketchConsole, cs: number, ch: number): number {
  con.cmd(`l ${cs}`);
  const [, hi, lo] = con.spi(`01 ${(0x80 | (ch << 4)).toString(16)} 00`);
  con.cmd(`h ${cs}`);
  return ((hi & 0x03) << 8) | lo;
}

// ── Rig ─────────────────────────────────────────────────────────────────────

describe('chips-spi rig', () => {
  it('rig setup: the Uno sketch boots and the microSD card on D10 answers the SD handshake', () => {
    const { sim, con } = uno();
    attachSd(sim, 10);
    run(sim, con);
    expect(sdHandshake(con, 10)).toEqual(SD_OK);
  });

  it('rig setup: the Pico sketch boots and the microSD card on GP17 answers the SD handshake', () => {
    const { sim, con } = pico();
    run(sim, con);
    attachSd(sim, 17);
    expect(sdHandshake(con, 17)).toEqual(SD_OK);
  });

  it('rig setup: the probe chip alone on the Uno answers its CS-framed exchange', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, UNO_PROBE);
    run(sim, con);
    expect(probeExchange(con, 9, '11 22 33')).toBe('c0 c1 c2');
    expect(chipLog('probe')).toContain('probe rx=11 22 33');
  });
});

// ── RP2040: the chip bridge takes SPI0 with setSPIHandler ────────────────────

const RP2040_BRIDGE =
  'rp2040-custom-chip-takes-spi-channel, rp2040-chip-setspihandler-steals-and-orphans, ' +
  'customchip-setspihandler-steals-bus0, rp2040-chip-bridge-overwrites-or-loses-spi0';

describe('custom chips on the Pico SPI0', () => {
  it(`${RP2040_BRIDGE} setup: a probe chip dropped on a running Pico answers on SPI0, and so does the card without it`, async () => {
    const card = pico();
    run(card.sim, card.con);
    attachSd(card.sim, 17);
    deselect(card.con, 17);
    expect(sdHandshake(card.con, 17)).toEqual(SD_OK);

    const { sim, con } = pico();
    run(sim, con);
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, PICO_PROBE);
    deselect(con, 20);
    expect(probeExchange(con, 20, '11 22 33')).toBe('c0 c1 c2');
    expect(chipLog('probe')).toContain('probe rx=11 22 33');
  });

  it(`${RP2040_BRIDGE}: a chip dropped on a running Pico leaves the microSD card on SPI0 answering`, async () => {
    const { sim, con } = pico();
    run(sim, con);
    attachSd(sim, 17);
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, PICO_PROBE);
    deselect(con, 17, 20);
    const probe = probeExchange(con, 20, '11 22');
    expect({ probe, sd: sdHandshake(con, 17) }).toEqual({ probe: 'c0 c1', sd: SD_OK });
  });

  it(`${RP2040_BRIDGE}: an I2C-only gallery chip (24C01 EEPROM) on the Pico leaves the microSD card answering`, async () => {
    const { sim, con } = pico();
    run(sim, con);
    attachSd(sim, 17);
    await attachChip(sim, 'eeprom', 'eeprom-24c01', galleryJson('eeprom-24c01'), { SDA: 4, SCL: 5 });
    deselect(con, 17);
    expect(sdHandshake(con, 17)).toEqual(SD_OK);
  });

  it(`${RP2040_BRIDGE}: a chip on the Pico still answers SPI0 after Stop and Reset`, async () => {
    const { sim, con } = pico();
    run(sim, con);
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, PICO_PROBE);
    deselect(con, 20);
    expect(probeExchange(con, 20, '11 22')).toBe('c0 c1');
    sim.reset(); // Stop + Reset: initMCU builds a new RP2040 from the same flash
    run(sim, con);
    deselect(con, 20);
    const miso = probeExchange(con, 20, '44 55');
    // The log line proves the chip still sees its CS frame: only the bytes are missing.
    expect({ miso, log: chipLog('probe').at(-1) }).toEqual({ miso: 'c0 c1', log: 'probe rx=44 55' });
  });

  it(`${RP2040_BRIDGE}: a chip on the Pico still answers SPI0 after a recompile remounts it`, async () => {
    const { sim, con } = pico();
    run(sim, con);
    const unmount = await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, PICO_PROBE);
    deselect(con, 20);
    expect(probeExchange(con, 20, '11 22')).toBe('c0 c1');
    // Recompile: the new image is loaded, the parts remount against it, Run.
    sim.stop();
    unmount();
    sim.loadBinary(PICO_BIN);
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, PICO_PROBE);
    run(sim, con);
    deselect(con, 20);
    const miso = probeExchange(con, 20, '44 55');
    expect({ miso, log: chipLog('probe').at(-1) }).toEqual({ miso: 'c0 c1', log: 'probe rx=44 55' });
  });

  it(`${RP2040_BRIDGE}: a chip placed before the first Run answers SPI0 once the firmware loads`, async () => {
    const { sim, con } = pico({ load: false });
    // Mounted with the project, before any firmware exists...
    const unmount = await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, PICO_PROBE);
    // ...then the first compile loads the image and the parts remount.
    unmount();
    sim.loadBinary(PICO_BIN);
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, PICO_PROBE);
    run(sim, con);
    deselect(con, 20);
    const miso = probeExchange(con, 20, '11 22');
    expect({ miso, log: chipLog('probe').at(-1) }).toEqual({ miso: 'c0 c1', log: 'probe rx=11 22' });
  });
});

// ── An always-armed chip claims the whole bus (Uno) ──────────────────────────

// Gallery 74HC595 on the Uno hardware SPI pins: SER = MOSI, SRCLK = SCK, RCLK
// on D9, Q0..Q7 read back on D2..D8, A0. QH (the cascade output) is left
// unwired, as it is on every single-595 board: the 595 never drives MISO.
const SR_HW = { SER: 11, SRCLK: 13, RCLK: 9, Q0: 2, Q1: 3, Q2: 4, Q3: 5, Q4: 6, Q5: 7, Q6: 8, Q7: 14 };
const SR_HW_Q = [2, 3, 4, 5, 6, 7, 8, 14];
// The same chip wired for shiftOut(): SER D2, SRCLK D3, RCLK D4, Q on D5..D8, A0..A3.
const SR_GPIO = { SER: 2, SRCLK: 3, RCLK: 4, Q0: 5, Q1: 6, Q2: 7, Q3: 8, Q4: 14, Q5: 15, Q6: 16, Q7: 17 };
const SR_GPIO_Q = [5, 6, 7, 8, 14, 15, 16, 17];

// Closed by F3. The gallery 74HC595 used to declare `.cs = RCLK` in its
// vx_spi_config, from the days when the runtime ignored that field. Once the
// fabric honoured it the chip went deaf except while RCLK was low, which is
// backwards: RCLK is the output LATCH the sketch pulses, not a select. A 595
// has no chip select at all, and its source now says so (`.cs = NO_PIN`,
// DESIGN section 10), so the fabric holds it permanently selected on the SCK
// net its SRCLK is wired to. The wasm fixture is built from that gallery
// source by fixtures/chips-spi-chips/build.sh, and the manifest case above
// fails while it is stale.
//
// The other half is in the fabric: a device drives MISO only when its declared
// MISO pin resolves to a board pin on that bus, so a 595 whose QH is unwired
// (every single-595 board) leaves the line to the card, and the last case here
// keeps passing with the chip permanently selected.
describe('an always-armed chip on the Uno SPI bus', () => {
  it('custom-chip-bus-ignores-wiring, spibus-no-cs-armed-chip-swallows, spibus-selection-ignores-pins setup: the gallery 74HC595 on the hardware SPI pins latches the byte clocked into it', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'sr', 'sn74hc595', galleryJson('sn74hc595'), SR_HW);
    run(sim, con);
    con.spi('3C');
    latch(con, 9);
    expect(readPins(con, SR_HW_Q)).toBe(0x3c);
  });

  // Flipped by F3: the 595 hears the card's traffic (it has no select, so it
  // shifts whatever the bus carries, as on the bench) but it does not answer,
  // because its QH is unwired. The card is the only driver on MISO.
  it('custom-chip-bus-ignores-wiring, spibus-no-cs-armed-chip-swallows, spibus-selection-ignores-pins: a 74HC595 on the hardware SPI pins does not deafen the microSD card that shares them', async () => {
    const { sim, con } = uno();
    attachSd(sim, 10);
    await attachChip(sim, 'sr', 'sn74hc595', galleryJson('sn74hc595'), SR_HW);
    run(sim, con);
    deselect(con, 10);
    expect(sdHandshake(con, 10)).toEqual(SD_OK);
  });

  // Closed by F3: a chip is on the bus of the SCK net its own vx_spi_config
  // names, so a 595 clocked on D3 hears nothing of what the SPI peripheral
  // clocks on D13, and the card has the bus to itself.
  it('custom-chip-bus-ignores-wiring, spibus-selection-ignores-pins: a 74HC595 wired to D2/D3/D4 for shiftOut() takes no part in hardware SPI traffic', async () => {
    const { sim, con } = uno();
    attachSd(sim, 10);
    await attachChip(sim, 'sr', 'sn74hc595', galleryJson('sn74hc595'), SR_GPIO);
    run(sim, con);
    deselect(con, 10);
    latch(con, 4);
    const before = readPins(con, SR_GPIO_Q);
    const sd = sdHandshake(con, 10);
    latch(con, 4);
    // Hardware: SCK/MOSI never reach the 595, so its register is untouched
    // and the card, alone on the bus, answers.
    expect({ sd, q: readPins(con, SR_GPIO_Q) }).toEqual({ sd: SD_OK, q: before });
  });

  // Flipped by F3: every device on the net is clocked, not just the first one
  // with a transfer armed, so both registers take the byte.
  it('spibus-no-cs-armed-chip-swallows, spibus-selection-ignores-pins: two 74HC595 on the same SER/SRCLK both shift the byte and each latches it on its own RCLK', async () => {
    const { sim, con } = uno();
    // A: RCLK D9, Q0..Q3 on D2..D5. B: RCLK D8, Q0..Q3 on D6, D7, A0, A1.
    await attachChip(sim, 'srA', 'sn74hc595', galleryJson('sn74hc595'), { SER: 11, SRCLK: 13, RCLK: 9, Q0: 2, Q1: 3, Q2: 4, Q3: 5 });
    await attachChip(sim, 'srB', 'sn74hc595', galleryJson('sn74hc595'), { SER: 11, SRCLK: 13, RCLK: 8, Q0: 6, Q1: 7, Q2: 14, Q3: 15 });
    run(sim, con);
    con.spi('05');
    latch(con, 9);
    latch(con, 8);
    // Low nibble: A's Q0..Q3; high nibble: B's Q0..Q3. Both hold 0101.
    expect(readPins(con, [2, 3, 4, 5, 6, 7, 14, 15]).toString(16)).toBe('55');
  });

  // Closed by F3: there is no chain and no "first armed chip wins" any more.
  // Every selected device on the bus is clocked, so the probe hears its frame
  // whoever was placed first.
  it('spibus-no-cs-armed-chip-swallows, spibus-selection-ignores-pins: a CS-gated chip that is selected gets its bytes even though a 74HC595 was placed first', async () => {
    const { sim, con } = uno();
    // RCLK on D8, clear of the probe's CS on D9. No Q outputs: SR_HW puts Q6
    // on D8, which would short an output onto the RCLK net.
    await attachChip(sim, 'sr', 'sn74hc595', galleryJson('sn74hc595'), { SER: 11, SRCLK: 13, RCLK: 8 });
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, UNO_PROBE);
    run(sim, con);
    deselect(con, 9);
    const miso = probeExchange(con, 9, '11 22');
    expect({ miso, log: chipLog('probe').at(-1) }).toEqual({ miso: 'c0 c1', log: 'probe rx=11 22' });
  });
});

// ── Software SPI never reaches a chip ────────────────────────────────────────

describe('a chip on software SPI (Uno)', () => {
  // Probe chip on D4 (CS), D5 (SCK), D6 (MOSI), D7 (MISO): no SPI peripheral on those pins.
  const BITBANG_PROBE = { CS: 4, SCK: 5, MOSI: 6, MISO: 7 };

  it('no-bitbang-spi-miso-undriven setup: the software-SPI command reads the MISO level, and the probe chip on D4-D7 sees its CS frame', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, BITBANG_PROBE);
    run(sim, con);
    con.cmd('r 7'); // MISO as INPUT before a level is injected on it
    sim.setPinState(7, true);
    expect(con.cmd('b 5 6 7 00')).toBe('FF');
    sim.setPinState(7, false);
    expect(con.cmd('b 5 6 7 00')).toBe('00');
    deselect(con, 4);
    // deselect's own rising edge already logs an empty frame, so count: the
    // l/h pair must end exactly one more frame on the chip.
    const frames = () => chipLog('probe').filter((m) => m === 'probe rx=').length;
    const before = frames();
    con.cmd('l 4');
    con.cmd('h 4');
    expect(frames()).toBe(before + 1);
  });

  // Closed by F3: the chip hears a bit-banged master, and it answers the first
  // byte too. The soft decoder used to cache the outgoing byte at the
  // selection edge, and on AVR the pad channel delivers that edge before the
  // level channel the chip's own CS watch listens on, so it asked before the
  // chip had armed. It now asks the bus at drive time.
  it('no-bitbang-spi-miso-undriven: the probe chip answers a software-SPI transfer on MISO and hears MOSI', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, BITBANG_PROBE);
    run(sim, con);
    deselect(con, 4);
    con.cmd('l 4');
    const miso = con.cmd('b 5 6 7 5A');
    con.cmd('h 4');
    expect({ miso, log: chipLog('probe').at(-1) }).toEqual({ miso: 'C0', log: 'probe rx=5a' });
  });

  // Closed by F8: the bus told the soft decoder to restart, and the decoder
  // put the first MISO bit on the wire, BEFORE the chip heard its select
  // edge, so a chip that arms in its CS watch had nothing armed when it was
  // asked and the idle 1 went out. The probe's 0xC0 has that bit set and
  // hid it; a first byte of 0x3C read back as 0xBC.
  it('spibus-setselected-before-device-select: a chip that arms 0x3C in its CS watch puts a 0 on MISO before the first clock', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, BITBANG_PROBE, { first: 0x3c });
    run(sim, con);
    deselect(con, 4);
    con.cmd('l 4');
    const miso = con.cmd('b 5 6 7 5A');
    con.cmd('h 4');
    expect({ miso, log: chipLog('probe').at(-1) }).toEqual({ miso: '3C', log: 'probe rx=5a' });
  });

  it('no-bitbang-spi-miso-undriven setup: shiftOut() clocks SRCLK (D3) eight times with the byte on SER (D2), and the sketch reads the Q pins back', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'sr', 'sn74hc595', galleryJson('sn74hc595'), SR_GPIO);
    run(sim, con);
    let ser = false;
    let sampled = 0;
    let rising = 0;
    const offSer = sim.pinManager.onPinChange(2, (_pin, state) => {
      ser = state;
    });
    const offClk = sim.pinManager.onPinChange(3, (_pin, state) => {
      if (!state) return;
      rising++;
      sampled = ((sampled << 1) | (ser ? 1 : 0)) & 0xff;
    });
    con.cmd('s 2 3 A5');
    offSer();
    offClk();
    // What a 74HC595 sees on its pins: eight SRCLK rising edges, A5 on SER.
    expect({ rising, sampled: sampled.toString(16) }).toEqual({ rising: 8, sampled: 'a5' });
    // The Q readback of this wiring. The 595's Q pins are its outputs (low
    // at registration, nothing latched yet), and under F7's net model a chip
    // output is a driver of its board pin: a level injected on D5-D8/A0-A3
    // (made inputs first, as the probe's MISO above) does not move a pin the
    // chip holds, and the sketch reads the chip's level back, as a push-pull
    // output on the bench would win over a weak source. Before F7 the
    // injection landed straight in the PIN register and read ff.
    readPins(con, SR_GPIO_Q);
    for (const p of SR_GPIO_Q) sim.setPinState(p, true);
    expect(readPins(con, SR_GPIO_Q)).toBe(0x00);
  });

  // Flipped by F3: shiftOut() on D2/D3 is a software SPI master on the D3 SCK
  // net, and the 595, selected because it declares no select, shifts the byte
  // in like the part on a breadboard.
  it('no-bitbang-spi-miso-undriven: the gallery 74HC595 wired to D2/D3/D4 latches the byte shiftOut() clocks into it', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'sr', 'sn74hc595', galleryJson('sn74hc595'), SR_GPIO);
    run(sim, con);
    con.cmd('s 2 3 A5');
    latch(con, 4);
    expect(readPins(con, SR_GPIO_Q).toString(16)).toBe('a5');
  });
});

// ── Gallery MCP3008 ─────────────────────────────────────────────────────────

// ── The gallery 74HC595, bit by bit (#409) ───────────────────────────────────
//
// The model used to take whole bytes from the bus: the register became the last
// byte, QH' echoed the previous byte, a clock count that was not a multiple of
// 8 was lost, and every chip on the clock got the controller's byte, so a
// daisy chain showed the same byte on every chip. It now shifts one bit per
// SRCLK rising edge, puts stage H on QH' at the falling edge, and keeps the
// byte path for hardware SPI only (the existing cases above).

describe('the gallery 74HC595 on shiftOut() (Uno)', () => {
  /** Clock `bits` by hand: SER to each level, one SRCLK pulse per bit. */
  function clockBits(con: SketchConsole, ser: number, srclk: number, bits: number[]): void {
    for (const b of bits) {
      con.cmd(`${b ? 'h' : 'l'} ${ser}`);
      con.cmd(`h ${srclk}`);
      con.cmd(`l ${srclk}`);
    }
  }

  it('two chips in a chain (QH to the next SER): the first byte sent ends up in the far chip', async () => {
    const { sim, con } = uno();
    // A chip-to-chip net, the key the canvas gives a wire with no board pin on it.
    const link = syntheticNetPin('sr-chain-test');
    // Same SRCLK and RCLK, A's QH on B's SER. A's Q0..Q3 on D5..D8, B's on A0..A3.
    await attachChip(sim, 'srA', 'sn74hc595', galleryJson('sn74hc595'), {
      SER: 2, SRCLK: 3, RCLK: 4, QH: link, Q0: 5, Q1: 6, Q2: 7, Q3: 8,
    });
    await attachChip(sim, 'srB', 'sn74hc595', galleryJson('sn74hc595'), {
      SER: link, SRCLK: 3, RCLK: 4, Q0: 14, Q1: 15, Q2: 16, Q3: 17,
    });
    run(sim, con);
    con.cmd('s 2 3 05');
    con.cmd('s 2 3 0A');
    latch(con, 4);
    // Low nibble A (the last byte), high nibble B (the first one).
    expect(readPins(con, [5, 6, 7, 8, 14, 15, 16, 17]).toString(16)).toBe('5a');
  });

  it('a clock count that is not a multiple of 8 shifts that many bits', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'sr', 'sn74hc595', galleryJson('sn74hc595'), SR_GPIO);
    run(sim, con);
    con.cmd('s 2 3 A5');
    clockBits(con, 2, 3, [1, 1, 1, 1]);
    latch(con, 4);
    // 1010 0101, four more ones in: 0101 1111.
    expect(readPins(con, SR_GPIO_Q).toString(16)).toBe('5f');
  });

  it('RCLK in the middle of a byte latches the register as it stands', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'sr', 'sn74hc595', galleryJson('sn74hc595'), SR_GPIO);
    run(sim, con);
    con.cmd('s 2 3 FF');
    clockBits(con, 2, 3, [0, 0, 0]);
    latch(con, 4);
    expect(readPins(con, SR_GPIO_Q).toString(16)).toBe('f8');
  });

  it('SRCLR low clears the shift register and ignores clocks; the outputs wait for RCLK', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'sr', 'sn74hc595', galleryJson('sn74hc595'), { ...SR_GPIO, SRCLR: 9 });
    run(sim, con);
    con.cmd('h 9');
    con.cmd('s 2 3 A5');
    latch(con, 4);
    expect(readPins(con, SR_GPIO_Q).toString(16)).toBe('a5');
    con.cmd('l 9');
    // The storage register is not cleared: Q keeps A5 until the next RCLK.
    expect(readPins(con, SR_GPIO_Q).toString(16)).toBe('a5');
    con.cmd('s 2 3 FF'); // clocked while SRCLR is held low: no effect
    con.cmd('h 9');
    latch(con, 4);
    expect(readPins(con, SR_GPIO_Q)).toBe(0);
  });

  it("OE high releases Q0..Q7 without touching QH' or the storage register", async () => {
    const { sim, con } = uno();
    const link = syntheticNetPin('sr-oe-test');
    await attachChip(sim, 'sr', 'sn74hc595', galleryJson('sn74hc595'), { ...SR_GPIO, OE: 9, QH: link });
    run(sim, con);
    con.cmd('l 9');
    con.cmd('s 2 3 FF');
    latch(con, 4);
    readPins(con, SR_GPIO_Q); // the Q pads as inputs on the sketch's side
    const inject = (level: boolean) => {
      for (const p of SR_GPIO_Q) sim.setPinState(p, level);
    };
    inject(false);
    // Driven: the chip's HIGH wins over a level put on its pads.
    expect(readPins(con, SR_GPIO_Q).toString(16)).toBe('ff');
    con.cmd('h 9');
    inject(false);
    // Released: whoever else is on the pads has them.
    expect(readPins(con, SR_GPIO_Q)).toBe(0);
    // QH' is stage H of the shift register, outside OE's reach.
    expect(sim.pinManager.getPinState(link)).toBe(true);
    con.cmd('l 9');
    expect(readPins(con, SR_GPIO_Q).toString(16)).toBe('ff');
  });
});

describe('the gallery MCP3008 chip (Uno)', () => {
  // CS D10, hardware SPI; CH0 wired to D9, CH1 wired to GND.
  const ADC = { CS: 10, SCK: 13, MOSI: 11, MISO: 12, CH0: 9, CH1: -1 };
  /** The circuit solve's word on the chip's inputs: CH0's net at `volts`,
   *  CH1's net is ground. What vx_pin_read_analog answers (padVolts.ts). */
  const solve = (volts: number, id = 'adc') =>
    useElectricalStore.setState({
      pinNetMap: new Map([
        [`${id}:CH0`, 'pot'],
        [`${id}:CH1`, '0'],
      ]),
      nodeVoltages: { pot: volts },
    } as never);
  const V_HALF = (128 / 255) * 5;
  const counts = (volts: number) => Math.floor((volts / 5) * 1023 + 0.5);

  it('mcp3008-example-returns-1023 setup: the MCP3008 is selected by its CS, decodes a CH0 read and samples CH0 at the solved voltage', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'adc', 'mcp3008', galleryJson('mcp3008'), ADC);
    run(sim, con);
    solve(V_HALF);
    con.cmd('h 10');
    // Six bytes in one CS frame. The chip decodes the CH0 command and puts the
    // conversion, 514 = 0x202, on MISO as 02 02 (the example used to answer
    // it in the frame AFTER the command, which was the finding). "Not the
    // loopback" proves nothing here: an absent or unselected chip leaves the
    // line idle at ff, the same bytes the defect answered.
    const has514 = /(^| )02 02( |$)/;
    con.cmd('l 10');
    const selected = hex(con.spi('01 80 00 00 00 00'));
    con.cmd('h 10');
    expect(selected).toMatch(has514);
    // With CS high the same bytes do not reach it.
    expect(hex(con.spi('01 80 00 00 00 00'))).not.toMatch(has514);
  });

  // Closed by F7: the example answers through velxio-chip.h `on_exchange`
  // (D-013), so the result bits land in the frame that carries the command,
  // as the silicon puts them, instead of being queued for a second frame that
  // CS rising cancelled.
  it('mcp3008-example-returns-1023: one 3-byte frame returns the conversion of that frame (CH0 at half scale, CH1 at GND)', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'adc', 'mcp3008', galleryJson('mcp3008'), ADC);
    run(sim, con);
    solve(V_HALF);
    con.cmd('h 10');
    const expected = counts(V_HALF);
    expect([mcp3008Read(con, 10, 0), mcp3008Read(con, 10, 1)]).toEqual([expected, 0]);
    // And the same code on the next frame, and the next: the CS edge resets
    // the conversion, nothing of the previous frame carries over.
    expect([mcp3008Read(con, 10, 0), mcp3008Read(con, 10, 0)]).toEqual([expected, expected]);
  });

  // Closed by F8: the browser runtime used to answer vx_pin_read_analog with
  // the pad's PWM duty times five, so an ADC chip read a number that is not
  // the voltage of anything on the canvas (and the worker read the digital
  // level times five). Both hosts now answer the voltage the circuit solve
  // publishes for the pad's net, the number VirtualMcp3008 reads.
  it('vx-pin-read-analog-answers-neither-host-the-solve: with a 50 % PWM on D9, the MCP3008 reads the 2.00 V the solve puts on CH0, not the duty times five', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'adc', 'mcp3008', galleryJson('mcp3008'), ADC);
    run(sim, con);
    con.cmd('a 9 128');
    expect(sim.pinManager.getPwmValue(9)).toBeCloseTo(128 / 255, 5);
    solve(2.0);
    con.cmd('h 10');
    expect(mcp3008Read(con, 10, 0)).toBe(counts(2.0));
    // The knob turns: the solve moves, and so does the reading.
    solve(3.5);
    expect(mcp3008Read(con, 10, 0)).toBe(counts(3.5));
    // A pad the solve has no number for reads 0 V, as the header says.
    useElectricalStore.setState({ pinNetMap: new Map(), nodeVoltages: {} } as never);
    expect(mcp3008Read(con, 10, 0)).toBe(0);
  });

  // The chip keeps a transfer armed across the CS edge (its look-ahead byte
  // for a bit-banged master), so this is the always-armed chip of
  // spibus-no-cs-armed-chip-swallows: only its chip select may decide which
  // bytes it takes and answers. TESTS.md S05, half of it.
  it('spibus-no-cs-armed-chip-swallows: the MCP3008, armed across its CS edge, leaves the microSD card on the same bus alone while the card is selected', async () => {
    const { sim, con } = uno();
    attachSd(sim, 8);
    await attachChip(sim, 'adc', 'mcp3008', galleryJson('mcp3008'), ADC);
    run(sim, con);
    solve(V_HALF);
    deselect(con, 8, 10);
    const expected = counts(V_HALF);
    // The card's answer would be ANDed with the ADC's 00 bytes if the ADC took
    // the card's frames; the ADC then reads its own frame right after.
    expect({ sd: sdHandshake(con, 8), adc: mcp3008Read(con, 10, 0) }).toEqual({ sd: SD_OK, adc: expected });
  });

  // TESTS.md S08: the same chip on four plain GPIOs, read the way the Pi
  // tutorials do (Adafruit's readadc: start + SGL + channel in one byte, two
  // bytes of zeros, result = (hi << 4 | lo >> 4) & 0x3ff). The result bits
  // come from the look-ahead byte the chip keeps armed, bit by bit, before
  // each byte of the master is complete.
  it('no-bitbang-spi-miso-undriven: the gallery MCP3008 answers a bit-banged readadc() on MISO', async () => {
    const { sim, con } = uno();
    // CS D4, SCK D5, MOSI D6, MISO D7; CH0 on D9, CH1 on GND.
    await attachChip(sim, 'adc', 'mcp3008', galleryJson('mcp3008'), { CS: 4, SCK: 5, MOSI: 6, MISO: 7, CH0: 9, CH1: -1 });
    run(sim, con);
    solve(V_HALF);
    con.cmd('r 7');
    deselect(con, 4);
    const readadc = (ch: number): number => {
      con.cmd('l 4');
      con.cmd(`b 5 6 7 ${(0x18 | ch).toString(16)}`);
      const hi = parseInt(con.cmd('b 5 6 7 00'), 16);
      const lo = parseInt(con.cmd('b 5 6 7 00'), 16);
      con.cmd('h 4');
      return ((hi << 4) | (lo >> 4)) & 0x3ff;
    };
    const expected = counts(V_HALF);
    expect([readadc(0), readadc(1), readadc(0)]).toEqual([expected, 0, expected]);
  });
});

// ── SPI mode and bit order ──────────────────────────────────────────────────

describe('SPI mode and bit order between the master and a chip (Uno)', () => {
  it('spi-mode-bitorder-ignored setup: the probe chip takes its mode attribute and exchanges MSB first in mode 0', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, UNO_PROBE, { mode: 1 });
    run(sim, con);
    expect(chipLog('probe')).toContain('probe mode=1 ready');
    deselect(con, 9);
    expect(probeExchange(con, 9, '01')).toBe('c0');
    expect(chipLog('probe')).toContain('probe rx=01');
    // The master really is in mode 0: SPCR (0x4C) has CPOL (bit 3) and CPHA
    // (bit 2) clear. Read from the register, not avr8js's spiMode getter,
    // which numbers modes as CPHA*2 + CPOL (1 and 2 swapped against SPI).
    const spcr = (sim as unknown as { cpu: { data: Uint8Array } }).cpu.data[0x4c];
    expect(spcr & 0x0c).toBe(0);
  });

  it('spi-mode-bitorder-ignored setup: the m command really puts the master in LSB-first mode 0', () => {
    const { sim, con } = uno();
    run(sim, con);
    con.cmd('m 0 0');
    con.spi('01');
    // SPCR (0x4C) as the transaction left it (endTransaction does not restore
    // it on AVR): DORD (bit 5) set, CPOL/CPHA (bits 3, 2) clear.
    const spcr = (sim as unknown as { cpu: { data: Uint8Array } }).cpu.data[0x4c];
    expect(spcr & 0x2c).toBe(0x20);
  });

  // Closed by F3: the chip declares the mode of its vx_spi_config and MSB
  // first, so the bus compares them with the controller's and hands the chip
  // the bit-reversed byte an LSB-first master really puts on the wire.
  it('spi-mode-bitorder-ignored: an LSB-first master and an MSB-first chip see each other bit-reversed', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, UNO_PROBE);
    run(sim, con);
    deselect(con, 9);
    con.cmd('m 0 0'); // SPISettings(1 MHz, LSBFIRST, SPI_MODE0)
    const miso = probeExchange(con, 9, '01');
    // The chip shifts C0 out MSB first; the master assembles it LSB first.
    expect({ miso, log: chipLog('probe').at(-1) }).toEqual({ miso: '03', log: 'probe rx=80' });
  });

  // Closed by F3: the declared mode reaches the bus, which reports the
  // mismatch as the spi-mode diagnostic (DESIGN section 12).
  it('spi-mode-bitorder-ignored: a chip declaring mode 1 clocked by a mode-0 master is reported', async () => {
    // Either channel counts: a console warning, or the bus fabric's own
    // diagnostic (code 'spi-mode', DESIGN section 12), which is where D-011
    // puts this report and which never touches the console.
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const diags: BusDiagnostic[] = [];
    busRegistry.resetDiagnostics();
    const offDiag = busRegistry.onDiagnostic((d) => diags.push(d));
    try {
      const { sim, con } = uno();
      await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, UNO_PROBE, { mode: 1 });
      run(sim, con);
      deselect(con, 9);
      probeExchange(con, 9, '01');
      const said = [...warn.mock.calls, ...error.mock.calls].map((c) => c.map(String).join(' '));
      const warned = said.find((m) => /mode/i.test(m) && /probe/.test(m));
      const diagnosed = diags.find(
        (d) => d.code === 'spi-mode' && (d.owners.some((o) => o.includes('probe')) || /probe/.test(d.message)),
      );
      expect(warned ?? diagnosed, 'a warning or diagnostic naming the chip and the SPI mode').toBeDefined();
    } finally {
      offDiag();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

// ── ChipRuntime bookkeeping ─────────────────────────────────────────────────

describe('ChipRuntime SPI bookkeeping (Uno)', () => {
  const GROW_PROBE = { ...UNO_PROBE, GROW: 8 };

  it('spi-view-detached-on-memory-grow setup: the probe chip grows its memory and still answers a transfer armed after the growth', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, GROW_PROBE);
    run(sim, con);
    deselect(con, 9);
    con.cmd('l 8');
    con.cmd('h 8');
    expect(chipLog('probe')).toContain('probe grew');
    expect(probeExchange(con, 9, '11 22')).toBe('c0 c1');
    expect(chipLog('probe').at(-1)).toBe('probe rx=11 22');
  });

  // Closed by F3: the armed transfer is a POINTER into the chip's memory,
  // read through a view taken per access, so a growth that detaches every
  // older view does not swallow the bytes.
  it('spi-view-detached-on-memory-grow: a chip that grows its memory while a transfer is armed keeps answering and receiving', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, GROW_PROBE);
    run(sim, con);
    deselect(con, 9);
    con.cmd('l 8');
    con.cmd('l 9');
    const first = hex(con.spi('11'));
    con.cmd('h 8'); // the chip mallocs 320 KB with byte 2 armed
    const rest = hex(con.spi('22 33'));
    con.cmd('h 9');
    expect(chipLog('probe')).toContain('probe grew');
    expect({ miso: `${first} ${rest}`, log: chipLog('probe').at(-1) }).toEqual({
      miso: 'c0 c1 c2',
      log: 'probe rx=11 22 33',
    });
  });

  it('spi-done-bufptr-shared setup: both SPI handles of the two-handle chip receive a byte', async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'dual', 'spi-dual', DUAL_JSON, { CS: 9, SCK: 13, MOSI: 11 });
    run(sim, con);
    deselect(con, 9);
    con.cmd('l 9');
    con.spi('11');
    con.cmd('h 9');
    con.spi('22');
    const log = chipLog('dual');
    expect(log.some((m) => m.startsWith('dual h0 '))).toBe(true);
    expect(log.some((m) => m.startsWith('dual h1 '))).toBe(true);
  });

  // Closed by F3: each handle is its own device on the bus, with its own
  // buffer pointer captured for its own completion.
  it("spi-done-bufptr-shared: each SPI handle's on_done is handed that handle's own buffer", async () => {
    const { sim, con } = uno();
    await attachChip(sim, 'dual', 'spi-dual', DUAL_JSON, { CS: 9, SCK: 13, MOSI: 11 });
    run(sim, con);
    deselect(con, 9);
    con.cmd('l 9');
    con.spi('11'); // selected: handle 0
    con.cmd('h 9');
    con.spi('22'); // deselected: the always-armed handle 1
    // Only the buffer each completion was handed is asserted. Whether the
    // no-CS handle 1 also hears 0x11 is spibus-no-cs-armed-chip-swallows (on
    // hardware it does), so this list is not pinned to exactly two lines.
    const lines = chipLog('dual').filter((m) => m.startsWith('dual h'));
    expect({
      foreign: lines.filter((m) => !m.includes(' own=1 ')),
      h0: lines.includes('dual h0 own=1 rx=11'),
      h1: lines.includes('dual h1 own=1 rx=22'),
    }).toEqual({ foreign: [], h0: true, h1: true });
  });
});

// ── Parts leave the SPI chain without dropping who joined after them ────────

describe('a part removed from under a chip (Uno)', () => {
  const EPD_PINS: Record<string, number> = { CS: 10, DC: 7, RST: 6, BUSY: 5 };
  const TFT_PINS: Record<string, number> = { CS: 10, 'D/C': 7, DC: 7, RST: 6 };

  it('cleanup-tests-pass-under-old-restore-prev: removing the microSD card leaves the chip that joined after it on the bus, and the card silent', async () => {
    const { sim, con } = uno();
    const removeCard = attachSd(sim, 10);
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, UNO_PROBE);
    run(sim, con);
    deselect(con, 9, 10);
    expect(sdHandshake(con, 10)).toEqual(SD_OK);
    expect(probeExchange(con, 9, '11 22')).toBe('c0 c1');
    removeCard();
    expect(probeExchange(con, 9, '33 44')).toBe('c0 c1');
    expect(chipLog('probe').at(-1)).toBe('probe rx=33 44');
    expect(sdHandshake(con, 10)).not.toEqual(SD_OK);
  });

  it('cleanup-tests-pass-under-old-restore-prev: removing an e-paper panel leaves the chip that joined after it on the bus', async () => {
    const { sim, con } = uno();
    wireToSpi(sim, 'epd', { sck: 'SCK', mosi: 'SDI' }, EPD_PINS);
    const removePanel = PartSimulationRegistry.get('epaper-1in54-bw')!.attachEvents!(
      partElement('epd', { 'panel-kind': 'epaper-1in54-bw' }),
      sim as never,
      (pin) => EPD_PINS[pin] ?? null,
      'epd',
    );
    cleanups.push(removePanel);
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, UNO_PROBE);
    run(sim, con);
    deselect(con, 9, 10);
    expect(probeExchange(con, 9, '11 22')).toBe('c0 c1');
    removePanel();
    expect(probeExchange(con, 9, '33 44')).toBe('c0 c1');
    expect(chipLog('probe').at(-1)).toBe('probe rx=33 44');
  });

  it('cleanup-tests-pass-under-old-restore-prev: removing an ILI9341 leaves the chip that joined after it on the bus', async () => {
    const { sim, con } = uno();
    wireToSpi(sim, 'tft', { sck: 'SCK', mosi: 'MOSI', miso: 'MISO' }, TFT_PINS);
    const removePanel = PartSimulationRegistry.get('ili9341')!.attachEvents!(
      partElement('tft'),
      sim as never,
      (pin) => TFT_PINS[pin] ?? null,
      'tft',
    );
    cleanups.push(removePanel);
    await attachChip(sim, 'probe', 'spi-probe', PROBE_JSON, UNO_PROBE);
    run(sim, con);
    deselect(con, 9, 10);
    expect(probeExchange(con, 9, '11 22')).toBe('c0 c1');
    removePanel();
    expect(probeExchange(con, 9, '33 44')).toBe('c0 c1');
    expect(chipLog('probe').at(-1)).toBe('probe rx=33 44');
  });
});
