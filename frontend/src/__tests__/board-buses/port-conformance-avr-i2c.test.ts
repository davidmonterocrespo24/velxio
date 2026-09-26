/**
 * Board buses F5: the AVR engine's I2C controller port (the TWI) against the
 * shared I2C conformance suite (project/board-buses-2026-09, F5-F6-SPEC,
 * TESTS.md layer 2), plus what the suite cannot see on this engine: the
 * fabric end to end by nets, and the ATtiny85, whose two-wire USI reaches the
 * fabric through the software decoder.
 *
 * Everything under test is the real thing: avr8js behind AVRSimulator, driven
 * through the store's own lifecycle (addBoard, compileBoardProgram, startBoard,
 * stopBoard, resetBoard) with a real guest. fixtures/conf-i2c-console is one
 * sketch built for the Uno and for the Mega with the production toolchain (the
 * .ino says how to rebuild it); the rig types each I2cGuestTransaction to it
 * over the board's serial port ('x U AA N HH ..') and reads back what Wire
 * reported. fixtures/avr-tiny-oled is Tiny4kOLED (TinyWireM on the USI) driving
 * an SSD1306. Only the frame clock is a stand-in: the store's
 * requestAnimationFrame never fires, and the rig steps the CPU itself.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node environment, with the browser globals the store's Run path touches.
vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
let nextFrame = 1;
vi.stubGlobal('requestAnimationFrame', () => nextFrame++);
vi.stubGlobal('cancelAnimationFrame', () => {});

import { useSimulatorStore, getBoardSimulator } from '../../store/useSimulatorStore';
import type { AVRSimulator } from '../../simulation/AVRSimulator';
import { attachI2cTarget, busRegistry } from '../../simulation/buses';
import type { BusDiagnostic, EngineBinding, I2cTarget } from '../../simulation/buses/types';
import {
  defineI2cPortConformance,
  ProbeTarget,
  type I2cConformanceRig,
  type I2cGuestResult,
  type I2cGuestTransaction,
} from '../../simulation/buses/conformance/i2cPortConformance';

const fixture = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), 'utf-8');

type AvrKind = 'arduino-uno' | 'arduino-mega';

interface Variant {
  hex: string;
  /** The TWI's pins (the board's pin function table). */
  sda: number;
  scl: number;
  /** Two plain GPIOs, for a target wired somewhere the TWI is not. */
  other: { sda: number; scl: number };
}

const VARIANTS: Record<AvrKind, Variant> = {
  'arduino-uno': {
    hex: fixture('conf-i2c-console/uno/conf-i2c-console.ino.hex'),
    sda: 18,
    scl: 19,
    other: { sda: 2, scl: 3 },
  },
  'arduino-mega': {
    hex: fixture('conf-i2c-console/mega/conf-i2c-console.ino.hex'),
    sda: 20,
    scl: 21,
    other: { sda: 2, scl: 3 },
  },
};

const hex2 = (b: number) => b.toString(16).padStart(2, '0');

