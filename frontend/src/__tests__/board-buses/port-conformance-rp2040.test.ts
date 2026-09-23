/**
 * Board buses F2: the RP2040 SPI controller ports (project board-buses-2026-09,
 * F2-SPEC, TESTS.md layer 2).
 *
 * Everything runs the real rp2040js core through RP2040Simulator with a guest
 * built by the production toolchain:
 *   fixtures/conf-rp2040-console  a serial-driven SPI master for both PL022s
 *                                 (arduino-pico SPI and SPI1), any pins
 *   fixtures/conf-rp2040-sd       SD.h (SdFat) mounting a card on SPI0
 * plus the MicroPython v1.20 UF2 the app ships, for the MicroPython reset.
 *
 * The shared conformance suite (buses/conformance/spiPortConformance.ts) runs
 * twice: SPI0 and SPI1 on the arduino-pico default pins, byte by byte
 * (SPI.transfer(b)); and both controllers moved to another pin set with
 * setRX/setSCK/setTX, through the FIFO-fed SPI.transfer(tx, rx, n). The cases
 * after it cover what is specific to this SoC: the mode numbering rp2040js
 * gets backwards, 16-bit frames, routing that follows funcsel, the PL022's own
 * chip select, the MicroPython reset, the transition bridge (the legacy
 * `simulator.spi` facade and setSPIHandler), a full fabric wired by nets, and
 * the microSD card of bus matrix scenario d2, which never mounted on a Pico
 * before the card left the SD spec's N_CR fill byte in front of its R1.
 *
 * Stand-ins, only for what node lacks: a fetch that serves the MicroPython UF2
 * and the littlefs WASM from disk, and a console.log that keeps the guest's
 * serial echo out of the report.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RP2040Simulator } from '../../simulation/RP2040Simulator';
import { PinManager } from '../../simulation/PinManager';
import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import '../../simulation/parts/ProtocolParts';
import { spiChainAttach } from '../../simulation/parts/spiChannel';
import { buildFat16Image } from '../../utils/fatImage';
import {
  ProbeDevice,
  bindProbe,
  defineSpiPortConformance,
  type GuestTransaction,
  type SpiConformanceRig,
} from '../../simulation/buses/conformance/spiPortConformance';
import { BusRegistry, busRegistry } from '../../simulation/buses/registry';
import type {
  NetResolver,
  PinRef,
  ResolvedPin,
  SpiDevice,
  SpiRouting,
} from '../../simulation/buses/types';

// ── Firmware ─────────────────────────────────────────────────────────────────

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const CONSOLE_BIN = readFileSync(
  here('./fixtures/conf-rp2040-console/conf-rp2040-console.ino.bin'),
).toString('base64');
const SD_BIN = readFileSync(here('./fixtures/conf-rp2040-sd/conf-rp2040-sd.ino.bin')).toString('base64');
const MICROPYTHON_UF2 = readFileSync(here('../../../public/firmware/micropython-rp2040.uf2'));
const LITTLEFS_WASM = readFileSync(here('../../../node_modules/littlefs/dist/littlefs.wasm'));

const saved: Record<string, unknown> = {};
const realLog = console.log;
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  saved.fetch = g.fetch;
  g.fetch = async (url: unknown) =>
    String(url).includes('littlefs')
      ? new Response(LITTLEFS_WASM, { headers: { 'content-type': 'application/wasm' } })
      : new Response(MICROPYTHON_UF2);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    if (process.env.RP2040_PORT_VERBOSE) realLog(...args);
  });
});
afterAll(() => {
  (globalThis as Record<string, unknown>).fetch = saved.fetch;
  vi.restoreAllMocks();
});

// ── The console guest ────────────────────────────────────────────────────────

const hex2 = (b: number) => b.toString(16).padStart(2, '0');
const hexList = (bytes: number[]) => bytes.map(hex2).join(' ');

/** A Pico running conf-rp2040-console, driven the way the chips-spi rig drives
 *  its console: one command line in over UART0, one '=' line back. Time only
 *  moves through the production frame body (runFrameForTime). */
class PicoConsole {
  readonly sim: RP2040Simulator;
  private out = '';

  constructor(sim: RP2040Simulator) {
    this.sim = sim;
    sim.onSerialData = (ch) => {
      this.out += ch;
    };
  }

  get length(): number {
    return this.out.length;
  }

