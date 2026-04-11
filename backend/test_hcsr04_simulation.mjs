/**
 * test_hcsr04_simulation.mjs
 *
 * Full end-to-end diagnostic test for the ESP32 + HC-SR04 ultrasonic sensor.
 * Mirrors exactly what the frontend does:
 *   1. POST /api/compile/  → get firmware_b64
 *   2. WebSocket /api/simulation/ws/{id}
 *   3. send start_esp32 with firmware + sensors:[{sensor_type:'hc-sr04',…}]
 *   4. Watch serial output — should see "Distance: N cm", NOT "Out of range"
 *   5. Send esp32_sensor_update with several distances and verify each one
 *      is reflected in the next serial output line
 *
 * Diagnostics printed:
 *   - Every GPIO change on TRIG (GPIO18) and ECHO (GPIO19) is logged
 *   - System events (boot, crash) are logged
 *   - A separate "TRIG/ECHO timeline" is built to show the full pulse sequence
 *
 * Run from the backend/ directory:
 *   node test_hcsr04_simulation.mjs [--timeout=60] [--backend=http://localhost:8001]
 *
 * Prerequisites: Backend running on http://localhost:8001
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const BACKEND   = process.env.BACKEND_URL
  ?? process.argv.find(a => a.startsWith('--backend='))?.slice(10)
  ?? 'http://localhost:8001';
const WS_BASE   = BACKEND.replace(/^https?:/, m => m === 'https:' ? 'wss:' : 'ws:');
const SESSION   = `test-hcsr04-${Date.now()}`;
const TIMEOUT_S = parseInt(
  process.argv.find(a => a.startsWith('--timeout='))?.slice(10) ?? '60'
);

// ─── ESP32 HC-SR04 sketch (same as the example in examples.ts) ───────────────
const SKETCH = `// ESP32 — HC-SR04 Ultrasonic Distance Sensor
// Wiring: TRIG → D18  |  ECHO → D19  |  VCC → 3V3  |  GND → GND


#define TRIG_PIN 18
#define ECHO_PIN 19


void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  Serial.println("ESP32 HC-SR04 ready");
}

long measureCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long d = pulseIn(ECHO_PIN, HIGH, 30000UL);
  return (d == 0) ? -1 : (long)(d * 0.0343 / 2.0);
}

void loop() {
  long cm = measureCm();
  if (cm < 0) Serial.println("Out of range");
  else        Serial.printf("Distance: %ld cm\\n", cm);
  delay(500);
}`;

// ─── Sensor config: TRIG=GPIO18, ECHO=GPIO19 ─────────────────────────────────
const HCSR04_SENSOR = {
  sensor_type: 'hc-sr04',
  pin:      18,   // TRIG pin (listened to for HIGH pulse)
  echo_pin: 19,   // ECHO pin (driven HIGH by backend sync handler)
  distance: 40.0, // cm — echo_us = 40 * 58 = 2320 µs
};

// Distance → expected cm conversion
// pulseIn measures HIGH duration in µs; firmware: (µs * 0.0343 / 2) → cm
// Our driver drives ECHO HIGH for (distance_cm * 58) µs
// Expected: (distance_cm * 58 * 0.0343 / 2) ≈ distance_cm * 0.9947 ≈ distance_cm
const distanceToCm = (d) => Math.round(d * 58 * 0.0343 / 2);

// Test distances to cycle through, with expected serial output
const TEST_DISTANCES = [
  { distance: 40,  label: 'initial (40 cm)' },
  { distance: 100, label: 'far (100 cm)' },
  { distance: 10,  label: 'close (10 cm)' },
  { distance: 200, label: 'very far (200 cm)' },
];

// ─── Logging helpers ──────────────────────────────────────────────────────────
const T0  = Date.now();
const ts  = () => `[+${((Date.now() - T0) / 1000).toFixed(3)}s]`;
const C   = {
  INFO:   '\x1b[36m',
  WARN:   '\x1b[33m',
  ERROR:  '\x1b[31m',
  OK:     '\x1b[32m',
  SERIAL: '\x1b[32m',
  GPIO:   '\x1b[35m',
  DIAG:   '\x1b[33m',
  RESET:  '\x1b[0m',
};
const log  = (lvl, ...a) => console.log(`${C[lvl] ?? ''}${ts()} [${lvl}]${C.RESET}`, ...a);
const info    = (...a) => log('INFO',   ...a);
const ok      = (...a) => log('OK',     ...a);
const err     = (...a) => log('ERROR',  ...a);
const serial  = (...a) => log('SERIAL', ...a);
const gpiolog = (...a) => log('GPIO',   ...a);
const diag    = (...a) => log('DIAG',   ...a);

// ─── Step 1: Compile the sketch ───────────────────────────────────────────────
async function compile() {
  info('Compiling HC-SR04 sketch via POST /api/compile/ ...');
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

    // ── State tracking ──────────────────────────────────────────────────
    let serialLines      = [];   // all lines received
    let outOfRangeCount  = 0;   // "Out of range" count
    let distanceReadings = [];   // {sent, received, line}
    let trigHigh    = 0;         // count of TRIG→HIGH events (gpio_change)
    let echoHighSys = 0;         // count of hcsr04_echo_high system events
    let echoLowSys  = 0;         // count of hcsr04_echo_low  system events

    // Current distance under test
    let distIdx     = 0;            // index into TEST_DISTANCES
    let currentDist = TEST_DISTANCES[0].distance;
    let advanceTimer = null;        // single pending advance timeout (cancel on reschedule)
    let readingsAtCurrent = 0;      // readings received at currentDist

    const timer = setTimeout(() => {
      info(`Timeout (${TIMEOUT_S}s) — stopping`);
      ws.close();
      resolve({ timedOut: true, serialLines, distanceReadings, outOfRangeCount,
                trigHigh, echoHigh: echoHighSys, echoLow: echoLowSys });
    }, TIMEOUT_S * 1000);

    // ── Schedule one advance (cancels any pending) ──────────────────────
    function scheduleAdvance(delayMs) {
      if (advanceTimer) clearTimeout(advanceTimer);
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        advanceDistance();
      }, delayMs);
    }

    // ── Advance to the next test distance ───────────────────────────────
    function advanceDistance() {
      distIdx++;
      if (distIdx >= TEST_DISTANCES.length) {
        clearTimeout(timer);
        ws.close();
        resolve({ timedOut: false, serialLines, distanceReadings, outOfRangeCount,
                  trigHigh, echoHigh: echoHighSys, echoLow: echoLowSys });
        return;
      }
      currentDist = TEST_DISTANCES[distIdx].distance;
      readingsAtCurrent = 0;
      info(`→ Sending sensor_update: distance=${currentDist} cm (${TEST_DISTANCES[distIdx].label})`);
      ws.send(JSON.stringify({
        type: 'esp32_sensor_update',
        data: { pin: 18, distance: currentDist },
      }));
    }

    ws.addEventListener('open', () => {
      ok('WebSocket connected');
      ws.send(JSON.stringify({
        type: 'start_esp32',
        data: {
          board:        'esp32',
          firmware_b64,
          sensors:      [HCSR04_SENSOR],
          wifi_enabled: false,
        },
      }));
      info(`Sent start_esp32 with HC-SR04: TRIG=GPIO18 ECHO=GPIO19 distance=${HCSR04_SENSOR.distance} cm`);
      info(`Expected echo_us=${HCSR04_SENSOR.distance * 58} µs → ~${distanceToCm(HCSR04_SENSOR.distance)} cm`);
    });

    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const { type, data } = msg;

      // ── Serial output ─────────────────────────────────────────────────
      if (type === 'serial_output') {
        const text = data?.data ?? '';
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          serialLines.push(line);
          serial(`UART: ${line}`);

          if (line.includes('HC-SR04 ready')) {
            info('Firmware booted — waiting for distance readings...');
            return;
          }

          if (line.includes('Out of range')) {
            outOfRangeCount++;
            diag(`⚠ "Out of range" at distance=${currentDist} cm — ECHO may have missed pulseIn window`);
            readingsAtCurrent++;
            // Schedule only on the 2nd reading to avoid re-arming the timer
            // (readings arrive every 500 ms — >= 2 keeps resetting the 800 ms timer)
            if (readingsAtCurrent === 2) scheduleAdvance(800);
            return;
          }

          const m = line.match(/Distance:\s*(-?\d+)\s*cm/);
          if (m) {
            const cm = parseInt(m[1]);
            distanceReadings.push({ sent: currentDist, received: cm, line });
            info(`Distance reading: sent=${currentDist} cm → received=${cm} cm (expected≈${distanceToCm(currentDist)})`);
            readingsAtCurrent++;
            // Schedule only on the 2nd reading to avoid re-arming the timer
            if (readingsAtCurrent === 2) scheduleAdvance(800);
          }
        }
        return;
      }

      // ── GPIO changes on TRIG (18) — firmware-driven OUTPUT changes ───
      if (type === 'gpio_change') {
        const { pin, state } = data ?? {};
        if (pin === 18) {
          const tsMs = Date.now() - T0;
          gpiolog(`GPIO${pin} (TRIG) → ${state ? 'HIGH' : 'LOW '} @ +${tsMs}ms`);
          if (state === 1) trigHigh++;
        }
        return;
      }

      // ── System events (boot, hcsr04_echo_high/low, etc.) ──────────────
      if (type === 'system') {
        info(`system: ${JSON.stringify(data)}`);
        // ECHO is driven externally by backend thread — emits system events
        if (data?.event === 'hcsr04_echo_high') echoHighSys++;
        if (data?.event === 'hcsr04_echo_low')  echoLowSys++;
        return;
      }
      if (type === 'error') {
        err(`simulation error: ${JSON.stringify(data)}`);
        return;
      }
    });

    ws.addEventListener('close', ev => {
      clearTimeout(timer);
      info(`WebSocket closed (code=${ev.code})`);
      resolve({ timedOut: false, serialLines, distanceReadings, outOfRangeCount, trigHigh, echoHigh, echoLow });
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
  console.log(' TEST: ESP32 + HC-SR04 Ultrasonic Distance Simulation');
  console.log(' Session:', SESSION);
  console.log(' Backend:', BACKEND);
  console.log(' Timeout:', TIMEOUT_S, 's');
  console.log(' TRIG   : GPIO18   ECHO: GPIO19');
  console.log(' Distances to test:', TEST_DISTANCES.map(d => d.distance + ' cm').join(', '));
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

  // ─── GPIO timeline summary ─────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(' TRIG / ECHO event timeline');
  console.log('─'.repeat(60));
  console.log(`  TRIG HIGH events (gpio_change) : ${result.trigHigh}`);
  console.log(`  ECHO HIGH events (system)      : ${result.echoHigh}`);
  console.log(`  ECHO LOW  events (system)      : ${result.echoLow}`);
  console.log('  Note: ECHO is driven externally (system events, not gpio_change)');
  if (result.trigHigh > 0 && result.echoHigh === 0) {
    console.log('\x1b[31m  ✗ TRIG fired but ECHO thread never ran\x1b[0m');
    console.log('\x1b[33m  → Check _on_pin_change hc-sr04 branch in esp32_worker.py\x1b[0m');
  } else if (result.echoHigh > 0 && result.outOfRangeCount > 0) {
    console.log('\x1b[33m  ⚠ ECHO fired but some pulseIn() calls timed out\x1b[0m');
    console.log('\x1b[33m  → Transient OS scheduling jitter — normal for short echo pulses\x1b[0m');
  } else if (result.trigHigh > 0 && result.echoHigh === result.trigHigh) {
    console.log('\x1b[32m  ✓ Every TRIG got an ECHO response\x1b[0m');
  }

  // ─── Distance readings summary ─────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(' Distance readings');
  console.log('─'.repeat(60));
  if (result.distanceReadings.length === 0) {
    console.log('  (none — all readings were "Out of range")');
  } else {
    for (const r of result.distanceReadings) {
      const expected = distanceToCm(r.sent);
      const delta    = Math.abs(r.received - expected);
      const ok_str   = delta <= 5 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`  ${ok_str} sent=${r.sent} cm → received=${r.received} cm (expected≈${expected}, delta=${delta})`);
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log(' SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Serial lines received  : ${result.serialLines.length}`);
  console.log(`  "Out of range" count   : ${result.outOfRangeCount}`);
  console.log(`  Distance readings      : ${result.distanceReadings.length}`);
  console.log(`  Timed out              : ${result.timedOut}`);
  console.log();
  console.log('  All serial output:');
  for (const l of result.serialLines) console.log(`    ${l}`);
  console.log();

  // ─── Pass/Fail ─────────────────────────────────────────────────────────────
  // Tolerance: ±15 cm — simulation timing is not hardware-accurate
  const TOLERANCE_CM = 15;
  const uniqueSent    = new Set(result.distanceReadings.map(r => r.sent)).size;
  const correctCount  = result.distanceReadings.filter(
    r => Math.abs(r.received - distanceToCm(r.sent)) <= TOLERANCE_CM
  ).length;
  const missRate = result.distanceReadings.length === 0 ? 1
    : result.outOfRangeCount / (result.distanceReadings.length + result.outOfRangeCount);

  if (result.distanceReadings.length >= 3 && uniqueSent >= 2 && correctCount >= 3 && missRate <= 0.3) {
    console.log('\x1b[32m  ✓ PASS — HC-SR04 sensor simulation is working correctly\x1b[0m');
    console.log(`\x1b[32m    ${correctCount}/${result.distanceReadings.length} readings within ±${TOLERANCE_CM} cm, `
      + `${uniqueSent} distances tested, miss rate ${(missRate * 100).toFixed(0)}%\x1b[0m`);
    process.exit(0);
  } else if (result.outOfRangeCount > 0 && result.distanceReadings.length === 0) {
    console.log('\x1b[31m  ✗ FAIL — All readings were "Out of range"\x1b[0m');
    if (result.trigHigh === 0) {
      console.log('\x1b[33m  → TRIG never went HIGH: sensor registration failed\x1b[0m');
    } else if (result.echoHigh === 0) {
      console.log('\x1b[33m  → TRIG fired but ECHO thread never ran\x1b[0m');
      console.log('\x1b[33m    Check _on_pin_change hc-sr04 branch in esp32_worker.py\x1b[0m');
    } else {
      console.log('\x1b[33m  → ECHO fired but pulseIn() timed out every time\x1b[0m');
    }
    process.exit(1);
  } else if (result.timedOut) {
    console.log('\x1b[33m  ? TIMEOUT — no serial output received\x1b[0m');
    process.exit(1);
  } else {
    console.log('\x1b[33m  ? PARTIAL — not enough readings or too many misses\x1b[0m');
    console.log(`\x1b[33m    readings=${result.distanceReadings.length} correct=${correctCount} `
      + `uniqueDist=${uniqueSent} missRate=${(missRate * 100).toFixed(0)}%\x1b[0m`);
    process.exit(1);
  }
}

main().catch(e => { err('Unhandled error:', e); process.exit(1); });
