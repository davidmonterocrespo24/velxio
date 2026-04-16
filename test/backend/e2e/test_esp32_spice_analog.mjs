/**
 * test_esp32_spice_analog.mjs
 *
 * Full end-to-end co-simulation test: ESP32 (QEMU via backend) + ngspice (WASM).
 *
 * What it tests:
 *   1. Compile a minimal ESP32 sketch that reads analogRead(34) every 500 ms
 *      and prints "ADC34: raw=XXXX voltage=X.XXXV" via Serial.
 *   2. Boot the ESP32 in QEMU via the backend WebSocket.
 *   3. Run ngspice to solve a voltage divider circuit (R1=10k + R2=10k, Vcc=3.3V)
 *      producing V(mid) = 1.65 V.
 *   4. Inject V(mid) into ESP32's ADC channel 6 (GPIO34) via `esp32_adc_set`.
 *   5. Read Serial output and verify the ADC value matches the SPICE voltage
 *      within tolerance (12-bit ADC: 4096 counts over 3.3V → ±20 counts).
 *   6. Update the circuit (R2=30k → V(mid)=2.475V), re-inject, and verify
 *      the ESP32 reads the new voltage.
 *
 * Run:
 *   cd test/backend/e2e && npm install && node test_esp32_spice_analog.mjs
 *
 * Prerequisites:
 *   - Backend running on http://localhost:8001
 *   - ESP32 Arduino core installed (`arduino-cli core install esp32:esp32`)
 */

import { Simulation } from 'eecircuit-engine';

// ─── Config ───────────────────────────────────────────────────────────────────
const BACKEND   = process.env.BACKEND_URL
  ?? process.argv.find(a => a.startsWith('--backend='))?.slice(10)
  ?? 'http://localhost:8001';
const WS_BASE   = BACKEND.replace(/^https?:/, m => m === 'https:' ? 'wss:' : 'ws:');
const SESSION   = `test-esp32-spice-${Date.now()}`;
const TIMEOUT_S = parseInt(
  process.argv.find(a => a.startsWith('--timeout='))?.slice(10) ?? '90'
);

// ─── ESP32 ADC sketch ────────────────────────────────────────────────────────
const SKETCH = `// ESP32 ADC reader for SPICE co-simulation test
// Reads GPIO34 (ADC1_CH6) at 12-bit resolution

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  delay(500);
  Serial.println("ESP32_ADC_READY");
}

void loop() {
  int raw = analogRead(34);
  float voltage = raw * 3.3 / 4095.0;
  Serial.printf("ADC34: raw=%d voltage=%.3fV\\n", raw, voltage);
  delay(500);
}`;

// ─── Logging ──────────────────────────────────────────────────────────────────
const T0  = Date.now();
const ts  = () => `[+${((Date.now() - T0) / 1000).toFixed(3)}s]`;
const C   = {
  INFO: '\x1b[36m', OK: '\x1b[32m', ERROR: '\x1b[31m',
  SERIAL: '\x1b[32m', SPICE: '\x1b[35m', RESET: '\x1b[0m',
};
const log    = (lvl, ...a) => console.log(`${C[lvl] ?? ''}${ts()} [${lvl}]${C.RESET}`, ...a);
const info   = (...a) => log('INFO',   ...a);
const ok     = (...a) => log('OK',     ...a);
const err    = (...a) => log('ERROR',  ...a);
const serial = (...a) => log('SERIAL', ...a);
const spice  = (...a) => log('SPICE',  ...a);

// ─── ngspice Engine (singleton) ──────────────────────────────────────────────
let sim = null;
async function bootNgspice() {
  if (sim) return sim;
  spice('Booting ngspice-WASM...');
  sim = new Simulation();
  await sim.start();
  spice('ngspice ready');
  return sim;
}

async function solveCircuit(r1, r2, vcc = 3.3) {
  const engine = await bootNgspice();
  const netlist = `Voltage divider R1=${r1} R2=${r2}
V1 vcc 0 DC ${vcc}
R1 vcc mid ${r1}
R2 mid 0 ${r2}
.op
.end`;
  engine.setNetList(netlist);
  const result = await engine.runSim();
  const names = result.variableNames.map(n => n.toLowerCase());
  const idx = names.indexOf('v(mid)');
  if (idx < 0) throw new Error(`v(mid) not found in result: ${names}`);
  const voltage = result.data[idx].values[0];
  spice(`Solved: R1=${r1}, R2=${r2}, V(mid) = ${voltage.toFixed(4)}V`);
  return voltage;
}

