/**
 * Board buses F5: the RP2040 I2C controller ports (project board-buses-2026-09,
 * F5-F6-SPEC, TESTS.md layer 2).
 *
 * Everything runs the real rp2040js core through RP2040Simulator with guests
 * built by the production toolchain (arduino-pico 6.1.1):
 *   fixtures/conf-i2c-console/pico  a serial-driven master on I2C0 and I2C1,
 *                                   any pins (pico-sdk's blocking calls, the
 *                                   ones Wire makes, so the codes are exact)
 *   fixtures/rp2040-i2c-wire1       Wire on GP4/GP5 and Wire1 on GP26/GP27,
 *                                   each probing 0x44 (the F0 repro guest)
 *   fixtures/rp2040-xiao-i2c        the XIAO RP2040 build, whose Wire is I2C1
 *                                   on GP6/GP7 (the Grove socket)
 * plus the MicroPython v1.20 UF2 the app ships, for machine.I2C and the
 * MicroPython reset.
 *
 * The shared conformance suite (buses/conformance/i2cPortConformance.ts) runs
 * twice: both controllers on the arduino-pico default pins, and both moved to
 * another legal pair with setSDA/setSCL. The cases after it cover what is
 * specific to this SoC: routing that follows funcsel, the fabric deciding by
 * nets which controller a target hears (rp2040-i2c-bus0-hardcoded: the part
 * used to land on bus 0 whatever it was wired to), the zero-length probe that
 * arduino-pico bit-bangs, and the MicroPython reset.
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
import {
  ProbeTarget,
  bindProbes,
  defineI2cPortConformance,
  type I2cConformanceRig,
  type I2cGuestResult,
  type I2cGuestTransaction,
} from '../../simulation/buses/conformance/i2cPortConformance';
import { BusRegistry } from '../../simulation/buses/registry';
import type { BusDiagnostic, I2cRouting, I2cTarget, NetResolver, PinRef, ResolvedPin } from '../../simulation/buses/types';

// ── Firmware ─────────────────────────────────────────────────────────────────

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const bin = (rel: string) => readFileSync(here(`./fixtures/${rel}`)).toString('base64');
const CONSOLE_BIN = bin('conf-i2c-console/pico/conf-i2c-console.ino.bin');
const WIRE1_BIN = bin('rp2040-i2c-wire1/rp2040-i2c-wire1.ino.bin');
const XIAO_BIN = bin('rp2040-xiao-i2c/rp2040-xiao-i2c.ino.bin');
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

/** A board running a guest that talks over UART0. Time only moves through the
 *  production frame body (runFrameForTime). */
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

  text(from = 0): string {
    return this.out.slice(from);
  }

  /** Run 1 ms frames until `text` shows up after `from`. */
  waitFor(text: string, from = 0, maxMs = 3000): void {
    for (let t = 0; t < maxMs && this.out.indexOf(text, from) < 0; t++) this.sim.runFrameForTime(1);
    if (this.out.indexOf(text, from) < 0) {
      throw new Error(`guest never printed ${text}; got ${JSON.stringify(this.out.slice(from))}`);
    }
  }

  /** Type one line; returns what the guest answered after '='. */
  cmd(line: string, maxMs = 800): string {
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

  /** One Wire exchange ('x U AA N HH ..'): the status and the bytes read. */
  exchange(t: I2cGuestTransaction): I2cGuestResult {
    const words = this.cmd(`x ${t.unit} ${hex2(t.address)} ${t.read} ${t.write.map(hex2).join(' ')}`)
      .split(/\s+/)
      .filter(Boolean);
    return { status: parseInt(words[0], 10), read: words.slice(1).map((h) => parseInt(h, 16)) };
  }
}

function boot(firmware: string, ready = 'READY'): PicoConsole {
  const sim = new RP2040Simulator(new PinManager());
  sim.loadBinary(firmware);
  const con = new PicoConsole(sim);
  con.waitFor(ready);
  return con;
}

interface PinPair {
  sda: number;
  scl: number;
}

/** arduino-pico rpipico defaults (pins_arduino.h): Wire on GP4/GP5, Wire1 on GP26/GP27. */
const DEFAULT_PINS: [PinPair, PinPair] = [
  { sda: 4, scl: 5 },
  { sda: 26, scl: 27 },
];
/** Another legal F3 pair for each controller: I2C0 on GP8/GP9, I2C1 on GP10/GP11. */
const ALT_PINS: [PinPair, PinPair] = [
  { sda: 8, scl: 9 },
  { sda: 10, scl: 11 },
];

