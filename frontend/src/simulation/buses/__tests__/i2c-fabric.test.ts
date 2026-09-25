/**
 * Layer 1 of project board-buses-2026-09 (TESTS.md), F5: the I2C fabric on
 * its own, with a fake circuit, fake board pins and fake controller ports that
 * follow the real contracts. No engine here; the engine adapters prove their
 * ports with conformance/i2cPortConformance.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BusRegistry } from '../registry';
import type {
  BoardPins,
  BusDiagnostic,
  EngineBinding,
  I2cControllerPort,
  I2cRouting,
  I2cTarget,
  I2cTransactionHandler,
  NetResolver,
  PinRef,
  ResolvedPin,
} from '../types';
import { registerBoardPinFunctions } from '../pinFunctions';

// ── Fakes ───────────────────────────────────────────────────────────────────

/**
 * Board pins with open-drain lines. `levels` is what the MCU latches,
 * `pads` its drive state when the engine reports one, `driven` what a target
 * puts on a pin through driveInput. With `echo`, the engine reports the LINE
 * (latch AND target) as the pin state and fires a pin change when a target
 * drives it, which is what some engines do with an input they are handed.
 */
class FakePins implements BoardPins {
  levels = new Map<number, boolean>();
  driven = new Map<number, boolean>();
  pads = new Map<number, { drive: 'low' | 'high' | 'z'; pull: 0 | 1 | 2 }>();
  echo = false;
  private listeners = new Map<number, Set<(p: number, l: boolean) => void>>();
  private padListeners = new Map<number, Set<() => void>>();
  onPinChange(pin: number, cb: (p: number, l: boolean) => void): () => void {
    let s = this.listeners.get(pin);
    if (!s) this.listeners.set(pin, (s = new Set()));
    s.add(cb);
    return () => this.listeners.get(pin)?.delete(cb);
  }
  peekPinState(pin: number): boolean | undefined {
    if (this.echo) return (this.levels.get(pin) ?? true) && this.driven.get(pin) !== false;
    return this.levels.get(pin);
  }
  peekPad(pin: number): { drive: 'low' | 'high' | 'z'; pull: 0 | 1 | 2 } | undefined {
    return this.pads.get(pin);
  }
  onPadChange(pin: number, cb: () => void): () => void {
    let s = this.padListeners.get(pin);
    if (!s) this.padListeners.set(pin, (s = new Set()));
    s.add(cb);
    return () => this.padListeners.get(pin)?.delete(cb);
  }
  driveInput(pin: number, level: boolean): void {
    const before = this.peekPinState(pin);
    this.driven.set(pin, level);
    if (this.echo && before !== this.peekPinState(pin)) this.fire(pin);
  }
  write(pin: number, level: boolean): void {
    const before = this.peekPinState(pin);
    this.levels.set(pin, level);
    if (before !== this.peekPinState(pin) || !this.echo) this.fire(pin);
  }
  pad(pin: number, drive: 'low' | 'high' | 'z', pull: 0 | 1 | 2 = 0): void {
    this.pads.set(pin, { drive, pull });
    for (const cb of this.padListeners.get(pin) ?? []) cb();
  }
  /** An MCU reset: the MCU's own latches and pads, not what the parts drive. */
  reset(): void {
    this.levels.clear();
    this.pads.clear();
  }
  private fire(pin: number): void {
    const l = this.peekPinState(pin) ?? true;
    for (const cb of this.listeners.get(pin) ?? []) cb(pin, l);
  }
}

interface WireResult {
  status: number;
  read: number[];
}

/** A controller port whose "guest" behaves like Arduino Wire. */
class FakeI2cPort implements I2cControllerPort {
  readonly bus = 'i2c' as const;
  handler: I2cTransactionHandler | null = null;
  route: I2cRouting | 'static';
  routingChanged: (() => void) | null = null;
  readonly unit: number;
  readonly name: string;
  constructor(unit: number, name: string, route: I2cRouting | 'static' = 'static') {
    this.unit = unit;
    this.name = name;
    this.route = route;
  }
  setTransactionHandler(h: I2cTransactionHandler | null): void {
    this.handler = h;
  }
  routing(): I2cRouting | 'static' {
    return this.route;
  }
  setRoutingChangeHandler(h: (() => void) | null): void {
    this.routingChanged = h;
  }
  /** beginTransmission / write / endTransmission(read === 0) / requestFrom. */
  wire(address: number, write: number[], read = 0): WireResult {
    const h = this.handler;
    let status = 0;
    if (write.length > 0 || read === 0) {
      const ack = h ? h.start(address, false) : false;
      status = ack ? 0 : 2;
      if (ack) {
        for (const b of write) {
          if (!h!.write(b)) {
            status = 3;
            break;
          }
        }
      }
      if (status !== 0 || read === 0) {
        h?.stop();
        return { status, read: [] };
      }
    }
    const ack = h ? h.start(address, true) : false;
    const out: number[] = [];
    if (ack) for (let i = 0; i < read; i++) out.push(h!.read());
    h?.stop();
    return { status: ack ? status : 2, read: out };
  }
}