  /** Run 1 ms frames until `text` shows up after `from`. */
  waitFor(text: string, from = 0, maxMs = 3000): void {
    for (let t = 0; t < maxMs && this.out.indexOf(text, from) < 0; t++) this.sim.runFrameForTime(1);
    if (this.out.indexOf(text, from) < 0) {
      throw new Error(`guest never printed ${text}; got ${JSON.stringify(this.out.slice(from))}`);
    }
  }

  /** Type one line; returns what the guest answered after '='. */
  cmd(line: string, maxMs = 500): string {
    const mark = this.out.length;
    const text = `${line}\n`;
    // The PL011 RX FIFO is 32 deep: hand the line over in slices.
    for (let i = 0; i < text.length; i += 16) {
      this.sim.serialWrite(text.slice(i, i + 16));
      this.sim.runFrameForTime(1);
    }
    for (let t = 0; t < maxMs; t++) {
      const m = /=([^\r\n]*)\r?\n/.exec(this.out.slice(mark));
      if (m) return m[1].trim();
      this.sim.runFrameForTime(1);
    }
    throw new Error(`no answer to "${line}"; got ${JSON.stringify(this.out.slice(mark))}`);
  }

  /** Parse a hex byte answer. */
  bytes(line: string): number[] {
    return this.cmd(line)
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => parseInt(h, 16));
  }
}

function bootConsole(): PicoConsole {
  const sim = new RP2040Simulator(new PinManager());
  sim.loadBinary(CONSOLE_BIN);
  const con = new PicoConsole(sim);
  con.waitFor('READY');
  return con;
}

/** Pins of one controller: arduino-pico's names (RX = MISO, TX = MOSI). */
interface PinSet {
  miso: number;
  sck: number;
  mosi: number;
  cs: number;
}

/** arduino-pico rpipico defaults (pins_arduino.h): SPI on GP16-19, SPI1 on GP12-15. */
const DEFAULT_PINS: [PinSet, PinSet] = [
  { miso: 16, sck: 18, mosi: 19, cs: 17 },
  { miso: 12, sck: 14, mosi: 15, cs: 13 },
];
/** Another legal F1 set for each controller: SPI0 on GP2-4, SPI1 on GP26-28. */
const ALT_PINS: [PinSet, PinSet] = [
  { miso: 4, sck: 2, mosi: 3, cs: 5 },
  { miso: 28, sck: 26, mosi: 27, cs: 22 },
];

/** Move controller `unit` to `p` in the guest (end, setRX/SCK/TX, begin). */
function movePins(con: PicoConsole, unit: 0 | 1, p: PinSet, hwCs = false): void {
  expect(con.cmd(`p ${unit} ${p.miso} ${p.sck} ${p.mosi} ${p.cs} ${hwCs ? 1 : 0}`)).toBe('OK');
}

/**
 * The rig the shared suite drives. `pins` says where the controllers live;
 * the guest boots on the defaults, so a moved rig moves them again after
 * every boot. `buffered` sends each transaction through SPI.transfer(tx, rx, n)
 * (the TX FIFO kept fed) instead of byte by byte.
 */
function consoleRig(pins: [PinSet, PinSet], buffered: boolean): SpiConformanceRig {
  const con = bootConsole();
  const sim = con.sim;
  let moved = pins === DEFAULT_PINS;
  const place = () => {
    if (moved) return;
    movePins(con, 0, pins[0]);
    movePins(con, 1, pins[1]);
    moved = true;
  };
  const reboot = (step: () => void) => {
    const mark = con.length;
    step();
    con.waitFor('READY', mark);
    moved = pins === DEFAULT_PINS;
  };
  return {
    units: [0, 1],
    csPinFor: (unit) => pins[unit].cs,
    binding: () => sim.getBusBinding(),
    run: async (txs: GuestTransaction[]) => {
      place();
      return txs.map((tx) =>
        con.bytes(`${buffered ? 'T' : 't'} ${tx.unit} ${tx.csPin} ${hexList(tx.bytes)}`),
      );
    },
    // The store's resetBoard and stopBoard do the same to an RP2040: reset()
    // and a hard pin reset. Run then only restarts the frame loop.
    reset: async () =>
      reboot(() => {
        sim.reset();
        sim.pinManager.hardResetPinStates();
      }),
    stopRun: async () =>
      reboot(() => {
        sim.reset();
        sim.pinManager.hardResetPinStates();
      }),
    reload: async () => reboot(() => sim.loadBinary(CONSOLE_BIN)),
    expectedRouting: (unit) => ({ sck: pins[unit].sck, mosi: pins[unit].mosi, miso: pins[unit].miso }),
    onPinEdge: (pin, cb) => sim.pinManager.onPinChange(pin, () => cb()),
    dispose: () => sim.stop(),
  };
}

