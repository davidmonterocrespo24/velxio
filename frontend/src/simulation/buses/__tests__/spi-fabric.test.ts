/**
 * Layer 1 of project board-buses-2026-09 (TESTS.md): the SPI fabric on its own,
 * with a fake circuit, fake board pins and fake controller ports that follow
 * the real contracts. No engine here; the engine adapters have their own
 * conformance suite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BusRegistry } from '../registry';
import type {
  BoardPins,
  BusDiagnostic,
  EngineBinding,
  NetResolver,
  PinRef,
  ResolvedPin,
  SpiControllerConfig,
  SpiControllerPort,
  SpiDevice,
  SpiRouting,
} from '../types';
import { registerBoardPinFunctions } from '../pinFunctions';

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakePins implements BoardPins {
  levels = new Map<number, boolean>();
  driven = new Map<number, boolean>();
  private listeners = new Map<number, Set<(p: number, l: boolean) => void>>();
  onPinChange(pin: number, cb: (p: number, l: boolean) => void): () => void {
    let s = this.listeners.get(pin);
    if (!s) this.listeners.set(pin, (s = new Set()));
    s.add(cb);
    return () => this.listeners.get(pin)?.delete(cb);
  }
  peekPinState(pin: number): boolean | undefined {
    return this.levels.get(pin);
  }
  driveInput(pin: number, level: boolean): void {
    this.driven.set(pin, level);
  }
  /** The MCU writes a pin. */
  write(pin: number, level: boolean): void {
    const prev = this.levels.get(pin);
    this.levels.set(pin, level);
    if (prev !== level) for (const cb of this.listeners.get(pin) ?? []) cb(pin, level);
  }
  reset(): void {
    this.levels.clear();
    this.pads.clear();
  }
  // Pad drive state, for engines that report it (AVR DDR/PORT, RP funcsel).
  pads = new Map<number, { drive: 'low' | 'high' | 'z'; pull: 0 | 1 | 2 }>();
  private padListeners = new Map<number, Set<() => void>>();
  peekPad(pin: number): { drive: 'low' | 'high' | 'z'; pull: 0 | 1 | 2 } | undefined {
    return this.pads.get(pin);
  }
  onPadChange(pin: number, cb: () => void): () => void {
    let s = this.padListeners.get(pin);
    if (!s) this.padListeners.set(pin, (s = new Set()));
    s.add(cb);
    return () => this.padListeners.get(pin)?.delete(cb);
  }
  /** The guest changes the pad drive state without moving the level latch. */
  pad(pin: number, drive: 'low' | 'high' | 'z', pull: 0 | 1 | 2 = 0): void {
    this.pads.set(pin, { drive, pull });
    for (const cb of this.padListeners.get(pin) ?? []) cb();
  }
}

class FakePort implements SpiControllerPort {
  readonly bus = 'spi' as const;
  handler: ((mosi: number, bits: number) => number) | null = null;
  block: ((mosi: Uint8Array, miso: Uint8Array | null) => void) | null = null;
  hwCs: ((i: number, a: boolean) => void) | null = null;
  cfg: SpiControllerConfig = { enabled: true, mode: 0, bitOrder: 'msb', bits: 8 };
  route: SpiRouting | 'static';
  readonly unit: number;
  readonly name: string;
  constructor(unit: number, name: string, route: SpiRouting | 'static') {
    this.unit = unit;
    this.name = name;
    this.route = route;
  }
  setFrameHandler(h: ((mosi: number, bits: number) => number) | null): void {
    this.handler = h;
  }
  setBlockHandler(h: ((mosi: Uint8Array, miso: Uint8Array | null) => void) | null): void {
    this.block = h;
  }
  setHardwareCsHandler(h: ((i: number, a: boolean) => void) | null): void {
    this.hwCs = h;
  }
  config(): SpiControllerConfig {
    return this.cfg;
  }
  routing(): SpiRouting | 'static' {
    return this.route;
  }
  /** The engine clocks one frame. */
  xfer(mosi: number, bits = 8): number {
    if (!this.handler) throw new Error('no frame handler bound');
    return this.handler(mosi, bits);
  }
}

/** A circuit: component pin -> where it lands. */
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

