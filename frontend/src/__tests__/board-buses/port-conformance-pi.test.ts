// @vitest-environment jsdom
/**
 * Board buses F2: the Raspberry Pi's SPI controller ports
 * (project/board-buses-2026-09, F2-SPEC.md "Pi shim").
 *
 * A Pi runs its script in a Linux guest (QEMU, through the backend relay) or
 * in the tab (Pyodide). Either way every SPI operation reaches the board as
 * one request line, `SPI <bus> <cs> X|XC|W|WC <hex>` or `CONFIG`, answered by
 * the board's PiBridgeShim: that line IS the guest's controller access, the
 * way a register write is on an MCU engine. So the rig drives the real shim
 * the store builds for the board with exactly the lines velxio-busd and the
 * tab's spidev/fcntl shims send (a long transaction split into XC chunks and a
 * final X, as SPI_IOC_MESSAGE with several transfers arrives), and the
 * lifecycle steps go through the store's own paths: Stop/Run is stopBoard +
 * startBoard, a guest reboot is the relay announcing a fresh guest, and Reset
 * is resetBoard. No guest boot is needed: nothing between the guest and the
 * line is under test here.
 *
 * The second half pins what the shared suite cannot see: two controllers with
 * the CE lines as their own hardware chip selects, SPI1 routed only while the
 * guest uses it, the routes against the pin function tables, the whole
 * transaction as one block on the real fabric, the reset order, and the
 * relay's `spi.attached` gate seeing fabric devices.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../../simulation/RaspberryPi3Bridge', () => ({
  RaspberryPi3Bridge: class {
    boardId: string;
    boardKind: string;
    connected = false;
    onSerialData: unknown = null;
    onPinChange: unknown = null;
    onPinPull: unknown = null;
    onBusRequest: unknown = null;
    onBusRelay: ((v: number) => void) | null = null;
    onGpioPwm: unknown = null;
    onBooted: unknown = null;
    onDisconnected: (() => void) | null = null;
    onError: unknown = null;
    quietBootDefault = false;
    quietBootLabel = '';
    topologies: unknown[] = [];
    constructor(id: string, kind: string) {
      this.boardId = id;
      this.boardKind = kind;
    }
    connect() {}
    disconnect() {}
    sendPinEvent() {}
    sendBusTopology(t: unknown) {
      this.topologies.push(t);
    }
  },
}));

import {
  useSimulatorStore,
  getBoardSimulator,
  getBoardBridge,
  getBoardPinManager,
} from '../../store/useSimulatorStore';
import { PiBridgeShim } from '../../simulation/PiBridgeShim';
import { PinManager } from '../../simulation/PinManager';
import { BusRegistry, busRegistry } from '../../simulation/buses/registry';
import {
  createStoreNetResolver,
  functionsOfPin,
  getBoardPinFunctions,
  registerBoardPinFunctions,
} from '../../simulation/buses';
import {
  defineSpiPortConformance,
  type GuestTransaction,
  type SpiConformanceRig,
} from '../../simulation/buses/conformance/spiPortConformance';
import type {
  NetResolver,
  PinRef,
  ResolvedPin,
  SpiControllerPort,
  SpiDevice,
  SpiRouting,
} from '../../simulation/buses/types';

beforeAll(() => {
  // startBoard logs which engine took each run.
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

// ── Lines ───────────────────────────────────────────────────────────────────

const hex = (bytes: readonly number[]): string =>
  bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');

/** The MISO bytes of `SPI_DATA <bus> <cs> <hex>`, checking it answers that bus and select. */
function spiData(reply: string | null, bus: number, cs: number): number[] {
  const t = (reply ?? '').trim().split(/\s+/);
  expect(t.slice(0, 3), `reply to SPI ${bus} ${cs}: ${reply}`).toEqual(['SPI_DATA', String(bus), String(cs)]);
  const h = t[3] ?? '';
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

/** The Pi's CE pins per controller, as a guest's `cs` index names them. */
const CE: Record<number, number[]> = { 0: [8, 7], 1: [18, 17, 16] };
const HEADER: Record<number, { sck: number; mosi: number; miso: number }> = {
  0: { sck: 11, mosi: 10, miso: 9 },
  1: { sck: 21, mosi: 20, miso: 19 },
};

/** Transfers per SPI_IOC_MESSAGE chunk: a longer transaction arrives as XC lines and a last X. */
const CHUNK = 16;

function guestTransaction(shim: PiBridgeShim, t: GuestTransaction): number[] {
  const cs = CE[t.unit]?.indexOf(t.csPin) ?? -1;
  if (cs < 0) throw new Error(`GPIO${t.csPin} is not a chip select of SPI${t.unit}`);
  const got: number[] = [];
  for (let i = 0; i < t.bytes.length; i += CHUNK) {
    const last = i + CHUNK >= t.bytes.length;
    const reply = shim.answerBusLine(`SPI ${t.unit} ${cs} ${last ? 'X' : 'XC'} ${hex(t.bytes.slice(i, i + CHUNK))}`);
    got.push(...spiData(reply, t.unit, cs));
  }
  return got;
}

// ── The shared suite, through the store ─────────────────────────────────────

interface MockBridge {
  onBusRelay: ((v: number) => void) | null;
  topologies: unknown[];
}

async function storePiRig(kind: string): Promise<SpiConformanceRig> {
  const id = useSimulatorStore.getState().addBoard(kind as never, 100, 100);
  const shim = getBoardSimulator(id) as PiBridgeShim;
  const bridge = getBoardBridge(id) as unknown as MockBridge;
  const pm = getBoardPinManager(id)!;
  // The probe stands where the fabric would: the store bound the board to the
  // page's fabric, which would otherwise answer the ports alongside it.
  busRegistry.unbindBoard(id);
  return {
    units: [0, 1],
    csPinFor: (unit) => CE[unit][0],
    binding: () => shim.getBusBinding(),
    run: async (transactions) => transactions.map((t) => guestTransaction(shim, t)),
    // A guest reboot under a running board: the backend announces the new
    // guest and the store restarts the bus sync.
    reset: async () => {
      bridge.onBusRelay?.(1);
    },
    stopRun: async () => {
      useSimulatorStore.getState().stopBoard(id);
      useSimulatorStore.getState().startBoard(id);
      bridge.onBusRelay?.(1);
    },
    // The script again: the toolbar's Reset, which on a Pi restarts the
    // program and never the controller.
    reload: async () => {
      useSimulatorStore.getState().resetBoard(id);
    },
    expectedRouting: (unit) => HEADER[unit],
    onPinEdge: (pin, cb) => pm.onPinChange(pin, () => cb()),
    dispose: () => useSimulatorStore.getState().removeBoard(id),
  };
}

defineSpiPortConformance('Raspberry Pi 4 (PiBridgeShim, relay lines)', () => storePiRig('raspberry-pi-4'), {
  hasBlockPath: true,
});
defineSpiPortConformance('Raspberry Pi 5 (PiBridgeShim, relay lines)', () => storePiRig('raspberry-pi-5'), {
  hasBlockPath: true,
});

// ── Fakes for the Pi-specific cases ─────────────────────────────────────────

function newShim(kind = 'raspberry-pi-4', boardId = 'pi'): { shim: PiBridgeShim; pm: PinManager } {
  const pm = new PinManager();
  const shim = new PiBridgeShim({
    boardId,
    boardKind: kind,
    bridge: {} as never,
    pinManager: pm,
    boardState: () => undefined,
  });
  return { shim, pm };
}

/** A Pi port: it implements every optional member of the contract. */
type PiPort = SpiControllerPort &
  Required<Pick<SpiControllerPort, 'setBlockHandler' | 'setHardwareCsHandler' | 'setRoutingChangeHandler'>>;

function port(shim: PiBridgeShim, unit: number): PiPort {
  const p = shim.getBusBinding().spi.find((x) => x.unit === unit);
  if (!p?.setBlockHandler || !p.setHardwareCsHandler || !p.setRoutingChangeHandler) {
    throw new Error(`no complete SPI${unit} port`);
  }
  return p as PiPort;
}

/** The circuit: component pin -> where it lands on the board. */
class Circuit implements NetResolver {
  private readonly nets = new Map<string, ResolvedPin>();
  private readonly boardId: string;
  private readonly kind: string;
  constructor(boardId: string, kind: string) {
    this.boardId = boardId;
    this.kind = kind;
  }
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }
  boardKind(id: string): string | undefined {
    return id === this.boardId ? this.kind : undefined;
  }
  boards(): string[] {
    return [this.boardId];
  }
  /** Wire a chip's SCK/MOSI/MISO/CS to these board pins. */
  wireSpi(owner: string, pins: { sck: number; mosi: number; miso: number; cs: number }): void {
    for (const [name, pin] of Object.entries({ SCK: pins.sck, MOSI: pins.mosi, MISO: pins.miso, CS: pins.cs })) {
      this.nets.set(`${owner}:${name}`, { kind: 'board', boardId: this.boardId, pin });
    }
  }
}

