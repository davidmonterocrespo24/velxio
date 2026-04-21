/**
 * esp32-dht22-flow.test.ts
 *
 * Tests for the ESP32 sensor registration flow, focusing on the DHT22 example.
 * Verifies:
 *   1. Esp32BridgeShim delegates registerSensor → bridge.sendSensorAttach
 *   2. DHT22 attachEvents detects ESP32 shim and calls registerSensor
 *   3. DHT22 attachEvents falls back to local protocol on AVR (registerSensor → false)
 *   4. Sensor update flow: updateSensor → bridge.sendSensorUpdate
 *   5. Cleanup: unregisterSensor → bridge.sendSensorDetach
 *   6. Esp32Bridge includes pre-registered sensors in start_esp32 payload
 *   7. Race condition fix: sensors are pre-registered before firmware executes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

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
    this.isRunning = vi.fn().mockReturnValue(false);
    this.registerSensor = vi.fn().mockReturnValue(false);
    this.updateSensor = vi.fn();
    this.unregisterSensor = vi.fn();
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
    this.isRunning = vi.fn().mockReturnValue(false);
    this.registerSensor = vi.fn().mockReturnValue(false);
    this.updateSensor = vi.fn();
    this.unregisterSensor = vi.fn();
  }),
}));

vi.mock('../simulation/PinManager', () => ({
  PinManager: vi.fn(function (this: any) {
    this.updatePort = vi.fn();
    this.onPinChange = vi.fn().mockReturnValue(() => {});
    this.onPwmChange = vi.fn().mockReturnValue(() => {});
    this.getListenersCount = vi.fn().mockReturnValue(0);
    this.updatePwm = vi.fn();
  }),
}));

vi.mock('../simulation/I2CBusManager', () => ({
  VirtualDS1307: vi.fn(function (this: any) {}),
  VirtualTempSensor: vi.fn(function (this: any) {}),
  I2CMemoryDevice: vi.fn(function (this: any) {}),
}));

vi.mock('../store/useOscilloscopeStore', () => ({
  useOscilloscopeStore: {
    getState: vi.fn().mockReturnValue({ channels: [], pushSample: vi.fn() }),
  },
}));

// WebSocket mock
class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: any) => void) | null = null;
  onerror: ((e?: any) => void) | null = null;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  receive(payload: object) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** Parse all sent JSON messages */
  get messages(): Array<{ type: string; data: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());
