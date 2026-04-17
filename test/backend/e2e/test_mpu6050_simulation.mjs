/**
 * test_mpu6050_simulation.mjs
 *
 * Full end-to-end test for the ESP32 + MPU-6050 I2C simulation.
 * Mirrors exactly what the frontend does:
 *   1. POST /api/compile/  → get firmware_b64
 *   2. WebSocket /api/simulation/ws/{id}
 *   3. send start_esp32 with firmware + sensors:[{sensor_type:'mpu6050',…}]
 *   4. Watch all events, log I2C state machine + serial output
 *
 * Run from the backend/ directory:
 *   node test_mpu6050_simulation.mjs [--timeout 30]
 *
 * Prerequisites: Backend running on http://localhost:8001
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const BACKEND   = process.env.BACKEND_URL ?? process.argv.find(a => a.startsWith('--backend='))?.slice(10) ?? 'http://localhost:8001';
const WS_BASE   = BACKEND.replace(/^https?:/, m => m === 'https:' ? 'wss:' : 'ws:');
const SESSION   = `test-mpu6050-${Date.now()}`;
const TIMEOUT_S = parseInt(process.argv.find(a => a.startsWith('--timeout='))?.slice(10) ?? '40');

// ─── MPU-6050 sketch (same as the example in examples.ts) ────────────────────
const SKETCH = `// ESP32 — MPU-6050 Accelerometer & Gyroscope (I2C)
// Requires: Adafruit MPU6050, Adafruit Unified Sensor libraries
// Wiring: SDA → D21  |  SCL → D22  |  VCC → 3V3  |  GND → GND

#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>

Adafruit_MPU6050 mpu;

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22); // SDA=21, SCL=22
  if (!mpu.begin()) {
    Serial.println("MPU6050 not found! Check wiring.");
    while (true) delay(10);
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  Serial.println("MPU6050 ready!");
}

void loop() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  Serial.printf("Accel X=%.2f Y=%.2f Z=%.2f m/s^2\\n",
    a.acceleration.x, a.acceleration.y, a.acceleration.z);
  Serial.printf("Gyro  X=%.2f Y=%.2f Z=%.2f rad/s\\n",
    g.gyro.x, g.gyro.y, g.gyro.z);
  Serial.printf("Temp: %.1f C\\n---\\n", temp.temperature);
  delay(500);
}`;

// ─── I2C event decoder (mirrors Python esp32_i2c_slaves.py constants) ─────────
const I2C_OP = { 0x00: 'STOP', 0x01: 'START', 0x03: 'READ', 0x05: 'WRITE_FIRST', 0x06: 'WRITE_CONT' };

// Local mirror of the MPU6050 slave state machine — tracks the same logic as
// Python's MPU6050Slave so we can annotate WHICH firmware call each event came from.
class MPU6050StateMirror {
  constructor() {
    this.reg_ptr         = 0x75;
    this.first_byte      = true;
    this._who_am_i_count = 0;
    this.regs            = new Uint8Array(256);
    // WHO_AM_I = 0x68
    this.regs[0x75] = 0x68;
    // ACCEL_Z = +1g = 0x40 (MSB at 0x3F)
    this.regs[0x3F] = 0x40;
    // TEMP raw for 25°C
    const tempRaw = Math.round((25.0 - 36.53) * 340) & 0xFFFF;
    this.regs[0x41] = (tempRaw >> 8) & 0xFF;
    this.regs[0x42] =  tempRaw       & 0xFF;
    this.eventCount = 0;
    this.readCount  = 0;
  }

  handle(event) {
    const op   = event & 0xFF;
    const data = (event >> 8) & 0xFF;
    this.eventCount++;
    let val = 0;
    let note = '';

    if (op === 0x01) { // I2C_START
      this.first_byte = true;
      if (this._who_am_i_count >= 2) {
        this.reg_ptr = 0x3B;
        note = `DATA_MODE  (count=${this._who_am_i_count} ≥ 2)`;
      } else {
        this.reg_ptr = 0x75;
        note = `WHO_AM_I_MODE (count=${this._who_am_i_count} < 2)`;
      }
      val = 1;
    } else if (op === 0x05 || op === 0x06) { // WRITE
      if (this.first_byte) {
        this.reg_ptr    = data;
        this.first_byte = false;
        note = `set reg_ptr=0x${data.toString(16).padStart(2,'0')} (${REG_NAME[data] ?? '?'})`;
      } else {
        this.regs[this.reg_ptr] = data;
        if (this.reg_ptr === 0x6B) this.regs[0x6B] &= 0x7F; // auto-clear DEVICE_RESET
        note = `write 0x${data.toString(16).padStart(2,'0')} → reg[0x${this.reg_ptr.toString(16).padStart(2,'0')}]`;
        this.reg_ptr = (this.reg_ptr + 1) & 0xFF;
      }
      val = 1;
    } else if (op === 0x03) { // READ
      this.readCount++;
      val = this.regs[this.reg_ptr];
      if (this.reg_ptr === 0x75 && val === 0x68) {
        this._who_am_i_count++;
        note = `WHO_AM_I read #${this._who_am_i_count} → 0x68`;
      } else {
        note = `reg[0x${this.reg_ptr.toString(16).padStart(2,'0')}]=${FRIENDLY_REG(this.reg_ptr, val)}`;
      }
      this.reg_ptr = (this.reg_ptr + 1) & 0xFF;
    } else { // STOP
      this.first_byte = true;
      note = 'transaction end';
    }

    return { val, note };
  }

  /** Guess which firmware function triggered this event sequence */
  guessPhase() {
    const c = this._who_am_i_count;
    const r = this.readCount;
    if (c === 0)  return 'before_begin / detected()';
    if (c === 1)  return 'chip_id.read() or reset() read-modify-write';
    if (c === 2 && r <= 3) return 'reset() wait loop or setFilterBandwidth';
    if (c >= 2)   return '_init() config setup OR sketch getEvent() loop';
    return '?';
  }
}

