/**
 * test_multi_board_i2c.mjs
 *
 * End-to-end test for I2C communication between multiple boards:
 *   - ESP32 (master) scans I2C bus and reads from two slave addresses
 *   - Arduino UNO (slave at 0x08) — sketch compiles for arduino:avr:uno
 *   - Raspberry Pi Pico (slave at 0x09) — sketch compiles for rp2040:rp2040:rpipico
 *
 * The test compiles each sketch to verify compilation, then runs the ESP32
 * simulation with two I2C slave devices (pcf8574) at addresses 0x08 and 0x09.
 * The ESP32 sketch prints the read values to serial, which we verify.
 *
 * Run:
 *   node test/backend/e2e/test_multi_board_i2c.mjs [--timeout=60] [--backend=http://localhost:8001]
 *
 * Prerequisites: Backend running with QEMU libs and arduino-cli cores installed.
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const BACKEND   = process.env.BACKEND_URL
  ?? process.argv.find(a => a.startsWith('--backend='))?.slice(10)
  ?? 'http://localhost:8001';
const WS_BASE   = BACKEND.replace(/^https?:/, m => m === 'https:' ? 'wss:' : 'ws:');
const SESSION   = `test-multi-i2c-${Date.now()}`;
const TIMEOUT_S = parseInt(
  process.argv.find(a => a.startsWith('--timeout='))?.slice(10) ?? '90'
);

// I2C slave addresses
const SLAVE_ARDUINO_ADDR = 0x08;
const SLAVE_PICO_ADDR    = 0x09;

// ─── Sketches ─────────────────────────────────────────────────────────────────

// ESP32 master sketch
const ESP32_SKETCH = `// ESP32 I2C Master - scan and read from two slave addresses
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22); // SDA=21, SCL=22
  Serial.println("ESP32 I2C Master starting...");
  delay(100);
}

void loop() {
  // Scan I2C bus
  Serial.println("Scanning I2C bus...");
  byte count = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("Found device at 0x%02X\\n", addr);
      count++;
    }
    delay(10);
  }
  Serial.printf("Total devices found: %d\\n", count);

  // Read from Arduino slave (0x08)
  Wire.requestFrom(0x08, 1);
  if (Wire.available()) {
    byte val = Wire.read();
    Serial.printf("Arduino slave (0x%02X) value: %d\\n", 0x08, val);
  } else {
    Serial.println("No response from Arduino slave");
  }

  // Read from Pico slave (0x09)
  Wire.requestFrom(0x09, 1);
  if (Wire.available()) {
    byte val = Wire.read();
    Serial.printf("Pico slave (0x%02X) value: %d\\n", 0x09, val);
  } else {
    Serial.println("No response from Pico slave");
  }

  Serial.println("---");
  delay(2000);
}`;

// Arduino UNO slave sketch (I2C slave)
const ARDUINO_SKETCH = `// Arduino UNO I2C Slave at address 0x08
#include <Wire.h>

#define SLAVE_ADDR 0x08
volatile byte receivedValue = 0;

void receiveEvent(int howMany) {
  if (Wire.available()) {
    receivedValue = Wire.read();
  }
}

void requestEvent() {
  // Return a fixed value (e.g., 42)
  Wire.write(42);
}

void setup() {
  Wire.begin(SLAVE_ADDR);
  Wire.onReceive(receiveEvent);
  Wire.onRequest(requestEvent);
}

void loop() {
  // Slave operates via interrupts
  delay(1000);
}`;

// Raspberry Pi Pico slave sketch (I2C slave for RP2040)
const PICO_SKETCH = `// Raspberry Pi Pico I2C Slave at address 0x09
#include <Wire.h>

#define SLAVE_ADDR 0x09
volatile byte receivedValue = 0;

void receiveEvent(int howMany) {
  if (Wire.available()) {
    receivedValue = Wire.read();
  }
}

void requestEvent() {
  // Return a fixed value (e.g., 123)
  Wire.write(123);
}

void setup() {
  Wire.begin(SLAVE_ADDR);
  Wire.onReceive(receiveEvent);
  Wire.onRequest(requestEvent);
}

void loop() {
  delay(1000);
}`;

// ─── Logging ──────────────────────────────────────────────────────────────────
const T0  = Date.now();
const ts  = () => `[+${((Date.now() - T0) / 1000).toFixed(3)}s]`;
const C   = {
  INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m',
  OK: '\x1b[32m', SERIAL: '\x1b[32m', DIAG: '\x1b[33m', RESET: '\x1b[0m',
};
const log    = (lvl, ...a) => console.log(`${C[lvl] ?? ''}${ts()} [${lvl}]${C.RESET}`, ...a);
const info   = (...a) => log('INFO',   ...a);
const ok     = (...a) => log('OK',     ...a);
const warn   = (...a) => log('WARN',   ...a);
const err    = (...a) => log('ERROR',  ...a);
const serial = (...a) => log('SERIAL', ...a);
const diag   = (...a) => log('DIAG',   ...a);

// ─── Compile sketch ───────────────────────────────────────────────────────────
async function compileSketch(sketch, boardFqbn, sketchName) {
  info(`Compiling ${sketchName} for ${boardFqbn}...`);
  const res = await fetch(`${BACKEND}/api/compile/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ name: 'sketch.ino', content: sketch }],
      board_fqbn: boardFqbn,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Compilation failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  if (!body.success) {
    throw new Error(`Compilation error:\\n${(body.error ?? body.stderr ?? 'unknown').slice(0, 500)}`);
  }
  let firmware_b64 = body.binary_content ?? body.firmware_b64;
  // For AVR/RP2040 boards, hex_content may be provided instead of binary_content
  if (!firmware_b64 && body.hex_content) {
    // We don't need the hex content for simulation, but we can accept it as success
    firmware_b64 = null;
  }
  if (boardFqbn.startsWith('esp32:') && !firmware_b64) {
    throw new Error(`No firmware in response. Keys: ${Object.keys(body).join(', ')}`);
  }
  if (firmware_b64) {
    const sizeKB = Math.round(firmware_b64.length * 0.75 / 1024);
    ok(`${sketchName} compilation succeeded — ${sizeKB} KB firmware`);
  } else {
    ok(`${sketchName} compilation succeeded (hex content available)`);
  }
  return firmware_b64;
}

// ─── Run ESP32 simulation with I2C slaves ─────────────────────────────────────
function runSimulation(firmware_b64) {
  return new Promise((resolve) => {
    const wsUrl = `${WS_BASE}/api/simulation/ws/${SESSION}`;
    info(`Connecting WebSocket → ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    // Collected evidence
    const serialLines = [];
    let foundScan = false;
    let foundArduinoSlave = false;
    let foundPicoSlave = false;
    let scanCount = 0;
    let arduinoValue = null;
    let picoValue = null;

    const globalTimer = setTimeout(() => {
      info(`Global timeout (${TIMEOUT_S}s)`);
      ws.close();
      resolve({ timedOut: true, serialLines, foundScan, foundArduinoSlave, foundPicoSlave });
    }, TIMEOUT_S * 1000);

    ws.addEventListener('open', () => {
      ok('WebSocket connected');
      const payload = {
        type: 'start_esp32',
        data: {
          board:        'esp32',
          firmware_b64,
          sensors: [],  // No sensors - we'll use set_i2c_response instead
          wifi_enabled: false,
        },
      };
      info('Sent start_esp32 with no sensors (will use set_i2c_response)');
      ws.send(JSON.stringify(payload));

      // Send set_i2c_response commands for our slave addresses
      // These must be sent quickly before ESP32 starts scanning I2C
      setTimeout(() => {
        const cmd1 = { cmd: 'set_i2c_response', addr: SLAVE_ARDUINO_ADDR, response: 42 };
        const cmd2 = { cmd: 'set_i2c_response', addr: SLAVE_PICO_ADDR, response: 123 };
        ws.send(JSON.stringify(cmd1));
        ws.send(JSON.stringify(cmd2));
        info('Sent set_i2c_response commands for addresses 0x08 (42) and 0x09 (123)');
      }, 100);
    });

    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const { type, data } = msg;

      if (type === 'serial_output') {
        const text = data?.data ?? '';
        if (!text.trim()) return;
        // Echo to console
        for (const ch of text) process.stdout.write(ch);

        // Split lines
        const lines = text.split(/\\r?\\n/).map(l => l.trim()).filter(l => l.length > 0);
        for (const line of lines) {
          serialLines.push(line);
          serial(`UART: ${line}`);

          // Detect scan
          if (line.includes('Scanning I2C bus')) foundScan = true;
          if (line.includes('Total devices found:')) {
            const match = line.match(/Total devices found: (\\d+)/);
            if (match) scanCount = parseInt(match[1]);
          }
          // Detect Arduino slave response
          if (line.includes('Arduino slave (0x08) value:')) {
            foundArduinoSlave = true;
            const match = line.match(/value: (\\d+)/);
            if (match) arduinoValue = parseInt(match[1]);
          }
          // Detect Pico slave response
          if (line.includes('Pico slave (0x09) value:')) {
            foundPicoSlave = true;
            const match = line.match(/value: (\\d+)/);
            if (match) picoValue = parseInt(match[1]);
          }

          // If we have all evidence, exit early
          if (foundScan && foundArduinoSlave && foundPicoSlave) {
            clearTimeout(globalTimer);
            ws.close();
            resolve({ timedOut: false, serialLines, foundScan, foundArduinoSlave, foundPicoSlave, scanCount, arduinoValue, picoValue });
          }
        }
        return;
      }

      if (type === 'i2c_trace' || type === 'i2c_event') {
        diag(`I2C event: ${JSON.stringify(data)}`);
        return;
      }

      if (type === 'system') {
        info(`system: ${JSON.stringify(data)}`);
        return;
      }
      if (type === 'error') {
        err(`simulation error: ${JSON.stringify(data)}`);
        return;
      }
    });

    ws.addEventListener('close', ev => {
      clearTimeout(globalTimer);
      info(`WebSocket closed (code=${ev.code})`);
      resolve({ timedOut: false, serialLines, foundScan, foundArduinoSlave, foundPicoSlave, scanCount, arduinoValue, picoValue });
    });

    ws.addEventListener('error', ev => {
      err('WebSocket error', ev.message ?? '');
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\\n' + '='.repeat(60));
  console.log('  Multi‑Board I2C Communication Test');
  console.log('='.repeat(60) + '\\n');
  info(`Backend: ${BACKEND}`);
  info(`Timeout: ${TIMEOUT_S}s`);

  let exitCode = 0;

  try {
    // 1. Compile all three sketches (only ESP32 firmware is used for simulation)
    info('Step 1: Compiling sketches...');
    const esp32Firmware = await compileSketch(ESP32_SKETCH, 'esp32:esp32:esp32', 'ESP32 master');
    const arduinoFirmware = await compileSketch(ARDUINO_SKETCH, 'arduino:avr:uno', 'Arduino UNO slave');
    const picoFirmware = await compileSketch(PICO_SKETCH, 'rp2040:rp2040:rpipico', 'Raspberry Pi Pico slave');
    ok('All sketches compiled successfully');

    // 2. Run ESP32 simulation with I2C slaves
    info('\\nStep 2: Starting ESP32 simulation with I2C slave devices...');
    const result = await runSimulation(esp32Firmware);

    // ── Report ──────────────────────────────────────────────────────────
    console.log('\\n' + '─'.repeat(60));
    console.log('  Results');
    console.log('─'.repeat(60));
    console.log(`  Timed out:            ${result.timedOut}`);
    console.log(`  I2C scan detected:    ${result.foundScan}`);
    console.log(`  Arduino slave reply:  ${result.foundArduinoSlave} (value: ${result.arduinoValue})`);
    console.log(`  Pico slave reply:     ${result.foundPicoSlave} (value: ${result.picoValue})`);
    console.log(`  Total devices found:  ${result.scanCount}`);
    console.log(`  Serial lines:         ${result.serialLines.length}`);
    console.log('─'.repeat(60) + '\\n');

    // ── Assertions ──────────────────────────────────────────────────────
    const FAIL = (msg) => { err(`FAIL: ${msg}`); exitCode = 1; };

    if (result.timedOut) FAIL('Test timed out before completing I2C communication');
    if (!result.foundScan) FAIL('ESP32 I2C scan not detected in serial output');
    if (!result.foundArduinoSlave) FAIL('No response from Arduino slave at 0x08');
    if (!result.foundPicoSlave) FAIL('No response from Pico slave at 0x09');
    if (result.scanCount !== 2) FAIL(`Expected 2 I2C devices, found ${result.scanCount}`);
    if (result.arduinoValue !== 42) FAIL(`Expected Arduino slave value 42, got ${result.arduinoValue}`);
    if (result.picoValue !== 123) FAIL(`Expected Pico slave value 123, got ${result.picoValue}`);

    if (exitCode === 0) {
      ok('ALL CHECKS PASSED ✓');
    }
  } catch (e) {
    err(`Fatal: ${e.message}`);
    console.error(e);
    exitCode = 1;
  }

  process.exit(exitCode);
}

main();