function movePins(con: PicoConsole, unit: 0 | 1, p: PinPair): void {
  expect(con.cmd(`p ${unit} ${p.sda} ${p.scl}`)).toBe('OK');
}

/** The rig the shared suite drives. The guest boots on the defaults, so a
 *  moved rig moves the controllers again after every boot. */
function consoleRig(pins: [PinPair, PinPair]): I2cConformanceRig {
  const con = boot(CONSOLE_BIN);
  const sim = con.sim;
  const atDefaults = pins === DEFAULT_PINS;
  let moved = atDefaults;
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
    moved = atDefaults;
  };
  return {
    units: [0, 1],
    binding: () => sim.getBusBinding(),
    run: async (txs) => {
      place();
      return txs.map((t) => con.exchange(t));
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
    expectedRouting: (unit) => pins[unit],
    onPinEdge: (pin, cb) => sim.pinManager.onPinChange(pin, () => cb()),
    dispose: () => sim.stop(),
  };
}

defineI2cPortConformance('RP2040 I2C0 and I2C1 on the default pins', async () => consoleRig(DEFAULT_PINS));
defineI2cPortConformance('RP2040 I2C0 and I2C1 moved to GP8/GP9 and GP10/GP11', async () => consoleRig(ALT_PINS));

// ── Routing follows funcsel ──────────────────────────────────────────────────

describe('RP2040 I2C ports: routing is the pads whose funcsel is I2C', () => {
  it('both controllers are ports named for the datasheet, and a pin move is reported as it happens', () => {
    const con = boot(CONSOLE_BIN);
    const ports = con.sim.getBusBinding().i2c ?? [];
    expect(ports.map((p) => [p.bus, p.unit, p.name])).toEqual([
      ['i2c', 0, 'I2C0'],
      ['i2c', 1, 'I2C1'],
    ]);
    const [p0, p1] = ports;
    expect(p0.routing()).toEqual({ sda: 4, scl: 5 });
    expect(p1.routing()).toEqual({ sda: 26, scl: 27 });

    let changes = 0;
    p1.setRoutingChangeHandler!(() => changes++);
    movePins(con, 1, ALT_PINS[1]);
    expect(changes).toBeGreaterThan(0);
    expect(p1.routing()).toEqual({ sda: 10, scl: 11 });
    // The other controller never moved.
    expect(p0.routing()).toEqual({ sda: 4, scl: 5 });
    p1.setRoutingChangeHandler!(null);
    con.sim.stop();
  });

  it('a reset starts routing over from the new SoC (no pad is I2C until the sketch says so again)', () => {
    const con = boot(CONSOLE_BIN);
    const port = (con.sim.getBusBinding().i2c ?? [])[1];
    const seen: Array<I2cRouting | 'static'> = [];
    port.setRoutingChangeHandler!(() => seen.push(port.routing()));
    const mark = con.length;
    con.sim.reset();
    expect(seen[0]).toEqual({});
    con.waitFor('READY', mark);
    expect(port.routing()).toEqual({ sda: 26, scl: 27 });
    port.setRoutingChangeHandler!(null);
    con.sim.stop();
  });
});

// ── Under the fabric: a target hears the controller its wires reach ─────────

/** The circuit, as a plain NetResolver: component pins wired to GPIOs of one Pico. */
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

/** The F0 chip's register model in JS: a register write, then BE EF from 0x00. */
class BeefTarget implements I2cTarget {
  heard: number[] = [];
  starts = 0;
  resets = 0;
  private ptr = 0;
  private first = true;
  start(): boolean {
    this.starts++;
    this.first = true;
    return true;
  }
  write(b: number): boolean {
    this.heard.push(b);
    if (this.first) this.ptr = b;
    this.first = false;
    return true;
  }
  read(): number {
    return this.ptr++ === 0 ? 0xbe : 0xef;
  }
  stop(): void {}
  boardReset(): void {
    this.resets++;
  }
}

function fabricBoard(firmware: string): { con: PicoConsole; registry: BusRegistry; circuit: Circuit } {
  const sim = new RP2040Simulator(new PinManager());
  const registry = new BusRegistry();
  const circuit = new Circuit();
  registry.setResolver(circuit);
  // On the canvas the board and its wires exist before the sketch runs.
  registry.bindBoard('pico', sim);
  sim.loadBinary(firmware);
  const con = new PicoConsole(sim);
  return { con, registry, circuit };
}

const I2C_PINS = { sda: 'SDA', scl: 'SCL' };

