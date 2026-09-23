/**
 * Board buses F2: the AVR engine's SPI controller port against the shared
 * conformance suite (project/board-buses-2026-09, F2-SPEC, TESTS.md layer 2),
 * plus what the suite cannot see on this engine: the SPI configuration it
 * reports, the transition bridge (`simulator.spi`), the reset notification,
 * the fabric end to end, and the ATtiny85.
 *
 * Everything under test is the real thing: avr8js behind AVRSimulator, driven
 * through the store's own lifecycle (addBoard, compileBoardProgram, startBoard,
 * stopBoard, resetBoard) with a real guest. fixtures/conf-avr-spi is one
 * sketch built for the Uno and for the Mega with the production toolchain (the
 * .ino says how to rebuild it); the rig types each GuestTransaction to it over
 * the board's serial port ('x CS HH ..') and reads back the bytes the sketch
 * got from SPI.transfer(). Only the frame clock is a stand-in: the store's
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

import {
  useSimulatorStore,
  getBoardSimulator,
  getBoardPinManager,
} from '../../store/useSimulatorStore';
import type { AVRSimulator } from '../../simulation/AVRSimulator';
import { attachSpiDevice } from '../../simulation/buses';
import type { EngineBinding, SpiControllerConfig } from '../../simulation/buses/types';
import {
  defineSpiPortConformance,
  ProbeDevice,
  type GuestTransaction,
  type SpiConformanceRig,
} from '../../simulation/buses/conformance/spiPortConformance';

const hexOf = (dir: string) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/conf-avr-spi/${dir}/conf-avr-spi.ino.hex`, import.meta.url)),
    'utf-8',
  );

type AvrKind = 'arduino-uno' | 'arduino-mega';

interface Variant {
  hex: string;
  /** Chip select the guest drives: SS on the Uno, a plain PORTL GPIO on the Mega. */
  cs: number;
  /** A second GPIO, for a transaction that selects someone else. */
  otherCs: number;
  /** Where the ATmega's SPI pins are (the board's pin function table). */
  spi: { sck: number; mosi: number; miso: number };
}

const VARIANTS: Record<AvrKind, Variant> = {
  'arduino-uno': { hex: hexOf('uno'), cs: 10, otherCs: 7, spi: { sck: 13, mosi: 11, miso: 12 } },
  'arduino-mega': { hex: hexOf('mega'), cs: 49, otherCs: 7, spi: { sck: 52, mosi: 51, miso: 50 } },
};

const hex2 = (b: number) => b.toString(16).padStart(2, '0');