defineSpiPortConformance('RP2040 SPI0 and SPI1 on the default pins, byte by byte', async () =>
  consoleRig(DEFAULT_PINS, false),
);
defineSpiPortConformance('RP2040 SPI0 and SPI1 moved to GP2-4 and GP26-28, FIFO-fed', async () =>
  consoleRig(ALT_PINS, true),
);

// ── What the controller reports ──────────────────────────────────────────────

describe('RP2040 SPI ports: configuration', () => {
  it('config() gives the standard SPI mode for all four modes (rp2040js numbers CPOL = 1 backwards)', () => {
    const con = bootConsole();
    const port = con.sim.getBusBinding().spi.find((p) => p.unit === 0)!;
    const seen: number[] = [];
    for (const mode of [0, 1, 2, 3]) {
      con.cmd(`m 0 ${mode} 1 4000000`);
      // Read inside the transaction, while the settings are live.
      port.setFrameHandler(() => {
        seen.push(port.config().mode!);
        return 0xff;
      });
      con.bytes('t 0 17 00');
    }
    port.setFrameHandler(null);
    expect(seen).toEqual([0, 1, 2, 3]);
    const cfg = port.config();
    expect(cfg.enabled).toBe(true);
    expect(cfg.bitOrder).toBe('msb');
    expect(cfg.bits).toBe(8);
    con.sim.stop();
  });

  it('config() reports the SCK rate the core programmed (the highest one at or below the request)', () => {
    const con = bootConsole();
    const port = con.sim.getBusBinding().spi.find((p) => p.unit === 1)!;
    let hz = 0;
    con.cmd('m 1 0 1 1000000');
    port.setFrameHandler(() => {
      hz = port.config().hz ?? 0;
      return 0xff;
    });
    con.bytes('t 1 13 00');
    port.setFrameHandler(null);
    expect(hz).toBeGreaterThan(500_000);
    expect(hz).toBeLessThanOrEqual(1_000_000);
    con.sim.stop();
  });

  it('a 16-bit frame reaches the handler as one frame of 16 bits, and its 16-bit answer reaches the guest', () => {
    const con = bootConsole();
    const binding = con.sim.getBusBinding();
    const port = binding.spi.find((p) => p.unit === 0)!;
    const frames: Array<[number, number]> = [];
    port.setFrameHandler((mosi, bits) => {
      frames.push([mosi, bits]);
      return (mosi ^ 0xa55a) & 0xffff;
    });
    expect(con.cmd('w 0 17 1234 BEEF')).toBe('B76E 1BB5');
    expect(frames).toEqual([
      [0x1234, 16],
      [0xbeef, 16],
    ]);
    // Unbound, a 16-bit frame reads the pulled-up line: all ones.
    port.setFrameHandler(null);
    expect(con.cmd('w 0 17 0000')).toBe('FFFF');
    con.sim.stop();
  });
});

// ── Routing follows funcsel ──────────────────────────────────────────────────

describe('RP2040 SPI ports: routing is the pads whose funcsel is SPI', () => {
  it('the port reports a pin move as it happens, including the chip-select pad the controller owns', () => {
    const con = bootConsole();
    const port = con.sim.getBusBinding().spi.find((p) => p.unit === 1)!;
    let changes = 0;
    port.setRoutingChangeHandler!(() => changes++);
    expect(port.routing()).toEqual({ sck: 14, mosi: 15, miso: 12 });

    movePins(con, 1, ALT_PINS[1]);
    expect(changes).toBeGreaterThan(0);
    expect(port.routing()).toEqual({ sck: 26, mosi: 27, miso: 28 });

    // SPI1.begin(true): GP13 becomes the PL022's CSn.
    const before = changes;
    movePins(con, 1, { ...DEFAULT_PINS[1] }, true);
    expect(changes).toBeGreaterThan(before);
    expect(port.routing()).toEqual({ sck: 14, mosi: 15, miso: 12, cs: [13] });
    // The other controller never moved.
    expect(con.sim.getBusBinding().spi.find((p) => p.unit === 0)!.routing()).toEqual({
      sck: 18,
      mosi: 19,
      miso: 16,
    });
    port.setRoutingChangeHandler!(null);
    con.sim.stop();
  });

  it('a reset starts routing over from the new SoC (no pad is SPI until the sketch says so again)', () => {
    const con = bootConsole();
    const port = con.sim.getBusBinding().spi.find((p) => p.unit === 0)!;
    const seen: Array<SpiRouting | 'static'> = [];
    port.setRoutingChangeHandler!(() => seen.push(port.routing()));
    const mark = con.length;
    con.sim.reset();
    expect(seen[0]).toEqual({});
    con.waitFor('READY', mark);
    expect(port.routing()).toEqual({ sck: 18, mosi: 19, miso: 16 });
    port.setRoutingChangeHandler!(null);
    con.sim.stop();
  });
});

