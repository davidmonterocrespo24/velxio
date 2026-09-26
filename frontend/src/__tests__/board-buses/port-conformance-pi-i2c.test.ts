// @vitest-environment jsdom
/**
 * Board buses F5: the Raspberry Pi's I2C controller ports
 * (project/board-buses-2026-09, F5-SPEC "Motores": "Pi shim / instant: I2C1
 * (y I2C0 si el modelo lo expone) como puertos").
 *
 * Both engines that run a Pi script reach the board's I2C as request lines,
 * `I2C <bus> <addr> R|W|RR|WR|T ...`, answered by the board's PiBridgeShim:
 * that line is the guest's controller access, the way a register write is on
 * an MCU engine. `<bus>` is the controller: /dev/i2c-1 (BSC1, GPIO2/3) and
 * /dev/i2c-0 (BSC0, GPIO0/1), both served by velxio-busd.
 *
 * The shared conformance suite runs first, on the store's own board, with the
 * exact lines a guest sends. Then what only the Pi has:
 *  - a target is on the controller its SDA is wired to, and a line on the
 *    other bus does not reach it (before F5 every device was on "the header
 *    bus" whatever its wiring, and bus 0 reached nothing);
 *  - the topology the backend relay answers absent addresses from is per bus,
 *    from the same placement, and register pushes are keyed by bus too;
 *  - a NAK on a data byte ends the write and says so, in a reply every guest
 *    parser still reads as EREMOTEIO.
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
    constructor(id: string, kind: string) {
      this.boardId = id;
      this.boardKind = kind;
    }
    connect() {}
    disconnect() {}
    sendPinEvent() {}
    sendBusTopology() {}
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
import { busRegistry } from '../../simulation/buses/registry';
import { createStoreNetResolver } from '../../simulation/buses';
import {
  defineI2cPortConformance,
  type I2cConformanceRig,
  type I2cGuestResult,
  type I2cGuestTransaction,
} from '../../simulation/buses/conformance/i2cPortConformance';
import type { I2cTarget, NetResolver, PinRef, ResolvedPin } from '../../simulation/buses/types';

beforeAll(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

const hex = (bytes: readonly number[]): string =>
  bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');

/** The line a Linux i2c-dev transfer (or the tab's fcntl shim) sends for one Wire-style exchange. */
function lineFor(t: I2cGuestTransaction): string {
  const a = t.address.toString(16).padStart(2, '0');
  if (t.read === 0) return `I2C ${t.unit} ${a} W ${hex(t.write)}`;
  if (t.write.length === 0) return `I2C ${t.unit} ${a} R ${t.read}`;
  return `I2C ${t.unit} ${a} T ${hex(t.write)} ${t.read}`;
}

/** Wire's view of the reply: 0 done, 2 address NAK, 3 data NAK. */
function resultOf(reply: string | null): I2cGuestResult {
  const t = (reply ?? '').trim().split(/\s+/);
  if (t[0] === 'I2C_ERR') return { status: t[3] === 'nack' && t[4] === 'data' ? 3 : 2, read: [] };
  expect(t[0], `reply: ${reply}`).toBe('I2C_DATA');
  const h = t[3] ?? '';
  const read: number[] = [];
  for (let i = 0; i < h.length; i += 2) read.push(parseInt(h.slice(i, i + 2), 16));
  return { status: 0, read };
}

const HEADER: Record<number, { sda: number; scl: number }> = {
  0: { sda: 0, scl: 1 },
  1: { sda: 2, scl: 3 },
};

interface MockBridge {
  onBusRelay: ((v: number) => void) | null;
}

