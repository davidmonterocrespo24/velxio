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
 *   5. Read Serial output and verify the reading matches the SPICE voltage
 *      under one ADC model for every reading (see ADC models below).
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
// Prints the raw code and analogReadMilliVolts(): on a real ESP32 the code
// follows the chip's curve at the attenuation set (12 dB by default), and the
// millivolts, from the eFuse calibration, are how a sketch measures volts.
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
  uint32_t mv = analogReadMilliVolts(34);
  Serial.printf("ADC34: raw=%d mv=%u\\n", raw, (unsigned)mv);
  delay(500);
}`;

// ─── ADC models ───────────────────────────────────────────────────────────────
// A run passes when ONE model explains every batch, each with its own
// tolerance (neither is widened to fit the other):
//   linear  the libqemu velxio.dev served before velxio/velxio-prod#171: the
//           pad voltage converted linearly over 0-3.3 V; raw within 50 counts
//           of V / 3.3 * 4095, the tolerance this test always had.
//   chip    the libqemu after #171, which converts like a real ESP32: the raw
//           code follows the chip's 12 dB curve (1.65 V reads about 1872, not
//           2048) and analogReadMilliVolts() gives the pad voltage back from
//           the eFuse calibration, to within MV_TOL. Above the range (about
//           3.13 V at 12 dB) the code is 4095 and the millivolts stop at the
//           top of the range, below the pad.
// Drop `linear` once CI downloads the curve library.
// MV_TOL: the worker hands libqemu the voltage in 12-bit steps of the 3.3 V
// scale (0.806 mV, so +-0.4 mV), a 12 dB code is 0.8-1.3 mV wide, and ESP-IDF
// returns whole millivolts: 3 mV covers the three.
const MV_TOL = 3;
const ADC_MODELS = [
  { name: 'linear (libqemu before velxio/velxio-prod#171)',
    fits: (raw, mv, v) => Math.abs(raw - Math.round(v / 3.3 * 4095)) <= 50 },
  { name: "the chip's curve and eFuse calibration (libqemu after #171)",
    fits: (raw, mv, v) => (raw >= 4095 ? mv <= v * 1000 + MV_TOL : Math.abs(mv - v * 1000) <= MV_TOL) },
];

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
            // Inject v1 into ADC channel 6 (GPIO34), with its fraction of a
            // millivolt, as the tab sends it
            const mv = v1 * 1000;
            ws.send(JSON.stringify({
              type: 'esp32_adc_set',
              data: { channel: 6, millivolts: mv },
            }));
            spice(`Injected V(mid) = ${v1.toFixed(3)}V (${mv.toFixed(1)} mV) into ADC CH6`);
            phase = 1;
            firstInjected = true;
          }

          // Parse ADC readings
          const adcMatch = line.match(/ADC34:\s*raw=(\d+)\s+mv=(\d+)/);
          if (adcMatch) {
            const raw = parseInt(adcMatch[1]);
            const mvRead = parseInt(adcMatch[2]);

            if (phase === 1) {
              firstReadings.push({ raw, mv: mvRead });
              // After 3 readings at v1, switch to v2
              if (firstReadings.length >= 3 && !secondInjected) {
                info('3 readings at v1 collected -- injecting SPICE voltage #2');
                const mv2 = v2 * 1000;
                ws.send(JSON.stringify({
                  type: 'esp32_adc_set',
                  data: { channel: 6, millivolts: mv2 },
                }));
                spice(`Injected V(mid) = ${v2.toFixed(3)}V (${mv2.toFixed(1)} mV) into ADC CH6`);
                phase = 2;
                secondInjected = true;
              }
            } else if (phase === 2) {
              secondReadings.push({ raw, mv: mvRead });
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

  info(`Circuit 1: R1=10k, R2=10k -> V(mid)=${v1.toFixed(4)}V (linear ADC ${Math.round(v1 / 3.3 * 4095)})`);
  info(`Circuit 2: R1=10k, R2=30k -> V(mid)=${v2.toFixed(4)}V (linear ADC ${Math.round(v2 / 3.3 * 4095)})`);
  info('');

  let pass = true;

  if (timedOut) {
    err('Test timed out before collecting enough readings');
    pass = false;
  }

  const avg = (rs, k) => rs.reduce((s, r) => s + r[k], 0) / rs.length;
  const batches = [];
  for (const [name, rs, v] of [['First', firstReadings, v1], ['Second', secondReadings, v2]]) {
    if (rs.length < 1) {
      err(`No ADC readings received for the ${name.toLowerCase()} batch`);
      pass = false;
      continue;
    }
    const b = { raw: avg(rs, 'raw'), mv: avg(rs, 'mv'), v };
    batches.push(b);
    info(`${name} batch: ${rs.length} readings, avg raw=${b.raw.toFixed(0)} avg mv=${b.mv.toFixed(1)} `
         + `(pad ${(v * 1000).toFixed(1)} mV)`);
  }

  // One ADC model has to explain every batch
  if (batches.length === 2) {
    const model = ADC_MODELS.find(m => batches.every(b => m.fits(b.raw, b.mv, b.v)));
    if (model) {
      ok(`Every batch fits one ADC model: ${model.name}`);
    } else {
      err('No ADC model explains every batch:');
      for (const m of ADC_MODELS) {
        const off = batches.filter(b => !m.fits(b.raw, b.mv, b.v));
        err(`  ${m.name}: ${off.length} of ${batches.length} batches off`);
      }
      pass = false;
    }
  }

  // Check that the two batches are DIFFERENT (proving the circuit change was detected)
  if (batches.length === 2) {
    const delta = Math.abs(batches[1].raw - batches[0].raw);
    if (delta < 100) {
      err(`First and second batches too similar (delta=${delta.toFixed(0)}). Circuit change not detected.`);
      pass = false;
    } else {
      ok(`Circuit change detected: delta=${delta.toFixed(0)} counts`);
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