// Known MPU-6050 register names
const REG_NAME = {
  0x19: 'SMPRT_DIV', 0x1A: 'CONFIG', 0x1B: 'GYRO_CONFIG', 0x1C: 'ACCEL_CONFIG',
  0x3B: 'ACCEL_XOUT_H', 0x3C: 'ACCEL_XOUT_L', 0x3D: 'ACCEL_YOUT_H', 0x3E: 'ACCEL_YOUT_L',
  0x3F: 'ACCEL_ZOUT_H', 0x40: 'ACCEL_ZOUT_L',
  0x41: 'TEMP_OUT_H',   0x42: 'TEMP_OUT_L',
  0x43: 'GYRO_XOUT_H',  0x44: 'GYRO_XOUT_L',  0x45: 'GYRO_YOUT_H', 0x46: 'GYRO_YOUT_L',
  0x47: 'GYRO_ZOUT_H',  0x48: 'GYRO_ZOUT_L',
  0x6B: 'PWR_MGMT_1',  0x6C: 'PWR_MGMT_2',
  0x68: 'SIGNAL_PATH_RESET',
  0x75: 'WHO_AM_I',
};

function FRIENDLY_REG(reg, val) {
  const name = REG_NAME[reg];
  const hex  = `0x${val.toString(16).padStart(2,'0')}`;
  if (name) return `${hex} [${name}]`;
  return hex;
}

// ─── Logging helpers ───────────────────────────────────────────────────────────
const T0 = Date.now();
const ts  = () => `[+${((Date.now() - T0)/1000).toFixed(3)}s]`;