let rigSeq = 0;
const liveRigs = new Set<AvrRig>();
afterEach(() => {
  for (const r of liveRigs) r.dispose();
  liveRigs.clear();
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

/** One board of the real store, running the conformance guest. */
class AvrRig implements SpiConformanceRig {
  readonly units = [0];
  readonly id: string;
  readonly v: Variant;
  out = '';
  /** Serial offset where the current boot began: READY is looked for after it. */
  private bootFrom = 0;
  private booted = false;

  constructor(kind: AvrKind) {
    this.v = VARIANTS[kind];
    this.id = `${kind}-conf${++rigSeq}`;
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

  csPinFor(): number {
    return this.v.cs;
  }

  binding(): EngineBinding {
    return this.sim.getBusBinding();
  }

  expectedRouting(): { sck: number; mosi: number; miso: number } {
    return this.v.spi;
  }

  onPinEdge(pin: number, cb: () => void): () => void {
    return getBoardPinManager(this.id)!.onPinChange(pin, () => cb());
  }

  async run(transactions: GuestTransaction[]): Promise<number[][]> {
    // After Reset the board is stopped: the user presses Run.
    const board = useSimulatorStore.getState().boards.find((b) => b.id === this.id);
    if (!board?.running) useSimulatorStore.getState().startBoard(this.id);
    this.awaitBoot();
    return transactions.map((t) => {
      if (t.unit !== 0) throw new Error(`the ATmega has one SPI controller, not unit ${t.unit}`);
      return this.transact(t.csPin, t.bytes);
    });
  }

  /** One transaction on `cs`; the bytes the guest read back. */
  transact(cs: number, bytes: number[]): number[] {
    this.awaitBoot();
    return this.cmd(`x ${cs} ${bytes.map(hex2).join(' ')}`)
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => parseInt(h, 16));
  }

  /** Reset button: resetBoard (the board stops; run() presses Run again). */
  async reset(): Promise<void> {
    useSimulatorStore.getState().resetBoard(this.id);
    this.rebooted();
  }

  /** Stop, then Run, with no recompile. */
  async stopRun(): Promise<void> {
    const st = useSimulatorStore.getState();
    st.stopBoard(this.id);
    this.rebooted();
    st.startBoard(this.id);
  }

  /** A recompile of the same sketch lands in compileBoardProgram. */
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
      6_000_000,
      `no answer to "${line}"`,
    );
    return answer;
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

defineSpiPortConformance('AVR ATmega328P (Arduino Uno)', async () => new AvrRig('arduino-uno'), {
  staticRouting: true,
});
defineSpiPortConformance('AVR ATmega2560 (Arduino Mega)', async () => new AvrRig('arduino-mega'), {
  staticRouting: true,
});

// ── What the suite does not cover on this engine ────────────────────────────

const PATTERN = [0x00, 0xff, 0x5a, 0xa5, 0x01, 0x80, 0x3c, 0xc3];

for (const kind of ['arduino-uno', 'arduino-mega'] as const) {
  describe(`AVR SPI port on the ${kind}`, () => {
    it('config() reports the mode, bit order and clock the sketch set, in standard SPI numbering', () => {
      const rig = new AvrRig(kind);
      const port = rig.binding().spi[0];
      expect(port.config(), 'before SPI.begin() the controller is off').toMatchObject({
        enabled: false,
      });
      // [mode, MSB first, clock]: SPISettings picks the divider (4, 16, 2).
      const cases: Array<[0 | 1 | 2 | 3, 0 | 1, number]> = [
        [0, 1, 4_000_000],
        [1, 1, 4_000_000],
        [2, 0, 1_000_000],
        [3, 1, 8_000_000],
      ];
      for (const [mode, msb, hz] of cases) {
        expect(rig.cmd(`m ${mode} ${msb} ${hz}`)).toBe('');
        let atFrame: SpiControllerConfig | null = null;
        port.setFrameHandler(() => {
          atFrame ??= port.config();
          return 0xff;
        });
        rig.transact(rig.v.cs, [0x42]);
        port.setFrameHandler(null);
        const want: SpiControllerConfig = {
          enabled: true,
          mode,
          bitOrder: msb ? 'msb' : 'lsb',
          bits: 8,
          hz,
        };
        expect(atFrame, `SPI_MODE${mode}, ${msb ? 'MSB' : 'LSB'} first, ${hz} Hz`).toEqual(want);
      }
    });

    // The F2 transition bridge (`simulator.spi`) lived here: one case for the
    // channel's identity across Stop/Run, Reset and a reload, one for the
    // chain's last-answer-wins rule. F3 removed the channel; a device joins
    // this bus through the fabric alone. The identity claim is asserted on the
    // fabric below ('end to end through the registry'), and one-answer-per-frame
    // is in defineSpiPortConformance.

    it('pins.driveInput puts a level on an input the guest reads, and peekPinState follows what the guest drives', () => {
      const rig = new AvrRig(kind);
      const { pins } = rig.binding();
      const pin = rig.v.otherCs;
      pins.driveInput!(pin, true);
      expect(rig.cmd(`r ${pin}`)).toBe('1');
      pins.driveInput!(pin, false);
      expect(rig.cmd(`r ${pin}`)).toBe('0');
      pins.driveInput!(pin, true);
      expect(rig.cmd(`r ${pin}`)).toBe('1');

      // The first transaction takes CS from never written to high; the next
      // one is a clean low pulse.
      rig.transact(rig.v.cs, [0x00]);
      const edges: boolean[] = [];
      const off = pins.onPinChange(rig.v.cs, (_p, level) => edges.push(level));
      rig.transact(rig.v.cs, [0x00]);
      off();
      expect(edges, 'the chip select of one transaction').toEqual([false, true]);
      expect(pins.peekPinState(rig.v.cs)).toBe(true);
    });

    it('the reset handler runs after the board pins are undriven again, on a reload, a Reset and a Stop', async () => {
      const rig = new AvrRig(kind);
      const binding = rig.binding();
      const cs = rig.v.cs;
      const seen: Array<boolean | undefined> = [];
      binding.setResetHandler!(() => seen.push(binding.pins.peekPinState(cs)));
      const tx: GuestTransaction[] = [{ unit: 0, csPin: cs, bytes: [0x01] }];

      await rig.run(tx);
      expect(binding.pins.peekPinState(cs), 'the transaction leaves CS high').toBe(true);
      await rig.reload();
      expect(seen).toEqual([undefined]);

      await rig.run(tx);
      await rig.reset();
      expect(seen).toEqual([undefined, undefined]);

      await rig.run(tx);
      useSimulatorStore.getState().stopBoard(rig.id);
      expect(seen).toEqual([undefined, undefined, undefined]);
    });

    it('end to end through the registry: a device wired to the SPI pins answers its own chip select, and keeps answering after Stop/Run', async () => {
      const rig = new AvrRig(kind);
      const dev = `${rig.id}-dev`;
      let wireSeq = 0;
      const wire = (pin: string, boardPin: number) =>
        useSimulatorStore.getState().addWire({
          id: `${dev}-w${++wireSeq}`,
          start: { componentId: dev, pinName: pin, x: 0, y: 0 },
          end: { componentId: rig.id, pinName: String(boardPin), x: 0, y: 0 },
          waypoints: [],
          color: '#0a0',
        } as never);
      wire('SCK', rig.v.spi.sck);
      wire('MOSI', rig.v.spi.mosi);
      wire('MISO', rig.v.spi.miso);
      wire('CS', rig.v.cs);

      class Device extends ProbeDevice {
        resets = 0;
        boardReset(): void {
          this.resets++;
        }
      }
      const device = new Device();
      const handle = attachSpiDevice(
        { owner: dev, pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } },
        device,
      );
      try {
        expect(rig.transact(rig.v.cs, PATTERN)).toEqual(ProbeDevice.expected(PATTERN));
        expect(rig.transact(rig.v.otherCs, PATTERN), 'another chip selected').toEqual(
          PATTERN.map(() => 0xff),
        );
        expect(device.heard).toEqual(PATTERN);

        await rig.stopRun();
        expect(device.resets).toBe(1);
        const [again] = await rig.run([{ unit: 0, csPin: rig.v.cs, bytes: [0x11, 0x22] }]);
        expect(again).toEqual(ProbeDevice.expected([0x11, 0x22]));
        expect(device.heard).toEqual([...PATTERN, 0x11, 0x22]);
      } finally {
        handle.dispose();
      }
    });
  });
}

// ── ATtiny85 ─────────────────────────────────────────────────────────────────

describe('ATtiny85 bus binding', () => {
  it('exposes the board pins and resets, and no SPI controller (the USI has no frame avr8js can report)', () => {
    const id = `attiny85-conf${++rigSeq}`;
    const st = useSimulatorStore.getState();
    st.addBoard('attiny85', 0, 0, id);
    try {
      const sim = getBoardSimulator(id) as unknown as AVRSimulator;
      const binding = sim.getBusBinding();
      expect(binding.spi).toEqual([]);
      expect(sim.getBusBinding(), 'one binding for the life of the simulator').toBe(binding);

      // The pins are the board's PinManager.
      const pm = getBoardPinManager(id)!;
      const levels: boolean[] = [];
      const off = binding.pins.onPinChange(3, (_p, l) => levels.push(l));
      pm.triggerPinChange(3, true);
      expect(binding.pins.peekPinState(3)).toBe(true);
      expect(levels).toEqual([true]);
      off();

      const resets: Array<boolean | undefined> = [];
      binding.setResetHandler!(() => resets.push(binding.pins.peekPinState(3)));
      st.compileBoardProgram(
        id,
        readFileSync(
          fileURLToPath(new URL('./fixtures/avr-tiny-oled/avr-tiny-oled.ino.hex', import.meta.url)),
          'utf-8',
        ),
      );
      expect(resets).toEqual([undefined]);
      st.stopBoard(id);
      expect(resets).toEqual([undefined, undefined]);
    } finally {
      st.removeBoard(id);
    }
  });
});
