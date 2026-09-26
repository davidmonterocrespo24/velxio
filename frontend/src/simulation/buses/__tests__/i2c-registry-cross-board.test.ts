/**
 * Layer 1 of project board-buses-2026-09 (TESTS.md), F5 third part: an I2C
 * target on a net that reaches two boards is on both boards' buses.
 *
 * A wire from one board's SDA to another's (and the same for SCL) makes ONE
 * net, and a chip on it answers whichever master addresses it, as on the
 * bench. Before this the registry placed a target on the one board `resolve`
 * named, and the other board's master reached it only through the retired
 * I2CBusManager bridge graph (Interconnect.updateI2CBridges), which saw the
 * manager's own device map and nothing on the fabric. Fake circuit and fake
 * ports with the real contracts; no engine.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { BusRegistry, busRegistry } from '../registry';
import { RemoteI2cLane } from '../remoteI2c';
import type {
  BoardPins,
  I2cControllerPort,
  I2cRouting,
  I2cTarget,
  I2cTransactionHandler,
  NetResolver,
  PinRef,
  ResolvedPin,
} from '../types';

const PINS: BoardPins = {
  onPinChange: () => () => {},
  peekPinState: () => undefined,
  driveInput: () => {},
};

class Port implements I2cControllerPort {
  readonly bus = 'i2c' as const;
  readonly unit = 0;
  readonly name = 'I2C0';
  readonly remote: boolean;
  handler: I2cTransactionHandler | null = null;
  private readonly route: I2cRouting;
  constructor(route: I2cRouting, remote = false) {
    this.route = route;
    this.remote = remote;
  }
  setTransactionHandler(h: I2cTransactionHandler | null): void {
    this.handler = h;
  }
  routing(): I2cRouting {
    return this.route;
  }
  /** One register read as a master runs it: pointer write, repeated START, read. */
  readReg(address: number, reg: number): number | null {
    const h = this.handler;
    if (!h || !h.start(address, false)) {
      h?.stop();
      return null;
    }
    h.write(reg);
    if (!h.start(address, true)) {
      h.stop();
      return null;
    }
    const v = h.read();
    h.stop();
    return v;
  }
}

type Pin = { boardId: string; pin: number };

/** Two boards whose I2C pins may be wired to each other. */
class Circuit implements NetResolver {
  readonly nets = new Map<string, Pin[]>();
  ids = ['a', 'b'];
  wire(comp: string, sda: Pin[], scl: Pin[]): void {
    this.nets.set(`${comp}:SDA`, sda);
    this.nets.set(`${comp}:SCL`, scl);
  }
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    const first = this.nets.get(`${ref.componentId}:${ref.pinName}`)?.[0];
    return first ? { kind: 'board', ...first } : { kind: 'floating' };
  }
  resolveAll(ref: PinRef): ResolvedPin[] {
    if (ref.kind === 'board') return [{ kind: 'board', boardId: ref.boardId, pin: ref.pin }];
    return (this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? []).map((p) => ({ kind: 'board' as const, ...p }));
  }
  boardKind(): string | undefined {
    return undefined;
  }
  boards(): string[] {
    return this.ids;
  }
}

/** A register file: pointer, then data. */
class Regs implements I2cTarget {
  starts = 0;
  private ptr = 0;
  private first = true;
  private readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  start(): boolean {
    this.starts++;
    this.first = true;
    return true;
  }
  write(b: number): boolean {
    if (this.first) this.ptr = b;
    this.first = false;
    return true;
  }
  read(): number {
    return this.ptr === 0xd0 ? this.value : 0;
  }
  stop(): void {}
}

const on = (boardId: string, pin: number): Pin => ({ boardId, pin });

function rig(reg = new BusRegistry(), remoteB = false) {
  const circuit = new Circuit();
  reg.setResolver(circuit);
  const a = new Port({ sda: 18, scl: 19 });
  const b = new Port({ sda: 4, scl: 5 }, remoteB);
  reg.bindEngine('a', { pins: PINS, spi: [], i2c: [a] });
  reg.bindEngine('b', { pins: PINS, spi: [], i2c: [b] });
  // The chip sits on board b's pins; b's I2C header is wired to a's.
  circuit.wire('chip', [on('b', 4), on('a', 18)], [on('b', 5), on('a', 19)]);
  return { reg, circuit, a, b };
}

afterEach(() => busRegistry.clear());

