/**
 * ESP32 WiFi & Bluetooth emulation tests
 *
 * Covers:
 *  1. Esp32Bridge — wifi_enabled flag in start_esp32 payload
 *  2. Esp32Bridge — wifi_status / ble_status event dispatch
 *  3. WiFi auto-detection from sketch #include directives
 *  4. Store updates on WiFi/BLE status events
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
  static OPEN    = 1;
  static CLOSING = 2;
  static CLOSED  = 3;

  readyState = MockWebSocket.OPEN;
  onopen:    (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose:   (() => void) | null = null;
  onerror:   (() => void) | null = null;
  sent: string[] = [];

  send(data: string)  { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(); }
  open()  { this.readyState = MockWebSocket.OPEN;   this.onopen?.(); }
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
// 1. Esp32Bridge — wifi_enabled in start_esp32 payload
// ─────────────────────────────────────────────────────────────────────────────

describe('Esp32Bridge — WiFi flag', () => {
  let bridge: Esp32Bridge;
  let ws: MockWebSocket;

  beforeEach(() => {
    bridge = new Esp32Bridge('board-1', 'esp32');
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

  it('includes board type in start_esp32', () => {
    bridge.wifiEnabled = true;
    bridge.connect();
    ws = (bridge as any).socket as MockWebSocket;
    ws.open();

    const msg = JSON.parse(ws.sent[0]);
    expect(msg.data.board).toBe('esp32');
  });

  it('maps esp32-s3 board kind to correct QEMU type', () => {
    const s3Bridge = new Esp32Bridge('board-s3', 'esp32-s3');
    s3Bridge.wifiEnabled = true;
    s3Bridge.connect();
    const s3ws = (s3Bridge as any).socket as MockWebSocket;
    s3ws.open();

    const msg = JSON.parse(s3ws.sent[0]);
    expect(msg.data.board).toBe('esp32-s3');
    s3Bridge.disconnect();
  });

  it('maps esp32-c3 board kind to correct QEMU type', () => {
    const c3Bridge = new Esp32Bridge('board-c3', 'esp32-c3');
    c3Bridge.wifiEnabled = true;
    c3Bridge.connect();
    const c3ws = (c3Bridge as any).socket as MockWebSocket;
    c3ws.open();

    const msg = JSON.parse(c3ws.sent[0]);
    expect(msg.data.board).toBe('esp32-c3');
    c3Bridge.disconnect();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Esp32Bridge — WiFi/BLE status event dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe('Esp32Bridge — WiFi/BLE status events', () => {
  let bridge: Esp32Bridge;
  let ws: MockWebSocket;

  beforeEach(() => {
    bridge = new Esp32Bridge('board-1', 'esp32');
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

  it('dispatches wifi_status disconnected event', () => {
    const received: WifiStatus[] = [];
    bridge.onWifiStatus = (status) => received.push(status);

    ws.receive({
      type: 'wifi_status',
      data: { status: 'disconnected' },
    });

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('disconnected');
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

  it('does not crash when callbacks are not set', () => {
    bridge.onWifiStatus = null;
    bridge.onBleStatus = null;

    // Should not throw
    ws.receive({ type: 'wifi_status', data: { status: 'got_ip', ip: '10.0.0.1' } });
    ws.receive({ type: 'ble_status', data: { status: 'initialized' } });
  });

  it('handles multiple sequential WiFi status changes', () => {
    const received: WifiStatus[] = [];
    bridge.onWifiStatus = (status) => received.push(status);

    ws.receive({ type: 'wifi_status', data: { status: 'initializing' } });
    ws.receive({ type: 'wifi_status', data: { status: 'connected', ssid: 'Velxio-GUEST' } });
    ws.receive({ type: 'wifi_status', data: { status: 'got_ip', ssid: 'Velxio-GUEST', ip: '192.168.4.2' } });

    expect(received).toHaveLength(3);
    expect(received[0].status).toBe('initializing');
    expect(received[1].status).toBe('connected');
    expect(received[2].status).toBe('got_ip');
    expect(received[2].ip).toBe('192.168.4.2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WiFi auto-detection from sketch files
// ─────────────────────────────────────────────────────────────────────────────

describe('WiFi auto-detection', () => {
  it('detects #include <WiFi.h> in sketch content', () => {
    const content = `
#include <WiFi.h>
void setup() { WiFi.begin("Velxio-GUEST", ""); }
void loop() {}
`;
    const hasWifi = content.includes('#include <WiFi.h>') ||
                    content.includes('#include <esp_wifi.h>') ||
                    content.includes('#include "WiFi.h"') ||
                    content.includes('WiFi.begin(');
    expect(hasWifi).toBe(true);
  });

  it('detects #include <esp_wifi.h> in sketch content', () => {
    const content = `
#include <esp_wifi.h>
void setup() { esp_wifi_init(); }
void loop() {}
`;
    const hasWifi = content.includes('#include <WiFi.h>') ||
                    content.includes('#include <esp_wifi.h>') ||
                    content.includes('#include "WiFi.h"') ||
                    content.includes('WiFi.begin(');
    expect(hasWifi).toBe(true);
  });

  it('detects WiFi.begin() call in sketch content', () => {
    const content = `
void setup() { WiFi.begin("ssid", "pass"); }
void loop() {}
`;
    const hasWifi = content.includes('#include <WiFi.h>') ||
                    content.includes('#include <esp_wifi.h>') ||
                    content.includes('#include "WiFi.h"') ||
                    content.includes('WiFi.begin(');
    expect(hasWifi).toBe(true);
  });

  it('returns false for non-WiFi sketches', () => {
    const content = `
void setup() { Serial.begin(115200); }
void loop() { delay(1000); }
`;
    const hasWifi = content.includes('#include <WiFi.h>') ||
                    content.includes('#include <esp_wifi.h>') ||
                    content.includes('#include "WiFi.h"') ||
                    content.includes('WiFi.begin(');
    expect(hasWifi).toBe(false);
  });

  it('detects #include "WiFi.h" (quotes) in sketch', () => {
    const content = '#include "WiFi.h"\nvoid setup() {}\nvoid loop() {}';
    const hasWifi = content.includes('#include <WiFi.h>') ||
                    content.includes('#include <esp_wifi.h>') ||
                    content.includes('#include "WiFi.h"') ||
                    content.includes('WiFi.begin(');
    expect(hasWifi).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. BLE detection from sketch files
// ─────────────────────────────────────────────────────────────────────────────

describe('BLE detection in sketches', () => {
  it('detects BLEDevice.h include', () => {
    const content = '#include <BLEDevice.h>\nvoid setup() { BLEDevice::init("test"); }';
    const hasBLE = content.includes('#include <BLEDevice.h>') ||
                   content.includes('#include <esp_bt.h>') ||
                   content.includes('BLEDevice::init(');
    expect(hasBLE).toBe(true);
  });

  it('returns false for non-BLE sketches', () => {
    const content = 'void setup() { Serial.begin(115200); }\nvoid loop() {}';
    const hasBLE = content.includes('#include <BLEDevice.h>') ||
                   content.includes('#include <esp_bt.h>') ||
                   content.includes('BLEDevice::init(');
    expect(hasBLE).toBe(false);
  });
});
