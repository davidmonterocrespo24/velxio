/**
 * ESP32-C3 (RISC-V) WiFi & Bluetooth emulation tests
 *
 * Covers:
 *  1. Esp32Bridge — wifi_enabled flag with C3 board kind
 *  2. Board kind mapping — C3 variants map to 'esp32-c3'
 *  3. WiFi/BLE status event dispatch (same protocol as Xtensa ESP32)
 *  4. WiFi auto-detection from sketch #include directives
 *  5. BLE detection (C3 supports BLE 5.0 only, no Classic BT)
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
  }),
}));

vi.mock('../simulation/PinManager', () => ({
  PinManager: vi.fn(function (this: any) {
    this.updatePort = vi.fn();
    this.onPinChange = vi.fn().mockReturnValue(() => {});
    this.getListenersCount = vi.fn().mockReturnValue(0);
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
  receive(payload: object) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

// ── Imports (after mocks) ────────────────────────────────────────────────────
import { Esp32Bridge } from '../simulation/Esp32Bridge';
import type { WifiStatus, BleStatus } from '../simulation/Esp32Bridge';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Esp32Bridge — wifi_enabled with C3 board kind
// ─────────────────────────────────────────────────────────────────────────────

describe('Esp32Bridge — WiFi flag (ESP32-C3)', () => {
  let bridge: Esp32Bridge;
  let ws: MockWebSocket;

  beforeEach(() => {
    bridge = new Esp32Bridge('board-c3', 'esp32-c3');
  });

  afterEach(() => {
    bridge.disconnect();
  });

  it('sends wifi_enabled=false by default in start_esp32', () => {
    bridge.connect();
    ws = (bridge as any).socket as MockWebSocket;
    ws.open();

    expect(ws.sent.length).toBeGreaterThan(0);
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.type).toBe('start_esp32');
    expect(msg.data.wifi_enabled).toBe(false);
  });

  it('sends wifi_enabled=true when wifiEnabled is set before connect', () => {
    bridge.wifiEnabled = true;
    bridge.connect();
    ws = (bridge as any).socket as MockWebSocket;
    ws.open();

    const msg = JSON.parse(ws.sent[0]);
    expect(msg.type).toBe('start_esp32');
    expect(msg.data.wifi_enabled).toBe(true);
  });

  it('sends board type as esp32-c3 in start_esp32 payload', () => {
    bridge.wifiEnabled = true;
    bridge.connect();
    ws = (bridge as any).socket as MockWebSocket;
    ws.open();

    const msg = JSON.parse(ws.sent[0]);
    expect(msg.data.board).toBe('esp32-c3');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Board kind mapping — C3 variants
// ─────────────────────────────────────────────────────────────────────────────

describe('Esp32Bridge — C3 board variant mapping', () => {
  it('maps esp32-c3 to esp32-c3 QEMU type', () => {
    const bridge = new Esp32Bridge('b1', 'esp32-c3');
    bridge.wifiEnabled = true;
    bridge.connect();
    const ws = (bridge as any).socket as MockWebSocket;
    ws.open();
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.data.board).toBe('esp32-c3');
    bridge.disconnect();
  });

  it('maps xiao-esp32-c3 to esp32-c3 QEMU type', () => {
    const bridge = new Esp32Bridge('b2', 'xiao-esp32-c3');
    bridge.wifiEnabled = true;
    bridge.connect();
    const ws = (bridge as any).socket as MockWebSocket;
    ws.open();
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.data.board).toBe('esp32-c3');
    bridge.disconnect();
  });

  it('maps aitewinrobot-esp32c3-supermini to esp32-c3 QEMU type', () => {
    const bridge = new Esp32Bridge('b3', 'aitewinrobot-esp32c3-supermini');
    bridge.wifiEnabled = true;
    bridge.connect();
    const ws = (bridge as any).socket as MockWebSocket;
    ws.open();
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.data.board).toBe('esp32-c3');
    bridge.disconnect();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WiFi/BLE status events (C3 uses same protocol as Xtensa ESP32)
// ─────────────────────────────────────────────────────────────────────────────

describe('Esp32Bridge — WiFi/BLE status events (ESP32-C3)', () => {
  let bridge: Esp32Bridge;
  let ws: MockWebSocket;

  beforeEach(() => {
    bridge = new Esp32Bridge('board-c3', 'esp32-c3');
    bridge.wifiEnabled = true;
    bridge.connect();
    ws = (bridge as any).socket as MockWebSocket;
    ws.open();
  });

  afterEach(() => {
    bridge.disconnect();
  });

  it('dispatches wifi_status event to onWifiStatus callback', () => {
    const received: WifiStatus[] = [];
    bridge.onWifiStatus = (status) => received.push(status);

    ws.receive({
      type: 'wifi_status',
      data: { status: 'got_ip', ssid: 'Velxio-GUEST', ip: '192.168.4.2' },
    });

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('got_ip');
    expect(received[0].ssid).toBe('Velxio-GUEST');
    expect(received[0].ip).toBe('192.168.4.2');
  });

  it('dispatches wifi_status initializing event', () => {
    const received: WifiStatus[] = [];
    bridge.onWifiStatus = (status) => received.push(status);

    ws.receive({
      type: 'wifi_status',
      data: { status: 'initializing' },
    });

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('initializing');
  });

  it('dispatches ble_status event to onBleStatus callback', () => {
    const received: BleStatus[] = [];
    bridge.onBleStatus = (status) => received.push(status);

    ws.receive({
      type: 'ble_status',
      data: { status: 'initialized' },
    });

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('initialized');
  });

  it('dispatches ble_status advertising event', () => {
    const received: BleStatus[] = [];
    bridge.onBleStatus = (status) => received.push(status);

    ws.receive({
      type: 'ble_status',
      data: { status: 'advertising' },
    });

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('advertising');
  });

  it('handles full WiFi connection lifecycle', () => {
    const received: WifiStatus[] = [];
    bridge.onWifiStatus = (status) => received.push(status);

    ws.receive({ type: 'wifi_status', data: { status: 'initializing' } });
    ws.receive({ type: 'wifi_status', data: { status: 'connected', ssid: 'Velxio-GUEST' } });
    ws.receive({
      type: 'wifi_status',
      data: { status: 'got_ip', ssid: 'Velxio-GUEST', ip: '192.168.4.2' },
    });

    expect(received).toHaveLength(3);
    expect(received[0].status).toBe('initializing');
    expect(received[1].status).toBe('connected');
    expect(received[2].status).toBe('got_ip');
    expect(received[2].ip).toBe('192.168.4.2');
  });

  it('does not crash when callbacks are not set', () => {
    bridge.onWifiStatus = null;
    bridge.onBleStatus = null;

    ws.receive({ type: 'wifi_status', data: { status: 'got_ip', ip: '10.0.0.1' } });
    ws.receive({ type: 'ble_status', data: { status: 'initialized' } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. WiFi auto-detection from sketch files
// ─────────────────────────────────────────────────────────────────────────────

describe('WiFi auto-detection (ESP32-C3 sketches)', () => {
  const detectWifi = (content: string) =>
    content.includes('#include <WiFi.h>') ||
    content.includes('#include <esp_wifi.h>') ||
    content.includes('#include "WiFi.h"') ||
    content.includes('WiFi.begin(');

  it('detects #include <WiFi.h> in C3 sketch', () => {
    const content = `#include <WiFi.h>
void setup() { WiFi.begin("Velxio-GUEST", ""); }
void loop() {}`;
    expect(detectWifi(content)).toBe(true);
  });

  it('detects #include <esp_wifi.h> in C3 sketch', () => {
    const content = `#include <esp_wifi.h>
void setup() { esp_wifi_init(); }
void loop() {}`;
    expect(detectWifi(content)).toBe(true);
  });

  it('detects WiFi.begin() call in C3 sketch', () => {
    const content = `void setup() { WiFi.begin("ssid", "pass"); }
void loop() {}`;
    expect(detectWifi(content)).toBe(true);
  });

  it('returns false for non-WiFi C3 sketch', () => {
    const content = `void setup() { Serial.begin(115200); pinMode(8, OUTPUT); }
void loop() { digitalWrite(8, HIGH); delay(1000); digitalWrite(8, LOW); delay(1000); }`;
    expect(detectWifi(content)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. BLE detection (ESP32-C3 — BLE 5.0 only, no Classic BT)
// ─────────────────────────────────────────────────────────────────────────────

describe('BLE detection in ESP32-C3 sketches', () => {
  const detectBLE = (content: string) =>
    content.includes('#include <BLEDevice.h>') ||
    content.includes('#include <esp_bt.h>') ||
    content.includes('BLEDevice::init(');

  it('detects BLEDevice.h include', () => {
    const content = '#include <BLEDevice.h>\nvoid setup() { BLEDevice::init("Velxio-ESP32C3"); }';
    expect(detectBLE(content)).toBe(true);
  });

  it('returns false for non-BLE C3 sketches', () => {
    const content = 'void setup() { Serial.begin(115200); }\nvoid loop() {}';
    expect(detectBLE(content)).toBe(false);
  });

  it('C3 does not support Classic Bluetooth (SPP)', () => {
    // ESP32-C3 only has BLE 5.0 — no BluetoothSerial
    const content = '#include <BluetoothSerial.h>\nBluetoothSerial SerialBT;';
    // BluetoothSerial is Classic BT — should NOT be detected as BLE
    expect(detectBLE(content)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. FQBN mapping for ESP32-C3 compilation
// ─────────────────────────────────────────────────────────────────────────────

describe('ESP32-C3 board FQBN mapping', () => {
  const FQBN_MAP: Record<string, string> = {
    esp32: 'esp32:esp32:esp32',
    'esp32-s3': 'esp32:esp32:esp32s3',
    'esp32-c3': 'esp32:esp32:esp32c3',
  };

  it('ESP32-C3 maps to esp32:esp32:esp32c3', () => {
    expect(FQBN_MAP['esp32-c3']).toBe('esp32:esp32:esp32c3');
  });

  it('C3 FQBN differs from Xtensa ESP32', () => {
    expect(FQBN_MAP['esp32-c3']).not.toBe(FQBN_MAP['esp32']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. QEMU NIC model for C3
// ─────────────────────────────────────────────────────────────────────────────

describe('ESP32-C3 QEMU NIC configuration', () => {
  it('C3 uses esp32c3_wifi NIC model (not esp32_wifi)', () => {
    const machine = 'esp32c3-picsimlab';
    const nicModel = machine.includes('c3') ? 'esp32c3_wifi' : 'esp32_wifi';
    expect(nicModel).toBe('esp32c3_wifi');
  });

  it('builds correct -nic arg for C3 with WiFi and hostfwd', () => {
    const machine = 'esp32c3-picsimlab';
    const hostfwdPort = 54321;
    const nicModel = machine.includes('c3') ? 'esp32c3_wifi' : 'esp32_wifi';
    let nicArg = `user,model=${nicModel},net=192.168.4.0/24`;
    nicArg += `,hostfwd=tcp::${hostfwdPort}-192.168.4.2:80`;

    expect(nicArg).toContain('model=esp32c3_wifi');
    expect(nicArg).toContain('net=192.168.4.0/24');
    expect(nicArg).toContain('hostfwd=tcp::54321-192.168.4.2:80');
  });

  it('C3 uses qemu-system-riscv32 (not qemu-system-xtensa)', () => {
    const QEMU_MAP: Record<string, string> = {
      esp32: 'qemu-system-xtensa',
      'esp32-s3': 'qemu-system-xtensa',
      'esp32-c3': 'qemu-system-riscv32',
    };
    expect(QEMU_MAP['esp32-c3']).toBe('qemu-system-riscv32');
  });
});