describe('an I2C target on a net that reaches two boards', () => {
  it('is on both boards\' buses, and either master reads it', () => {
    const { reg, a, b } = rig();
    const chip = new Regs(0x58);
    const h = reg.attachI2c({ owner: 'chip', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x76] }, chip);
    expect(reg.i2cPlacements('chip')).toEqual([
      { boardId: 'b', sdaPin: 4, sclPin: 5, clocked: true },
      { boardId: 'a', sdaPin: 18, sclPin: 19, clocked: true },
    ]);
    expect(reg.i2cPlacement('chip'), 'the board `resolve` names comes first').toMatchObject({ boardId: 'b' });
    expect(b.readReg(0x76, 0xd0)).toBe(0x58);
    expect(a.readReg(0x76, 0xd0)).toBe(0x58);
    expect(chip.starts).toBe(4);
    expect(a.readReg(0x77, 0xd0), 'another address').toBeNull();
    h.dispose();
    expect(reg.i2cPlacements('chip')).toEqual([]);
    expect(a.readReg(0x76, 0xd0)).toBeNull();
    expect(b.readReg(0x76, 0xd0)).toBeNull();
  });

  it('is not an unplaced owner for either board', () => {
    const { reg } = rig();
    reg.attachI2c({ owner: 'chip', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x76] }, new Regs(1));
    expect(reg.unplacedI2cOwners('a')).toEqual([]);
    expect(reg.unplacedI2cOwners('b')).toEqual([]);
    expect(reg.unplacedI2cOwners()).toEqual([]);
  });

  it('leaves a board\'s bus when the wire to that board goes, and stays on the other', () => {
    const { reg, circuit, a, b } = rig();
    reg.attachI2c({ owner: 'chip', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x76] }, new Regs(0x58));
    // Only SDA still reaches board a: half a bus is no bus.
    circuit.wire('chip', [on('b', 4), on('a', 18)], [on('b', 5)]);
    reg.netlistChanged();
    expect(reg.i2cPlacements('chip')).toEqual([{ boardId: 'b', sdaPin: 4, sclPin: 5, clocked: true }]);
    expect(a.readReg(0x76, 0xd0)).toBeNull();
    expect(b.readReg(0x76, 0xd0)).toBe(0x58);
    expect(reg.unplacedI2cOwners('a')).toEqual(['chip']);
    // Wired back: on both again, with no re-attach.
    circuit.wire('chip', [on('b', 4), on('a', 18)], [on('b', 5), on('a', 19)]);
    reg.netlistChanged();
    expect(a.readReg(0x76, 0xd0)).toBe(0x58);
  });

  it('announces both boards when it is attached, and the board it left', async () => {
    const { reg, circuit } = rig();
    const heard: string[] = [];
    reg.onI2cMapChange((id) => heard.push(id));
    reg.attachI2c({ owner: 'chip', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x76] }, new Regs(1));
    await Promise.resolve();
    expect(heard.sort()).toEqual(['a', 'b']);
    heard.length = 0;
    circuit.wire('chip', [on('b', 4)], [on('b', 5)]);
    reg.netlistChanged();
    await Promise.resolve();
    expect(heard).toContain('a');
  });

  it('a board that leaves the project takes only its own bus from under the target', () => {
    const { reg, circuit, a, b } = rig();
    reg.attachI2c({ owner: 'chip', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x76] }, new Regs(0x58));
    circuit.ids = ['b'];
    circuit.wire('chip', [on('b', 4)], [on('b', 5)]);
    reg.unbindBoard('a');
    // The store recomputes membership right after a board leaves.
    reg.netlistChanged();
    expect(reg.i2cPlacements('chip')).toEqual([{ boardId: 'b', sdaPin: 4, sclPin: 5, clocked: true }]);
    expect(a.readReg(0x76, 0xd0)).toBeNull();
    expect(b.readReg(0x76, 0xd0)).toBe(0x58);
  });

  it('a resolver without resolveAll places it on the one board resolve names', () => {
    const reg = new BusRegistry();
    const circuit = new Circuit();
    const bare: NetResolver = {
      resolve: (ref) => circuit.resolve(ref),
      boardKind: () => undefined,
      boards: () => ['a', 'b'],
    };
    reg.setResolver(bare);
    const a = new Port({ sda: 18, scl: 19 });
    const b = new Port({ sda: 4, scl: 5 });
    reg.bindEngine('a', { pins: PINS, spi: [], i2c: [a] });
    reg.bindEngine('b', { pins: PINS, spi: [], i2c: [b] });
    circuit.wire('chip', [on('b', 4), on('a', 18)], [on('b', 5), on('a', 19)]);
    reg.attachI2c({ owner: 'chip', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x76] }, new Regs(0x58));
    expect(reg.i2cPlacements('chip')).toEqual([{ boardId: 'b', sdaPin: 4, sclPin: 5, clocked: true }]);
    expect(b.readReg(0x76, 0xd0)).toBe(0x58);
    expect(a.readReg(0x76, 0xd0)).toBeNull();
  });

  it('a board whose master runs in a backend worker sees it in its bus map, by that board\'s pins', () => {
    // The page's registry: the lane reads it.
    const { reg } = rig(busRegistry, true);
    reg.attachI2c({ owner: 'chip', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x76] }, new Regs(1));
    const lane = new RemoteI2cLane('b', 'esp32');
    const map = lane.publication();
    expect(map).toEqual([{ owner: 'chip', bus_id: null, sda: 4, scl: 5, addresses: [0x76] }]);
  });
});