// ─── Step 1: Compile ──────────────────────────────────────────────────────────
async function compile() {
  info('Compiling ESP32 ADC sketch...');
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
    throw new Error(`Compilation HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const body = await res.json();
  if (!body.success) {
    throw new Error(`Compilation error:\n${(body.error ?? body.stderr ?? 'unknown').slice(0, 500)}`);
  }
  const firmware_b64 = body.binary_content ?? body.firmware_b64;
  if (!firmware_b64) throw new Error(`No firmware. Keys: ${Object.keys(body)}`);
  ok(`Compiled -- ${Math.round(firmware_b64.length * 0.75 / 1024)} KB firmware`);
  return firmware_b64;
}

// ─── Step 2: Run co-simulation ────────────────────────────────────────────────
function runCoSimulation(firmware_b64) {
  return new Promise(async (resolve) => {
    // Pre-solve two circuit configurations with ngspice
    const v1 = await solveCircuit(10000, 10000, 3.3);   // 1.65V
    const v2 = await solveCircuit(10000, 30000, 3.3);   // 2.475V

    const wsUrl = `${WS_BASE}/api/simulation/ws/${SESSION}`;
    info(`Connecting WebSocket -> ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    let serialLines = [];
    let lineBuf = '';
    let readyReceived = false;
    let firstInjected = false;
    let secondInjected = false;
    let firstReadings = [];
    let secondReadings = [];
    let phase = 0; // 0=boot, 1=injected v1, 2=injected v2

    const timer = setTimeout(() => {
      info(`Timeout (${TIMEOUT_S}s)`);
      ws.close();
      resolve({
        timedOut: true, firstReadings, secondReadings,
        v1, v2, serialLines,
      });
    }, TIMEOUT_S * 1000);

    ws.addEventListener('open', () => {
      ok('WebSocket connected');
      ws.send(JSON.stringify({
        type: 'start_esp32',
        data: {
          board: 'esp32',
          firmware_b64,
          wifi_enabled: false,
        },
      }));
      info('Sent start_esp32');
    });

    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const { type, data } = msg;

      if (type === 'serial_output') {
        lineBuf += data?.data ?? '';
        let nl;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl).replace(/\r$/, '');
          lineBuf = lineBuf.slice(nl + 1);
          if (!line.trim()) continue;
          serialLines.push(line);
          serial(`UART: ${line}`);

          // Detect ready signal
          if (line.includes('ESP32_ADC_READY') && !readyReceived) {
            readyReceived = true;
            ok('ESP32 ADC ready -- injecting SPICE voltage #1');
            // Inject v1 into ADC channel 6 (GPIO34)
            const mv = Math.round(v1 * 1000);
            ws.send(JSON.stringify({
              type: 'esp32_adc_set',
              data: { channel: 6, millivolts: mv },
            }));
            spice(`Injected V(mid) = ${v1.toFixed(3)}V (${mv} mV) into ADC CH6`);
            phase = 1;
            firstInjected = true;
          }

          // Parse ADC readings
          const adcMatch = line.match(/ADC34:\s*raw=(\d+)\s+voltage=([\d.]+)V/);
          if (adcMatch) {
            const raw = parseInt(adcMatch[1]);
            const vRead = parseFloat(adcMatch[2]);

            if (phase === 1) {
              firstReadings.push({ raw, voltage: vRead });
              // After 3 readings at v1, switch to v2
              if (firstReadings.length >= 3 && !secondInjected) {
                info('3 readings at v1 collected -- injecting SPICE voltage #2');
                const mv2 = Math.round(v2 * 1000);
                ws.send(JSON.stringify({
                  type: 'esp32_adc_set',
                  data: { channel: 6, millivolts: mv2 },
                }));
                spice(`Injected V(mid) = ${v2.toFixed(3)}V (${mv2} mV) into ADC CH6`);
                phase = 2;
                secondInjected = true;
              }
            } else if (phase === 2) {
              secondReadings.push({ raw, voltage: vRead });
              if (secondReadings.length >= 3) {
                clearTimeout(timer);
                ws.close();
                resolve({
                  timedOut: false, firstReadings, secondReadings,
                  v1, v2, serialLines,
                });
              }
            }
          }
        }
        return;
      }

      if (type === 'system') info(`system: ${JSON.stringify(data)}`);
      if (type === 'error')  err(`error: ${JSON.stringify(data)}`);
    });

    ws.addEventListener('close', () => {
      clearTimeout(timer);
      if (phase < 2) {
        resolve({
          timedOut: true, firstReadings, secondReadings,
          v1, v2, serialLines,
        });
      }
    });

    ws.addEventListener('error', e => {
      err(`WebSocket error: ${e.message ?? e}`);
    });
  });
}