class FakeCircuit implements NetResolver {
  nets = new Map<string, ResolvedPin>();
  kinds = new Map<string, string>();
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }
  boardKind(id: string): string | undefined {
    return this.kinds.get(id);
  }
  boards(): string[] {
    return Array.from(this.kinds.keys());
  }
  wire(comp: string, pin: string, to: ResolvedPin): void {
    this.nets.set(`${comp}:${pin}`, to);
  }
}

const gpio = (pin: number, boardId = 'uno'): ResolvedPin => ({ kind: 'board', boardId, pin });

/** A register-file target: first written byte sets the pointer, reads walk the file. */
class Chip implements I2cTarget {
  log: string[] = [];
  heard: number[] = [];
  regs: number[];
  ptr = 0;
  first = true;
  reads = 0;
  stops = 0;
  resets = 0;
  ackAddress = true;
  nackByte: number | null = null;
  /** Shared by several chips: the order the bus called them in. */
  global: string[] | null = null;
  name = '';
  constructor(regs: number[] = [0x10, 0x20, 0x30, 0x40]) {
    this.regs = regs;
  }
  private note(e: string): void {
    this.log.push(e);
    this.global?.push(`${this.name}:${e}`);
  }
  start(address: number, read: boolean): boolean {
    this.note(`S${read ? 'r' : 'w'}${address.toString(16)}`);
    this.first = !read;
    return this.ackAddress;
  }
  write(byte: number): boolean {
    this.note(`W${byte.toString(16)}`);
    this.heard.push(byte);
    if (this.first) {
      this.ptr = byte;
      this.first = false;
    }
    return byte !== this.nackByte;
  }
  read(): number {
    this.reads++;
    this.note('R');
    const v = this.regs[this.ptr % this.regs.length];
    this.ptr++;
    return v;
  }
  stop(): void {
    this.stops++;
    this.note('P');
  }
  boardReset(): void {
    this.resets++;
  }
}

// Uno-like board: TWI on A4 (18) SDA / A5 (19) SCL.
registerBoardPinFunctions(['test-uno-i2c'], {
  routing: 'fixed',
  source: 'test',
  controllers: [{ bus: 'i2c', unit: 0, name: 'TWI', arduino: ['Wire'], defaultPins: { sda: 18, scl: 19 } }],
  pins: {
    18: [{ bus: 'i2c', unit: 0, signal: 'sda' }],
    19: [{ bus: 'i2c', unit: 0, signal: 'scl' }],
  },
});

function rig() {
  const reg = new BusRegistry();
  const circuit = new FakeCircuit();
  circuit.kinds.set('uno', 'test-uno-i2c');
  const pins = new FakePins();
  const port = new FakeI2cPort(0, 'TWI');
  let resetHandler: (() => void) | null = null;
  const binding: EngineBinding = {
    pins,
    spi: [],
    i2c: [port],
    setResetHandler: (h) => {
      resetHandler = h;
    },
  };
  const diags: BusDiagnostic[] = [];
  reg.onDiagnostic((d) => diags.push(d));
  reg.setResolver(circuit);
  reg.bindEngine('uno', binding);
  /** Wire a target's SDA/SCL (default: the TWI pins) and register it. */
  const target = (
    id: string,
    addresses: number[],
    chip: I2cTarget,
    sda: ResolvedPin = gpio(18),
    scl: ResolvedPin = gpio(19),
  ) => {
    circuit.wire(id, 'SDA', sda);
    circuit.wire(id, 'SCL', scl);
    return reg.attachI2c({ owner: id, pins: { sda: 'SDA', scl: 'SCL' }, addresses }, chip);
  };
  return {
    reg,
    circuit,
    pins,
    port,
    diags,
    target,
    codes: () => diags.map((d) => d.code),
    mcuReset: () => {
      pins.reset();
      resetHandler?.();
    },
  };
}

// ── Membership ──────────────────────────────────────────────────────────────

