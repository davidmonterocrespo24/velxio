/**
 * The MPU-6050 powers on asleep, as the chip does, and a sketch that reads it
 * without waking it is told so where it is looking: the serial monitor.
 *
 * fixtures/avr-mpu6050-asleep is that sketch, the most common first bug with
 * this sensor: it reads ACCEL_XOUT_H and never writes PWR_MGMT_1. On the
 * bench it prints zeros. Here it runs as real firmware on avr8js through the
 * store's own lifecycle (compileBoardProgram, startBoard, stopBoard,
 * resetBoard), with the part mounted the way the canvas mounts it, so the
 * note travels the whole way: the model, the bus registry's diagnostics, the
 * store's listener, the board's monitor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// startBoard hands the CPU loop to the browser's frame clock. Here the test
// steps the CPU itself, so the frame never comes.
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});

import {
  useSimulatorStore,
  getBoardSimulator,
  replayProjectSensorValuesOnAttach,
} from '../store/useSimulatorStore';
import type { AVRSimulator } from '../simulation/AVRSimulator';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { FRAME_WAIT_MS } from '../store/serialBatcher';

const HEX = readFileSync(
  fileURLToPath(
    new URL('./fixtures/avr-mpu6050-asleep/avr-mpu6050-asleep.ino.hex', import.meta.url),
  ),
  'utf-8',
);

const NOTE = '[Velxio] MPU6050 0x68 is in sleep mode: write 0x00 to PWR_MGMT_1 (0x6B) to wake it';

let seq = 0;

/** One Uno of the real store with an MPU-6050 on A4/A5, mounted as the canvas mounts it. */
class Bench {
  readonly id = `arduino-uno-imu${++seq}`;
  out = '';
  private cleanup: (() => void) | undefined;
  private readonly unsubscribe: () => void;

  constructor() {
    const st = useSimulatorStore.getState();
    st.addBoard('arduino-uno', 0, 0, this.id);
    st.setActiveBoardId(this.id);
    st.setComponents([{ id: 'imu', metadataId: 'mpu6050', x: 0, y: 0, properties: {} }] as never);
    this.wire('SDA', 'A4');
    this.wire('SCL', 'A5');
    this.attach();
    // DynamicComponent: every part attaches again when hexEpoch moves.
    let epoch = useSimulatorStore.getState().hexEpoch;
    this.unsubscribe = useSimulatorStore.subscribe((s) => {
      if (s.hexEpoch === epoch) return;
      epoch = s.hexEpoch;
      this.cleanup?.();
      this.attach();
    });
  }

  get sim(): AVRSimulator {
    return getBoardSimulator(this.id) as unknown as AVRSimulator;
  }

  private wire(pin: string, boardPin: string): void {
    useSimulatorStore.getState().addWire({
      id: `${this.id}-${pin}`,
      start: { componentId: 'imu', pinName: pin, x: 0, y: 0 },
      end: { componentId: this.id, pinName: boardPin, x: 0, y: 0 },
      waypoints: [],
      color: '#0a0',
    } as never);
  }

  private attach(): void {
    const el = new EventTarget() as unknown as HTMLElement;
    this.cleanup = PartSimulationRegistry.get('mpu6050')!.attachEvents!(
      el,
      this.sim as never,
      () => null,
      'imu',
    );
    replayProjectSensorValuesOnAttach('imu');
  }

  load(): void {
    useSimulatorStore.getState().compileBoardProgram(this.id, HEX);
  }

  run(): void {
    useSimulatorStore.getState().startBoard(this.id);
    // The sketch's own bytes are read here; the monitor keeps the notes.
    this.sim.onSerialData = (ch: string) => {
      this.out += ch;
    };
  }

  stop(): void {
    useSimulatorStore.getState().stopBoard(this.id);
  }

  reset(): void {
    useSimulatorStore.getState().resetBoard(this.id);
  }

  /** Step the CPU until the sketch has printed `count` more readings; returns them. */
  readings(count: number, budget = 6_000_000): string[] {
    const from = this.out.length;
    for (let i = 0; i < budget; i++) {
      this.sim.step();
      if ((i & 0x3ff) !== 0) continue;
      const found = this.out.slice(from).match(/A=[^\r\n]*\r?\n/g);
      if (found && found.length >= count) return found.slice(0, count).map((l) => l.trim());
    }
    throw new Error(
      `no ${count} readings; the sketch printed ${JSON.stringify(this.out.slice(from))}`,
    );
  }

  /** What the board's serial monitor holds, once the batcher has flushed. The
   *  frame is stubbed out above, so the batcher's timer flushes, after
   *  FRAME_WAIT_MS. */
  async monitor(): Promise<string> {
    await new Promise((r) => setTimeout(r, FRAME_WAIT_MS + 50));
    return useSimulatorStore.getState().boards.find((b) => b.id === this.id)?.serialOutput ?? '';
  }

  dispose(): void {
    this.unsubscribe();
    this.cleanup?.();
    useSimulatorStore.getState().removeBoard(this.id);
  }
}

const notesIn = (monitor: string): number => monitor.split(NOTE).length - 1;

let benches: Bench[] = [];
const bench = () => {
  const b = new Bench();
  benches.push(b);
  return b;
};

beforeEach(() => {
  benches = [];
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});
afterEach(() => {
  for (const b of benches) b.dispose();
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

describe('a sketch that reads the MPU-6050 without waking it', () => {
  it('reads zeros whatever the panel says, and its monitor says why, once', async () => {
    const b = bench();
    b.load();
    b.run();
    expect(b.readings(3)).toEqual(['A=0,0,0', 'A=0,0,0', 'A=0,0,0']);
    dispatchSensorUpdate('imu', { accelX: 1, accelZ: -1 });
    expect(b.readings(3)).toEqual(['A=0,0,0', 'A=0,0,0', 'A=0,0,0']);

    const monitor = await b.monitor();
    expect(monitor).toContain(NOTE);
    expect(notesIn(monitor)).toBe(1);
  }, 120_000);

  it('is told again on the next Run: Stop resets the MCU, the chip stays as it was', async () => {
    const b = bench();
    b.load();
    b.run();
    b.readings(2);
    const before = notesIn(await b.monitor());
    expect(before).toBe(1);

    b.stop();
    b.run();
    expect(b.readings(2)).toEqual(['A=0,0,0', 'A=0,0,0']);
    expect(notesIn(await b.monitor())).toBe(before + 1);
  }, 120_000);

  it('is told again after Reset, which starts every part anew', async () => {
    const b = bench();
    b.load();
    b.run();
    b.readings(2);
    expect(notesIn(await b.monitor())).toBe(1);

    b.reset();
    b.run();
    expect(b.readings(2)).toEqual(['A=0,0,0', 'A=0,0,0']);
    // Reset cleared the monitor: this is the note of the new run.
    expect(notesIn(await b.monitor())).toBe(1);
  }, 120_000);
});
