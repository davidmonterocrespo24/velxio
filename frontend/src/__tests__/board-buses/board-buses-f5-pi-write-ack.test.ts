// @vitest-environment jsdom
/**
 * Board buses F5 second part, item 8: a NAK from the tab reaches the Linux
 * guest on a Raspberry Pi write (project/board-buses-2026-09).
 *
 * The backend relay (pro/backend/app/pro_boards/pi_bus_relay.py) answers the
 * ACK of a guest's write itself, so a display's frame does not pay a network
 * round trip per chunk; a device that can refuse a byte then had its NAK
 * swallowed. The tab now marks those devices in the topology it publishes
 * (`ask_writes`, from I2cTarget.mayNak) and the relay asks the tab for their
 * writes only. The relay half is test_pi_bus_relay.py; this is the tab half:
 *  - the mark is on exactly the devices that can NAK, on the bus they are on;
 *  - it changes the map's identity, so a device gaining it is republished;
 *  - the line the relay then asks is answered with the device's own NAK.
 */
import { describe, it, expect } from 'vitest';
import { PiBridgeShim } from '../../simulation/PiBridgeShim';
import { PinManager } from '../../simulation/PinManager';
import { busRegistry } from '../../simulation/buses/registry';
import { createStoreNetResolver } from '../../simulation/buses';
import type { I2cTarget, NetResolver, PinRef, ResolvedPin } from '../../simulation/buses/types';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { ChipInstance } from '../../simulation/customChips/ChipRuntime';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

class Circuit implements NetResolver {
  private readonly nets = new Map<string, ResolvedPin>();
  private readonly boardId: string;
  constructor(boardId: string) {
    this.boardId = boardId;
  }
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }
  boardKind(id: string): string | undefined {
    return id === this.boardId ? 'raspberry-pi-4' : undefined;
  }
  boards(): string[] {
    return [this.boardId];
  }
  wireI2c(owner: string, sda: number, scl: number): void {
    this.nets.set(`${owner}:SDA`, { kind: 'board', boardId: this.boardId, pin: sda });
    this.nets.set(`${owner}:SCL`, { kind: 'board', boardId: this.boardId, pin: scl });
  }
}

/** A chip that takes register bytes and refuses 0xff as data, as a custom chip may. */
function picky(mayNak: boolean): I2cTarget {
  let first = true;
  return {
    mayNak,
    start: () => {
      first = true;
      return true;
    },
    write: (b) => {
      const ok = first || b !== 0xff;
      first = false;
      return ok;
    },
    read: () => 0,
    stop: () => {},
  };
}

function onFabric(boardId: string) {
  const sent: unknown[] = [];
  const shim = new PiBridgeShim({
    boardId,
    boardKind: 'raspberry-pi-4',
    bridge: { sendBusTopology: (t: unknown) => sent.push(t) } as never,
    pinManager: new PinManager(),
    boardState: () => undefined,
  });
  const circuit = new Circuit(boardId);
  busRegistry.setResolver(circuit);
  busRegistry.bindEngine(boardId, shim.getBusBinding());
  const handles: Array<{ dispose(): void }> = [];
  return {
    shim,
    sent,
    circuit,
    attach(owner: string, sda: number, scl: number, target: I2cTarget, address: number) {
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

describe('Raspberry Pi: the topology marks the devices whose writes the tab must ACK', () => {
  it('marks a chip that can NAK, on its own bus, and nothing else', () => {
    const f = onFabric('pi-ack-a');
    try {
      f.attach('chip', 2, 3, picky(true), 0x50);
      f.attach('oled', 2, 3, picky(false), 0x3c);
      f.attach('chip0', 0, 1, picky(true), 0x51);
      expect(f.shim.busTopology().i2c).toEqual([
        { bus: 0, addr: 0x51, regs: null, ask_writes: true },
        { bus: 1, addr: 0x3c, regs: null },
        { bus: 1, addr: 0x50, regs: null, ask_writes: true },
      ]);
    } finally {
      f.done();
    }
  });

  it('two chips at one address: the mark wins if either can NAK', () => {
    const f = onFabric('pi-ack-b');
    try {
      f.attach('quiet', 2, 3, picky(false), 0x50);
      f.attach('loud', 2, 3, picky(true), 0x50);
      expect(f.shim.busTopology().i2c).toEqual([{ bus: 1, addr: 0x50, regs: null, ask_writes: true }]);
    } finally {
      f.done();
    }
  });

  it('gaining the mark republishes the map on the next tick', () => {
    const f = onFabric('pi-ack-d');
    try {
      f.shim.startBusSync();
      const h = f.attach('chip', 2, 3, picky(false), 0x50);
      (f.shim as unknown as { busTick(): void }).busTick();
      const before = f.sent.length;
      h.dispose();
      f.attach('chip', 2, 3, picky(true), 0x50);
      (f.shim as unknown as { busTick(): void }).busTick();
      expect(f.sent.length).toBe(before + 1);
      expect((f.sent.at(-1) as { i2c: unknown[] }).i2c).toEqual([
        { bus: 1, addr: 0x50, regs: null, ask_writes: true },
      ]);
    } finally {
      f.done();
    }
  });

  it('the line the relay asks is answered with the chip own NAK', () => {
    const f = onFabric('pi-ack-e');
    try {
      f.attach('chip', 2, 3, picky(true), 0x50);
      // What velxio-busd sends for write(fd, "\x10\xff", 2): an acknowledged write.
      expect(f.shim.answerBusLine('I2C 1 50 T 10ff 0')).toBe('I2C_ERR 1 50 nack data');
      expect(f.shim.answerBusLine('I2C 1 50 T 1001 0')).toBe('I2C_DATA 1 50');
    } finally {
      f.done();
    }
  });
});

describe('Raspberry Pi: a user custom chip is a device that can NAK', () => {
  // The chip's on_i2c_write decides the ACK, so its writes are the ones the
  // relay must ask the tab about. The real runtime, with a real chip: the
  // gallery-style i2c-probe, at 0x50 on GPIO2/3.
  it('the chip the runtime puts on the fabric is marked ask_writes', async () => {
    const f = onFabric('pi-ack-chip');
    let inst: ChipInstance | null = null;
    try {
      f.circuit.wireI2c('chip', 2, 3);
      busRegistry.netlistChanged();
      inst = await ChipInstance.create({
        // jsdom serves this file over http, so the fixture is found from the
        // package root vitest runs in.
        wasm: readFileSync(resolve('src/__tests__/board-buses/fixtures/chips-other-chips/i2c-probe.wasm')),
        componentId: 'chip',
        pinManager: new PinManager(),
        attrs: new Map([['addr1', 0x50]]),
        log: () => {},
      });
      inst.start();
      expect(f.shim.busTopology().i2c).toEqual([{ bus: 1, addr: 0x50, regs: null, ask_writes: true }]);
    } finally {
      inst?.dispose();
      f.done();
    }
  });
});