describe('RP2040 I2C under the fabric: a target answers on the controller its SDA/SCL are wired to', () => {
  it('rp2040-i2c-bus0-hardcoded (F0 guest): a target on GP26/GP27 answers Wire1 and not Wire', () => {
    const { con, registry, circuit } = fabricBoard(WIRE1_BIN);
    const t = new BeefTarget();
    circuit.wire('chip', { SDA: 26, SCL: 27 });
    registry.netlistChanged();
    registry.attachI2c({ owner: 'chip', pins: I2C_PINS, addresses: [0x44] }, t);
    con.waitFor('DONE');
    expect(con.text()).toContain('WIRE0:NACK');
    expect(con.text()).toContain('WIRE1:ACK:BEEF');
    expect(t.heard).toEqual([0x00]);
    registry.clear();
    con.sim.stop();
  });

  it('rp2040-i2c-bus0-hardcoded control: the same target on GP4/GP5 answers Wire and not Wire1', () => {
    const { con, registry, circuit } = fabricBoard(WIRE1_BIN);
    circuit.wire('chip', { SDA: 4, SCL: 5 });
    registry.netlistChanged();
    registry.attachI2c({ owner: 'chip', pins: I2C_PINS, addresses: [0x44] }, new BeefTarget());
    con.waitFor('DONE');
    expect(con.text()).toContain('WIRE0:ACK:BEEF');
    expect(con.text()).toContain('WIRE1:NACK');
    registry.clear();
    con.sim.stop();
  });

  it('two targets at the same address, one per bus, each answer only their own controller (TESTS I01)', () => {
    const { con, registry, circuit } = fabricBoard(WIRE1_BIN);
    const a = new BeefTarget();
    const b = new BeefTarget();
    circuit.wire('a', { SDA: 4, SCL: 5 });
    circuit.wire('b', { SDA: 26, SCL: 27 });
    registry.netlistChanged();
    const seen: BusDiagnostic[] = [];
    registry.onDiagnostic((d) => seen.push(d));
    registry.attachI2c({ owner: 'a', pins: I2C_PINS, addresses: [0x44] }, a);
    registry.attachI2c({ owner: 'b', pins: I2C_PINS, addresses: [0x44] }, b);
    con.waitFor('DONE');
    expect(con.text()).toContain('WIRE0:ACK:BEEF');
    expect(con.text()).toContain('WIRE1:ACK:BEEF');
    expect([a.starts, b.starts]).toEqual([2, 2]);
    expect(seen.filter((d) => d.code === 'i2c-address-conflict'), 'two buses, no conflict').toEqual([]);
    registry.clear();
    con.sim.stop();
  });

  it('rp2040-i2c-bus0-hardcoded (XIAO RP2040 guest): Wire is I2C1 on GP6/GP7, and a target on those pins answers it', () => {
    const { con, registry, circuit } = fabricBoard(XIAO_BIN);
    circuit.wire('grove', { SDA: 6, SCL: 7 });
    registry.netlistChanged();
    registry.attachI2c({ owner: 'grove', pins: I2C_PINS, addresses: [0x44] }, new BeefTarget());
    con.waitFor('DONE');
    expect(con.text()).toContain('WIRE:ACK:BEEF');
    expect(con.sim.getBusBinding().i2c?.[1].routing()).toEqual({ sda: 6, scl: 7 });
    registry.clear();
    con.sim.stop();
  });

  it('when the sketch moves I2C1 the controller follows, and the target wired to the new pins starts answering', () => {
    const { con, registry, circuit } = fabricBoard(CONSOLE_BIN);
    con.waitFor('READY');
    const t = new BeefTarget();
    circuit.wire('m', { SDA: 10, SCL: 11 });
    registry.netlistChanged();
    registry.attachI2c({ owner: 'm', pins: I2C_PINS, addresses: [0x44] }, t);
    expect(con.exchange({ unit: 1, address: 0x44, write: [0x00], read: 0 }).status, 'I2C1 still on GP26').toBe(2);
    movePins(con, 1, ALT_PINS[1]);
    expect(con.exchange({ unit: 1, address: 0x44, write: [0x00], read: 2 })).toEqual({ status: 0, read: [0xbe, 0xef] });
    expect(con.exchange({ unit: 0, address: 0x44, write: [0x00], read: 0 }).status, 'I2C0 is elsewhere').toBe(2);
    registry.clear();
    con.sim.stop();
  });

  it('Stop and Run keep the target on its bus and tell it about the reset', () => {
    const { con, registry, circuit } = fabricBoard(CONSOLE_BIN);
    con.waitFor('READY');
    const t = new BeefTarget();
    circuit.wire('a', { SDA: 4, SCL: 5 });
    registry.netlistChanged();
    registry.attachI2c({ owner: 'a', pins: I2C_PINS, addresses: [0x44] }, t);
    expect(con.exchange({ unit: 0, address: 0x44, write: [0x00], read: 2 }).read).toEqual([0xbe, 0xef]);
    const mark = con.length;
    con.sim.reset();
    con.sim.pinManager.hardResetPinStates();
    expect(t.resets).toBe(1);
    con.waitFor('READY', mark);
    expect(con.exchange({ unit: 0, address: 0x44, write: [0x00], read: 2 }).read).toEqual([0xbe, 0xef]);
    registry.clear();
    con.sim.stop();
  });

  it("arduino-pico's zero-length probe (bit-banged on the pins) finds a target through the software decoder, and misses an address nobody has", () => {
    const { con, registry, circuit } = fabricBoard(CONSOLE_BIN);
    con.waitFor('READY');
    const t = new BeefTarget();
    circuit.wire('a', { SDA: 4, SCL: 5 });
    registry.netlistChanged();
    registry.attachI2c({ owner: 'a', pins: I2C_PINS, addresses: [0x44] }, t);
    expect(con.cmd('z 0 44'), 'Wire.endTransmission() on an empty write').toBe('0');
    expect(t.starts, 'the decoder delivered the address phase').toBe(1);
    expect(con.cmd('z 0 45')).toBe('2');
    // Unwired, the same probe finds nobody.
    expect(con.cmd('z 1 44')).toBe('2');
    // And the controller is back on its pads afterwards.
    expect(con.exchange({ unit: 0, address: 0x44, write: [0x00], read: 2 }).read).toEqual([0xbe, 0xef]);
    registry.clear();
    con.sim.stop();
  });
});