async function storePiRig(kind: string): Promise<I2cConformanceRig> {
  const id = useSimulatorStore.getState().addBoard(kind as never, 100, 100);
  const shim = getBoardSimulator(id) as PiBridgeShim;
  const bridge = getBoardBridge(id) as unknown as MockBridge;
  const pm = getBoardPinManager(id)!;
  // The probes stand where the fabric would.
  busRegistry.unbindBoard(id);
  return {
    units: [0, 1],
    binding: () => shim.getBusBinding(),
    run: async (ts) => ts.map((t) => resultOf(shim.answerBusLine(lineFor(t)))),
    reset: async () => {
      bridge.onBusRelay?.(1);
    },
    stopRun: async () => {
      useSimulatorStore.getState().stopBoard(id);
      useSimulatorStore.getState().startBoard(id);
      bridge.onBusRelay?.(1);
    },
    reload: async () => {
      useSimulatorStore.getState().resetBoard(id);
    },
    expectedRouting: (unit) => HEADER[unit],
    onPinEdge: (pin, cb) => pm.onPinChange(pin, () => cb()),
    dispose: () => useSimulatorStore.getState().removeBoard(id),
  };
}

defineI2cPortConformance('Raspberry Pi 4 (PiBridgeShim, relay lines)', () => storePiRig('raspberry-pi-4'));
defineI2cPortConformance('Raspberry Pi 3 (PiBridgeShim, relay lines)', () => storePiRig('raspberry-pi-3'));

// ── The Pi on the page's fabric ─────────────────────────────────────────────

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
  wireI2c(owner: string, sda: number, scl: number): void {
    this.nets.set(`${owner}:SDA`, { kind: 'board', boardId: this.boardId, pin: sda });
    this.nets.set(`${owner}:SCL`, { kind: 'board', boardId: this.boardId, pin: scl });
  }
}

/** A register file at one address: pointer write, auto-incrementing reads. */
class Regs implements I2cTarget {
  regs = new Uint8Array(256);
  private ptr = 0;
  private first = true;
  constructor(fill: number) {
    this.regs.fill(fill);
  }
  start(): boolean {
    this.first = true;
    return true;
  }
  write(b: number): boolean {
    if (this.first) {
      this.ptr = b;
      this.first = false;
    } else this.regs[this.ptr++ & 0xff] = b;
    return true;
  }
  read(): number {
    return this.regs[this.ptr++ & 0xff];
  }
  stop(): void {}
}

function onFabric(boardId: string) {
  const sent: Array<{ type: string; data: unknown }> = [];
  const bridge = {
    sendBusTopology: (t: unknown) => sent.push({ type: 'topology', data: t }),
    sendBusRegs: (bus: number, addr: number, regs: string) =>
      sent.push({ type: 'regs', data: { bus, addr, regs } }),
  };
  const shim = new PiBridgeShim({
    boardId,
    boardKind: 'raspberry-pi-4',
    bridge: bridge as never,
    pinManager: new PinManager(),
    boardState: () => undefined,
  });
  const circuit = new Circuit(boardId, 'raspberry-pi-4');
  busRegistry.setResolver(circuit);
  busRegistry.bindEngine(boardId, shim.getBusBinding());
  const handles: Array<{ dispose(): void }> = [];
  return {
    shim,
    sent,
    attach(owner: string, sda: number, scl: number, target: I2cTarget, address = 0x76) {
      circuit.wireI2c(owner, sda, scl);
      const h = busRegistry.attachI2c({ owner, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [address] }, target);
      handles.push(h);
      return h;
    },
    done() {
      shim.stopBusSync();
      for (const h of handles) h.dispose();
      busRegistry.unbindBoard(boardId);
      busRegistry.setResolver(createStoreNetResolver(() => useSimulatorStore.getState()));
    },
  };
}