describe('I2C fabric: membership from the nets', () => {
  let r: ReturnType<typeof rig>;
  beforeEach(() => {
    r = rig();
  });

  it('a target on the controller SDA/SCL answers Wire: ACK, bytes in, register read out', () => {
    const c = new Chip([0xaa, 0xbb, 0xcc]);
    r.target('rtc', [0x68], c);
    expect(r.port.wire(0x68, [0x01, 0x55]).status).toBe(0);
    expect(c.heard).toEqual([0x01, 0x55]);
    expect(r.port.wire(0x68, [0x01], 2)).toEqual({ status: 0, read: [0xbb, 0xcc] });
    expect(r.reg.i2cPlacement('rtc')).toEqual({ boardId: 'uno', sdaPin: 18, sclPin: 19, clocked: true });
    expect(r.diags).toEqual([]);
  });

  it('a target on two other GPIOs is on a software bus: the hardware controller does not reach it', () => {
    const c = new Chip();
    r.target('ee', [0x50], c, gpio(2), gpio(3));
    expect(r.port.wire(0x50, [0]).status).toBe(2);
    expect(c.log).toEqual([]);
    expect(r.reg.i2cPlacement('ee')).toMatchObject({ sdaPin: 2, sclPin: 3, clocked: true });
    // Legitimate wiring for software I2C: nothing to report.
    expect(r.codes()).not.toContain('i2c-wiring');
  });

  it('an unwired SDA or SCL: the chip does not answer, and the diagnostic says which pin', () => {
    const a = new Chip();
    r.target('no-sda', [0x50], a, { kind: 'floating' }, gpio(19));
    const b = new Chip();
    r.target('no-scl', [0x51], b, gpio(18), { kind: 'floating' });
    const c = new Chip();
    r.target('none', [0x52], c, { kind: 'floating' }, { kind: 'floating' });
    for (const addr of [0x50, 0x51, 0x52]) expect(r.port.wire(addr, [1]).status).toBe(2);
    expect(a.log.concat(b.log, c.log)).toEqual([]);
    for (const id of ['no-sda', 'no-scl', 'none']) expect(r.reg.i2cPlacement(id)).toBeNull();
    const wiring = r.diags.filter((d) => d.code === 'i2c-wiring');
    // A chip with neither line on a board is a part not wired yet: SPI's rule
    // (nothing said until the clock reaches a board), see i2c-registry-part2.
    expect(wiring.map((d) => d.owners[0]).sort()).toEqual(['no-scl', 'no-sda']);
    expect(wiring.find((d) => d.owners[0] === 'no-sda')!.message).toMatch(/SDA is not connected/);
    expect(wiring.find((d) => d.owners[0] === 'no-scl')!.message).toMatch(/SCL is not connected/);
  });

  it('SDA on one board and SCL on another: on no bus, and reported', () => {
    r.circuit.kinds.set('uno2', 'test-uno-i2c');
    const c = new Chip();
    r.target('split', [0x40], c, gpio(18), gpio(19, 'uno2'));
    expect(r.port.wire(0x40, [1]).status).toBe(2);
    expect(r.reg.i2cPlacement('split')).toBeNull();
    expect(r.diags.find((d) => d.code === 'i2c-wiring')?.message).toMatch(/one board's bus/);
  });

  it('SCL on another pin than the controller clocks: shares SDA but never answers, and is reported', () => {
    const c = new Chip();
    r.target('lost', [0x40], c, gpio(18), gpio(7));
    expect(r.port.wire(0x40, [1]).status).toBe(2);
    expect(c.log).toEqual([]);
    expect(r.reg.i2cPlacement('lost')).toMatchObject({ clocked: false });
    expect(r.diags.find((d) => d.code === 'i2c-wiring')?.message).toMatch(/clocked on pin 19/);
  });

  it('SDA and SCL crossed against the controller are reported as crossed', () => {
    r.target('x', [0x40], new Chip(), gpio(19), gpio(18));
    expect(r.port.wire(0x40, [1]).status).toBe(2);
    expect(r.diags.some((d) => d.code === 'i2c-wiring' && /crossed/.test(d.message))).toBe(true);
  });

  it('Wire and Wire1 on different pins are two buses: the same address on each answers its own', () => {
    const wire1 = new FakeI2cPort(1, 'I2C1', { sda: 2, scl: 3 });
    r.reg.bindEngine('uno', { pins: r.pins, spi: [], i2c: [r.port, wire1] });
    const a = new Chip([0x0a]);
    const b = new Chip([0x0b]);
    r.target('on-wire', [0x44], a);
    r.target('on-wire1', [0x44], b, gpio(2), gpio(3));
    expect(r.port.wire(0x44, [0], 1).read).toEqual([0x0a]);
    expect(wire1.wire(0x44, [0], 1).read).toEqual([0x0b]);
    expect(a.log.filter((x) => x === 'R')).toHaveLength(1);
    expect(b.log.filter((x) => x === 'R')).toHaveLength(1);
    expect(r.codes()).not.toContain('i2c-address-conflict');
  });

  it('two controllers routed to the same SDA pin are reported', () => {
    const dup = new FakeI2cPort(1, 'I2C1', { sda: 18, scl: 19 });
    r.reg.bindEngine('uno', { pins: r.pins, spi: [], i2c: [r.port, dup] });
    r.target('t', [0x44], new Chip());
    expect(r.diags.some((d) => d.code === 'i2c-wiring' && /both routed to SDA pin 18/.test(d.message))).toBe(true);
  });

  it('a controller the sketch moves to other pins feeds the bus on its new SDA net', () => {
    const moving = new FakeI2cPort(0, 'I2C0', { sda: 18, scl: 19 });
    r.reg.bindEngine('uno', { pins: r.pins, spi: [], i2c: [moving] });
    const c = new Chip([0x77]);
    r.target('t', [0x44], c, gpio(21), gpio(22));
    expect(moving.wire(0x44, [0], 1).status).toBe(2);
    moving.route = { sda: 21, scl: 22 }; // Wire.begin(21, 22)
    moving.routingChanged!();
    expect(moving.wire(0x44, [0], 1)).toEqual({ status: 0, read: [0x77] });
  });

  it('a target on another board goes to that board', () => {
    r.circuit.kinds.set('uno2', 'test-uno-i2c');
    const pins2 = new FakePins();
    const port2 = new FakeI2cPort(0, 'TWI');
    r.reg.bindEngine('uno2', { pins: pins2, spi: [], i2c: [port2] });
    const c = new Chip([0x2b]);
    r.target('t', [0x44], c, gpio(18, 'uno2'), gpio(19, 'uno2'));
    expect(r.port.wire(0x44, [0], 1).status).toBe(2);
    expect(port2.wire(0x44, [0], 1)).toEqual({ status: 0, read: [0x2b] });
  });

  it('rewiring SDA/SCL moves the target without re-attaching', () => {
    const c = new Chip([0x33]);
    r.target('t', [0x44], c);
    expect(r.port.wire(0x44, [0], 1).read).toEqual([0x33]);
    r.circuit.wire('t', 'SDA', gpio(2));
    r.circuit.wire('t', 'SCL', gpio(3));
    r.reg.netlistChanged();
    expect(r.port.wire(0x44, [0], 1).status).toBe(2);
    r.circuit.wire('t', 'SDA', gpio(18));
    r.circuit.wire('t', 'SCL', gpio(19));
    r.reg.netlistChanged();
    expect(r.port.wire(0x44, [0], 1).read).toEqual([0x33]);
  });
});

// ── Arbitration ─────────────────────────────────────────────────────────────

describe('I2C fabric: arbitration by address', () => {
  let r: ReturnType<typeof rig>;
  beforeEach(() => {
    r = rig();
  });

  it('an address nobody has is NACK; nothing is delivered and a read sees the pull-up', () => {
    const c = new Chip();
    r.target('t', [0x44], c);
    expect(r.port.wire(0x45, [1, 2])).toEqual({ status: 2, read: [] });
    expect(c.log).toEqual([]);
    // The handler itself, as an engine that ignores the NACK would call it.
    const h = r.port.handler!;
    expect(h.start(0x45, true)).toBe(false);
    expect(h.read()).toBe(0xff);
    expect(h.write(9)).toBe(false);
    h.stop();
    expect(c.log).toEqual([]);
  });

  it('two targets at one address: both ACK, both take writes, a read is the wired-AND, and it is reported', () => {
    const a = new Chip([0xf0]);
    const b = new Chip([0x3c]);
    r.target('b-sensor', [0x76], b);
    r.target('a-sensor', [0x76], a);
    expect(r.port.wire(0x76, [0x00]).status).toBe(0);
    expect(a.heard).toEqual([0x00]);
    expect(b.heard).toEqual([0x00]);
    expect(r.port.wire(0x76, [0x00], 1).read).toEqual([0x30]);
    const conflict = r.diags.filter((d) => d.code === 'i2c-address-conflict');
    expect(conflict).toHaveLength(1);
    expect(conflict[0].owners).toEqual(['a-sensor', 'b-sensor']);
    expect(conflict[0].message).toMatch(/0x76/);
  });

  it('two parts at one address are reported as soon as they share a bus, before any traffic', () => {
    r.target('a', [0x3c], new Chip());
    r.target('b', [0x3c], new Chip());
    expect(r.diags.filter((d) => d.code === 'i2c-address-conflict').map((d) => d.owners)).toEqual([['a', 'b']]);
  });

  it('after resetDiagnostics a live conflict is reported again on the next read', () => {
    r.target('a', [0x76], new Chip([0xf0]));
    r.target('b', [0x76], new Chip([0x3c]));
    r.reg.resetDiagnostics();
    r.diags.length = 0;
    r.port.wire(0x76, [0x00], 1);
    expect(r.codes()).toEqual(['i2c-address-conflict']);
  });

  it('a target that NACKs its own address (busy) is not addressed; the one that ACKs answers alone', () => {
    const busy = new Chip([0x00]);
    busy.ackAddress = false;
    const ok = new Chip([0x5a]);
    r.target('busy', [0x50], busy);
    r.target('ok', [0x50], ok);
    expect(r.port.wire(0x50, [0], 1).read).toEqual([0x5a]);
    expect(busy.heard).toEqual([]);
    expect(busy.reads).toBe(0);
  });

  it('a NACKed data byte reaches the controller', () => {
    const c = new Chip();
    c.nackByte = 0x99;
    r.target('t', [0x20], c);
    expect(r.port.wire(0x20, [1, 0x99, 3]).status).toBe(3);
    expect(c.heard).toEqual([1, 0x99]);
  });

  it('every target addressed since the last STOP sees that STOP, across a repeated START', () => {
    const a = new Chip();
    const b = new Chip();
    const idle = new Chip();
    r.target('a', [0x10], a);
    r.target('b', [0x11], b);
    r.target('idle', [0x12], idle);
    const h = r.port.handler!;
    expect(h.start(0x10, false)).toBe(true);
    h.write(0x01);
    expect(h.start(0x11, true)).toBe(true); // repeated START to another target
    h.read();
    h.stop();
    expect(a.log).toEqual(['Sw10', 'W1', 'P']);
    expect(b.log).toEqual(['Sr11', 'R', 'P']);
    expect(idle.log).toEqual([]);
  });
});

// ── Order independence ──────────────────────────────────────────────────────

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe('I2C fabric: attach order does not matter', () => {
  it('every permutation of 4 targets (a conflict pair and a two-address chip) gives the same traffic', () => {
    const specs = [
      { id: 'bme-a', addrs: [0x76], regs: [0xf1, 0x0f, 0x55] },
      { id: 'bme-b', addrs: [0x76], regs: [0x3c, 0xff, 0x5a] },
      { id: 'lcd', addrs: [0x3e, 0x62], regs: [0x80, 0x81] },
      { id: 'rtc', addrs: [0x68], regs: [0x12, 0x34, 0x56, 0x78] },
    ];
    const script: Array<[number, number[], number]> = [
      [0x76, [0x00], 3],
      [0x3e, [0x01, 0x02], 0],
      [0x62, [0x00], 2],
      [0x68, [0x02], 2],
      [0x77, [0x00], 1],
      [0x76, [0x02, 0x10], 0],
      [0x68, [], 3],
    ];
    let reference: string | null = null;
    let runs = 0;
    for (const order of permutations(specs)) {
      const r = rig();
      const chips = new Map<string, Chip>();
      const global: string[] = [];
      for (const s of order) {
        const c = new Chip(s.regs);
        c.global = global;
        c.name = s.id;
        chips.set(s.id, c);
        r.target(s.id, s.addrs, c);
      }
      const results = script.map(([a, w, n]) => r.port.wire(a, w, n));
      const fingerprint = JSON.stringify({
        results,
        logs: specs.map((s) => chips.get(s.id)!.log),
        // Across chips too: two targets sharing an address are called in the
        // same order whatever order they were attached in.
        global,
        diags: r.diags.map((d) => `${d.code}:${d.owners.join(',')}`),
      });
      reference ??= fingerprint;
      expect(fingerprint).toBe(reference);
      runs++;
    }
    expect(runs).toBe(24);
  });
});

// ── Removal by identity ─────────────────────────────────────────────────────

describe('I2C fabric: removal by identity', () => {
  it('a two-address chip answers at both, and leaves with both', () => {
    const r = rig();
    const lcd = new Chip();
    const h = r.target('lcd', [0x3e, 0x62], lcd);
    expect(r.port.wire(0x3e, [1]).status).toBe(0);
    expect(r.port.wire(0x62, [1]).status).toBe(0);
    h.dispose();
    expect(r.port.wire(0x3e, [1]).status).toBe(2);
    expect(r.port.wire(0x62, [1]).status).toBe(2);
    expect(r.reg.i2cPlacement('lcd')).toBeNull();
  });

  it('removing one of two parts at the SAME address leaves the other answering on its own', () => {
    const r = rig();
    const a = new Chip([0x11]);
    const b = new Chip([0x22]);
    const ha = r.target('sht-a', [0x44], a);
    r.target('sht-b', [0x44], b);
    expect(r.port.wire(0x44, [0], 1).read).toEqual([0x11 & 0x22]);
    ha.dispose();
    expect(r.port.wire(0x44, [0], 1).read).toEqual([0x22]);
  });

  it('removing one of two parts at different addresses leaves the other', () => {
    const r = rig();
    const ha = r.target('a', [0x40], new Chip([0x01]));
    r.target('b', [0x41], new Chip([0x02]));
    ha.dispose();
    expect(r.port.wire(0x40, [0], 1).status).toBe(2);
    expect(r.port.wire(0x41, [0], 1).read).toEqual([0x02]);
  });

  it('a stale handle never removes the owner registered after it', () => {
    const r = rig();
    const stale = r.target('t', [0x44], new Chip([0x01]));
    r.target('t', [0x44], new Chip([0x02]));
    stale.dispose();
    expect(r.port.wire(0x44, [0], 1).read).toEqual([0x02]);
    expect(r.codes()).not.toContain('i2c-address-conflict');
  });

  it('a target removed mid-transaction neither answers the rest nor sees the STOP', () => {
    const r = rig();
    const c = new Chip();
    // Another part keeps the bus alive, so the removed one is not simply
    // cut off by its bus going away.
    const other = new Chip();
    r.target('other', [0x45], other);
    const h = r.target('t', [0x44], c);
    const port = r.port.handler!;
    port.start(0x44, false);
    h.dispose();
    expect(port.write(1)).toBe(false);
    port.stop();
    expect(c.log).toEqual(['Sw44']);
    expect(r.port.wire(0x45, [7]).status).toBe(0);
  });

  it('registering an owner again replaces the old instance, wherever the old one was', () => {
    const r = rig();
    const old = new Chip([0x01]);
    r.target('t', [0x44], old);
    const fresh = new Chip([0x02]);
    r.target('t', [0x44], fresh, gpio(2), gpio(3)); // remounted after its wires moved
    expect(r.port.wire(0x44, [0], 1).status).toBe(2);
    expect(old.log).toEqual([]);
    expect(r.reg.i2cPlacement('t')).toMatchObject({ sdaPin: 2 });
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('I2C fabric: lifecycle', () => {
  it('re-binding the engine keeps every target and releases the old port', () => {
    const r = rig();
    const c = new Chip([0x61]);
    r.target('t', [0x44], c);
    const port2 = new FakeI2cPort(0, 'TWI');
    r.reg.bindEngine('uno', { pins: new FakePins(), spi: [], i2c: [port2] });
    expect(r.port.handler).toBeNull();
    expect(port2.wire(0x44, [0], 1).read).toEqual([0x61]);
  });

  it('an MCU reset tells targets and drops the open transaction', () => {
    const r = rig();
    const c = new Chip();
    r.target('t', [0x44], c);
    const h = r.port.handler!;
    h.start(0x44, false);
    r.mcuReset();
    expect(c.resets).toBe(1);
    h.stop(); // the new run's first STOP belongs to no transaction of before
    expect(c.stops).toBe(0);
    expect(r.port.wire(0x44, [1]).status).toBe(0);
  });

  it('an engine with no I2C ports still binds, and its I2C pins are software buses', () => {
    const r = rig();
    const c = new Chip();
    r.target('t', [0x44], c);
    r.reg.bindEngine('uno', { pins: r.pins, spi: [] });
    expect(r.reg.i2cPlacement('t')).toMatchObject({ sdaPin: 18, clocked: true });
  });

  it('a board that leaves the circuit takes its targets off', () => {
    const r = rig();
    r.target('t', [0x44], new Chip());
    r.circuit.kinds.delete('uno');
    r.reg.unbindBoard('uno');
    expect(r.reg.i2cPlacement('t')).toBeNull();
  });
});

// ── Software I2C ────────────────────────────────────────────────────────────

type DriveStyle = 'latch' | 'pad';

/**
 * A bit-banged I2C master on board pins, open-drain: it pulls a line low or
 * lets it go (latch: digitalWrite; pad: pinMode OUTPUT/INPUT with the latch
 * at 0), and reads the LINE, which a target can hold low.
 */
class SoftMaster {
  /** Runs during the ninth clock of an address byte, with SCL high. */
  onAddressAck: (() => void) | null = null;
  private readonly pins: FakePins;
  private readonly style: DriveStyle;
  readonly sda: number;
  readonly scl: number;
  constructor(pins: FakePins, style: DriveStyle, sda = 2, scl = 3) {
    this.pins = pins;
    this.style = style;
    this.sda = sda;
    this.scl = scl;
    this.set(sda, true);
    this.set(scl, true);
  }
  private set(pin: number, high: boolean): void {
    if (this.style === 'latch') this.pins.write(pin, high);
    else this.pins.pad(pin, high ? 'z' : 'low', 1);
  }
  private line(): boolean {
    const mine = this.style === 'latch' ? this.pins.levels.get(this.sda) !== false : this.pins.pads.get(this.sda)?.drive !== 'low';
    return mine && this.pins.driven.get(this.sda) !== false;
  }
  start(): void {
    this.set(this.sda, true);
    this.set(this.scl, true);
    this.set(this.sda, false);
    this.set(this.scl, false);
  }
  stop(): void {
    this.set(this.sda, false);
    this.set(this.scl, true);
    this.set(this.sda, true);
  }
  writeByte(b: number, address = false): boolean {
    for (let i = 7; i >= 0; i--) {
      this.set(this.sda, ((b >> i) & 1) === 1);
      this.set(this.scl, true);
      this.set(this.scl, false);
    }
    this.set(this.sda, true);
    this.set(this.scl, true);
    const ack = !this.line();
    if (address) this.onAddressAck?.();
    this.set(this.scl, false);
    return ack;
  }
  readByte(ack: boolean): number {
    this.set(this.sda, true);
    let v = 0;
    for (let i = 0; i < 8; i++) {
      this.set(this.scl, true);
      v = (v << 1) | (this.line() ? 1 : 0);
      this.set(this.scl, false);
    }
    this.set(this.sda, !ack);
    this.set(this.scl, true);
    this.set(this.scl, false);
    this.set(this.sda, true);
    return v;
  }
  /** The same Wire-shaped exchange FakeI2cPort.wire performs. */
  wire(address: number, write: number[], read = 0): WireResult {
    let status = 0;
    if (write.length > 0 || read === 0) {
      this.start();
      const ack = this.writeByte(address << 1, true);
      status = ack ? 0 : 2;
      if (ack) {
        for (const b of write) {
          if (!this.writeByte(b)) {
            status = 3;
            break;
          }
        }
      }
      if (status !== 0 || read === 0) {
        this.stop();
        return { status, read: [] };
      }
    }
    this.start(); // START, or a repeated START after the register write
    const ack = this.writeByte((address << 1) | 1, true);
    const out: number[] = [];
    if (ack) for (let i = 0; i < read; i++) out.push(this.readByte(i < read - 1));
    this.stop();
    return { status: ack ? status : 2, read: out };
  }
}

function softRig(style: DriveStyle, echo = false) {
  const r = rig();
  r.pins.echo = echo;
  const master = new SoftMaster(r.pins, style);
  return { ...r, master };
}

describe('I2C fabric: software (bit-banged) I2C reaches the same targets', () => {
  for (const style of ['latch', 'pad'] as const) {
    for (const echo of [false, true]) {
      const tag = `${style}${echo ? ', engine echoes the target' : ''}`;

      it(`${tag}: write, then register read through a repeated START`, () => {
        const r = softRig(style, echo);
        const c = new Chip([0xa5, 0x3c, 0x81, 0x7e]);
        r.target('t', [0x48], c, gpio(2), gpio(3));
        expect(r.master.wire(0x48, [0x02, 0x99])).toEqual({ status: 0, read: [] });
        expect(r.master.wire(0x48, [0x01], 3)).toEqual({ status: 0, read: [0x3c, 0x81, 0x7e] });
        expect(c.log).toEqual(['Sw48', 'W2', 'W99', 'P', 'Sw48', 'W1', 'Sr48', 'R', 'R', 'R', 'P']);
        // The master NACKed the third byte: a fourth is never taken from the chip.
        expect(c.reads).toBe(3);
      });

      it(`${tag}: an address nobody has is NACK and reaches nobody`, () => {
        const r = softRig(style, echo);
        const c = new Chip();
        r.target('t', [0x48], c, gpio(2), gpio(3));
        expect(r.master.wire(0x49, [1, 2])).toEqual({ status: 2, read: [] });
        expect(r.master.wire(0x49, [], 2)).toEqual({ status: 2, read: [] });
        expect(c.log).toEqual([]);
        expect(r.pins.driven.get(2), 'SDA released after the exchange').not.toBe(false);
      });
    }
  }

  it('a data NACK from the target reaches a software master', () => {
    const r = softRig('latch');
    const c = new Chip();
    c.nackByte = 0x42;
    r.target('t', [0x48], c, gpio(2), gpio(3));
    expect(r.master.wire(0x48, [1, 0x42, 3]).status).toBe(3);
    expect(c.heard).toEqual([1, 0x42]);
  });

  it('the byte read is asked of the chip at drive time, not at the START', () => {
    const r = softRig('latch');
    const c = new Chip([0x00]);
    r.target('t', [0x48], c, gpio(2), gpio(3));
    // The chip's register changes while the address ACK is on the wire,
    // after the address phase and before the first data bit must go out.
    r.master.onAddressAck = () => {
      c.regs = [0xc3];
    };
    expect(r.master.wire(0x48, [], 1).read).toEqual([0xc3]);
  });

  it('two targets at one address on a software bus read as the wired-AND, and are reported', () => {
    const r = softRig('pad');
    r.target('a', [0x50], new Chip([0xf0]), gpio(2), gpio(3));
    r.target('b', [0x50], new Chip([0x3c]), gpio(2), gpio(3));
    expect(r.master.wire(0x50, [0], 1).read).toEqual([0x30]);
    expect(r.codes()).toContain('i2c-address-conflict');
  });

  it('software and hardware give the same result for the same sequence', () => {
    const script: Array<[number, number[], number]> = [
      [0x48, [0x00, 0x11], 0],
      [0x48, [0x01], 2],
      [0x49, [0x00], 0],
      [0x48, [], 3],
    ];
    const hw = rig();
    const hc = new Chip([1, 2, 3, 4]);
    hw.target('t', [0x48], hc);
    const hwOut = script.map(([a, w, n]) => hw.port.wire(a, w, n));
    const sw = softRig('pad');
    const sc = new Chip([1, 2, 3, 4]);
    sw.target('t', [0x48], sc, gpio(2), gpio(3));
    const swOut = script.map(([a, w, n]) => sw.master.wire(a, w, n));
    expect(swOut).toEqual(hwOut);
    expect(sc.log).toEqual(hc.log);
  });

  it('a software bus with no controller is clocked where most of its targets put SCL', () => {
    const r = softRig('latch');
    const a = new Chip([0x0a]);
    const b = new Chip([0x0b]);
    const odd = new Chip([0x0c]);
    r.target('a', [0x10], a, gpio(2), gpio(3));
    r.target('odd', [0x12], odd, gpio(2), gpio(4));
    r.target('b', [0x11], b, gpio(2), gpio(3));
    expect(r.master.wire(0x10, [0], 1).read).toEqual([0x0a]);
    expect(r.master.wire(0x11, [0], 1).read).toEqual([0x0b]);
    expect(r.master.wire(0x12, [0], 1).status).toBe(2);
    expect(r.reg.i2cPlacement('odd')).toMatchObject({ clocked: false });
    expect(r.diags.some((d) => d.code === 'i2c-wiring' && d.owners[0] === 'odd')).toBe(true);
  });

  it('a tie between two SCL pins goes to the lower pin, in either attach order', () => {
    for (const order of [['a', 'b'], ['b', 'a']]) {
      const r = softRig('latch');
      const scl: Record<string, number> = { a: 4, b: 3 };
      for (const id of order) r.target(id, [id === 'a' ? 0x10 : 0x11], new Chip(), gpio(2), gpio(scl[id]));
      expect(r.reg.i2cPlacement('b'), order.join()).toMatchObject({ clocked: true });
      expect(r.reg.i2cPlacement('a'), order.join()).toMatchObject({ clocked: false });
    }
  });

  it('an MCU reset while the target holds SDA low lets the line go', () => {
    const r = softRig('latch');
    r.target('t', [0x48], new Chip(), gpio(2), gpio(3));
    // Clocked by hand so the MCU stops dead at the reset: a reset MCU makes
    // no further edge, so nothing but the reset itself can release the line.
    r.master.start();
    const addr = 0x48 << 1;
    for (let i = 7; i >= 0; i--) {
      r.pins.write(2, ((addr >> i) & 1) === 1);
      r.pins.write(3, true);
      r.pins.write(3, false);
    }
    r.pins.write(2, true);
    r.pins.write(3, true); // ninth clock high: the target is ACKing
    expect(r.pins.driven.get(2), 'the target was ACKing').toBe(false);
    r.mcuReset();
    expect(r.pins.driven.get(2), 'a reset MCU does not find its bus held low').toBe(true);
  });

  it('an MCU reset in the middle of a bit-banged byte starts clean', () => {
    const r = softRig('latch');
    const c = new Chip([0x5a]);
    r.target('t', [0x48], c, gpio(2), gpio(3));
    r.master.start();
    r.master.writeByte(0x48 << 1, true); // addressed, then the MCU resets
    r.mcuReset();
    const fresh = new SoftMaster(r.pins, 'latch');
    expect(fresh.wire(0x48, [0], 1)).toEqual({ status: 0, read: [0x5a] });
  });
});