// ── MicroPython ──────────────────────────────────────────────────────────────

const PY_I2C = `
from machine import I2C, Pin
import ubinascii
i0 = I2C(0, sda=Pin(4), scl=Pin(5), freq=100000)
i1 = I2C(1, sda=Pin(26), scl=Pin(27), freq=100000)
i0.writeto(0x42, b'\\x10\\x20')
print('R0:' + ubinascii.hexlify(i0.readfrom(0x42, 3)).decode())
print('R1:' + ubinascii.hexlify(i1.readfrom_mem(0x29, 0x07, 2)).decode())
print('DONE')
`;

describe('RP2040 I2C ports: MicroPython', () => {
  it('machine.I2C(0) and I2C(1) reach the same ports before and after the MicroPython reset', async () => {
    const sim = new RP2040Simulator(new PinManager());
    let out = '';
    sim.onSerialData = (ch) => {
      out += ch;
    };
    await sim.loadMicroPython([{ name: 'main.py', content: PY_I2C }]);
    const binding = sim.getBusBinding();
    const a = new ProbeTarget([0x42], 0x11);
    const b = new ProbeTarget([0x29], 0x77);
    bindProbes(binding, 0, [a]);
    bindProbes(binding, 1, [b]);
    const until = (text: string, from: number) => {
      for (let t = 0; t < 4000 && out.indexOf(text, from) < 0; t += 10) sim.runFrameForTime(10);
    };
    const line = (tag: string, from: number) => new RegExp(`${tag}:([0-9a-f]*)`).exec(out.slice(from))?.[1];
    const want = (seed: number, addr: number, n: number) =>
      ProbeTarget.expected(seed, addr, n).map(hex2).join('');

    until('DONE', 0);
    expect({ r0: line('R0', 0), r1: line('R1', 0) }).toEqual({ r0: want(0x11, 0x42, 3), r1: want(0x77, 0x29, 2) });
    expect(binding.i2c?.[0].routing()).toEqual({ sda: 4, scl: 5 });
    expect(binding.i2c?.[1].routing()).toEqual({ sda: 26, scl: 27 });

    const from = out.length;
    sim.reset();
    sim.pinManager.hardResetPinStates();
    until('DONE', from);
    expect({ r0: line('R0', from), r1: line('R1', from) }).toEqual({ r0: want(0x11, 0x42, 3), r1: want(0x77, 0x29, 2) });
    expect(a.heard).toEqual([0x10, 0x20, 0x10, 0x20]);
    expect(b.heard).toEqual([0x07, 0x07]);
    sim.stop();
  }, 120_000);
});