describe('Raspberry Pi I2C: a target is on the controller its SDA is wired to', () => {
  it('two identical sensors, one per controller, are two devices', () => {
    const f = onFabric('pi-i2c-a');
    try {
      f.attach('bus1', 2, 3, new Regs(0x11));
      f.attach('bus0', 0, 1, new Regs(0x22));
      expect(f.shim.answerBusLine('I2C 1 76 RR d0 2')).toBe('I2C_DATA 1 76 1111');
      expect(f.shim.answerBusLine('I2C 0 76 RR d0 2')).toBe('I2C_DATA 0 76 2222');
    } finally {
      f.done();
    }
  });

  it('a sensor on GPIO2/3 is not on bus 0, and one wired nowhere is on neither', () => {
    const f = onFabric('pi-i2c-b');
    try {
      f.attach('bus1', 2, 3, new Regs(0x11));
      f.attach('loose', 5, 6, new Regs(0x33), 0x48);
      expect(f.shim.answerBusLine('I2C 0 76 R 1')).toBe('I2C_ERR 0 76 nack');
      expect(f.shim.answerBusLine('I2C 1 48 R 1')).toBe('I2C_ERR 1 48 nack');
      expect(f.shim.answerBusLine('I2C 0 48 R 1')).toBe('I2C_ERR 0 48 nack');
    } finally {
      f.done();
    }
  });

  it('the relay topology is per bus, from the same placement, registers included', () => {
    const f = onFabric('pi-i2c-c');
    try {
      const withDump = Object.assign(new Regs(0x11), {
        dumpRegisters(this: Regs) {
          return this.regs.slice();
        },
      });
      f.attach('bus1', 2, 3, withDump);
      f.attach('bus0', 0, 1, new Regs(0x22));
      f.attach('loose', 5, 6, new Regs(0x33), 0x48);
      // SDA on the header bus, SCL on another pin: it never sees BSC1's clock.
      f.attach('unclocked', 2, 6, new Regs(0x44), 0x50);
      const t = f.shim.busTopology();
      expect(t.i2c.map((d) => [d.bus, d.addr, d.regs === null ? 'ask' : d.regs.slice(0, 4)])).toEqual([
        [0, 0x76, 'ask'],
        [1, 0x76, '1111'],
      ]);
      expect(f.shim.i2cAddresses(0)).toEqual([0x76]);
      expect(f.shim.i2cAddresses(1)).toEqual([0x76]);
    } finally {
      f.done();
    }
  });

  it('register pushes are keyed by bus: the same address on two buses is two devices', () => {
    vi.useFakeTimers();
    const f = onFabric('pi-i2c-d');
    try {
      const mk = (fill: number) =>
        Object.assign(new Regs(fill), {
          dumpRegisters(this: Regs) {
            return this.regs.slice();
          },
        });
      const a = mk(0x11);
      const b = mk(0x22);
      f.attach('bus1', 2, 3, a);
      f.attach('bus0', 0, 1, b);
      f.shim.startBusSync();
      f.sent.length = 0;
      b.regs[0] = 0x99;
      vi.advanceTimersByTime(260);
      expect(f.sent.map((m) => [m.type, (m.data as { bus: number }).bus])).toEqual([['regs', 0]]);
    } finally {
      f.done();
      vi.useRealTimers();
    }
  });

  it('an address NAK still ends in a STOP for the target that refused it', () => {
    const f = onFabric('pi-i2c-g');
    try {
      const log: string[] = [];
      f.attach('shy', 2, 3, {
        start: () => {
          log.push('S');
          return false;
        },
        write: () => true,
        read: () => 0,
        stop: () => log.push('P'),
      });
      expect(f.shim.answerBusLine('I2C 1 76 W 01')).toBe('I2C_ERR 1 76 nack');
      expect(log).toEqual(['S', 'P']);
    } finally {
      f.done();
    }
  });

  it('a NAK on a data byte ends the write, as `nack data`', () => {
    const f = onFabric('pi-i2c-f');
    try {
      const heard: number[] = [];
      f.attach('picky', 2, 3, {
        start: () => true,
        write: (b) => {
          heard.push(b);
          return b !== 0x5a;
        },
        read: () => 0,
        stop: () => {},
      });
      expect(f.shim.answerBusLine('I2C 1 76 W 015a02')).toBe('I2C_ERR 1 76 nack data');
      expect(heard).toEqual([0x01, 0x5a]);
      expect(f.shim.i2cTransfer(0x76, [0x5a], 0, 1)).toBeNull();
    } finally {
      f.done();
    }
  });
});