/** A device that records what it hears and answers from a queue. */
class Recorder implements SpiDevice {
  heard: number[] = [];
  selects = 0;
  deselects = 0;
  resets = 0;
  answer: (mosi: number) => number | null;
  next: () => number | null;
  constructor(
    answer: (mosi: number) => number | null = () => 0x5a,
    next: () => number | null = () => 0x5a,
  ) {
    this.answer = answer;
    this.next = next;
  }
  select(): void {
    this.selects++;
  }
  deselect(): void {
    this.deselects++;
  }
  transfer(mosi: number): number | null {
    this.heard.push(mosi);
    return this.answer(mosi);
  }
  peekMiso(): number | null {
    return this.next();
  }
  boardReset(): void {
    this.resets++;
  }
}

// Uno-like board: SPI0 SCK 13, MOSI 11, MISO 12, SS 10.
registerBoardPinFunctions(['test-uno'], {
  routing: 'fixed',
  source: 'test',
  controllers: [
    { bus: 'spi', unit: 0, name: 'SPI', arduino: ['SPI'], defaultPins: { sck: 13, mosi: 11, miso: 12, cs: 10 } },
  ],
  pins: {
    13: [{ bus: 'spi', unit: 0, signal: 'sck' }],
    11: [{ bus: 'spi', unit: 0, signal: 'mosi' }],
    12: [{ bus: 'spi', unit: 0, signal: 'miso' }],
    10: [{ bus: 'spi', unit: 0, signal: 'cs', csIndex: 0 }],
  },
});