/** A chip that records what it hears and answers a function of it. */
class Chip implements SpiDevice {
  heard: number[] = [];
  selects = 0;
  deselects = 0;
  resets = 0;
  blocks: number[][] = [];
  /** CE0 level (GPIO8) each time boardReset ran. */
  ce0AtReset: Array<boolean | undefined> = [];
  private readonly answer: ((mosi: number) => number | null) | null;
  private readonly pm: PinManager | null;
  constructor(answer: ((mosi: number) => number | null) | null, opts: { block?: boolean; pm?: PinManager } = {}) {
    this.answer = answer;
    this.pm = opts.pm ?? null;
    if (opts.block) {
      this.transferBlock = (mosi: Uint8Array) => {
        this.blocks.push(Array.from(mosi));
        this.heard.push(...mosi);
      };
    }
  }
  transferBlock?: (mosi: Uint8Array) => void;
  select(): void {
    this.selects++;
  }
  deselect(): void {
    this.deselects++;
  }
  transfer(mosi: number): number | null {
    this.heard.push(mosi);
    return this.answer ? this.answer(mosi) : null;
  }
  boardReset(): void {
    this.resets++;
    this.ce0AtReset.push(this.pm?.peekPinState(8));
  }
}

const SPI0_CE0 = { ...HEADER[0], cs: 8 };
const SPI0_CE1 = { ...HEADER[0], cs: 7 };
const SPI1_CE0 = { ...HEADER[1], cs: 18 };

