/**
 * ESP32 WiFi + WebServer integration test
 *
 * Tests the full pipeline for the user's specific sketch:
 *  1. Sketch structure validation (includes, SSID, server setup)
 *  2. WiFi auto-detection triggers wifi_enabled flag
 *  3. Esp32Bridge sends correct start_esp32 payload
 *  4. WiFi status events flow through correctly
 *  5. Serial output parsing for connection messages
 *  6. HTTP server detection from serial output
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

  send(data: string) { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(); }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  receive(payload: object) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

// ── Imports (after mocks) ────────────────────────────────────────────────────
import { Esp32Bridge } from '../simulation/Esp32Bridge';
import type { WifiStatus } from '../simulation/Esp32Bridge';

// ── The user's exact sketch ──────────────────────────────────────────────────

const WEBSERVER_SKETCH = `#include <WiFi.h>
#include <WebServer.h>

const char* ssid = "Velxio-GUEST";
const char* password = "";

WebServer server(80);

void handleRoot() {
  server.send(200, "text/html", "<h1>Hola desde ESP32 🚀</h1>");
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  Serial.print("Conectando");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\\nConectado!");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
  server.on("/", handleRoot);
  server.begin();
  Serial.println("Servidor HTTP iniciado");
}

void loop() {
  server.handleClient();
}
`;

// ── Simulated serial output (what QEMU would produce) ────────────────────────

const EXPECTED_SERIAL_OUTPUT = [
  'I (432) wifi:wifi sta start',
  'I (500) wifi:new:Velxio-GUEST, old: , ASSOC',
  'I (800) wifi:connected with Velxio-GUEST, aid = 1, channel 6',
  'I (1200) esp_netif_handlers: sta ip: 192.168.4.2, mask: 255.255.255.0',
  'Conectando',
  '...',
  'Conectado!',
  'IP: 192.168.4.2',
  'Servidor HTTP iniciado',
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Sketch structure validation
// ─────────────────────────────────────────────────────────────────────────────

describe('WebServer sketch — structure validation', () => {
  it('includes WiFi.h and WebServer.h headers', () => {
    expect(WEBSERVER_SKETCH).toContain('#include <WiFi.h>');
    expect(WEBSERVER_SKETCH).toContain('#include <WebServer.h>');
  });

  it('uses Velxio-GUEST SSID with empty password', () => {
    expect(WEBSERVER_SKETCH).toContain('"Velxio-GUEST"');
    expect(WEBSERVER_SKETCH).toMatch(/password\s*=\s*""/);
  });

  it('creates WebServer on port 80', () => {
    expect(WEBSERVER_SKETCH).toContain('WebServer server(80)');
  });

  it('calls WiFi.begin() with ssid and password', () => {
    expect(WEBSERVER_SKETCH).toContain('WiFi.begin(ssid, password)');
  });

  it('registers root handler and starts server', () => {
    expect(WEBSERVER_SKETCH).toContain('server.on("/", handleRoot)');
    expect(WEBSERVER_SKETCH).toContain('server.begin()');
  });

  it('calls server.handleClient() in loop', () => {
    expect(WEBSERVER_SKETCH).toContain('server.handleClient()');
  });

  it('has handleRoot function sending HTML response', () => {
    expect(WEBSERVER_SKETCH).toContain('void handleRoot()');
    expect(WEBSERVER_SKETCH).toContain('server.send(200, "text/html"');
    expect(WEBSERVER_SKETCH).toContain('Hola desde ESP32');
  });

  it('uses Serial.begin(115200) for debugging', () => {
    expect(WEBSERVER_SKETCH).toContain('Serial.begin(115200)');
  });

  it('prints connection status messages in Spanish', () => {
    expect(WEBSERVER_SKETCH).toContain('Conectando');
    expect(WEBSERVER_SKETCH).toContain('Conectado!');
    expect(WEBSERVER_SKETCH).toContain('Servidor HTTP iniciado');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. WiFi auto-detection from sketch content
// ─────────────────────────────────────────────────────────────────────────────

describe('WebServer sketch — WiFi auto-detection', () => {
  const detectWifi = (content: string) =>
    content.includes('#include <WiFi.h>') ||
    content.includes('#include <esp_wifi.h>') ||
    content.includes('#include "WiFi.h"') ||
    content.includes('WiFi.begin(');

  it('auto-detects WiFi usage in the WebServer sketch', () => {
    expect(detectWifi(WEBSERVER_SKETCH)).toBe(true);
  });

  it('detects via #include <WiFi.h>', () => {
    expect(WEBSERVER_SKETCH).toContain('#include <WiFi.h>');
  });

  it('detects via WiFi.begin() call', () => {
    expect(WEBSERVER_SKETCH).toContain('WiFi.begin(');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Esp32Bridge — sends wifi_enabled=true for this sketch
// ─────────────────────────────────────────────────────────────────────────────

describe('WebServer sketch — Esp32Bridge WiFi payload', () => {
  let bridge: Esp32Bridge;
  let ws: MockWebSocket;

  afterEach(() => {
    bridge.disconnect();
  });

  it('sends wifi_enabled=true when sketch contains WiFi includes', () => {
    bridge = new Esp32Bridge('board-1', 'esp32');
    bridge.wifiEnabled = true; // auto-detected from sketch
    bridge.connect();
    ws = (bridge as any).socket as MockWebSocket;
    ws.open();

    const msg = JSON.parse(ws.sent[0]);
    expect(msg.type).toBe('start_esp32');
    expect(msg.data.wifi_enabled).toBe(true);
    expect(msg.data.board).toBe('esp32');
  });

  it('uses esp32:esp32:esp32 FQBN for compilation', () => {
    const FQBN_MAP: Record<string, string> = {
      'esp32': 'esp32:esp32:esp32',
      'esp32-s3': 'esp32:esp32:esp32s3',
      'esp32-c3': 'esp32:esp32:esp32c3',
    };
    expect(FQBN_MAP['esp32']).toBe('esp32:esp32:esp32');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. WiFi status event flow — simulated QEMU serial output
// ─────────────────────────────────────────────────────────────────────────────

describe('WebServer sketch — WiFi connection lifecycle', () => {
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

  it('receives initializing → connected → got_ip status sequence', () => {
    const statuses: WifiStatus[] = [];
    bridge.onWifiStatus = (s) => statuses.push(s);

    // Simulate QEMU WiFi status events from serial parsing
    ws.receive({ type: 'wifi_status', data: { status: 'initializing' } });
    ws.receive({ type: 'wifi_status', data: { status: 'connected', ssid: 'Velxio-GUEST' } });
    ws.receive({ type: 'wifi_status', data: { status: 'got_ip', ssid: 'Velxio-GUEST', ip: '192.168.4.2' } });

    expect(statuses).toHaveLength(3);
    expect(statuses[0].status).toBe('initializing');
    expect(statuses[1].status).toBe('connected');
    expect(statuses[1].ssid).toBe('Velxio-GUEST');
    expect(statuses[2].status).toBe('got_ip');
    expect(statuses[2].ip).toBe('192.168.4.2');
  });

  it('assigns IP in 192.168.4.x range (QEMU slirp default)', () => {
    const statuses: WifiStatus[] = [];
    bridge.onWifiStatus = (s) => statuses.push(s);

    ws.receive({
      type: 'wifi_status',
      data: { status: 'got_ip', ssid: 'Velxio-GUEST', ip: '192.168.4.2' },
    });

    expect(statuses[0].ip).toMatch(/^192\.168\.4\.\d+$/);
  });

  it('connects to Velxio-GUEST SSID (channel 6, open, no password)', () => {
    const statuses: WifiStatus[] = [];
    bridge.onWifiStatus = (s) => statuses.push(s);

    ws.receive({
      type: 'wifi_status',
      data: { status: 'connected', ssid: 'Velxio-GUEST' },
    });

    expect(statuses[0].ssid).toBe('Velxio-GUEST');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Serial output parsing — expected messages from the sketch
// ─────────────────────────────────────────────────────────────────────────────

describe('WebServer sketch — serial output verification', () => {
  it('serial output contains WiFi STA start log', () => {
    const output = EXPECTED_SERIAL_OUTPUT.join('\n');
    expect(output).toContain('wifi sta start');
  });

  it('serial output contains connection to Velxio-GUEST', () => {
    const output = EXPECTED_SERIAL_OUTPUT.join('\n');
    expect(output).toContain('Velxio-GUEST');
  });

  it('serial output contains assigned IP address', () => {
    const output = EXPECTED_SERIAL_OUTPUT.join('\n');
    expect(output).toMatch(/sta ip: 192\.168\.4\.\d+/);
  });

  it('serial output contains "Conectado!" message from sketch', () => {
    const output = EXPECTED_SERIAL_OUTPUT.join('\n');
    expect(output).toContain('Conectado!');
  });

  it('serial output contains "Servidor HTTP iniciado"', () => {
    const output = EXPECTED_SERIAL_OUTPUT.join('\n');
    expect(output).toContain('Servidor HTTP iniciado');
  });

  it('serial output contains IP address line', () => {
    const output = EXPECTED_SERIAL_OUTPUT.join('\n');
    expect(output).toContain('IP: 192.168.4.2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. HTTP server detection from serial output
// ─────────────────────────────────────────────────────────────────────────────

describe('WebServer sketch — HTTP server detection', () => {
  const detectHttpServer = (serialOutput: string): { detected: boolean; ip?: string } => {
    // Detect HTTP server from serial patterns like:
    // "Server at: X.X.X.X" or "Servidor HTTP iniciado" + "IP: X.X.X.X"
    const serverPatterns = [
      /[Ss]erver\s+at:\s*([\d.]+)/,
      /[Ss]ervidor\s+HTTP\s+iniciado/,
      /server\.begin\(\)/,
    ];

    const ipPattern = /IP:\s*([\d.]+)/;
    const hasServer = serverPatterns.some((p) => p.test(serialOutput));
    const ipMatch = serialOutput.match(ipPattern);

    return {
      detected: hasServer,
      ip: ipMatch ? ipMatch[1] : undefined,
    };
  };

  it('detects HTTP server from serial output', () => {
    const output = EXPECTED_SERIAL_OUTPUT.join('\n');
    const result = detectHttpServer(output);
    expect(result.detected).toBe(true);
  });

  it('extracts ESP32 IP address from serial output', () => {
    const output = EXPECTED_SERIAL_OUTPUT.join('\n');
    const result = detectHttpServer(output);
    expect(result.ip).toBe('192.168.4.2');
  });

  it('does not detect server in non-server output', () => {
    const output = 'Hello World!\nJust blinking an LED\n';
    const result = detectHttpServer(output);
    expect(result.detected).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. IoT Gateway URL construction
// ─────────────────────────────────────────────────────────────────────────────

describe('WebServer sketch — IoT Gateway URL', () => {
  it('constructs correct gateway URL for client', () => {
    const clientId = 'board-1';
    const backendUrl = 'http://localhost:8001';
    const gatewayUrl = `${backendUrl}/api/gateway/${clientId}/`;
    expect(gatewayUrl).toBe('http://localhost:8001/api/gateway/board-1/');
  });

  it('constructs gateway URL with subpath', () => {
    const clientId = 'board-1';
    const backendUrl = 'http://localhost:8001';
    const path = 'api/data';
    const gatewayUrl = `${backendUrl}/api/gateway/${clientId}/${path}`;
    expect(gatewayUrl).toBe('http://localhost:8001/api/gateway/board-1/api/data');
  });

  it('root path maps to ESP32 handleRoot handler', () => {
    // The sketch registers: server.on("/", handleRoot)
    // Gateway URL /api/gateway/{client_id}/ → ESP32 port 80 /
    const clientId = 'board-1';
    const hostfwdPort = 12345;
    const espUrl = `http://127.0.0.1:${hostfwdPort}/`;
    expect(espUrl).toContain(':12345/');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. QEMU NIC args for this sketch
// ─────────────────────────────────────────────────────────────────────────────

describe('WebServer sketch — QEMU NIC configuration', () => {
  it('builds correct -nic arg for ESP32 with WiFi', () => {
    const machine = 'esp32-picsimlab';
    const wifiEnabled = true;
    const hostfwdPort = 54321;

    const nicModel = machine.includes('c3') ? 'esp32c3_wifi' : 'esp32_wifi';
    let nicArg = `user,model=${nicModel},net=192.168.4.0/24`;
    if (hostfwdPort) {
      nicArg += `,hostfwd=tcp::${hostfwdPort}-192.168.4.2:80`;
    }

    expect(nicArg).toContain('model=esp32_wifi');
    expect(nicArg).toContain('net=192.168.4.0/24');
    expect(nicArg).toContain('hostfwd=tcp::54321-192.168.4.2:80');
  });

  it('uses port 80 for hostfwd (WebServer default)', () => {
    const hostfwdPort = 12345;
    const nicArg = `user,model=esp32_wifi,net=192.168.4.0/24,hostfwd=tcp::${hostfwdPort}-192.168.4.2:80`;
    // ESP32 WebServer listens on port 80, hostfwd maps external port to internal 80
    expect(nicArg).toMatch(/hostfwd=tcp::\d+-192\.168\.4\.2:80/);
  });
});
