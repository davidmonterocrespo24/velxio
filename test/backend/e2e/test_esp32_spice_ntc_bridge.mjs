/**
 * test_esp32_spice_ntc_bridge.mjs
 *
 * Advanced co-simulation: ESP32 reads a Wheatstone bridge with an NTC
 * thermistor through its ADC, and the bridge voltages are computed by
 * ngspice-WASM. The test sweeps temperature from 0C to 50C and verifies
 * the ESP32's calculated temperature matches within tolerance.
 *
 * Circuit (ngspice):
 *     Vcc=3.3V
 *      |
 *     R1=10k        R3=10k
 *      |              |
 *     VA (ADC34)     VB (ADC35)
 *      |              |
 *     NTC(T)         R4=10k (fixed reference)
 *      |              |
 *     GND            GND
 *
 *   V_diff = VA - VB  (proportional to NTC deviation from 10k)
 *
 * Sketch: reads ADC34 and ADC35, computes V_diff, estimates temperature
 * from the NTC beta-model, and prints via Serial.
 *
 * Run:
 *   cd test/backend/e2e && npm install && node test_esp32_spice_ntc_bridge.mjs
 *
 * Prerequisites: Backend on http://localhost:8001, esp32 core installed.
 */

import { Simulation } from 'eecircuit-engine';

const BACKEND   = process.env.BACKEND_URL ?? 'http://localhost:8001';
const WS_BASE   = BACKEND.replace(/^https?:/, m => m === 'https:' ? 'wss:' : 'ws:');
const SESSION   = `test-esp32-ntc-${Date.now()}`;
const TIMEOUT_S = parseInt(process.argv.find(a => a.startsWith('--timeout='))?.slice(10) ?? '120');

// NTC beta model (matches the sketch)
const NTC_R0   = 10000;  // 10k at 25C
const NTC_T0   = 298.15; // 25C in Kelvin
const NTC_BETA = 3950;

function ntcResistance(Tc) {
  const T = Tc + 273.15;
  return NTC_R0 * Math.exp(NTC_BETA * (1 / T - 1 / NTC_T0));
}

// ─── ESP32 Sketch ────────────────────────────────────────────────────────────
const SKETCH = `// ESP32 Wheatstone bridge + NTC temperature reader
// ADC34 = bridge leg A (NTC side)
// ADC35 = bridge leg B (reference side)

#define NTC_R0   10000.0
#define NTC_T0   298.15
#define NTC_BETA 3950.0
#define R_PULL   10000.0
#define VCC      3.3

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  delay(500);
  Serial.println("ESP32_BRIDGE_READY");
}

void loop() {
  int rawA = analogRead(34);
  int rawB = analogRead(35);
  float vA = rawA * VCC / 4095.0;
  float vB = rawB * VCC / 4095.0;

  // Estimate NTC resistance from VA (half-bridge: Vcc -> R_pull -> VA -> NTC -> GND)
  // VA = VCC * R_ntc / (R_pull + R_ntc) => R_ntc = R_pull * VA / (VCC - VA)
  float rNtc = R_PULL * vA / (VCC - vA + 0.001);

  // Beta model: T = 1 / (1/T0 + ln(R/R0)/beta)
  float tK = 1.0 / (1.0 / NTC_T0 + log(rNtc / NTC_R0) / NTC_BETA);
  float tC = tK - 273.15;

  Serial.printf("BRIDGE: rawA=%d rawB=%d vA=%.3f vB=%.3f R_ntc=%.0f T=%.1fC\\n",
                rawA, rawB, vA, vB, rNtc, tC);
  delay(500);
}`;

// ─── Logging ──────────────────────────────────────────────────────────────────
const T0  = Date.now();
const ts  = () => `[+${((Date.now() - T0) / 1000).toFixed(3)}s]`;
const C   = { INFO: '\x1b[36m', OK: '\x1b[32m', ERROR: '\x1b[31m', SERIAL: '\x1b[32m', SPICE: '\x1b[35m', RESET: '\x1b[0m' };
const log    = (lvl, ...a) => console.log(`${C[lvl] ?? ''}${ts()} [${lvl}]${C.RESET}`, ...a);
const info   = (...a) => log('INFO',   ...a);
const ok     = (...a) => log('OK',     ...a);
const err    = (...a) => log('ERROR',  ...a);
const serial = (...a) => log('SERIAL', ...a);
const spice  = (...a) => log('SPICE',  ...a);