/** A shim bound to a fabric of its own, with the circuit it resolves. */
function onFabric(kind = 'raspberry-pi-4') {
  const { shim, pm } = newShim(kind, 'pi');
  const circuit = new Circuit('pi', kind);
  const reg = new BusRegistry();
  reg.setResolver(circuit);
  reg.bindEngine('pi', shim.getBusBinding());
  const attach = (owner: string, pins: typeof SPI0_CE0, chip: Chip) => {
    circuit.wireSpi(owner, pins);
    return reg.attachSpi({ owner, pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } }, chip);
  };
  return { shim, pm, reg, attach };
}

// ── Two controllers, CE lines as hardware chip selects ──────────────────────

describe('Raspberry Pi SPI: two controllers, two ports', () => {
  it('SPI0 and SPI1 are separate ports, and a frame on one never reaches the other', () => {
    const { shim } = newShim();
    const seen: Array<[number, number]> = [];
    port(shim, 0).setFrameHandler((m) => (seen.push([0, m]), 0x10));
    port(shim, 1).setFrameHandler((m) => (seen.push([1, m]), 0x20));
    expect(shim.answerBusLine('SPI 0 0 X a1')).toBe('SPI_DATA 0 0 10');
    expect(shim.answerBusLine('SPI 1 2 X b2')).toBe('SPI_DATA 1 2 20');
    expect(seen).toEqual([
      [0, 0xa1],
      [1, 0xb2],
    ]);
    expect(shim.getBusBinding().spi.map((p) => [p.unit, p.name])).toEqual([
      [0, 'SPI0'],
      [1, 'SPI1'],
    ]);
  });

  it('a bus number with no controller behind it clocks into nothing and reads idle', () => {
    const { shim } = newShim();
    let frames = 0;
    port(shim, 0).setFrameHandler(() => (frames++, 0));
    expect(shim.answerBusLine('SPI 3 0 X 0102')).toBe('SPI_DATA 3 0 ffff');
    expect(frames).toBe(0);
  });

  it('the CE lines are the controller\'s chip selects: hardware CS to the fabric, the pad low around the bytes', () => {
    const { shim, pm } = newShim();
    const events: string[] = [];
    for (const unit of [0, 1]) {
      const p = port(shim, unit);
      p.setHardwareCsHandler((i, a) => events.push(`spi${unit} cs${i} ${a ? 'on' : 'off'}`));
      p.setFrameHandler((m) => {
        // Inside the frame the pad of the selected CE reads low, the others high or untouched.
        events.push(`spi${unit} frame ${m} ce=${CE[unit].map((pin) => pm.peekPinState(pin) ?? '-').join(',')}`);
        return 0xff;
      });
    }
    shim.answerBusLine('SPI 0 1 X 05');
    shim.answerBusLine('SPI 1 2 X 06');
    expect(events).toEqual([
      'spi0 cs1 on',
      'spi0 frame 5 ce=-,false',
      'spi0 cs1 off',
      'spi1 cs2 on',
      'spi1 frame 6 ce=-,-,false',
      'spi1 cs2 off',
    ]);
    expect(pm.getPinState(7)).toBe(true);
    expect(pm.getPinState(16)).toBe(true);
  });

  it('an XC line holds its CE across lines; a transfer on another CE releases it first', () => {
    const { shim } = newShim();
    const events: string[] = [];
    port(shim, 0).setHardwareCsHandler((i, a) => events.push(`cs${i} ${a ? 'on' : 'off'}`));
    port(shim, 0).setFrameHandler((m) => (events.push(`frame ${m}`), 0xff));
    shim.answerBusLine('SPI 0 0 XC 01');
    shim.answerBusLine('SPI 0 0 WC 02');
    shim.answerBusLine('SPI 0 0 X 03');
    shim.answerBusLine('SPI 0 0 XC 04');
    shim.answerBusLine('SPI 0 1 X 05');
    expect(events).toEqual([
      'cs0 on',
      'frame 1',
      'frame 2',
      'frame 3',
      'cs0 off',
      'cs0 on',
      'frame 4',
      'cs0 off',
      'cs1 on',
      'frame 5',
      'cs1 off',
    ]);
  });

  it('routing: SPI0 from boot, SPI1 once the guest uses it and not after the guest is gone', () => {
    const { shim } = newShim();
    const spi0 = port(shim, 0);
    const spi1 = port(shim, 1);
    let changes = 0;
    spi1.setRoutingChangeHandler(() => changes++);
    const cs0: SpiRouting = { ...HEADER[0], cs: CE[0] };
    const cs1: SpiRouting = { ...HEADER[1], cs: CE[1] };
    expect(spi0.routing()).toEqual(cs0);
    expect(spi0.config().enabled).toBe(true);
    expect(spi1.routing()).toEqual({});
    expect(spi1.config().enabled).toBe(false);
    shim.answerBusLine('SPI 1 0 CONFIG 1000000 0 8');
    expect(spi1.routing()).toEqual(cs1);
    expect(spi1.config().enabled).toBe(true);
    expect(changes).toBe(1);
    shim.answerBusLine('SPI 1 0 X 00');
    expect(changes).toBe(1);
    shim.stop();
    expect(spi1.routing()).toEqual({});
    expect(spi0.routing()).toEqual(cs0);
    expect(changes).toBe(2);
    shim.answerBusLine('SPI 1 1 W 00');
    expect(spi1.routing()).toEqual(cs1);
    expect(changes).toBe(3);
  });

  it.each(['raspberry-pi-zero', 'raspberry-pi-1', 'raspberry-pi-2', 'raspberry-pi-3', 'raspberry-pi-4', 'raspberry-pi-5'])(
    '%s: every routed pin carries that signal in the board\'s pin function table',
    (kind) => {
      const { shim } = newShim(kind);
      shim.answerBusLine('SPI 1 0 W 00');
      for (const unit of [0, 1]) {
        const r = port(shim, unit).routing() as SpiRouting;
        const has = (pin: number | undefined, signal: string, csIndex?: number) =>
          pin !== undefined &&
          functionsOfPin(kind, pin).some(
            (f) => f.bus === 'spi' && f.unit === unit && f.signal === signal && (csIndex === undefined || f.csIndex === csIndex),
          );
        expect(has(r.sck, 'sck'), `SPI${unit} sck ${r.sck}`).toBe(true);
        expect(has(r.mosi, 'mosi'), `SPI${unit} mosi ${r.mosi}`).toBe(true);
        expect(has(r.miso, 'miso'), `SPI${unit} miso ${r.miso}`).toBe(true);
        (r.cs ?? []).forEach((pin, i) => expect(has(pin, 'cs', i), `SPI${unit} CE${i} on ${pin}`).toBe(true));
      }
    },
  );

  it('CONFIG sets the mode and clock of the transactions on that chip select', () => {
    const { shim } = newShim();
    const spi0 = port(shim, 0);
    expect(spi0.config()).toEqual({ enabled: true, bitOrder: 'msb', bits: 8 });
    expect(shim.answerBusLine('SPI 0 0 CONFIG 500000 3 8')).toBeNull();
    expect(shim.answerBusLine('SPI 0 1 CONFIG 8000000 0 8')).toBeNull();
    const seen: unknown[] = [];
    spi0.setFrameHandler(() => (seen.push(spi0.config()), 0xff));
    shim.answerBusLine('SPI 0 0 X 00');
    shim.answerBusLine('SPI 0 1 X 00');
    expect(seen).toEqual([
      { enabled: true, mode: 3, bitOrder: 'msb', bits: 8, hz: 500000 },
      { enabled: true, mode: 0, bitOrder: 'msb', bits: 8, hz: 8000000 },
    ]);
    // A guest that is gone takes its settings with it.
    shim.stop();
    expect(spi0.config()).toEqual({ enabled: true, bitOrder: 'msb', bits: 8 });
  });

  it('UNIHIKER (same guest image, pads unknown): the controllers exist, route nowhere and toggle no pad', () => {
    const { shim, pm } = newShim('unihiker-m10');
    const heard: number[] = [];
    port(shim, 0).setFrameHandler((m) => (heard.push(m), 0x42));
    expect(port(shim, 0).routing()).toEqual({});
    expect(shim.answerBusLine('SPI 0 0 X 07')).toBe('SPI_DATA 0 0 42');
    expect(heard).toEqual([7]);
    // Edge pad P8 is a plain GPIO on this board: SPI never drives it.
    expect(pm.peekPinState(8)).toBeUndefined();
  });

  it('the pads come from the board\'s pin function table, not its name, even one registered after the board', () => {
    // A family board whose overlay registers its table late: unrouted until then.
    const late = 'test-pi-family-late';
    const { shim } = newShim(late);
    expect(port(shim, 0).routing()).toEqual({});
    registerBoardPinFunctions([late], getBoardPinFunctions('raspberry-pi-4')!);
    expect(port(shim, 0).routing()).toEqual({ ...HEADER[0], cs: CE[0] });
    // A table that puts no SPI on those pads (the UNIHIKER's lists only I2C).
    const noSpi = 'test-pi-family-no-spi';
    registerBoardPinFunctions([noSpi], {
      routing: 'fixed',
      controllers: [{ bus: 'i2c', unit: 1, name: 'I2C', defaultPins: { sda: 20, scl: 19 } }],
      pins: { 19: [{ bus: 'i2c', unit: 1, signal: 'scl' }], 20: [{ bus: 'i2c', unit: 1, signal: 'sda' }] },
      source: 'test',
    });
    const { shim: other, pm } = newShim(noSpi);
    expect(port(other, 0).routing()).toEqual({});
    other.answerBusLine('SPI 0 0 X 00');
    expect(pm.peekPinState(8)).toBeUndefined();
  });
});

