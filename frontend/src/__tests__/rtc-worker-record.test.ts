// @vitest-environment jsdom
/**
 * The record of a clock chip carries the tab's clock to the worker's copy
 * (project i2c-model-fidelity-2026-09).
 *
 * The worker's own clock is the server's, in the server's time zone: an ESP32
 * on QEMU read its DS1307 in UTC while the same sketch on a board that runs in
 * the tab read the time of the browser. The record says what the tab's clock
 * is, `epochMs` and `utcOffsetMin`, and it says it as of the Run: a part files
 * its record when it attaches, which can be long before the board is started,
 * and an epoch that old would show as a clock that is behind.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks (same shape as esp32-integration.test.ts) ─────────────────────────
vi.mock('../simulation/AVRSimulator', () => ({
  AVRSimulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onBaudRateChange = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadHex = vi.fn();
    this.addI2CDevice = vi.fn();
    this.setPinState = vi.fn();
  }),
}));

vi.mock('../simulation/RP2040Simulator', () => ({
  RP2040Simulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadBinary = vi.fn();
    this.addI2CDevice = vi.fn();
    this.attachPioPeripheral = vi.fn();
    this.spi = { onByte: null, completeTransfer: vi.fn() };
  }),
}));

vi.mock('../simulation/PinManager', () => ({
  PinManager: vi.fn(function (this: any) {
    this.updatePort = vi.fn();
    this.onPinChange = vi.fn().mockReturnValue(() => {});
    this.getListenersCount = vi.fn().mockReturnValue(0);
    this.hardResetPinStates = vi.fn();
    this.resetPinStates = vi.fn();
    this.getOutputPins = vi.fn().mockReturnValue(new Set<number>());
  }),
}));

vi.mock('../store/useOscilloscopeStore', () => ({
  useOscilloscopeStore: {
    getState: vi.fn().mockReturnValue({ channels: [], pushSample: vi.fn() }),
  },
}));

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  get messages(): Array<{ type: string; data: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

import { useSimulatorStore, getEsp32Bridge, getStm32Bridge } from '../store/useSimulatorStore';
import { hostClockRecord, i2cPartWorkerPin } from '../simulation/parts/i2cPart';

const BOARD = 'esp32';

function wire(id: string, a: [string, string], b: [string, string]): Record<string, unknown> {
  return {
    id,
    waypoints: [],
    color: '#000',
    start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
    end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
  };
}

function place(metadataId: 'ds1307' | 'ds3231', properties: Record<string, unknown> = {}): void {
  const s = useSimulatorStore.getState();
  s.setComponents([{ id: 'rtc1', metadataId, x: 0, y: 0, properties }] as never);
  s.setWires([
    wire('w1', ['rtc1', 'SDA'], [BOARD, '21']),
    wire('w2', ['rtc1', 'SCL'], [BOARD, '22']),
  ] as never);
}

/** Press Run and return the records the worker is started with. */
function run(): Array<Record<string, unknown>> {
  const bridge = getEsp32Bridge(BOARD)!;
  useSimulatorStore.getState().startBoard(BOARD);
  const socket = (bridge as unknown as { socket: MockWebSocket }).socket;
  socket.open();
  const start = socket.messages.find((m) => m.type === 'start_esp32');
  expect(start, 'start_esp32 was sent').toBeDefined();
  return start!.data.sensors as Array<Record<string, unknown>>;
}

// 12:34:56.250 of 30 September 2026 on the wall of whoever runs the test.
const ATTACHED = new Date(2026, 8, 30, 12, 34, 56, 250);
const RUN = new Date(2026, 8, 30, 12, 51, 3, 0);
/** Minutes east of UTC, as a JSON round trip writes it: 0, never -0, in UTC (the CI's zone). */
const eastOfUtc = (d: Date) => -d.getTimezoneOffset() || 0;