function rig() {
  const reg = new BusRegistry();
  const circuit = new FakeCircuit();
  circuit.kinds.set('uno', 'test-uno');
  const pins = new FakePins();
  const port = new FakePort(0, 'SPI', 'static');
  let resetHandler: (() => void) | null = null;
  const binding: EngineBinding = {
    pins,
    spi: [port],
    setResetHandler: (h) => {
      resetHandler = h;
    },
  };
  const diags: BusDiagnostic[] = [];
  reg.onDiagnostic((d) => diags.push(d));
  reg.setResolver(circuit);
  reg.bindEngine('uno', binding);
  const spiDevice = (id: string, cs: ResolvedPin | null, dev: SpiDevice, extra: object = {}) => {
    circuit.wire(id, 'SCK', gpio(13));
    circuit.wire(id, 'MOSI', gpio(11));
    circuit.wire(id, 'MISO', gpio(12));
    if (cs) circuit.wire(id, 'CS', cs);
    return reg.attachSpi(
      { owner: id, pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', ...(cs ? { cs: 'CS' } : {}) }, ...extra },
      dev,
    );
  };
  return {
    reg,
    circuit,
    pins,
    port,
    diags,
    spiDevice,
    mcuReset: () => {
      pins.reset();
      resetHandler?.();
    },
  };
}

// ── Arbitration ─────────────────────────────────────────────────────────────

describe('SPI fabric: arbitration by chip select', () => {
  let r: ReturnType<typeof rig>;
  beforeEach(() => {
    r = rig();
  });

  it('a device only hears frames while its CS is low', () => {
    const d = new Recorder();
    r.spiDevice('sd', gpio(10), d);
    expect(r.port.xfer(0x11)).toBe(0xff); // CS never driven: floating, not selected
    r.pins.write(10, true);
    expect(r.port.xfer(0x22)).toBe(0xff);
    r.pins.write(10, false);
    expect(r.port.xfer(0x33)).toBe(0x5a);
    r.pins.write(10, true);
    expect(r.port.xfer(0x44)).toBe(0xff);
    expect(d.heard).toEqual([0x33]);
    expect(d.selects).toBe(1);
    expect(d.deselects).toBe(1);
  });

  it('two devices on separate CS lines each get only their own bytes', () => {
    const a = new Recorder(() => 0xa0);
    const b = new Recorder(() => 0xb0);
    r.spiDevice('a', gpio(10), a);
    r.spiDevice('b', gpio(9), b);
    r.pins.write(10, true);
    r.pins.write(9, true);
    r.pins.write(10, false);
    expect(r.port.xfer(1)).toBe(0xa0);
    r.pins.write(10, true);
    r.pins.write(9, false);
    expect(r.port.xfer(2)).toBe(0xb0);
    expect(a.heard).toEqual([1]);
    expect(b.heard).toEqual([2]);
  });

  it('a write-only sink leaves MISO at the idle level', () => {
    const sink = new Recorder(() => null);
    r.spiDevice('tft', gpio(10), sink);
    r.pins.write(10, false);
    expect(r.port.xfer(0x2c)).toBe(0xff);
    expect(sink.heard).toEqual([0x2c]);
  });

  it('two selected drivers is contention: wired-AND plus a diagnostic', () => {
    r.spiDevice('a', gpio(10), new Recorder(() => 0xf0));
    r.spiDevice('b', gpio(9), new Recorder(() => 0x3c));
    r.pins.write(10, false);
    r.pins.write(9, false);
    expect(r.port.xfer(0)).toBe(0x30);
    const codes = r.diags.map((d) => d.code);
    expect(codes).toContain('spi-multiple-selected');
    expect(codes).toContain('spi-contention');
  });

  it('a selected sink next to a selected driver is not contention on MISO', () => {
    r.spiDevice('tft', gpio(10), new Recorder(() => null));
    r.spiDevice('sd', gpio(9), new Recorder(() => 0x01));
    r.pins.write(10, false);
    r.pins.write(9, false);
    expect(r.port.xfer(0)).toBe(0x01);
    expect(r.diags.map((d) => d.code)).not.toContain('spi-contention');
    expect(r.diags.map((d) => d.code)).toContain('spi-multiple-selected');
  });

  it('CS tied to GND is always selected, to VCC never', () => {
    const g = new Recorder(() => 0x77);
    r.spiDevice('adc', { kind: 'rail', rail: 'gnd' }, g);
    expect(r.port.xfer(0x01)).toBe(0x77);
    r.reg.clear();
    const r2 = rig();
    const v = new Recorder(() => 0x77);
    r2.spiDevice('adc', { kind: 'rail', rail: 'vcc' }, v);
    expect(r2.port.xfer(0x01)).toBe(0xff);
    expect(v.heard).toEqual([]);
  });

  it('an unconnected CS is deselected and reported, unless the chip declares a pull', () => {
    const d = new Recorder();
    r.spiDevice('mcp', { kind: 'floating' }, d);
    expect(r.port.xfer(1)).toBe(0xff);
    expect(r.diags.map((x) => x.code)).toContain('spi-cs-floating');
    const p = new Recorder(() => 0x42);
    r.spiDevice('pulled', { kind: 'floating' }, p, { csWhenFloating: 'selected' });
    expect(r.port.xfer(2)).toBe(0x42);
  });

  it('a device without a select line is always selected', () => {
    const d = new Recorder(() => 0x99);
    r.spiDevice('595', null, d);
    expect(r.port.xfer(0x80)).toBe(0x99);
  });

  it('a chip select driven low by its direction register alone selects the chip', () => {
    // pinMode(CS, OUTPUT) with the latch already 0: the level channel never
    // moves, but the pad is driven low, and on a real board the chip listens.
    const d = new Recorder(() => 0x3e);
    r.spiDevice('sd', gpio(10), d);
    expect(r.port.xfer(1)).toBe(0xff);
    r.pins.pad(10, 'low');
    expect(r.port.xfer(2)).toBe(0x3e);
    r.pins.pad(10, 'z', 1); // released with the pull-up: deselected
    expect(r.port.xfer(3)).toBe(0xff);
    r.pins.pad(10, 'z', 0); // released and floating, no level ever latched
    expect(r.port.xfer(4)).toBe(0xff);
    expect(d.heard).toEqual([2]);
  });

  it('active-high chip selects', () => {
    const d = new Recorder(() => 0x10);
    r.spiDevice('hi', gpio(10), d, { csActive: 'high' });
    r.pins.write(10, false);
    expect(r.port.xfer(1)).toBe(0xff);
    r.pins.write(10, true);
    expect(r.port.xfer(2)).toBe(0x10);
  });
});

// ── Order independence ──────────────────────────────────────────────────────

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe('SPI fabric: attach order does not matter', () => {
  it('every permutation of 4 devices gives the same MISO stream and the same bytes heard', () => {
    const specs = [
      { id: 'tft', cs: 10, answer: () => null },
      { id: 'sd', cs: 9, answer: (m: number) => (m ^ 0xff) & 0xff },
      { id: 'touch', cs: 8, answer: (m: number) => (m + 1) & 0xff },
      { id: 'adc', cs: 7, answer: () => 0x12 },
    ];
    const script: Array<[number, number]> = [];
    for (let k = 0; k < 40; k++) script.push([specs[k % 4].cs, (k * 37) & 0xff]);
    let reference: string | null = null;
    for (const order of permutations(specs)) {
      const r = rig();
      const recs = new Map<string, Recorder>();
      for (const s of order) {
        const rec = new Recorder(s.answer);
        recs.set(s.id, rec);
        r.spiDevice(s.id, gpio(s.cs), rec);
      }
      for (const s of specs) r.pins.write(s.cs, true);
      const miso: number[] = [];
      for (const [cs, mosi] of script) {
        r.pins.write(cs, false);
        miso.push(r.port.xfer(mosi));
        r.pins.write(cs, true);
      }
      const fingerprint = JSON.stringify({ miso, heard: specs.map((s) => recs.get(s.id)!.heard) });
      if (reference === null) reference = fingerprint;
      expect(fingerprint).toBe(reference);
    }
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('SPI fabric: lifecycle', () => {
  it('re-binding the engine keeps every device and re-watches chip select on the new pins', () => {
    const r = rig();
    const d = new Recorder(() => 0x61);
    r.spiDevice('sd', gpio(10), d);
    const pins2 = new FakePins();
    const port2 = new FakePort(0, 'SPI', 'static');
    r.reg.bindEngine('uno', { pins: pins2, spi: [port2] });
    expect(r.port.handler).toBeNull(); // old port released
    pins2.write(10, false);
    expect(port2.xfer(0x05)).toBe(0x61);
    r.pins.write(10, true); // the old pins no longer move anything
    expect(port2.xfer(0x06)).toBe(0x61);
    expect(d.heard).toEqual([0x05, 0x06]);
  });

  it('an MCU reset deselects (the pins float) and tells devices, keeping them registered', () => {
    const r = rig();
    const d = new Recorder(() => 0x61);
    r.spiDevice('sd', gpio(10), d);
    r.pins.write(10, false);
    expect(r.port.xfer(1)).toBe(0x61);
    r.mcuReset();
    expect(d.resets).toBe(1);
    expect(r.port.xfer(2)).toBe(0xff);
    r.pins.write(10, false); // setup() drives CS low again: a real edge from floating
    expect(r.port.xfer(3)).toBe(0x61);
    expect(d.heard).toEqual([1, 3]);
  });

  it('rewiring SCK moves the device to the other bus without re-attaching', () => {
    const r = rig();
    const d = new Recorder(() => 0x33);
    r.spiDevice('sd', { kind: 'rail', rail: 'gnd' }, d);
    expect(r.port.xfer(1)).toBe(0x33);
    r.circuit.wire('sd', 'SCK', gpio(5)); // moved to a pin no controller drives
    r.reg.netlistChanged();
    expect(r.port.xfer(2)).toBe(0xff);
    expect(r.reg.placement('sd')).toMatchObject({ sckPin: 5 });
    r.circuit.wire('sd', 'SCK', gpio(13));
    r.reg.netlistChanged();
    expect(r.port.xfer(3)).toBe(0x33);
    expect(d.heard).toEqual([1, 3]);
  });

  it('registering an owner again replaces the old instance', () => {
    const r = rig();
    const old = new Recorder(() => 1);
    const fresh = new Recorder(() => 2);
    r.spiDevice('sd', { kind: 'rail', rail: 'gnd' }, old);
    r.spiDevice('sd', { kind: 'rail', rail: 'gnd' }, fresh);
    expect(r.port.xfer(0)).toBe(2);
    expect(old.heard).toEqual([]);
  });

  it('dispose takes exactly that device off, by identity', () => {
    const r = rig();
    const a = r.spiDevice('a', { kind: 'rail', rail: 'gnd' }, new Recorder(() => 0x0a));
    const staleHandle = a;
    const fresh = new Recorder(() => 0x0b);
    r.spiDevice('a', { kind: 'rail', rail: 'gnd' }, fresh);
    staleHandle.dispose(); // the old handle must not remove the new instance
    expect(r.port.xfer(0)).toBe(0x0b);
  });

  it('a board that leaves the circuit takes its devices off', () => {
    const r = rig();
    const d = new Recorder(() => 0x33);
    r.spiDevice('sd', { kind: 'rail', rail: 'gnd' }, d);
    r.circuit.kinds.delete('uno');
    r.reg.unbindBoard('uno');
    expect(r.reg.placement('sd')).toBeNull();
  });
});

// ── Controller behaviour ────────────────────────────────────────────────────

describe('SPI fabric: controllers', () => {
  it('follows live routing: a controller moved to other pins feeds the bus on its new SCK net', () => {
    const r = rig();
    const moved = new FakePort(1, 'HSPI', { sck: 14, mosi: 15, miso: 16 });
    r.reg.bindEngine('uno', { pins: r.pins, spi: [moved] });
    const d = new Recorder(() => 0x44);
    r.circuit.wire('dev', 'SCK', gpio(14));
    r.circuit.wire('dev', 'MOSI', gpio(15));
    r.circuit.wire('dev', 'MISO', gpio(16));
    r.circuit.wire('dev', 'CS', { kind: 'rail', rail: 'gnd' });
    r.reg.attachSpi({ owner: 'dev', pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } }, d);
    expect(moved.xfer(9)).toBe(0x44);
  });

  it('hardware chip-select events select the device on the routed CS pin', () => {
    const r = rig();
    const hw = new FakePort(0, 'SPI', { sck: 13, mosi: 11, miso: 12, cs: [10] });
    r.reg.bindEngine('uno', { pins: r.pins, spi: [hw] });
    const d = new Recorder(() => 0x21);
    r.spiDevice('sd', gpio(10), d);
    expect(hw.xfer(1)).toBe(0xff);
    hw.hwCs!(0, true);
    expect(hw.xfer(2)).toBe(0x21);
    hw.hwCs!(0, false);
    expect(hw.xfer(3)).toBe(0xff);
    expect(d.heard).toEqual([2]);
  });

  it('a pin that stops carrying a hardware chip select is a plain GPIO again', () => {
    const r = rig();
    const hw = new FakePort(0, 'SPI', { sck: 13, mosi: 11, miso: 12, cs: [10] });
    let routingChanged: (() => void) | null = null;
    (hw as SpiControllerPort).setRoutingChangeHandler = (h) => {
      routingChanged = h;
    };
    r.reg.bindEngine('uno', { pins: r.pins, spi: [hw] });
    const d = new Recorder(() => 0x21);
    r.spiDevice('sd', gpio(10), d);
    hw.hwCs!(0, true);
    expect(hw.xfer(1)).toBe(0x21);
    // SPI.end(); SPI.begin() without hardware CS: pin 10 is a GPIO now.
    hw.route = { sck: 13, mosi: 11, miso: 12, cs: [] };
    routingChanged!();
    r.pins.write(10, true);
    expect(hw.xfer(2)).toBe(0xff);
    r.pins.write(10, false);
    expect(hw.xfer(3)).toBe(0x21);
    expect(d.heard).toEqual([1, 3]);
  });

  it('LSB-first controller and MSB-first chip: the chip sees reversed bits, and it is reported', () => {
    const r = rig();
    r.port.cfg = { enabled: true, mode: 0, bitOrder: 'lsb', bits: 8 };
    const d = new Recorder(() => 0x01);
    r.spiDevice('sd', { kind: 'rail', rail: 'gnd' }, d);
    expect(r.port.xfer(0x01)).toBe(0x80);
    expect(d.heard).toEqual([0x80]);
    expect(r.diags.map((x) => x.code)).toContain('spi-bit-order');
  });

  it('reports a mode the chip does not accept', () => {
    const r = rig();
    r.port.cfg = { enabled: true, mode: 3, bitOrder: 'msb', bits: 8 };
    r.spiDevice('sd', { kind: 'rail', rail: 'gnd' }, new Recorder(), { modes: [0] });
    r.port.xfer(0);
    expect(r.diags.map((x) => x.code)).toContain('spi-mode');
  });

  it('a block transfer gives exactly the per-byte result', () => {
    const r = rig();
    const sink = new Recorder(() => null);
    let blocks = 0;
    (sink as SpiDevice).transferBlock = (b: Uint8Array) => {
      blocks++;
      for (const x of b) sink.heard.push(x);
    };
    r.spiDevice('tft', { kind: 'rail', rail: 'gnd' }, sink);
    r.port.block!(new Uint8Array([1, 2, 3]), null);
    expect(blocks).toBe(1);
    const resp = new Recorder((m) => m + 1);
    const r2 = rig();
    r2.spiDevice('sd', { kind: 'rail', rail: 'gnd' }, resp);
    const miso = new Uint8Array(3);
    r2.port.block!(new Uint8Array([1, 2, 3]), miso);
    expect(Array.from(miso)).toEqual([2, 3, 4]);
    expect(sink.heard).toEqual([1, 2, 3]);
  });

  it('reports MOSI and MISO wired the wrong way round', () => {
    const r = rig();
    r.circuit.wire('sd', 'SCK', gpio(13));
    r.circuit.wire('sd', 'MOSI', gpio(12));
    r.circuit.wire('sd', 'MISO', gpio(11));
    r.circuit.wire('sd', 'CS', gpio(10));
    r.reg.attachSpi({ owner: 'sd', pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } }, new Recorder());
    const wiring = r.diags.filter((d) => d.code === 'spi-wiring');
    expect(wiring.some((d) => /crossed/.test(d.message))).toBe(true);
  });

  it('a device on another board goes to that board, not to the one whose engine answered first', () => {
    const r = rig();
    r.circuit.kinds.set('uno2', 'test-uno');
    const pins2 = new FakePins();
    const port2 = new FakePort(0, 'SPI', 'static');
    r.reg.bindEngine('uno2', { pins: pins2, spi: [port2] });
    const d = new Recorder(() => 0x2b);
    r.circuit.wire('sd', 'SCK', gpio(13, 'uno2'));
    r.circuit.wire('sd', 'MOSI', gpio(11, 'uno2'));
    r.circuit.wire('sd', 'MISO', gpio(12, 'uno2'));
    r.circuit.wire('sd', 'CS', { kind: 'rail', rail: 'gnd' });
    r.reg.attachSpi({ owner: 'sd', pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } }, d);
    expect(r.port.xfer(1)).toBe(0xff);
    expect(port2.xfer(2)).toBe(0x2b);
    expect(d.heard).toEqual([2]);
  });
});

// ── Software SPI ────────────────────────────────────────────────────────────

/** A bit-banged master writing the board pins, like shiftOut/shiftIn. */
function bitBang(pins: FakePins, mode: 0 | 1 | 2 | 3, msbFirst: boolean, byte: number): number {
  const cpol = (mode & 2) !== 0;
  const cpha = (mode & 1) !== 0;
  let read = 0;
  for (let i = 0; i < 8; i++) {
    const bitIdx = msbFirst ? 7 - i : i;
    const out = ((byte >> bitIdx) & 1) === 1;
    if (!cpha) {
      pins.write(11, out); // data valid before the leading edge
      pins.write(13, !cpol); // leading edge: sample
      const inBit = pins.driven.get(12) === true ? 1 : 0;
      read |= inBit << bitIdx;
      pins.write(13, cpol); // trailing edge: the slave shifts
    } else {
      pins.write(13, !cpol); // leading edge: the slave shifts
      pins.write(11, out);
      pins.write(13, cpol); // trailing edge: sample
      const inBit = pins.driven.get(12) === true ? 1 : 0;
      read |= inBit << bitIdx;
    }
  }
  return read;
}

describe('SPI fabric: software (bit-banged) SPI reaches the same devices', () => {
  for (const mode of [0, 1, 2, 3] as const) {
    for (const msb of [true, false]) {
      it(`mode ${mode}, ${msb ? 'MSB' : 'LSB'} first: bytes in and answers out`, () => {
        const r = rig();
        // No hardware controller on this bus: software only.
        r.reg.bindEngine('uno', { pins: r.pins, spi: [] });
        const answers = [0xa5, 0x3c, 0x81];
        let k = 0;
        const d = new Recorder(
          () => answers[Math.min(k++, answers.length - 1)],
          () => answers[Math.min(k, answers.length - 1)],
        );
        r.pins.write(13, (mode & 2) !== 0); // SCK idles at CPOL
        r.pins.write(10, true);
        r.spiDevice('dev', gpio(10), d, { modes: [mode], bitOrder: msb ? 'msb' : 'lsb' });
        r.pins.write(10, false);
        const got = [0x12, 0x34, 0x56].map((b) => bitBang(r.pins, mode, msb, b));
        r.pins.write(10, true);
        expect(d.heard).toEqual([0x12, 0x34, 0x56]);
        expect(got).toEqual(answers);
      });
    }
  }
});