// ── On the real fabric ──────────────────────────────────────────────────────

describe('Raspberry Pi SPI on the bus fabric', () => {
  it('a chip on CE0 and one on CE1 each hear only their own transfers; a chip on SPI1 hears none of SPI0\'s', () => {
    const { shim, attach } = onFabric();
    const a = new Chip((m) => m ^ 0x0f);
    const b = new Chip((m) => m ^ 0xf0);
    const c = new Chip((m) => m + 1);
    attach('a', SPI0_CE0, a);
    attach('b', SPI0_CE1, b);
    attach('c', SPI1_CE0, c);
    expect(shim.answerBusLine('SPI 0 0 X 0102')).toBe('SPI_DATA 0 0 0e0d');
    expect(shim.answerBusLine('SPI 0 1 X 03')).toBe('SPI_DATA 0 1 f3');
    expect(shim.answerBusLine('SPI 1 0 X 04')).toBe('SPI_DATA 1 0 05');
    expect([a.heard, b.heard, c.heard]).toEqual([[1, 2], [3], [4]]);
    expect([a.selects, b.selects, c.selects]).toEqual([1, 1, 1]);
    expect([a.deselects, b.deselects, c.deselects]).toEqual([1, 1, 1]);
  });

  it('idle: with nobody selected, or nobody on the bus, the guest reads 0xFF', () => {
    const { shim, attach } = onFabric();
    expect(shim.answerBusLine('SPI 0 0 X 0000')).toBe('SPI_DATA 0 0 ffff');
    const h = attach('a', SPI0_CE0, new Chip(() => 0x00));
    expect(shim.answerBusLine('SPI 0 1 X 0000')).toBe('SPI_DATA 0 1 ffff');
    h.dispose();
    expect(shim.answerBusLine('SPI 0 0 X 0000')).toBe('SPI_DATA 0 0 ffff');
  });

  it('XC chunks are one selection: the chip is selected once for the whole message', () => {
    const { shim, attach } = onFabric();
    const a = new Chip((m) => m);
    attach('a', SPI0_CE0, a);
    shim.answerBusLine('SPI 0 0 XC 0102');
    shim.answerBusLine('SPI 0 0 XC 03');
    expect(shim.answerBusLine('SPI 0 0 X 04')).toBe('SPI_DATA 0 0 04');
    expect(a.heard).toEqual([1, 2, 3, 4]);
    expect([a.selects, a.deselects]).toEqual([1, 1]);
  });

  it('a whole transaction is one block: a lone write-only sink takes a W line in one call', () => {
    const { shim, attach } = onFabric();
    const panel = new Chip(null, { block: true });
    attach('panel', SPI0_CE0, panel);
    const frame = Array.from({ length: 300 }, (_, i) => i & 0xff);
    expect(shim.answerBusLine(`SPI 0 0 W ${hex(frame)}`)).toBeNull();
    expect(panel.blocks).toEqual([frame]);
    expect(panel.heard).toEqual(frame);
  });

  it('a block that is read back answers exactly what the frames would', () => {
    const { shim, attach } = onFabric();
    const adc = new Chip((m) => (m * 3) & 0xff, { block: true });
    attach('adc', SPI0_CE1, adc);
    const bytes = Array.from({ length: 40 }, (_, i) => (i * 29) & 0xff);
    expect(spiData(shim.answerBusLine(`SPI 0 1 X ${hex(bytes)}`), 0, 1)).toEqual(bytes.map((b) => (b * 3) & 0xff));
    // Read back, so it went frame by frame: every byte answered once.
    expect(adc.blocks).toEqual([]);
    expect(adc.heard).toEqual(bytes);
  });

  it('Stop releases a held CE and every pad, then the fabric hears the reset with CE0 not driven', () => {
    const { shim, pm, attach } = onFabric();
    const a = new Chip((m) => m, { pm });
    attach('a', SPI0_CE0, a);
    shim.answerBusLine('SPI 0 0 XC 01');
    expect([a.selects, a.deselects, a.resets]).toEqual([1, 0, 0]);
    shim.stop();
    expect([a.selects, a.deselects, a.resets]).toEqual([1, 1, 1]);
    expect(a.ce0AtReset).toEqual([undefined]);
    // The next run starts a new transaction, selected afresh.
    shim.answerBusLine('SPI 0 0 XC 02');
    expect(a.selects).toBe(2);
  });

  it('Stop with a GPIO chip select held low: the chip is deselected, and the next run\'s bytes on CE0 are not its', () => {
    const { shim, pm, attach } = onFabric();
    const gpioCs = new Chip((m) => m ^ 0xff);
    const onCe0 = new Chip((m) => m);
    attach('gpio-cs', { ...HEADER[0], cs: 25 }, gpioCs);
    attach('ce0', SPI0_CE0, onCe0);
    // The script selects its chip by hand (RPi.GPIO) and is stopped mid-transaction.
    pm.triggerPinChange(25, true, 'mcu');
    pm.triggerPinChange(25, false, 'mcu');
    expect(gpioCs.selects).toBe(1);
    shim.stop();
    expect(pm.peekPinState(25)).toBeUndefined();
    expect([gpioCs.deselects, gpioCs.resets]).toEqual([1, 1]);
    // The next run talks to the chip on CE0 before it touches GPIO25 again.
    expect(shim.answerBusLine('SPI 0 0 X 77')).toBe('SPI_DATA 0 0 77');
    expect(gpioCs.heard).toEqual([]);
    expect(onCe0.heard).toEqual([0x77]);
  });

  it('a fresh guest (the relay\'s announcement) is an MCU reset too, and drops what the dead guest held', () => {
    const { shim, attach } = onFabric();
    const a = new Chip((m) => m);
    attach('a', SPI0_CE0, a);
    shim.answerBusLine('SPI 0 0 XC 01'); // the guest died here, no Stop
    shim.startBusSync();
    try {
      expect([a.deselects, a.resets]).toEqual([1, 1]);
      shim.answerBusLine('SPI 0 0 X 02');
      expect(a.selects).toBe(2);
    } finally {
      shim.stopBusSync();
    }
  });
});
// The F2 transition bridge (`spi` and `setSPIHandler`) lived here. F3 removed
// it: a device is on this board's SPI because its pins are on a controller's
// nets. Its four cases are covered above on the fabric — one answer per frame,
// SPI0 and SPI1 kept apart, the port surviving Stop/Run, and a sink taking the
// whole block in one call.