vi.stubGlobal('sessionStorage', {
  getItem: vi.fn().mockReturnValue('test-session-id'),
  setItem: vi.fn(),
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { Esp32Bridge } from '../simulation/Esp32Bridge';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';

// ─── Mock factories ──────────────────────────────────────────────────────────

function makeElement(props: Record<string, unknown> = {}): HTMLElement {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    ...props,
  } as unknown as HTMLElement;
}

/** Simulator mock that mimics Esp32BridgeShim (registerSensor returns true) */
function makeEsp32Shim() {
  const bridge = {
    sendSensorAttach: vi.fn(),
    sendSensorUpdate: vi.fn(),
    sendSensorDetach: vi.fn(),
  };
  return {
    bridge,
    pinManager: {
      onPinChange: vi.fn().mockReturnValue(() => {}),
      onPwmChange: vi.fn().mockReturnValue(() => {}),
    },
    setPinState: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
    registerSensor(type: string, pin: number, properties: Record<string, unknown>): boolean {
      bridge.sendSensorAttach(type, pin, properties);
      return true;
    },
    updateSensor(pin: number, properties: Record<string, unknown>): void {
      bridge.sendSensorUpdate(pin, properties);
    },
    unregisterSensor(pin: number): void {
      bridge.sendSensorDetach(pin);
    },
  };
}

/** Simulator mock that mimics AVR (registerSensor returns false) */
function makeAVRSim() {
  return {
    pinManager: {
      onPinChange: vi.fn().mockReturnValue(() => {}),
      onPwmChange: vi.fn().mockReturnValue(() => {}),
    },
    setPinState: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
    registerSensor: vi.fn().mockReturnValue(false),
    updateSensor: vi.fn(),
    unregisterSensor: vi.fn(),
    schedulePinChange: vi.fn(),
    getCurrentCycles: vi.fn().mockReturnValue(1000),
    cpu: { data: new Uint8Array(512).fill(0), cycles: 1000 },
  };
}

const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Esp32BridgeShim — registerSensor delegates to bridge
// ─────────────────────────────────────────────────────────────────────────────

describe('Esp32BridgeShim — sensor registration', () => {
  it('registerSensor calls bridge.sendSensorAttach and returns true', () => {
    const shim = makeEsp32Shim();
    const result = shim.registerSensor('dht22', 4, { temperature: 28, humidity: 65 });
    expect(result).toBe(true);
    expect(shim.bridge.sendSensorAttach).toHaveBeenCalledWith('dht22', 4, {
      temperature: 28,
      humidity: 65,
    });
  });

  it('updateSensor calls bridge.sendSensorUpdate', () => {
    const shim = makeEsp32Shim();
    shim.updateSensor(4, { temperature: 30, humidity: 70 });
    expect(shim.bridge.sendSensorUpdate).toHaveBeenCalledWith(4, { temperature: 30, humidity: 70 });
  });

  it('unregisterSensor calls bridge.sendSensorDetach', () => {
    const shim = makeEsp32Shim();
    shim.unregisterSensor(4);
    expect(shim.bridge.sendSensorDetach).toHaveBeenCalledWith(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DHT22 attachEvents — ESP32 shim detection
// ─────────────────────────────────────────────────────────────────────────────

describe('dht22 — ESP32 shim detection', () => {
  const logic = () => PartSimulationRegistry.get('dht22')!;

  it('detects ESP32 shim and delegates sensor to backend', () => {
    const shim = makeEsp32Shim();
    const el = makeElement({ temperature: 28, humidity: 65 });
    logic().attachEvents!(el, shim as any, pinMap({ SDA: 4 }), 'dht22-1');

    // Should have called registerSensor → sendSensorAttach
    expect(shim.bridge.sendSensorAttach).toHaveBeenCalledWith('dht22', 4, {
      temperature: 28,
      humidity: 65,
    });

    // Should NOT register onPinChange (local protocol) — ESP32 backend handles it
    expect(shim.pinManager.onPinChange).not.toHaveBeenCalled();
    // Should NOT call setPinState (no local pin driving)
    expect(shim.setPinState).not.toHaveBeenCalled();
  });

  it('cleanup calls unregisterSensor', () => {
    const shim = makeEsp32Shim();
    const el = makeElement({ temperature: 28, humidity: 65 });
    const cleanup = logic().attachEvents!(el, shim as any, pinMap({ SDA: 4 }), 'dht22-1');

    cleanup();
    expect(shim.bridge.sendSensorDetach).toHaveBeenCalledWith(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DHT22 attachEvents — AVR fallback (local protocol)
// ─────────────────────────────────────────────────────────────────────────────

describe('dht22 — AVR local protocol fallback', () => {
  const logic = () => PartSimulationRegistry.get('dht22')!;

  it('falls back to local protocol when registerSensor returns false', () => {
    const sim = makeAVRSim();
    const el = makeElement({ temperature: 25, humidity: 50 });
    logic().attachEvents!(el, sim as any, pinMap({ SDA: 7 }), 'dht22-avr');

    // AVR registerSensor returns false → local protocol path
    expect(sim.registerSensor).toHaveBeenCalledWith('dht22', 7, { temperature: 25, humidity: 50 });

    // Local protocol: onPinChange registered for start-signal detection
    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(7, expect.any(Function));
    // Local protocol: DATA pin set HIGH (idle)
    expect(sim.setPinState).toHaveBeenCalledWith(7, true);
  });

  it('local protocol does NOT call registerSensor on bridge methods', () => {
    const sim = makeAVRSim();
    const el = makeElement({ temperature: 25, humidity: 50 });
    logic().attachEvents!(el, sim as any, pinMap({ SDA: 7 }), 'dht22-avr2');

    // AVR path: uses onPinChange, not bridge sensor methods
    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(7, expect.any(Function));
    // updateSensor/unregisterSensor should NOT have been called
    expect(sim.updateSensor).not.toHaveBeenCalled();
    expect(sim.unregisterSensor).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Sensor update flow
// ─────────────────────────────────────────────────────────────────────────────

describe('dht22 — sensor update via SensorUpdateRegistry', () => {
  const logic = () => PartSimulationRegistry.get('dht22')!;

  it('registerSensorUpdate callback forwards to updateSensor', async () => {
    const shim = makeEsp32Shim();
    const el = makeElement({ temperature: 28, humidity: 65 }) as any;
    logic().attachEvents!(el, shim as any, pinMap({ SDA: 4 }), 'dht22-update');

    // Import the registry and dispatch an update
    const { dispatchSensorUpdate } = await import('../simulation/SensorUpdateRegistry');
    dispatchSensorUpdate('dht22-update', { temperature: 35 });

    // Should have forwarded the update to the bridge
    expect(shim.bridge.sendSensorUpdate).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ temperature: 35 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Esp32Bridge — WebSocket sensor messages
// ─────────────────────────────────────────────────────────────────────────────

describe('Esp32Bridge — sensor WebSocket protocol', () => {
  let bridge: Esp32Bridge;
  let ws: MockWebSocket;

  beforeEach(() => {
    bridge = new Esp32Bridge('test-esp32', 'esp32');
    bridge.connect();
    // Get the WebSocket instance created in connect()
    ws = (bridge as any).socket as MockWebSocket;
    ws.open(); // Trigger onopen → sends start_esp32
    ws.sent = []; // Clear the start_esp32 message
  });

  afterEach(() => {
    bridge.disconnect();
  });

  it('sendSensorAttach sends esp32_sensor_attach message', () => {
    bridge.sendSensorAttach('dht22', 4, { temperature: 28, humidity: 65 });
    expect(ws.messages).toEqual([
      {
        type: 'esp32_sensor_attach',
        data: { sensor_type: 'dht22', pin: 4, temperature: 28, humidity: 65 },
      },
    ]);
  });

  it('sendSensorUpdate sends esp32_sensor_update message', () => {
    bridge.sendSensorUpdate(4, { temperature: 35, humidity: 70 });
    expect(ws.messages).toEqual([
      {
        type: 'esp32_sensor_update',
        data: { pin: 4, temperature: 35, humidity: 70 },
      },
    ]);
  });

  it('sendSensorDetach sends esp32_sensor_detach message', () => {
    bridge.sendSensorDetach(4);
    expect(ws.messages).toEqual([
      {
        type: 'esp32_sensor_detach',
        data: { pin: 4 },
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Esp32Bridge — sensor pre-registration in start_esp32 payload
// ─────────────────────────────────────────────────────────────────────────────

describe('Esp32Bridge — sensor pre-registration', () => {
  it('includes sensors in start_esp32 payload when setSensors is called before connect', () => {
    const bridge = new Esp32Bridge('test-esp32', 'esp32');
    bridge.setSensors([{ sensor_type: 'dht22', pin: 4, temperature: 28, humidity: 65 }]);
    bridge.loadFirmware('AAAA'); // base64 firmware

    bridge.connect();
    const ws = (bridge as any).socket as MockWebSocket;
    ws.open(); // Trigger onopen → sends start_esp32

    const startMsg = ws.messages.find((m) => m.type === 'start_esp32');
    expect(startMsg).toBeDefined();
    expect(startMsg!.data.sensors).toEqual([
      { sensor_type: 'dht22', pin: 4, temperature: 28, humidity: 65 },
    ]);
  });

  it('start_esp32 payload has empty sensors array when none pre-registered', () => {
    const bridge = new Esp32Bridge('test-esp32', 'esp32');
    bridge.loadFirmware('AAAA');
    bridge.connect();
    const ws = (bridge as any).socket as MockWebSocket;
    ws.open();

    const startMsg = ws.messages.find((m) => m.type === 'start_esp32');
    expect(startMsg).toBeDefined();
    expect(startMsg!.data.sensors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Race condition: sensors pre-registered before firmware starts
// ─────────────────────────────────────────────────────────────────────────────

describe('Race condition fix — sensors arrive before firmware', () => {
  it('sensor_attach message is part of start_esp32, not a separate later message', () => {
    const bridge = new Esp32Bridge('test-esp32', 'esp32');
    bridge.setSensors([{ sensor_type: 'dht22', pin: 4, temperature: 28, humidity: 65 }]);
    bridge.loadFirmware('AAAA');

    bridge.connect();
    const ws = (bridge as any).socket as MockWebSocket;
    ws.open();

    // The very first message should be start_esp32 with sensors included
    const firstMsg = ws.messages[0];
    expect(firstMsg.type).toBe('start_esp32');
    expect(firstMsg.data.sensors).toHaveLength(1);
    expect(firstMsg.data.sensors[0].sensor_type).toBe('dht22');
    expect(firstMsg.data.sensors[0].pin).toBe(4);

    // No separate sensor_attach message should be needed at this point
    const sensorAttachMsgs = ws.messages.filter((m) => m.type === 'esp32_sensor_attach');
    expect(sensorAttachMsgs).toHaveLength(0);
  });

  it('sensors can still be attached dynamically after start', () => {
    const bridge = new Esp32Bridge('test-esp32', 'esp32');
    bridge.loadFirmware('AAAA');
    bridge.connect();
    const ws = (bridge as any).socket as MockWebSocket;
    ws.open();
    ws.sent = []; // Clear start_esp32

    // Dynamic attachment (e.g. user adds a sensor during simulation)
    bridge.sendSensorAttach('hc-sr04', 12, { distance: 50 });
    expect(ws.messages).toEqual([
      {
        type: 'esp32_sensor_attach',
        data: { sensor_type: 'hc-sr04', pin: 12, distance: 50 },
      },
    ]);
  });
});