// ── A full fabric, wired by nets ─────────────────────────────────────────────

/** The circuit as the fabric reads it: component pin -> board pin. */
class Circuit implements NetResolver {
  private readonly nets = new Map<string, ResolvedPin>();
  wire(comp: string, pins: Record<string, number>): void {
    for (const [name, pin] of Object.entries(pins)) {
      this.nets.set(`${comp}:${name}`, { kind: 'board', boardId: 'pico', pin });
    }
  }
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }
  boardKind(): string {
    return 'raspberry-pi-pico';
  }
  boards(): string[] {
    return ['pico'];
  }
}

/** A device that answers a fixed function of what it hears and counts selects. */
class Recorder implements SpiDevice {
  heard: number[] = [];
  selects = 0;
  deselects = 0;
  resets = 0;
  private readonly key: number;
  constructor(key: number) {
    this.key = key;
  }
  select(): void {
    this.selects++;
  }
  deselect(): void {
    this.deselects++;
  }
  transfer(mosi: number): number {
    this.heard.push(mosi);
    return (mosi ^ this.key) & 0xff;
  }
  boardReset(): void {
    this.resets++;
  }
}

function fabricBoard(): { con: PicoConsole; registry: BusRegistry; circuit: Circuit } {
  const con = bootConsole();
  const registry = new BusRegistry();
  const circuit = new Circuit();
  registry.setResolver(circuit);
  registry.bindBoard('pico', con.sim);
  return { con, registry, circuit };
}