let rigSeq = 0;
const liveRigs = new Set<AvrI2cRig>();
afterEach(() => {
  for (const r of liveRigs) r.dispose();
  liveRigs.clear();
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

/** One board of the real store, running the conformance guest. */
class AvrI2cRig implements I2cConformanceRig {
  readonly units = [0];
  readonly id: string;
  readonly v: Variant;
  out = '';
  private bootFrom = 0;
  private booted = false;

  constructor(kind: AvrKind) {
    this.v = VARIANTS[kind];
    this.id = `${kind}-i2c${++rigSeq}`;
    liveRigs.add(this);
    const st = useSimulatorStore.getState();
    st.addBoard(kind, 0, 0, this.id);
    this.sim.onSerialData = (ch: string) => {
      this.out += ch;
    };
    st.compileBoardProgram(this.id, this.v.hex);
    st.startBoard(this.id);
  }

  get sim(): AVRSimulator {
    return getBoardSimulator(this.id) as unknown as AVRSimulator;
  }

  binding(): EngineBinding {
    return this.sim.getBusBinding();
  }

  expectedRouting(): { sda: number; scl: number } {
    return { sda: this.v.sda, scl: this.v.scl };
  }

  onPinEdge(pin: number, cb: () => void): () => void {
    return this.sim.pinManager.onPinChange(pin, () => cb());
  }

  async run(transactions: I2cGuestTransaction[]): Promise<I2cGuestResult[]> {
    // After Reset the board is stopped: the user presses Run.
    const board = useSimulatorStore.getState().boards.find((b) => b.id === this.id);
    if (!board?.running) useSimulatorStore.getState().startBoard(this.id);
    return transactions.map((t) => {
      if (t.unit !== 0) throw new Error(`the ATmega has one TWI, not unit ${t.unit}`);
      return this.exchange(t);
    });
  }

  exchange(t: Omit<I2cGuestTransaction, 'unit'>): I2cGuestResult {
    const words = this.cmd(`x 0 ${hex2(t.address)} ${t.read} ${t.write.map(hex2).join(' ')}`)
      .split(/\s+/)
      .filter(Boolean);
    return { status: parseInt(words[0], 10), read: words.slice(1).map((h) => parseInt(h, 16)) };
  }

  async reset(): Promise<void> {
    useSimulatorStore.getState().resetBoard(this.id);
    this.rebooted();
  }

  async stopRun(): Promise<void> {
    const st = useSimulatorStore.getState();
    st.stopBoard(this.id);
    this.rebooted();
    st.startBoard(this.id);
  }

  async reload(): Promise<void> {
    useSimulatorStore.getState().compileBoardProgram(this.id, this.v.hex);
    this.rebooted();
  }

  dispose(): void {
    if (!liveRigs.delete(this)) return;
    useSimulatorStore.getState().removeBoard(this.id);
  }

  /** Type one command line; the sketch's answer (the text after '='). */
  cmd(line: string): string {
    this.awaitBoot();
    const mark = this.out.length;
    this.sim.serialWrite(`${line}\n`);
    let answer = '';
    this.stepUntil(
      () => {
        const m = /=([^\r\n]*)\r?\n/.exec(this.out.slice(mark));
        if (m) answer = m[1].trim();
        return m !== null;
      },
      8_000_000,
      `no answer to "${line}"`,
    );
    return answer;
  }

  /** Wire a component pin to one of this board's pins, as the canvas does. */
  wire(componentId: string, pinName: string, boardPin: number): void {
    useSimulatorStore.getState().addWire({
      id: `${componentId}-${pinName}-w`,
      start: { componentId, pinName, x: 0, y: 0 },
      end: { componentId: this.id, pinName: String(boardPin), x: 0, y: 0 },
      waypoints: [],
      color: '#0a0',
    } as never);
  }

  private rebooted(): void {
    this.bootFrom = this.out.length;
    this.booted = false;
  }

  private awaitBoot(): void {
    if (this.booted) return;
    this.stepUntil(
      () => /READY\r?\n/.test(this.out.slice(this.bootFrom)),
      3_000_000,
      'the sketch never printed READY',
    );
    this.booted = true;
  }

  private stepUntil(done: () => boolean, budget: number, what: string): void {
    const sim = this.sim;
    for (let i = 0; i < budget; i++) {
      sim.step();
      if ((i & 0xff) === 0 && done()) return;
    }
    if (!done()) throw new Error(`${what}; serial: ${JSON.stringify(this.out.slice(-160))}`);
  }
}

// ── The shared suite, on both ATmegas ────────────────────────────────────────

defineI2cPortConformance('AVR ATmega328P TWI (Arduino Uno)', async () => new AvrI2cRig('arduino-uno'), {
  staticRouting: true,
});
defineI2cPortConformance('AVR ATmega2560 TWI (Arduino Mega)', async () => new AvrI2cRig('arduino-mega'), {
  staticRouting: true,
});

// ── What the suite does not cover on this engine ────────────────────────────

/** A register-file target: first write byte = pointer, then data; reads walk it. */
class RegTarget implements I2cTarget {
  regs = new Uint8Array(256);
  heard: number[] = [];
  resets = 0;
  stops = 0;
  private ptr = 0;
  private first = true;
  constructor(fill: (i: number) => number) {
    for (let i = 0; i < 256; i++) this.regs[i] = fill(i) & 0xff;
  }
  start(): boolean {
    this.first = true;
    return true;
  }
  write(b: number): boolean {
    this.heard.push(b);
    if (this.first) {
      this.ptr = b;
      this.first = false;
    } else this.regs[this.ptr++ & 0xff] = b;
    return true;
  }
  read(): number {
    return this.regs[this.ptr++ & 0xff];
  }
  stop(): void {
    this.stops++;
  }
  boardReset(): void {
    this.resets++;
  }
}

for (const kind of ['arduino-uno', 'arduino-mega'] as const) {
  describe(`AVR I2C port on the ${kind}`, () => {
    it('the binding exposes the TWI as one static port, the same object for the life of the board', async () => {
      const rig = new AvrI2cRig(kind);
      const [port, ...rest] = rig.binding().i2c ?? [];
      expect(rest).toEqual([]);
      expect(port).toMatchObject({ bus: 'i2c', unit: 0, name: 'TWI' });
      expect(port.routing()).toBe('static');
      await rig.reset();
      await rig.reload();
      expect(rig.binding().i2c?.[0]).toBe(port);
    });

    it('end to end through the registry: a target wired to SDA/SCL answers, keeps answering after Stop/Run, and hears the reset', async () => {
      const rig = new AvrI2cRig(kind);
      const dev = `${rig.id}-reg`;
      rig.wire(dev, 'SDA', rig.v.sda);
      rig.wire(dev, 'SCL', rig.v.scl);
      const target = new RegTarget((i) => i ^ 0x5a);
      const handle = attachI2cTarget({ owner: dev, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x52] }, target);
      try {
        expect(busRegistry.i2cPlacement(dev)).toEqual({
          boardId: rig.id,
          sdaPin: rig.v.sda,
          sclPin: rig.v.scl,
          clocked: true,
        });
        expect(rig.exchange({ address: 0x52, write: [0x10, 0xaa, 0xbb], read: 0 })).toEqual({ status: 0, read: [] });
        expect(rig.exchange({ address: 0x52, write: [0x0f], read: 4 })).toEqual({
          status: 0,
          read: [0x0f ^ 0x5a, 0xaa, 0xbb, 0x12 ^ 0x5a],
        });
        expect(rig.exchange({ address: 0x53, write: [0x00], read: 0 }).status, 'another address').toBe(2);

        await rig.stopRun();
        expect(target.resets).toBe(1);
        expect(rig.exchange({ address: 0x52, write: [0x10], read: 2 })).toEqual({ status: 0, read: [0xaa, 0xbb] });
      } finally {
        handle.dispose();
      }
      // Gone by identity: the address is free again.
      expect(rig.exchange({ address: 0x52, write: [0x00], read: 0 }).status).toBe(2);
    });

    it('a target whose SDA and SCL are on two other GPIOs is not on the TWI: its address is NACKed', () => {
      const rig = new AvrI2cRig(kind);
      const dev = `${rig.id}-elsewhere`;
      rig.wire(dev, 'SDA', rig.v.other.sda);
      rig.wire(dev, 'SCL', rig.v.other.scl);
      const probe = new ProbeTarget([0x42]);
      const handle = attachI2cTarget({ owner: dev, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x42] }, probe);
      try {
        expect(rig.exchange({ address: 0x42, write: [0x01], read: 0 }).status).toBe(2);
        expect(probe.starts).toBe(0);
      } finally {
        handle.dispose();
      }
    });
  });
}