describe('the record of a clock chip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(ATTACHED);
    useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
    useSimulatorStore.getState().addBoard('esp32' as never, 0, 0, BOARD);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hostClockRecord() is the epoch and the minutes east of UTC', () => {
    expect(hostClockRecord()).toEqual({
      epochMs: ATTACHED.getTime(),
      utcOffsetMin: eastOfUtc(ATTACHED),
    });
    // What the tab's model shows is the epoch moved by the offset.
    const { epochMs, utcOffsetMin } = hostClockRecord();
    const wall = new Date(epochMs + utcOffsetMin * 60_000);
    expect([wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()]).toEqual([12, 34, 56]);
  });

  for (const kind of ['ds1307', 'ds3231'] as const) {
    it(`${kind}: the worker is started with the tab's clock as of the Run`, () => {
      place(kind);
      vi.setSystemTime(RUN);
      expect(run()).toContainEqual(
        expect.objectContaining({
          sensor_type: kind,
          pin: i2cPartWorkerPin('rtc1'),
          addr: 0x68,
          owner: 'rtc1',
          epochMs: RUN.getTime(),
          utcOffsetMin: eastOfUtc(RUN),
        }),
      );
    });

    it(`${kind}: the stamp of the Run replaces the one the part filed when it attached`, () => {
      place(kind);
      // What the part does when the canvas attaches it (parts/i2cPart.ts).
      getEsp32Bridge(BOARD)!.sendSensorAttach(kind, i2cPartWorkerPin('rtc1'), {
        ...hostClockRecord(),
        addr: 0x68,
        owner: 'rtc1',
      });
      vi.setSystemTime(RUN);
      const records = run().filter((r) => r.owner === 'rtc1');
      expect(records).toHaveLength(1);
      expect(records[0].epochMs).toBe(RUN.getTime());
    });
  }

  // A part that is the DS1307 under another name (pro's Grove DS1307 is an
  // alias of it) files the DS1307's record when it attaches, and the store
  // knows nothing of it. Its stamp used to be the one of the attach, so the
  // worker's copy ran behind by the time from the attach to the Run.
  it('a part that is a clock chip under another name is stamped as of the Run', () => {
    const s = useSimulatorStore.getState();
    s.setComponents([
      { id: 'rtc1', metadataId: 'grove-rtc-ds1307', x: 0, y: 0, properties: {} },
    ] as never);
    getEsp32Bridge(BOARD)!.sendSensorAttach('ds1307', i2cPartWorkerPin('rtc1'), {
      ...hostClockRecord(),
      addr: 0x68,
      owner: 'rtc1',
    });
    vi.setSystemTime(RUN);
    const records = run().filter((r) => r.owner === 'rtc1');
    expect(records).toEqual([
      expect.objectContaining({
        sensor_type: 'ds1307',
        epochMs: RUN.getTime(),
        utcOffsetMin: eastOfUtc(RUN),
      }),
    ]);
  });

  it('STM32: a clock chip under another name is stamped as of the Run', () => {
    const s = useSimulatorStore.getState();
    const bp = s.addBoard('stm32-bluepill' as never, 100, 100);
    s.setComponents([
      { id: 'rtc1', metadataId: 'grove-rtc-ds1307', x: 0, y: 0, properties: {} },
    ] as never);
    const bridge = getStm32Bridge(bp)!;
    bridge.sendSensorAttach('ds3231', i2cPartWorkerPin('rtc1'), {
      ...hostClockRecord(),
      temperature: 21,
      addr: 0x68,
      owner: 'rtc1',
    });
    vi.setSystemTime(RUN);
    useSimulatorStore.getState().startBoard(bp);
    const socket = (bridge as unknown as { socket: MockWebSocket }).socket;
    socket.open();
    const start = socket.messages.find((m) => m.type === 'start_stm32');
    expect(start, 'start_stm32 was sent').toBeDefined();
    const records = (start!.data.sensors as Array<Record<string, unknown>>).filter(
      (r) => r.owner === 'rtc1',
    );
    expect(records).toEqual([
      expect.objectContaining({ sensor_type: 'ds3231', temperature: 21, epochMs: RUN.getTime() }),
    ]);
  });

  it('ds3231: the record carries the temperature of the project with the clock', () => {
    place('ds3231', { temperature: '31.75' });
    expect(run()).toContainEqual(
      expect.objectContaining({
        sensor_type: 'ds3231',
        temperature: 31.75,
        epochMs: ATTACHED.getTime(),
      }),
    );
  });

  it('a part that keeps no time carries no clock', () => {
    const s = useSimulatorStore.getState();
    s.setComponents([{ id: 'imu1', metadataId: 'mpu6050', x: 0, y: 0, properties: {} }] as never);
    s.setWires([
      wire('w1', ['imu1', 'SDA'], [BOARD, '21']),
      wire('w2', ['imu1', 'SCL'], [BOARD, '22']),
    ] as never);
    const record = run().find((r) => r.sensor_type === 'mpu6050')!;
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty('epochMs');
    expect(record).not.toHaveProperty('utcOffsetMin');
  });
});
