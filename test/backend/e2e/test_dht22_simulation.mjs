/**
 * test_dht22_simulation.mjs
 *
 * Full end-to-end test for the ESP32 + DHT22 sensor simulation.
 * Mirrors exactly what the frontend does:
 *   1. POST /api/compile/  → get firmware_b64
 *   2. WebSocket /api/simulation/ws/{id}
 *   3. send start_esp32 with firmware + sensors:[{sensor_type:'dht22',…}]
 *   4. Watch serial output for temperature/humidity readings
 *   5. Send sensor_update with new values and verify the output changes
 *
 * Run from the backend/ directory:
 *   node test_dht22_simulation.mjs [--timeout=40] [--backend=http://localhost:8001]
 *
 * Prerequisites: Backend running on http://localhost:8001
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const BACKEND   = process.env.BACKEND_URL
  ?? process.argv.find(a => a.startsWith('--backend='))?.slice(10)
  ?? 'http://localhost:8001';
const WS_BASE   = BACKEND.replace(/^https?:/, m => m === 'https:' ? 'wss:' : 'ws:');
const SESSION   = `test-dht22-${Date.now()}`;
const TIMEOUT_S = parseInt(
  process.argv.find(a => a.startsWith('--timeout='))?.slice(10) ?? '45'
);

// ─── ESP32 DHT22 sketch (same as the example in examples.ts) ─────────────────
const SKETCH = `// ESP32 — DHT22 Temperature & Humidity Sensor
// Requires: Adafruit DHT sensor library
// Wiring: DATA → GPIO4  |  VCC → 3V3  |  GND → GND

#include <DHT.h>

#define DHT_PIN  4    // GPIO 4
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);


void setup() {
  Serial.begin(115200);
  dht.begin();
  delay(2000);
  Serial.println("ESP32 DHT22 ready!");
}

void loop() {
  delay(2000);

  float h = dht.readHumidity();
  float t = dht.readTemperature();

  if (isnan(h) || isnan(t)) {
    Serial.println("DHT22: waiting for sensor...");
    return;
  }
  Serial.printf("Temp: %.1f C   Humidity: %.1f %%\\n", t, h);
}`;

// ─── Sensor config: GPIO4, SDA pin, initial values ───────────────────────────
const DHT22_SENSOR = {
  sensor_type: 'dht22',
  pin: 4,
  temperature: 28.0,
  humidity: 65.0,
};

// ─── Logging helpers ──────────────────────────────────────────────────────────
const T0  = Date.now();
const ts  = () => `[+${((Date.now() - T0) / 1000).toFixed(3)}s]`;
const C   = { INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m', OK: '\x1b[32m', SERIAL: '\x1b[32m', GPIO: '\x1b[35m', RESET: '\x1b[0m' };
const log = (lvl, ...a) => console.log(`${C[lvl] ?? ''}${ts()} [${lvl}]${C.RESET}`, ...a);
const info   = (...a) => log('INFO',   ...a);
const ok     = (...a) => log('OK',     ...a);
const err    = (...a) => log('ERROR',  ...a);
const serial = (...a) => log('SERIAL', ...a);
const gpio   = (...a) => log('GPIO',   ...a);

// ─── Step 1: Compile the sketch ───────────────────────────────────────────────
async function compile() {
  info('Compiling DHT22 sketch via POST /api/compile/ ...');
  const res = await fetch(`${BACKEND}/api/compile/`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files:      [{ name: 'sketch.ino', content: SKETCH }],
      board_fqbn: 'esp32:esp32:esp32',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Compilation HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  if (!body.success) {
    throw new Error(`Compilation error:\n${(body.error ?? body.stderr ?? 'unknown').slice(0, 500)}`);
  }
  const firmware_b64 = body.binary_content ?? body.firmware_b64;
  if (!firmware_b64) {
    throw new Error(`No firmware in response. Keys: ${Object.keys(body).join(', ')}`);
  }
  ok(`Compiled — ${Math.round(firmware_b64.length * 0.75 / 1024)} KB firmware`);
  return firmware_b64;
}

// ─── Step 2: Run simulation via WebSocket ─────────────────────────────────────
function runSimulation(firmware_b64) {
  return new Promise((resolve, reject) => {
    const wsUrl = `${WS_BASE}/api/simulation/ws/${SESSION}`;
    info(`Connecting WebSocket → ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    let serialLines = [];
    let foundReady  = false;
    let foundData   = false;
    let updateSent  = false;
    let secondBatch = [];  // lines after sensor_update
    let _lineBuf    = '';  // accumulates partial serial chunks until '\n'

    const timer = setTimeout(() => {
      info(`Timeout (${TIMEOUT_S}s) — stopping`);
      ws.close();
      resolve({ timedOut: true, serialLines, secondBatch });
    }, TIMEOUT_S * 1000);

    ws.addEventListener('open', () => {
      ok('WebSocket connected');
      ws.send(JSON.stringify({
        type: 'start_esp32',
        data: {
          board:        'esp32',
          firmware_b64,
          sensors:      [DHT22_SENSOR],
          wifi_enabled: false,
        },
      }));
      info('Sent start_esp32 with DHT22 sensor on GPIO4');
    });

    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const { type, data } = msg;

      // ── Serial output ───────────────────────────────────────────────────
      // Serial data arrives in chunks (partial lines).  Buffer until '\n'.
      if (type === 'serial_output') {
        _lineBuf += data?.data ?? '';
        let nl;
        while ((nl = _lineBuf.indexOf('\n')) !== -1) {
          const line = _lineBuf.slice(0, nl).replace(/\r$/, '');
          _lineBuf = _lineBuf.slice(nl + 1);
          if (!line.trim()) continue;
          serialLines.push(line);
          serial(`UART: ${line}`);

          if (line.includes('ESP32 DHT22 ready!')) {
            info('DHT22 ready signal received — waiting for readings...');
          }

          // Detect temperature/humidity line: "Temp: 28.0 C   Humidity: 65.0 %"
          if (line.includes('Temp:') && line.includes('Humidity:')) {
            if (!updateSent) {
              // Got first reading — now update to new values and collect second batch
              info('First reading received — sending sensor_update (Temp=35°C, Humidity=80%)');
              ws.send(JSON.stringify({
                type: 'esp32_sensor_update',
                data: { pin: 4, temperature: 35.0, humidity: 80.0 },
              }));
              updateSent = true;
            } else {
              // Second batch after update
              secondBatch.push(line);
              if (secondBatch.length >= 2) {
                clearTimeout(timer);
                ws.close();
                resolve({ timedOut: false, serialLines, secondBatch });
              }
            }
          }
        }
        return;
      }

      // ── GPIO activity on pin 4 ─────────────────────────────────────────
      if (type === 'gpio_change') {
        if (data?.pin === 4) gpio(`GPIO4 (DHT22 SDA) → ${data.state}`);
        return;
      }

      // ── System / error ─────────────────────────────────────────────────
      if (type === 'system')  info(`system: ${JSON.stringify(data)}`);
      if (type === 'error')   err(`simulation error: ${JSON.stringify(data)}`);
    });

    ws.addEventListener('close', ev => {
      clearTimeout(timer);
      info(`WebSocket closed (code=${ev.code})`);
      resolve({ timedOut: false, serialLines, secondBatch });
    });

    ws.addEventListener('error', ev => {
      clearTimeout(timer);
      err('WebSocket error:', ev.message ?? ev.type);
      reject(new Error('WebSocket error'));
    });
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log(' TEST: ESP32 + DHT22 Sensor Simulation');
  console.log(' Session:', SESSION);
  console.log(' Backend:', BACKEND);
  console.log(' Timeout:', TIMEOUT_S, 's');
  console.log(' Sensor : GPIO4, Temp=28°C, Humidity=65%');
  console.log('═'.repeat(60) + '\n');

  let firmware_b64;
  try {
    firmware_b64 = await compile();
  } catch (e) {
    err('Compilation failed:', e.message);
    process.exit(1);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(' Starting simulation...');
  console.log('─'.repeat(60) + '\n');

  const result = await runSimulation(firmware_b64);

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log(' SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Serial lines received  : ${result.serialLines.length}`);
  console.log(`  Lines after update     : ${result.secondBatch.length}`);
  console.log(`  Timed out              : ${result.timedOut}`);
  console.log();
  console.log('  All serial output:');
  for (const l of result.serialLines) console.log(`    ${l}`);
  console.log();

  // ─── Pass/Fail ─────────────────────────────────────────────────────────────
  const firstReadings  = result.serialLines.filter(l => l.includes('Temp:'));
  const hasFirstRead   = firstReadings.length > 0;
  const hasSecondBatch = result.secondBatch.length > 0;

  // Check that values changed after sensor_update
  let valuesChanged = false;
  if (hasFirstRead && hasSecondBatch) {
    const firstTemp  = parseFloat(firstReadings[0].match(/Temp:\s*([\d.]+)/)?.[1] ?? '0');
    const secondTemp = parseFloat(result.secondBatch[0].match(/Temp:\s*([\d.]+)/)?.[1] ?? '0');
    valuesChanged = Math.abs(firstTemp - secondTemp) > 1;
    console.log(`  First reading  temp : ${firstTemp}°C`);
    console.log(`  Second reading temp : ${secondTemp}°C`);
    console.log(`  Values changed      : ${valuesChanged}`);
    console.log();
  }

  if (hasFirstRead && hasSecondBatch && valuesChanged) {
    console.log('\x1b[32m  ✓ PASS — DHT22 reads temperature/humidity and values update correctly\x1b[0m');
    process.exit(0);
  } else if (result.timedOut && !hasFirstRead) {
    console.log('\x1b[31m  ✗ FAIL — Timed out with no temperature readings\x1b[0m');
    console.log('\x1b[33m  → Check backend logs for DHT22 sync events.\x1b[0m');
    console.log('\x1b[33m  → Look for "DHT22 sync armed gpio=4" in uvicorn output.\x1b[0m');
    process.exit(1);
  } else if (hasFirstRead && !hasSecondBatch) {
    console.log('\x1b[33m  ? PARTIAL — Got first reading but no second batch after update\x1b[0m');
    console.log('\x1b[33m  → sensor_update may not be reflected yet; try longer --timeout\x1b[0m');
    process.exit(1);
  } else if (hasFirstRead && !valuesChanged) {
    console.log('\x1b[31m  ✗ FAIL — sensor_update sent but values did not change\x1b[0m');
    console.log('\x1b[33m  → Check that esp32_sensor_update propagates to backend _sensors dict.\x1b[0m');
    process.exit(1);
  } else {
    console.log('\x1b[33m  ? INCONCLUSIVE — No clear pass or fail signal\x1b[0m');
    process.exit(1);
  }
}

main().catch(e => { err('Unhandled error:', e); process.exit(1); });