// ── ATtiny85: the USI in two-wire mode ───────────────────────────────────────

describe('ATtiny85: TinyWireM on the USI reaches fabric targets through the software decoder', () => {
  const TINY_HEX = fixture('avr-tiny-oled/avr-tiny-oled.ino.hex');

  /** An SSD1306-shaped target: ACKs 0x3C and records every write transaction. */
  class OledTarget implements I2cTarget {
    txs: number[][] = [];
    private cur: number[] | null = null;
    start(address: number, read: boolean): boolean {
      if (read) return false;
      this.cur = [];
      this.txs.push(this.cur);
      return address === 0x3c;
    }
    write(b: number): boolean {
      this.cur?.push(b);
      return true;
    }
    read(): number {
      return 0xff;
    }
    stop(): void {
      this.cur = null;
    }
  }

  function bootTiny(wire: boolean): { id: string; sim: AVRSimulator; oled: OledTarget; dispose: () => void } {
    const id = `attiny85-i2c${++rigSeq}`;
    const st = useSimulatorStore.getState();
    st.addBoard('attiny85', 0, 0, id);
    const dev = `${id}-oled`;
    if (wire) {
      for (const [pinName, pb] of [
        ['SDA', 'PB0'],
        ['SCL', 'PB2'],
      ] as const) {
        st.addWire({
          id: `${dev}-${pinName}`,
          start: { componentId: dev, pinName, x: 0, y: 0 },
          end: { componentId: id, pinName: pb, x: 0, y: 0 },
          waypoints: [],
          color: '#0a0',
        } as never);
      }
    }
    const oled = new OledTarget();
    const handle = attachI2cTarget({ owner: dev, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x3c] }, oled);
    st.compileBoardProgram(id, TINY_HEX);
    st.startBoard(id);
    const sim = getBoardSimulator(id) as unknown as AVRSimulator;
    return {
      id,
      sim,
      oled,
      dispose: () => {
        handle.dispose();
        st.removeBoard(id);
      },
    };
  }

  const runFor = (sim: AVRSimulator, cycles: number, until: () => boolean) => {
    for (let i = 0; i < cycles; i++) {
      sim.step();
      if ((i & 0xfff) === 0 && until()) return;
    }
  };

  it('the binding reports no I2C controller (the USI is the pins, decoded by the fabric)', () => {
    const t = bootTiny(false);
    try {
      expect(t.sim.getBusBinding().i2c).toEqual([]);
    } finally {
      t.dispose();
    }
  });

  it('the SSD1306 init stream and the framebuffer reach a target on PB0/PB2 byte for byte, and the guest sees every byte ACKed', () => {
    const t = bootTiny(true);
    try {
      expect(busRegistry.i2cPlacement(`${t.id}-oled`)).toMatchObject({ sdaPin: 0, sclPin: 2, clocked: true });
      const pm = t.sim.pinManager;
      // The sketch raises PB3 when every endTransmission() returned 0 and
      // PB4 when any did not: TinyWireM reads each ACK off SDA itself.
      runFor(t.sim, 60_000_000, () => pm.peekPinState(3) === true || pm.peekPinState(4) === true);
      expect(pm.peekPinState(4), 'no transaction was NACKed').not.toBe(true);
      expect(pm.peekPinState(3), 'the sketch finished with every transaction ACKed').toBe(true);
      const init = [0xae, 0x8d, 0x14, 0x20, 0x00, 0x21, 0x00, 0x7f, 0x22, 0x00, 0x07, 0xaf];
      const data = Array.from({ length: 128 }, () => [0x40, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81]);
      expect(t.oled.txs).toEqual([...init.map((c) => [0x00, c]), ...data]);
    } finally {
      t.dispose();
    }
  });

  it('with its SDA/SCL left unwired the target hears nothing, and is not reported as miswired', () => {
    const seen: BusDiagnostic[] = [];
    const off = busRegistry.onDiagnostic((d) => seen.push(d));
    const t = bootTiny(false);
    try {
      runFor(t.sim, 8_000_000, () => false);
      expect(t.oled.txs).toEqual([]);
      // Neither line reaches the board: a part not wired yet, which the fabric
      // leaves unsaid exactly as it does for SPI (F5 part two, item 9). A half
      // wired chip is still named: i2c-registry-part2.test.ts.
      expect(seen.some((d) => d.code === 'i2c-wiring' && d.owners.includes(`${t.id}-oled`))).toBe(false);
    } finally {
      off();
      t.dispose();
    }
  });
});
