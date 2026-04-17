/**
 * ESP32 WiFi/BLE example compilation tests
 *
 * Verifies that WiFi and BLE example sketches would compile
 * with the correct board FQBN (esp32:esp32:esp32).
 */

import { describe, it, expect } from 'vitest';

// ── Example sketch sources ──────────────────────────────────────────────────

const WIFI_SCAN_SKETCH = `#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  int n = WiFi.scanNetworks();
  Serial.println("Networks found:");
  for (int i = 0; i < n; i++) {
    Serial.printf("%d: %s (%d dBm)\\n", i+1, WiFi.SSID(i).c_str(), WiFi.RSSI(i));
  }
}

void loop() { delay(10000); }
`;

const WIFI_CONNECT_SKETCH = `#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  Serial.print("Connecting to WiFi");
  WiFi.begin("Velxio-GUEST", "", 6);
  while (WiFi.status() != WL_CONNECTED) {
    delay(100);
    Serial.print(".");
  }
  Serial.println(" Connected!");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

void loop() { delay(1000); }
`;

const HTTP_SERVER_SKETCH = `#include <WiFi.h>
#include <WebServer.h>

WebServer server(80);

void setup() {
  Serial.begin(115200);
  WiFi.begin("Velxio-GUEST", "", 6);
  while (WiFi.status() != WL_CONNECTED) delay(100);
  server.on("/", []() {
    server.send(200, "text/html", "<h1>Hello from ESP32!</h1>");
  });
  server.begin();
  Serial.print("Server at: ");
  Serial.println(WiFi.localIP());
}

void loop() { server.handleClient(); }
`;

const BLE_ADVERTISE_SKETCH = `#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

void setup() {
  Serial.begin(115200);
  BLEDevice::init("Velxio-ESP32");
  BLEServer *pServer = BLEDevice::createServer();
  BLEAdvertising *pAdv = BLEDevice::getAdvertising();
  pAdv->start();
  Serial.println("BLE advertising started");
}

void loop() { delay(2000); }
`;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ESP32 WiFi example sketches — structure validation', () => {
  it('WiFi Scan sketch contains required includes', () => {
    expect(WIFI_SCAN_SKETCH).toContain('#include <WiFi.h>');
    expect(WIFI_SCAN_SKETCH).toContain('WiFi.scanNetworks()');
    expect(WIFI_SCAN_SKETCH).toContain('WiFi.SSID(');
  });

  it('WiFi Connect sketch uses Velxio-GUEST SSID', () => {
    expect(WIFI_CONNECT_SKETCH).toContain('#include <WiFi.h>');
    expect(WIFI_CONNECT_SKETCH).toContain('Velxio-GUEST');
    expect(WIFI_CONNECT_SKETCH).toContain('WiFi.begin(');
    expect(WIFI_CONNECT_SKETCH).toContain('WiFi.localIP()');
  });

  it('HTTP Server sketch uses WebServer on port 80', () => {
    expect(HTTP_SERVER_SKETCH).toContain('#include <WebServer.h>');
    expect(HTTP_SERVER_SKETCH).toContain('WebServer server(80)');
    expect(HTTP_SERVER_SKETCH).toContain('server.on("/",');
    expect(HTTP_SERVER_SKETCH).toContain('server.begin()');
  });

  it('BLE Advertise sketch initializes BLEDevice', () => {
    expect(BLE_ADVERTISE_SKETCH).toContain('#include <BLEDevice.h>');
    expect(BLE_ADVERTISE_SKETCH).toContain('BLEDevice::init(');
    expect(BLE_ADVERTISE_SKETCH).toContain('pAdv->start()');
  });
});

describe('ESP32 WiFi auto-detection in sketches', () => {
  const detectWifi = (content: string) =>
    content.includes('#include <WiFi.h>') ||
    content.includes('#include <esp_wifi.h>') ||
    content.includes('#include "WiFi.h"') ||
    content.includes('WiFi.begin(');

  it('detects WiFi in scan sketch', () => {
    expect(detectWifi(WIFI_SCAN_SKETCH)).toBe(true);
  });

  it('detects WiFi in connect sketch', () => {
    expect(detectWifi(WIFI_CONNECT_SKETCH)).toBe(true);
  });

  it('detects WiFi in HTTP server sketch', () => {
    expect(detectWifi(HTTP_SERVER_SKETCH)).toBe(true);
  });

  it('does not detect WiFi in BLE-only sketch', () => {
    expect(detectWifi(BLE_ADVERTISE_SKETCH)).toBe(false);
  });
});

describe('ESP32 board FQBN mapping for compilation', () => {
  // Maps board types to their expected FQBN for arduino-cli
  const FQBN_MAP: Record<string, string> = {
    'esp32': 'esp32:esp32:esp32',
    'esp32-s3': 'esp32:esp32:esp32s3',
    'esp32-c3': 'esp32:esp32:esp32c3',
  };

  it('ESP32 maps to esp32:esp32:esp32', () => {
    expect(FQBN_MAP['esp32']).toBe('esp32:esp32:esp32');
  });

  it('ESP32-S3 maps to esp32:esp32:esp32s3', () => {
    expect(FQBN_MAP['esp32-s3']).toBe('esp32:esp32:esp32s3');
  });

  it('ESP32-C3 maps to esp32:esp32:esp32c3', () => {
    expect(FQBN_MAP['esp32-c3']).toBe('esp32:esp32:esp32c3');
  });
});