// ── The relay's gate ────────────────────────────────────────────────────────

describe('Raspberry Pi SPI and the backend relay', () => {
  it('spi.attached counts a chip the fabric placed on a controller\'s SCK net', () => {
    const { shim } = newShim('raspberry-pi-4', 'pi-relay');
    const circuit = new Circuit('pi-relay', 'raspberry-pi-4');
    busRegistry.setResolver(circuit);
    try {
      busRegistry.bindEngine('pi-relay', shim.getBusBinding());
      expect(shim.busTopology().spi.attached).toBe(false);
      circuit.wireSpi('adc', SPI0_CE0);
      const h = busRegistry.attachSpi(
        { owner: 'adc', pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } },
        new Chip(() => 0),
      );
      expect(shim.busTopology().spi.attached).toBe(true);
      h.dispose();
      expect(shim.busTopology().spi.attached).toBe(false);
      // A bit-banged chip on other pins is not on a controller's bus.
      circuit.wireSpi('soft', { sck: 23, mosi: 24, miso: 25, cs: 5 });
      const s = busRegistry.attachSpi(
        { owner: 'soft', pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } },
        new Chip(() => 0),
      );
      expect(shim.busTopology().spi.attached).toBe(false);
      s.dispose();
    } finally {
      busRegistry.unbindBoard('pi-relay');
      busRegistry.setResolver(createStoreNetResolver(() => useSimulatorStore.getState()));
    }
  });
});