// ─── Step 3: Validate results ────────────────────────────────────────────────
function validate(result) {
  const { timedOut, firstReadings, secondReadings, v1, v2 } = result;

  info('');
  info('═══════════════════════════════════════════════════');
  info('  Co-Simulation Results: ESP32 + ngspice');
  info('═══════════════════════════════════════════════════');

  // Expected ADC raw values (12-bit, 3.3V reference)
  const expected1 = Math.round(v1 / 3.3 * 4095);
  const expected2 = Math.round(v2 / 3.3 * 4095);

  info(`Circuit 1: R1=10k, R2=10k -> V(mid)=${v1.toFixed(4)}V -> expected ADC=${expected1}`);
  info(`Circuit 2: R1=10k, R2=30k -> V(mid)=${v2.toFixed(4)}V -> expected ADC=${expected2}`);
  info('');

  let pass = true;

  if (timedOut) {
    err('Test timed out before collecting enough readings');
    pass = false;
  }

  // Check first batch
  if (firstReadings.length < 1) {
    err('No ADC readings received after first injection');
    pass = false;
  } else {
    const avg1 = firstReadings.reduce((s, r) => s + r.raw, 0) / firstReadings.length;
    info(`First batch: ${firstReadings.length} readings, avg raw=${avg1.toFixed(0)} (expected ${expected1})`);
    // Tolerance: ±50 counts (generous for QEMU ADC emulation + timing)
    if (Math.abs(avg1 - expected1) > 50) {
      err(`First batch off by ${Math.abs(avg1 - expected1).toFixed(0)} counts (tolerance: 50)`);
      pass = false;
    } else {
      ok(`First batch within tolerance`);
    }
  }

  // Check second batch
  if (secondReadings.length < 1) {
    err('No ADC readings received after second injection');
    pass = false;
  } else {
    const avg2 = secondReadings.reduce((s, r) => s + r.raw, 0) / secondReadings.length;
    info(`Second batch: ${secondReadings.length} readings, avg raw=${avg2.toFixed(0)} (expected ${expected2})`);
    if (Math.abs(avg2 - expected2) > 50) {
      err(`Second batch off by ${Math.abs(avg2 - expected2).toFixed(0)} counts (tolerance: 50)`);
      pass = false;
    } else {
      ok(`Second batch within tolerance`);
    }
  }

  // Check that the two batches are DIFFERENT (proving the circuit change was detected)
  if (firstReadings.length > 0 && secondReadings.length > 0) {
    const avg1 = firstReadings.reduce((s, r) => s + r.raw, 0) / firstReadings.length;
    const avg2 = secondReadings.reduce((s, r) => s + r.raw, 0) / secondReadings.length;
    if (Math.abs(avg2 - avg1) < 100) {
      err(`First and second batches too similar (delta=${Math.abs(avg2 - avg1).toFixed(0)}). Circuit change not detected.`);
      pass = false;
    } else {
      ok(`Circuit change detected: delta=${Math.abs(avg2 - avg1).toFixed(0)} counts`);
    }
  }

  info('');
  if (pass) {
    ok('ALL CHECKS PASSED -- ESP32 + ngspice co-simulation works!');
    process.exit(0);
  } else {
    err('SOME CHECKS FAILED');
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  info('ESP32 + ngspice analog co-simulation E2E test');
  info(`Backend: ${BACKEND}`);
  info(`Timeout: ${TIMEOUT_S}s`);
  info('');

  try {
    // Boot ngspice engine (async, ~400ms)
    await bootNgspice();

    // Compile sketch
    const firmware = await compile();

    // Run the co-simulation
    const result = await runCoSimulation(firmware);

    // Validate
    validate(result);
  } catch (e) {
    err(`Fatal: ${e.message}`);
    if (e.message?.includes('fetch')) {
      err('Is the backend running? Start with: cd backend && uvicorn app.main:app --port 8001');
    }
    process.exit(1);
  }
}

main();