// ─── ngspice ──────────────────────────────────────────────────────────────────
let engine = null;
async function bootNgspice() {
  if (engine) return engine;
  spice('Booting ngspice-WASM...');
  engine = new Simulation();
  await engine.start();
  spice('ngspice ready');
  return engine;
}

async function solveBridge(tempC) {
  const rNtc = ntcResistance(tempC);
  const e = await bootNgspice();
  const netlist = `Wheatstone bridge T=${tempC}C
V1 vcc 0 DC 3.3
R1 vcc va 10k
Rntc va 0 ${rNtc}
R3 vcc vb 10k
R4 vb 0 10k
.op
.end`;
  e.setNetList(netlist);
  const result = await e.runSim();
  const names = result.variableNames.map(n => n.toLowerCase());
  const iA = names.indexOf('v(va)');
  const iB = names.indexOf('v(vb)');
  if (iA < 0 || iB < 0) throw new Error(`Nets not found: ${names}`);
  const vA = result.data[iA].values[0];
  const vB = result.data[iB].values[0];
  spice(`T=${tempC}C: R_ntc=${rNtc.toFixed(0)} VA=${vA.toFixed(4)} VB=${vB.toFixed(4)}`);
  return { vA, vB, rNtc };
}

// ─── Compile ──────────────────────────────────────────────────────────────────
async function compile() {
  info('Compiling ESP32 bridge sketch...');
  const res = await fetch(`${BACKEND}/api/compile/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ name: 'sketch.ino', content: SKETCH }],
      board_fqbn: 'esp32:esp32:esp32',
    }),
  });
  if (!res.ok) throw new Error(`Compile HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const body = await res.json();
  if (!body.success) throw new Error(`Compile error: ${(body.error ?? body.stderr ?? '').slice(0, 500)}`);
  const fw = body.binary_content ?? body.firmware_b64;
  if (!fw) throw new Error(`No firmware. Keys: ${Object.keys(body)}`);
  ok(`Compiled -- ${Math.round(fw.length * 0.75 / 1024)} KB`);
  return fw;
}

// ─── Co-simulation ────────────────────────────────────────────────────────────
function runCoSim(firmware_b64) {
  // Temperature sweep: 0C, 25C, 50C
  const temps = [0, 25, 50];

  return new Promise(async (resolve) => {
    // Pre-solve all circuits
    const circuits = {};
    for (const t of temps) {
      circuits[t] = await solveBridge(t);
    }

    const wsUrl = `${WS_BASE}/api/simulation/ws/${SESSION}`;
    info(`Connecting WebSocket -> ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    let lineBuf = '';
    let serialLines = [];
    let ready = false;
    let tempIdx = 0;
    let results = {}; // temp -> [{rawA, rawB, vA, vB, rNtc, tC}]
    let currentTemp = temps[0];

    const timer = setTimeout(() => {
      ws.close();
      resolve({ timedOut: true, results, serialLines, circuits });
    }, TIMEOUT_S * 1000);

    function injectVoltage(tempC) {
      const c = circuits[tempC];
      const mvA = Math.round(c.vA * 1000);
      const mvB = Math.round(c.vB * 1000);
      ws.send(JSON.stringify({ type: 'esp32_adc_set', data: { channel: 6, millivolts: mvA } }));
      ws.send(JSON.stringify({ type: 'esp32_adc_set', data: { channel: 7, millivolts: mvB } }));
      spice(`Injected T=${tempC}C: CH6=${mvA}mV CH7=${mvB}mV`);
    }

    ws.addEventListener('open', () => {
      ok('WebSocket connected');
      ws.send(JSON.stringify({
        type: 'start_esp32',
        data: { board: 'esp32', firmware_b64, wifi_enabled: false },
      }));
    });

    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'serial_output') {
        lineBuf += msg.data?.data ?? '';
        let nl;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl).replace(/\r$/, '');
          lineBuf = lineBuf.slice(nl + 1);
          if (!line.trim()) continue;
          serialLines.push(line);
          serial(`UART: ${line}`);

          if (line.includes('ESP32_BRIDGE_READY') && !ready) {
            ready = true;
            ok('ESP32 bridge ready -- injecting first temperature');
            currentTemp = temps[0];
            injectVoltage(currentTemp);
          }

          const m = line.match(/BRIDGE:\s*rawA=(\d+)\s+rawB=(\d+)\s+vA=([\d.]+)\s+vB=([\d.]+)\s+R_ntc=([\d.]+)\s+T=([-\d.]+)C/);
          if (m) {
            const reading = {
              rawA: parseInt(m[1]), rawB: parseInt(m[2]),
              vA: parseFloat(m[3]), vB: parseFloat(m[4]),
              rNtc: parseFloat(m[5]), tC: parseFloat(m[6]),
            };
            if (!results[currentTemp]) results[currentTemp] = [];
            results[currentTemp].push(reading);

            // After 2 readings at this temp, move to next
            if (results[currentTemp].length >= 2) {
              tempIdx++;
              if (tempIdx < temps.length) {
                currentTemp = temps[tempIdx];
                info(`Switching to T=${currentTemp}C`);
                injectVoltage(currentTemp);
              } else {
                clearTimeout(timer);
                ws.close();
                resolve({ timedOut: false, results, serialLines, circuits });
              }
            }
          }
        }
      }

      if (msg.type === 'system') info(`system: ${JSON.stringify(msg.data)}`);
      if (msg.type === 'error')  err(`error: ${JSON.stringify(msg.data)}`);
    });

    ws.addEventListener('error', e => err(`WS error: ${e.message ?? e}`));
    ws.addEventListener('close', () => {
      clearTimeout(timer);
    });
  });
}

// ─── Validation ───────────────────────────────────────────────────────────────
function validate(result) {
  const { timedOut, results, circuits } = result;
  info('');
  info('══════════════════════════════════════════════════════════════');
  info('  Co-Simulation Results: ESP32 + ngspice Wheatstone Bridge');
  info('══════════════════════════════════════════════════════════════');

  let pass = true;
  if (timedOut) { err('Timed out'); pass = false; }

  for (const [tempStr, readings] of Object.entries(results)) {
    const temp = parseInt(tempStr);
    if (readings.length === 0) { err(`No readings for T=${temp}C`); pass = false; continue; }

    const avgT = readings.reduce((s, r) => s + r.tC, 0) / readings.length;
    const c = circuits[temp];
    info(`T=${temp}C: SPICE V(A)=${c.vA.toFixed(3)}V, R_ntc=${c.rNtc.toFixed(0)}ohm`);
    info(`  ESP32 read: avgT=${avgT.toFixed(1)}C (${readings.length} samples)`);

    // Tolerance: +/- 5C (ADC quantization + beta model rounding)
    if (Math.abs(avgT - temp) > 5) {
      err(`  Temperature off by ${Math.abs(avgT - temp).toFixed(1)}C (tolerance: 5C)`);
      pass = false;
    } else {
      ok(`  Within tolerance`);
    }
  }

  // Check that different temperatures produce different readings
  const temps = Object.keys(results).map(Number).sort((a, b) => a - b);
  if (temps.length >= 2) {
    const first = results[temps[0]];
    const last = results[temps[temps.length - 1]];
    if (first?.length > 0 && last?.length > 0) {
      const delta = Math.abs(first[0].rawA - last[0].rawA);
      if (delta < 50) {
        err(`ADC readings too similar across temperatures (delta=${delta})`);
        pass = false;
      } else {
        ok(`Temperature sweep produces distinct ADC readings (delta=${delta})`);
      }
    }
  }

  info('');
  if (pass) {
    ok('ALL CHECKS PASSED -- ESP32 Wheatstone bridge + ngspice co-simulation works!');
    process.exit(0);
  } else {
    err('SOME CHECKS FAILED');
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  info('ESP32 + ngspice Wheatstone bridge co-simulation E2E test');
  info(`Backend: ${BACKEND} | Timeout: ${TIMEOUT_S}s`);
  info('');

  try {
    await bootNgspice();
    const firmware = await compile();
    const result = await runCoSim(firmware);
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