// ── Responders the relay hosts (F4) ─────────────────────────────────────────

describe('Raspberry Pi SPI: the responders the relay runs beside the guest', () => {
  /** A shim on the page's registry, with a bridge that records what it sends. */
  function relayed() {
    const sent: Array<{ type: string; data: unknown }> = [];
    const bridge = {
      sendBusTopology: (t: unknown) => sent.push({ type: 'topology', data: t }),
      sendBusAttrs: (owner: string, attrs: unknown) =>
        sent.push({ type: 'attrs', data: { owner, attrs } }),
    };
    const pm = new PinManager();
    const shim = new PiBridgeShim({
      boardId: 'pi-host',
      boardKind: 'raspberry-pi-4',
      bridge: bridge as never,
      pinManager: pm,
      boardState: () => undefined,
    });
    const circuit = new Circuit('pi-host', 'raspberry-pi-4');
    busRegistry.setResolver(circuit);
    busRegistry.bindEngine('pi-host', shim.getBusBinding());
    // What the store does for a board in its simulator map; this shim is not
    // in it, so the route is made here and nothing else is.
    const unroute = busRegistry.onSpiAttrsChange((b, o, a) => {
      if (b === 'pi-host') shim.pushBusAttrs(o, a);
    });
    let level = 1;
    circuit.wireSpi('adc', SPI0_CE0);
    const handle = busRegistry.attachSpi(
      {
        owner: 'adc',
        pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' },
        remoteModel: () => ({ wasmB64: 'AGFzbQEAAAA=' }),
        remoteAttrs: () => ({ level }),
      },
      new Chip(() => 0),
    );
    const topologies = () =>
      sent.filter((m) => m.type === 'topology').map((m) => m.data as {
        spi: { responders?: Array<{ owner: string; cs: unknown; model: { attrs: unknown } }> };
      });
    const done = () => {
      unroute();
      shim.stopBusSync();
      handle.dispose();
      busRegistry.unbindBoard('pi-host');
      busRegistry.setResolver(createStoreNetResolver(() => useSimulatorStore.getState()));
    };
    return {
      shim,
      sent,
      topologies,
      done,
      move(v: number) {
        level = v;
        handle.attrsChanged();
      },
    };
  }

  it('publishes each responder with a model, on the chip enable the relay places it by', () => {
    const r = relayed();
    try {
      r.shim.startBusSync();
      const responders = r.topologies().at(-1)!.spi.responders!;
      expect(responders.map((e) => e.owner)).toEqual(['adc']);
      expect(responders[0].cs).toEqual({ kind: 'hw', index: 0, gpio: 8, active_low: true });
      expect(responders[0].model.attrs).toEqual({ level: 1 });
    } finally {
      r.done();
    }
  });

  it('sends a moved input only while a relay listens', () => {
    const r = relayed();
    try {
      r.move(2);
      expect(r.sent.filter((m) => m.type === 'attrs'), 'no relay yet').toEqual([]);
      r.shim.startBusSync();
      expect(r.topologies().at(-1)!.spi.responders![0].model.attrs, 'the map carries it').toEqual({
        level: 2,
      });
      r.move(3);
      expect(r.sent.filter((m) => m.type === 'attrs').map((m) => m.data)).toEqual([
        { owner: 'adc', attrs: { level: 3 } },
      ]);
      r.shim.stopBusSync();
      r.move(4);
      expect(r.sent.filter((m) => m.type === 'attrs')).toHaveLength(1);
    } finally {
      r.done();
    }
  });

  it('republishes the topology when membership changes, only while a relay listens', () => {
    const r = relayed();
    try {
      r.shim.startBusSync();
      const before = r.topologies().length;
      (r.shim as unknown as { pushBusMap(): void }).pushBusMap();
      expect(r.topologies().length).toBe(before + 1);
      r.shim.stopBusSync();
      (r.shim as unknown as { pushBusMap(): void }).pushBusMap();
      expect(r.topologies().length).toBe(before + 1);
    } finally {
      r.done();
    }
  });
});