const SPI_PINS = { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' };

describe('RP2040 SPI ports under the fabric: each device hears the controller its wires reach', () => {
  it('a device on the SPI0 pins and one on the SPI1 pins each get only their own controller', () => {
    const { con, registry, circuit } = fabricBoard();
    const a = new Recorder(0x0f);
    const b = new Recorder(0xf0);
    circuit.wire('a', { SCK: 18, MOSI: 19, MISO: 16, CS: 17 });
    circuit.wire('b', { SCK: 14, MOSI: 15, MISO: 12, CS: 13 });
    registry.netlistChanged();
    registry.attachSpi({ owner: 'a', pins: SPI_PINS }, a);
    registry.attachSpi({ owner: 'b', pins: SPI_PINS }, b);

    expect(con.bytes('t 0 17 11 22')).toEqual([0x11 ^ 0x0f, 0x22 ^ 0x0f]);
    expect(con.bytes('t 1 13 33 44')).toEqual([0x33 ^ 0xf0, 0x44 ^ 0xf0]);
    expect(a.heard).toEqual([0x11, 0x22]);
    expect(b.heard).toEqual([0x33, 0x44]);
    // The other chip select, driven on the other controller, selects nobody here.
    expect(con.bytes('t 1 17 55')).toEqual([0xff]);
    expect(a.heard).toEqual([0x11, 0x22]);
    registry.clear();
    con.sim.stop();
  });

  it('when the sketch moves SPI1 to GP26-28 the controller follows, and the device wired there starts hearing it', () => {
    const { con, registry, circuit } = fabricBoard();
    const moved = new Recorder(0x5a);
    circuit.wire('m', { SCK: 26, MOSI: 27, MISO: 28, CS: 22 });
    registry.netlistChanged();
    registry.attachSpi({ owner: 'm', pins: SPI_PINS }, moved);

    // SPI1 still on GP14: its frames go to the idle line on that net.
    expect(con.bytes('t 1 22 01')).toEqual([0xff]);
    expect(moved.heard).toEqual([]);
    movePins(con, 1, ALT_PINS[1]);
    expect(con.bytes('T 1 22 01 02 03')).toEqual([0x01 ^ 0x5a, 0x02 ^ 0x5a, 0x03 ^ 0x5a]);
    expect(moved.heard).toEqual([0x01, 0x02, 0x03]);
    registry.clear();
    con.sim.stop();
  });

  it('Stop and Run keep every device on its bus, deselected and told about the reset', () => {
    const { con, registry, circuit } = fabricBoard();
    const a = new Recorder(0x33);
    circuit.wire('a', { SCK: 18, MOSI: 19, MISO: 16, CS: 17 });
    registry.netlistChanged();
    registry.attachSpi({ owner: 'a', pins: SPI_PINS }, a);
    expect(con.bytes('t 0 17 10')).toEqual([0x10 ^ 0x33]);

    const mark = con.length;
    con.sim.reset();
    con.sim.pinManager.hardResetPinStates();
    expect(a.resets).toBe(1);
    expect(registry.placement('a')).toEqual({ boardId: 'pico', sckPin: 18, selected: false });
    con.waitFor('READY', mark);
    expect(con.bytes('t 0 17 20')).toEqual([0x20 ^ 0x33]);
    expect(a.heard).toEqual([0x10, 0x20]);
    registry.clear();
    con.sim.stop();
  });
});

// ── The PL022's own chip select ──────────────────────────────────────────────

describe('RP2040 SPI ports: hardware chip select (SPI.begin(true))', () => {
  it('mode 0 (SPH = 0): CSn pulses high between words, so the device is selected once per frame', () => {
    const { con, registry, circuit } = fabricBoard();
    const dev = new Recorder(0x81);
    circuit.wire('d', { SCK: 18, MOSI: 19, MISO: 16, CS: 17 });
    registry.netlistChanged();
    registry.attachSpi({ owner: 'd', pins: SPI_PINS }, dev);
    movePins(con, 0, DEFAULT_PINS[0], true);
    expect(con.sim.getBusBinding().spi[0].routing()).toEqual({ sck: 18, mosi: 19, miso: 16, cs: [17] });

    con.cmd('m 0 0 1 4000000');
    expect(con.bytes('n 0 01 02 03')).toEqual([0x01 ^ 0x81, 0x02 ^ 0x81, 0x03 ^ 0x81]);
    expect(dev.heard).toEqual([0x01, 0x02, 0x03]);
    expect({ selects: dev.selects, deselects: dev.deselects }).toEqual({ selects: 3, deselects: 3 });
    expect(registry.placement('d')?.selected).toBe(false);
    registry.clear();
    con.sim.stop();
  });

  it('mode 3 (SPH = 1): CSn stays low while the FIFO is fed and goes high one frame after the last word', () => {
    const { con, registry, circuit } = fabricBoard();
    const dev = new Recorder(0x18);
    circuit.wire('d', { SCK: 18, MOSI: 19, MISO: 16, CS: 17 });
    registry.netlistChanged();
    registry.attachSpi({ owner: 'd', pins: SPI_PINS }, dev);
    movePins(con, 0, DEFAULT_PINS[0], true);

    con.cmd('m 0 3 1 4000000');
    const bytes = Array.from({ length: 24 }, (_, i) => (i * 11) & 0xff);
    expect(con.bytes(`n 0 ${hexList(bytes)}`)).toEqual(bytes.map((b) => b ^ 0x18));
    expect(dev.heard).toEqual(bytes);
    expect({ selects: dev.selects, deselects: dev.deselects }).toEqual({ selects: 1, deselects: 1 });
    expect(registry.placement('d')?.selected).toBe(false);
    registry.clear();
    con.sim.stop();
  });

  it('without SPI.begin(true) the controller owns no CSn pad, so a device whose CS the sketch never drives stays deselected', () => {
    const { con, registry, circuit } = fabricBoard();
    const hw = new Recorder(0x0c);
    circuit.wire('hw', { SCK: 18, MOSI: 19, MISO: 16, CS: 17 });
    registry.netlistChanged();
    registry.attachSpi({ owner: 'hw', pins: SPI_PINS }, hw);
    // SPI.begin() without hardware CS: GP17 stays a GPIO, and the sketch never drives it.
    expect(con.bytes('n 0 42')).toEqual([0xff]);
    expect(hw.selects).toBe(0);
    registry.clear();
    con.sim.stop();
  });
});

// ── MicroPython ──────────────────────────────────────────────────────────────

const PY_BOTH = `
from machine import SPI, Pin
import ubinascii
cs0 = Pin(17, Pin.OUT, value=1)
cs1 = Pin(13, Pin.OUT, value=1)
s0 = SPI(0, baudrate=1000000, sck=Pin(18), mosi=Pin(19), miso=Pin(16))
s1 = SPI(1, baudrate=1000000, sck=Pin(14), mosi=Pin(15), miso=Pin(12))
def x(s, cs, data):
    buf = bytearray(data)
    cs.value(0)
    s.write_readinto(buf, buf)
    cs.value(1)
    return ubinascii.hexlify(buf).decode()
print('S0:' + x(s0, cs0, b'\\x11\\x22\\x33'))
print('S1:' + x(s1, cs1, b'\\x44\\x55'))
print('DONE')
`;

describe('RP2040 SPI ports: MicroPython', () => {
  it('machine.SPI(0) and SPI(1) clock into the same ports before and after the MicroPython reset, never into a loopback', async () => {
    const sim = new RP2040Simulator(new PinManager());
    let out = '';
    sim.onSerialData = (ch) => {
      out += ch;
    };
    await sim.loadMicroPython([{ name: 'main.py', content: PY_BOTH }]);
    const binding = sim.getBusBinding();
    const p0 = bindProbe(binding, 0, 17);
    const p1 = bindProbe(binding, 1, 13);
    const until = (text: string, from: number) => {
      for (let t = 0; t < 4000 && out.indexOf(text, from) < 0; t += 10) sim.runFrameForTime(10);
    };
    const line = (tag: string, from: number) => new RegExp(`${tag}:([0-9a-f]*)`).exec(out.slice(from))?.[1];
    const want = (bytes: number[]) => ProbeDevice.expected(bytes).map(hex2).join('');

    until('DONE', 0);
    expect({ s0: line('S0', 0), s1: line('S1', 0) }).toEqual({
      s0: want([0x11, 0x22, 0x33]),
      s1: want([0x44, 0x55]),
    });
    expect(p0.port.routing()).toEqual({ sck: 18, mosi: 19, miso: 16 });
    expect(p1.port.routing()).toEqual({ sck: 14, mosi: 15, miso: 12 });

    // The MicroPython reset builds a new SoC from the flash snapshot.
    let from = out.length;
    sim.reset();
    sim.pinManager.hardResetPinStates();
    until('DONE', from);
    expect({ s0: line('S0', from), s1: line('S1', from) }).toEqual({
      s0: want([0x11, 0x22, 0x33]),
      s1: want([0x44, 0x55]),
    });
    expect(p0.probe.heard).toEqual([0x11, 0x22, 0x33, 0x11, 0x22, 0x33]);
    expect(p1.probe.heard).toEqual([0x44, 0x55, 0x44, 0x55]);

    // Nothing bound: the idle line, not the guest's own bytes echoed back.
    p0.release();
    p1.release();
    from = out.length;
    sim.reset();
    sim.pinManager.hardResetPinStates();
    until('DONE', from);
    expect({ s0: line('S0', from), s1: line('S1', from) }).toEqual({ s0: 'ffffff', s1: 'ffff' });
    sim.stop();
  }, 120_000);
});

// ── The transition bridge ────────────────────────────────────────────────────

describe('RP2040 transition bridge: simulator.spi and setSPIHandler share the frame', () => {
  it('the facade is one object for the life of the simulator, on SPI0 only', () => {
    const con = bootConsole();
    const facade = con.sim.spi;
    const heard: number[] = [];
    const leave = spiChainAttach(facade, 'tap', (byte, next) => {
      heard.push(byte);
      next?.(byte);
    });
    con.bytes('t 0 17 01');
    con.bytes('t 1 13 02');
    expect(heard).toEqual([0x01]);
    let mark = con.length;
    con.sim.reset();
    con.waitFor('READY', mark);
    mark = con.length;
    con.sim.loadBinary(CONSOLE_BIN);
    con.waitFor('READY', mark);
    expect(con.sim.spi).toBe(facade);
    con.bytes('t 0 17 03');
    expect(heard).toEqual([0x01, 0x03]);
    leave();
    con.sim.stop();
  });

  it('one completeTransmit per frame: the last facade answer wins, ANDed with the fabric device', () => {
    const con = bootConsole();
    const { probe, release } = bindProbe(con.sim.getBusBinding(), 0, 17);
    const facade = con.sim.spi;
    // Two legacy listeners answering the same byte: an idle 0xFF, then a
    // selected part (the chain contract). The last one is the answer.
    facade.onByte = () => {
      facade.completeTransfer(0xff);
      facade.completeTransfer(0xf5);
    };
    const bytes = [0x00, 0x5a, 0xff];
    expect(con.bytes(`t 0 17 ${hexList(bytes)}`)).toEqual(ProbeDevice.expected(bytes).map((b) => b & 0xf5));
    expect(probe.frames).toBe(3);
    // A legacy listener that never answers leaves the fabric's answer alone.
    facade.onByte = () => {};
    expect(con.bytes('t 0 17 11')).toEqual(ProbeDevice.expected([0x11]));
    facade.onByte = null;
    release();
    con.sim.stop();
  });

  it('setSPIHandler joins the frame instead of replacing onTransmit, before the first load and across resets', () => {
    const sim = new RP2040Simulator(new PinManager());
    const heard: Array<[number, number]> = [];
    // A custom chip mounted with the project, before any firmware exists.
    sim.setSPIHandler(1, (mosi) => {
      heard.push([1, mosi]);
      return 0x3c;
    });
    sim.setSPIHandler(0, (mosi) => {
      heard.push([0, mosi]);
      return 0xff; // not selected: high-Z
    });
    sim.loadBinary(CONSOLE_BIN);
    const con = new PicoConsole(sim);
    con.waitFor('READY');
    const onTransmit = sim.getMCU()!.spi[1].onTransmit;
    const { release } = bindProbe(sim.getBusBinding(), 1, 13);
    expect(con.bytes('t 1 13 a0 a1')).toEqual(ProbeDevice.expected([0xa0, 0xa1]).map((b) => b & 0x3c));
    expect(con.bytes('t 0 17 b0')).toEqual([0xff]);
    expect(heard).toEqual([
      [1, 0xa0],
      [1, 0xa1],
      [0, 0xb0],
    ]);
    // The controller still clocks into the port, not into the handler.
    sim.setSPIHandler(1, () => 0xff);
    expect(sim.getMCU()!.spi[1].onTransmit).toBe(onTransmit);
    expect(con.bytes('t 1 13 c0')).toEqual(ProbeDevice.expected([0xc0]));

    const mark = con.length;
    sim.reset();
    sim.pinManager.hardResetPinStates();
    con.waitFor('READY', mark);
    sim.setSPIHandler(1, () => 0x0f);
    expect(con.bytes('t 1 13 d0')).toEqual(ProbeDevice.expected([0xd0]).map((b) => b & 0x0f));
    release();
    sim.stop();
  });
});

// ── microSD on the Pico (bus matrix d2) ──────────────────────────────────────

const CARD_TEXT = 'VELXIO-BUS-MATRIX-7F3A';

/** The card's own pin names on the sketch's SPI0 pins (GP18 SCK, GP19 MOSI,
 *  GP16 MISO) with the chip select conf-rp2040-sd drives, GP17. */
const SD_WIRING: Record<string, number> = { SCK: 18, DI: 19, DO: 16, CS: 17 };

interface SdRun {
  out: string;
  /** The MISO the guest read on the eight frames after the first CMD0. */
  reply: number[];
}

/**
 * Boot conf-rp2040-sd with the OSS microsd-card part holding a FAT16 card with
 * /data.txt.
 *
 * The card reaches the board the way it does in the app: through the bus
 * fabric. The rig supplies what the canvas supplies, a circuit that says where
 * the card's SCK/DI/DO/CS land and the board's engine binding, so the part is
 * clocked only while GP17 is low and answers on the board's MISO net.
 *
 * `wireDo: false` leaves the card's data-out leg unconnected. That is the
 * negative control: the fabric still clocks the card, and the card still
 * prepares its answers, but nothing of it reaches MISO, exactly as on a bench
 * with the DO pad open.
 */
function runSdMount(wireDo = true): SdRun {
  const sim = new RP2040Simulator(new PinManager());
  sim.loadBinary(SD_BIN);
  let out = '';
  sim.onSerialData = (ch) => {
    out += ch;
  };
  const circuit = new Circuit();
  const { DO, ...noDataOut } = SD_WIRING;
  circuit.wire('sd', wireDo ? SD_WIRING : noDataOut);
  busRegistry.setResolver(circuit);
  busRegistry.bindEngine('pico', sim.getBusBinding());

  const img = buildFat16Image([{ name: 'data.txt', data: new TextEncoder().encode(`${CARD_TEXT}\n`) }]);
  const el = { id: 'sd', sdImageData: img } as unknown as HTMLElement;
  const off = PartSimulationRegistry.get('microsd-card')!.attachEvents!(el, sim as never, () => null, 'sd');

  // Watch the wire: MOSI in, the MISO the guest reads back. Both are taken on
  // the SoC's own peripheral, under whatever the fabric decided, so the test
  // reads the line and never stands in for a device on it.
  const cs = () => sim.pinManager.peekPinState(17) === false;
  const wire: Array<[number, number]> = [];
  const spi0 = sim.getMCU()!.spi[0];
  const clock = spi0.onTransmit;
  const complete = spi0.completeTransmit.bind(spi0);
  let mosi = -1;
  spi0.onTransmit = (value: number) => {
    mosi = value;
    clock?.(value);
  };
  spi0.completeTransmit = (miso: number) => {
    if (cs()) wire.push([mosi, miso]);
    complete(miso);
  };

  try {
    for (let t = 0; t < 4000 && !out.includes('DONE'); t += 10) sim.runFrameForTime(10);
  } finally {
    sim.stop();
    off();
    busRegistry.clear();
  }
  // The first CMD0 frame (40 00 00 00 00 95) and the eight frames after it.
  const at = wire.findIndex(([m], i) => m === 0x40 && wire[i + 5]?.[0] === 0x95);
  return { out, reply: at < 0 ? [] : wire.slice(at + 6, at + 14).map(([, miso]) => miso) };
}

/**
 * Where R1 sits in a reply. The SD spec gives a card N_CR to answer, 1 to 8
 * fill bytes between the end of a command and its response, so a host scans
 * for the first byte with bit 7 clear instead of reading a fixed index, and so
 * does this test: reading index 0 would assert a timing the spec forbids, and
 * reading index 1 would assert one particular legal timing as if it were the
 * only one.
 */
function r1(reply: number[]): { fill: number; value: number | undefined } {
  const at = reply.findIndex((b) => (b & 0x80) === 0);
  return { fill: at < 0 ? reply.length : at, value: at < 0 ? undefined : reply[at] };
}

/** The mount, booted once and read by both tests below. */
let mounted: SdRun | null = null;
const sdMounted = (): SdRun => (mounted ??= runSdMount());

describe('RP2040 microSD with SD.h (bus matrix d2: the card mounts on a Pico)', () => {
  it('microsd-r1-without-ncr-fill setup: CMD0 reaches the card over the RP2040 port and the card answers R1 after the spec fill byte', () => {
    const run = sdMounted();
    expect(run.out).toContain('DONE');
    const { fill, value } = r1(run.reply);
    expect(value).toBe(0x01); // R1 = idle, the answer to CMD0
    // N_CR: a card never answers on the byte right after the command.
    expect(fill).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('microsd-r1-without-ncr-fill control: with the card DO leg unwired nothing drives MISO, and SD.begin() reports failure', () => {
    const run = runSdMount(false);
    expect(run.out).toContain('DONE');
    expect(run.out).toContain('BEGIN:0');
    // The capture has to have found the CMD0 frame: with an empty reply
    // "no R1" would be true of a rig that clocked nothing at all.
    expect(run.reply, 'the eight frames after CMD0').toHaveLength(8);
    // Nobody drives the line, so every one of them reads its idle level.
    expect(run.reply).toEqual(new Array(8).fill(0xff));
    expect(r1(run.reply).value).toBeUndefined();
  }, 60_000);

  // Closed by the N_CR fill byte the card now leaves in front of every
  // response (ProtocolParts.ts microsd-card: processCmd queues 0xFF before the
  // response). SdFat (the SD.h of arduino-pico) throws away the first byte
  // after a command, as N_CR >= 1 allows, and used to throw R1 away with it,
  // so no Pico sketch could mount this card. The libraries that poll from the
  // first byte (Arduino SD on AVR, ESP-IDF sd_diskio) read the fill byte as
  // the idle byte it is, which is why the same card mounted there.
  it('microsd-r1-without-ncr-fill: SD.h on arduino-pico mounts the OSS microSD card and reads /data.txt', () => {
    const run = sdMounted();
    expect(run.out).toContain('BEGIN:1');
    expect(run.out).toContain(`READ:${CARD_TEXT}`);
  }, 60_000);
});