const LOG_LEVELS = { INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m', OK: '\x1b[32m', I2C: '\x1b[35m', SERIAL: '\x1b[32m', RESET: '\x1b[0m' };
const log   = (lvl, ...args) => console.log(`${LOG_LEVELS[lvl] ?? ''}${ts()} [${lvl}]${LOG_LEVELS.RESET}`, ...args);
const info  = (...a) => log('INFO',   ...a);
const warn  = (...a) => log('WARN',   ...a);
const ok    = (...a) => log('OK',     ...a);
const err   = (...a) => log('ERROR',  ...a);
const i2c   = (...a) => log('I2C',    ...a);
const serial = (...a) => log('SERIAL', ...a);

// ─── Counters & state ─────────────────────────────────────────────────────────
let totalEvents   = 0;
let i2cEvents     = 0;
let i2cTraceCount = 0;
let serialLines   = [];
let foundOK       = false;
let foundFail     = false;
const mirror      = new MPU6050StateMirror();

// ─── Step 1: Compile the sketch ───────────────────────────────────────────────
async function compile() {
  info('Compiling MPU6050 sketch via POST /api/compile/ ...');
  const res = await fetch(`${BACKEND}/api/compile/`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      files:      [{ name: 'sketch.ino', content: SKETCH }],
      board_fqbn: 'esp32:esp32:esp32',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Compilation failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  if (!body.success) {
    throw new Error(`Compilation error:\n${(body.error ?? body.stderr ?? 'unknown').slice(0, 500)}`);
  }
  // API returns firmware as base64 in 'binary_content' (ESP32 flash image)
  const firmware_b64 = body.binary_content ?? body.firmware_b64;
  if (!firmware_b64) {
    throw new Error(`No firmware in response. Keys: ${Object.keys(body).join(', ')}`);
  }
  const sizeKB = Math.round(firmware_b64.length * 0.75 / 1024);
  ok(`Compilation succeeded — ${sizeKB} KB firmware (has_wifi=${body.has_wifi})`);
  return firmware_b64;
}

// ─── Step 2: Run simulation via WebSocket ─────────────────────────────────────
function runSimulation(firmware_b64) {
  return new Promise((resolve, reject) => {
    const wsUrl = `${WS_BASE}/api/simulation/ws/${SESSION}`;
    info(`Connecting WebSocket → ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    const timer = setTimeout(() => {
      info(`Timeout reached (${TIMEOUT_S}s) — stopping simulation`);
      ws.close();
      resolve({ timedOut: true });
    }, TIMEOUT_S * 1000);

    ws.addEventListener('open', () => {
      ok('WebSocket connected');
      const payload = {
        type: 'start_esp32',
        data: {
          board:        'esp32',
          firmware_b64,
          sensors: [
            // Mirror what useSimulatorStore sends for wokwi-mpu6050 component
            { sensor_type: 'mpu6050', pin: 200 + 0x68, addr: 0x68 }
          ],
          wifi_enabled: false,
        },
      };
      info('Sending start_esp32 with sensors:', JSON.stringify(payload.data.sensors));
      ws.send(JSON.stringify(payload));
    });

    ws.addEventListener('message', ev => {
      totalEvents++;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      const { type, data } = msg;

      // ── Serial output ──────────────────────────────────────────────────────
      if (type === 'serial_output') {
        const text = (data?.data ?? '').trim();
        if (!text) return;
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          serialLines.push(line);
          serial(`UART: ${line}`);
          if (line.includes('MPU6050 ready!') || line.includes('===BEGIN_OK===')) {
            foundOK = true;
          }
          if (line.includes('not found') || line.includes('===BEGIN_FAILED===')) {
            foundFail = true;
            warn('begin() returned FALSE — firmware reported "not found"');
          }
          // If we got sensor data, stop after a few lines
          if (foundOK && serialLines.filter(l => l.startsWith('Accel')).length >= 3) {
            clearTimeout(timer);
            ws.close();
            resolve({ timedOut: false });
          }
        }
        // Fail fast: if error already confirmed, still wait for a bit more events
        if (foundFail && i2cEvents > 5) {
          // Give 5 more seconds to see remaining I2C events
          setTimeout(() => { clearTimeout(timer); ws.close(); resolve({ timedOut: false }); }, 5000);
        }
        return;
      }

      // ── I2C trace (Python slave handled the event — always emitted for debug) ─
      if (type === 'i2c_trace') {
        i2cTraceCount++;
        const { bus, addr, event, op, result, reg_ptr, wai_count } = data;
        const regHex = reg_ptr != null ? `0x${reg_ptr.toString(16).padStart(2,'0')}` : '??';
        const resHex = `0x${(result??0).toString(16).padStart(2,'0')}`;
        i2c(`[slave] bus=${bus} addr=0x${(addr??0).toString(16).padStart(2,'0')} ` +
            `op=${op} result=${resHex} reg_ptr=${regHex} wai=${wai_count}`);
        return;
      }

      // ── I2C event (forwarded from Python worker when addr NOT in _i2c_slaves) ─
      if (type === 'i2c_event') {
        i2cEvents++;
        const { bus, addr, event, response } = data;
        const op     = event & 0xFF;
        const d      = (event >> 8) & 0xFF;
        const opName = I2C_OP[op] ?? `0x${op.toString(16)}`;
        i2c(`[UNHANDLED slave] bus=${bus} addr=0x${(addr??0).toString(16).padStart(2,'0')} ` +
            `event=0x${(event??0).toString(16).padStart(4,'0')} op=${opName} data=0x${d.toString(16).padStart(2,'0')} ` +
            `resp=0x${(response??0).toString(16).padStart(2,'0')}`);
        return;
      }

      // ── gpio_change — show I2C pin activity ───────────────────────────────
      if (type === 'gpio_change') {
        const { pin, state } = data ?? {};
        if (pin === 21 || pin === 22) {
          // SDA=21, SCL=22 — these toggling means I2C is active on the bus
          i2c(`I2C pin toggle: GPIO${pin} (${pin===21?'SDA':'SCL'}) → ${state}`);
        }
        return;
      }

      // ── system / error ─────────────────────────────────────────────────────
      if (type === 'system') {
        info(`system event: ${JSON.stringify(data)}`);
        return;
      }
      if (type === 'error') {
        err(`simulation error: ${JSON.stringify(data)}`);
        return;
      }

      // ── Everything else ───────────────────────────────────────────────────
      if (!['gpio_change'].includes(type)) {
        info(`event type=${type} data=${JSON.stringify(data).slice(0,120)}`);
      }
    });

    ws.addEventListener('close', ev => {
      clearTimeout(timer);
      info(`WebSocket closed (code=${ev.code})`);
      resolve({ timedOut: false });
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
  console.log(' TEST: ESP32 + MPU-6050 I2C Simulation');
  console.log(' Session:', SESSION);
  console.log(' Backend:', BACKEND);
  console.log(' Timeout:', TIMEOUT_S, 's');
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
  info('NOTE: I2C trace events emitted by backend are shown below with [slave] prefix.');
  console.log();

  const result = await runSimulation(firmware_b64);

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log(' SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Total WebSocket events received : ${totalEvents}`);
  console.log(`  I2C trace events (slave handled): ${i2cTraceCount}`);
  console.log(`  I2C events (no slave registered): ${i2cEvents}`);
  console.log(`  Serial lines received           : ${serialLines.length}`);
  console.log(`  Timed out                       : ${result.timedOut}`);
  console.log();
  console.log('  Serial output:');
  for (const l of serialLines) console.log(`    ${l}`);
  console.log();

  if (foundOK) {
    console.log('\x1b[32m  ✓ PASS — MPU6050 detected and sensor data flowing\x1b[0m');
    process.exit(0);
  } else if (foundFail) {
    console.log('\x1b[31m  ✗ FAIL — mpu.begin() returned false ("not found")\x1b[0m');
    console.log('\x1b[33m  → Check the backend (uvicorn) terminal for I2C event trace.\x1b[0m');
    console.log('\x1b[33m  → Look for "I2C bus=0 addr=0x68" lines to see the full sequence.\x1b[0m');
    process.exit(1);
  } else if (result.timedOut) {
    console.log('\x1b[33m  ? TIMEOUT — no "ready" or "not found" in serial output\x1b[0m');
    process.exit(1);
  } else {
    console.log('\x1b[33m  ? INCONCLUSIVE — WebSocket closed before result determined\x1b[0m');
    process.exit(1);
  }
}

main().catch(e => { err('Unhandled error:', e); process.exit(1); });
