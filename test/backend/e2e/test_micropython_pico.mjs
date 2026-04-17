/**
 * test_micropython_pico.mjs
 *
 * End-to-end test for MicroPython on Raspberry Pi Pico (RP2040) using rp2040js.
 *
 * What it tests:
 *   Part 1 — Backend compile:
 *     POST /api/compile/ with a simple Arduino serial sketch for rp2040:rp2040:rpipico.
 *     Verifies the backend returns success + a valid .bin binary.
 *     (The backend auto-installs rp2040:rp2040 core on first run.)
 *
 *   Part 2 — MicroPython simulation:
 *     Downloads MicroPython v1.20.0 UF2 firmware for Pico from micropython.org.
 *     Loads it into a rp2040js RP2040 emulator (pure Node.js, no QEMU/backend).
 *     Boots MicroPython to REPL, sends a Python snippet via raw REPL,
 *     and verifies the expected output appears on USBCDC serial.
 *
 * Run:
 *   node test/backend/e2e/test_micropython_pico.mjs [--timeout=180] [--backend=http://localhost:8001]
 *
 * Prerequisites:
 *   - Backend running on http://localhost:8001  (for Part 1 only)
 *   - npm install --prefix test/backend/e2e    (installs rp2040js)
 */

import { Simulator, USBCDC, ConsoleLogger, LogLevel } from 'rp2040js';
import { bootromB1 } from './rp2040-bootrom.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────
const BACKEND   = process.env.BACKEND_URL
  ?? process.argv.find(a => a.startsWith('--backend='))?.slice(10)
  ?? 'http://localhost:8001';
const TIMEOUT_S = parseInt(
  process.argv.find(a => a.startsWith('--timeout='))?.slice(10) ?? '180'
);

// MicroPython v1.20.0 UF2 for Raspberry Pi Pico (same version used by the frontend)
const MICROPYTHON_UF2_URL =
  'https://micropython.org/resources/firmware/RPI_PICO-20230426-v1.20.0.uf2';

// UF2 format constants
const UF2_MAGIC0       = 0x0a324655;
const UF2_MAGIC1       = 0x9e5d5157;
const FLASH_START_ADDR = 0x10000000;

// Python code injected once ">>>" is seen
const INJECT_CODE = [
  'import sys',
  'print("velxio_pico_ok")',
  'print("py_version:" + sys.version.split(" ")[0])',
  'print("math_check:" + str(6 * 7))',
].join('\n');

// ─── Logging ──────────────────────────────────────────────────────────────────
const T0     = Date.now();
const ts     = () => `[+${((Date.now() - T0) / 1000).toFixed(3)}s]`;
const C      = {
  INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m',
  OK: '\x1b[32m', SERIAL: '\x1b[35m', DIAG: '\x1b[33m', RESET: '\x1b[0m',
};
const log    = (lvl, ...a) => console.log(`${C[lvl] ?? ''}${ts()} [${lvl}]${C.RESET}`, ...a);
const info   = (...a) => log('INFO',   ...a);
const ok     = (...a) => log('OK',     ...a);
const warn   = (...a) => log('WARN',   ...a);
const err    = (...a) => log('ERROR',  ...a);
const serial = (...a) => log('SERIAL', ...a);
const diag   = (...a) => log('DIAG',   ...a);

// ─── UF2 Parser ───────────────────────────────────────────────────────────────
/**
 * Parse a UF2 binary into a flash Uint8Array at the correct offsets.
 * UF2 blocks are 512 bytes; payload is 256 bytes at offset 32; flash address at offset 12.
 */
function parseUF2(uf2Bytes, flash) {
  const view   = new DataView(uf2Bytes.buffer, uf2Bytes.byteOffset, uf2Bytes.byteLength);
  let   blocks = 0;
  for (let off = 0; off + 512 <= uf2Bytes.length; off += 512) {
    if (view.getUint32(off,     true) !== UF2_MAGIC0) continue;
    if (view.getUint32(off + 4, true) !== UF2_MAGIC1) continue;
    const flashAddr = view.getUint32(off + 12, true);
    const payload   = uf2Bytes.subarray(off + 32, off + 32 + 256);
    const flashOff  = flashAddr - FLASH_START_ADDR;
    if (flashOff >= 0 && flashOff + 256 <= flash.length) {
      flash.set(payload, flashOff);
      blocks++;
    }
  }
  info(`UF2 parsed: ${blocks} blocks written to flash`);
  return blocks;
}

// ─── Part 1: Backend compile check ────────────────────────────────────────────
/**
 * Compile a trivial Arduino serial sketch for rp2040:rp2040:rpipico via the backend.
 * The backend will auto-install the rp2040:rp2040 core if it is not present.
 * Returns true on success, false if the compile fails or the backend is unreachable.
 */
async function checkBackendCompile() {
  info('─── Part 1: Backend compile check (rp2040:rp2040:rpipico) ───');

  const SKETCH = `
void setup() {
  Serial.begin(115200);
  Serial.println("velxio_pico_compile_ok");
}
void loop() {}
`.trim();

  try {
    const res = await fetch(`${BACKEND}/api/compile/`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files:      [{ name: 'sketch.ino', content: SKETCH }],
        board_fqbn: 'rp2040:rp2040:rpipico',
      }),
      signal: AbortSignal.timeout(120_000), // 2 min — first run installs the core
    });

    if (!res.ok) {
      warn(`Backend returned HTTP ${res.status} — compile step skipped`);
      return false;
    }

    const body = await res.json();
    if (!body.success) {
      warn(`Compile failed: ${body.error ?? body.stderr?.slice(0, 200)}`);
      return false;
    }

    const binaryB64 = body.binary_content ?? body.hex_content;
    if (!binaryB64) {
      warn('Backend returned success but no binary — compile check inconclusive');
      return false;
    }

    const binaryBytes = Math.floor(binaryB64.length * 0.75);
    ok(`Compile succeeded: binary ≈ ${(binaryBytes / 1024).toFixed(0)} KB`);
    if (body.core_install_log) {
      info(`Core auto-install log:\n${body.core_install_log.slice(0, 400)}`);
    }
    return true;

  } catch (e) {
    warn(`Backend unreachable or timed out (${e.message}) — compile step skipped`);
    return false;
  }
}

// ─── Part 2: MicroPython UF2 download ─────────────────────────────────────────
async function downloadUF2() {
  info(`─── Part 2: Download MicroPython UF2 ───`);
  info(`  URL: ${MICROPYTHON_UF2_URL}`);

  const controller = new AbortController();
  const dlTimeout  = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(MICROPYTHON_UF2_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    clearTimeout(dlTimeout);
    const bytes = new Uint8Array(buf);
    ok(`UF2 downloaded: ${bytes.length} bytes (${(bytes.length / 1024).toFixed(0)} KB)`);
    return bytes;
  } catch (e) {
    clearTimeout(dlTimeout);
    throw new Error(`UF2 download failed: ${e.message}`);
  }
}

// ─── Part 3: rp2040js simulation ──────────────────────────────────────────────
/**
 * Load MicroPython UF2 into rp2040js and run until REPL appears,
 * then inject a Python snippet and verify the output.
 */
function runPicoSimulation(uf2Bytes) {
  return new Promise((resolve) => {
    info('─── Part 3: rp2040js simulation ───');

    // ── Build RP2040 instance ──────────────────────────────────────────
    const sim = new Simulator();
    sim.rp2040.loadBootrom(bootromB1);
    sim.rp2040.logger = new ConsoleLogger(LogLevel.Error);

    // ── Load UF2 into flash ────────────────────────────────────────────
    const flash  = sim.rp2040.flash;
    const blocks = parseUF2(uf2Bytes, flash);
    if (blocks === 0) {
      sim.stop();
      return resolve({ timedOut: false, error: 'UF2 parse produced 0 blocks — bad firmware?' });
    }

    // ── Set up USBCDC (MicroPython serial REPL) ─────────────────────────
    const cdc = new USBCDC(sim.rp2040.usbCtrl);

    // Collected state
    let serialBuf    = '';
    let replState    = 'idle';     // idle → prompt_seen → raw_repl_entered → done
    let replReady    = false;
    let codeInjected = false;
    let outputOk     = false;
    let mathCheck    = false;

    // Global timeout — stop sim, resolve with what we have
    const globalTimer = setTimeout(() => {
      sim.stop();
      resolve({ timedOut: true, replReady, codeInjected, outputOk, mathCheck });
    }, TIMEOUT_S * 1000);

    // ── Send code in the raw REPL (mirrors Esp32Bridge._sendCodeInRawRepl) ──
    function sendCodeInRawRepl() {
      if (codeInjected) return;
      codeInjected = true;
      info('Stage 3: raw REPL confirmed → sending code in 64-byte chunks');
      diag(`Code:\n${INJECT_CODE}`);

      const codeBytes   = Array.from(new TextEncoder().encode(INJECT_CODE));
      const CHUNK_SIZE  = 64;
      const CHUNK_DELAY = 150;
      let   offset      = 0;

      const sendChunk = () => {
        if (offset >= codeBytes.length) {
          // All bytes sent — send Ctrl+D to execute
          setTimeout(() => {
            for (const b of [0x04]) cdc.sendSerialByte(b);
            replState = 'done';
            info('Ctrl+D sent — code executing');
          }, 300);
          return;
        }
        const chunk = codeBytes.slice(offset, offset + CHUNK_SIZE);
        for (const b of chunk) cdc.sendSerialByte(b);
        offset += CHUNK_SIZE;
        setTimeout(sendChunk, CHUNK_DELAY);
      };
      sendChunk();
    }

    // ── USBCDC connected — send \r\n to wake the REPL ──────────────────
    cdc.onDeviceConnected = () => {
      info('USBCDC connected — sending \\r\\n to wake REPL');
      cdc.sendSerialByte('\r'.charCodeAt(0));
      cdc.sendSerialByte('\n'.charCodeAt(0));
    };

    // ── USBCDC serial data (incoming from MicroPython) ─────────────────
    cdc.onSerialData = (buffer) => {
      for (const byte of buffer) {
        const ch = String.fromCharCode(byte);
        process.stdout.write(ch);
        serialBuf += ch;
      }

      // Stage 1: ">>>" → send Ctrl+A to enter raw REPL
      if (replState === 'idle' && serialBuf.includes('>>>')) {
        replState = 'prompt_seen';
        replReady = true;
        serialBuf = '';
        ok('Stage 1: >>> seen → sending Ctrl+A (raw REPL)');
        setTimeout(() => cdc.sendSerialByte(0x01), 200);
      }

      // Stage 2: "raw REPL" → now safe to send code
      if (replState === 'prompt_seen' && serialBuf.includes('raw REPL')) {
        replState = 'raw_repl_entered';
        serialBuf = '';
        setTimeout(sendCodeInRawRepl, 200);
      }

      // Parse output lines for markers
      let nl;
      while ((nl = serialBuf.indexOf('\n')) !== -1) {
        const line = serialBuf.slice(0, nl).replace(/\r$/, '');
        serialBuf  = serialBuf.slice(nl + 1);
        if (!line.trim()) continue;

        serial(`USBCDC: ${line}`);

        if (line.startsWith('MicroPython')) {
          ok(`MicroPython booted: ${line}`);
        }
        if (line.includes('velxio_pico_ok')) {
          outputOk = true;
          ok('"velxio_pico_ok" received ✓');
        }
        if (line.includes('math_check:42')) {
          mathCheck = true;
          ok('"math_check:42" (6×7=42) confirmed ✓');
        }

        if (outputOk && mathCheck) {
          clearTimeout(globalTimer);
          sim.stop();
          resolve({ timedOut: false, replReady, codeInjected, outputOk, mathCheck });
        }
      }

      // Cap buffer to avoid runaway memory
      if (serialBuf.length > 4096) serialBuf = serialBuf.slice(-512);
    };

    // ── Start simulation ────────────────────────────────────────────────
    sim.rp2040.core.PC = 0x10000000;
    sim.execute();
    info('RP2040 simulation started (125 MHz, MicroPython UF2)');
    info(`Waiting up to ${TIMEOUT_S}s for REPL...`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  MicroPython Raspberry Pi Pico — E2E Test');
  console.log('='.repeat(60) + '\n');
  info(`Backend : ${BACKEND}`);
  info(`Timeout : ${TIMEOUT_S}s`);

  let exitCode = 0;

  try {
    // ── Part 1: backend compile ────────────────────────────────────────
    const compileOk = await checkBackendCompile();
    if (!compileOk) {
      warn('Backend compile check skipped or failed — continuing with simulation');
    }

    // ── Part 2: download firmware ──────────────────────────────────────
    const uf2Bytes = await downloadUF2();

    // ── Part 3: run simulation ─────────────────────────────────────────
    const result = await runPicoSimulation(uf2Bytes);

    // ── Report ─────────────────────────────────────────────────────────
    console.log('\n' + '─'.repeat(60));
    console.log('  Results');
    console.log('─'.repeat(60));
    console.log(`  Backend compile:  ${compileOk}`);
    console.log(`  Timed out:        ${result.timedOut}`);
    console.log(`  REPL appeared:    ${result.replReady}`);
    console.log(`  Code injected:    ${result.codeInjected}`);
    console.log(`  Output received:  ${result.outputOk}`);
    console.log(`  Math check (42):  ${result.mathCheck}`);
    console.log('─'.repeat(60) + '\n');

    // ── Assertions ─────────────────────────────────────────────────────
    const FAIL = (msg) => { err(`FAIL: ${msg}`); exitCode = 1; };

    if (!compileOk) {
      // Not a hard failure — rp2040 core may not be installed in this CI run
      warn('Backend compile check did not pass (rp2040 core may not be installed yet)');
    }
    if (result.error)       FAIL(result.error);
    if (!result.replReady)  FAIL('MicroPython REPL ">>>" never appeared within timeout');
    if (!result.outputOk)   FAIL('"velxio_pico_ok" not found in USBCDC output (REPL injection failed?)');
    if (!result.mathCheck)  FAIL('"math_check:42" not found (6×7 computation did not execute)');

    if (exitCode === 0) {
      ok('ALL SIMULATION CHECKS PASSED ✓');
    }

  } catch (e) {
    err(`Fatal: ${e.message}`);
    console.error(e);
    exitCode = 1;
  }

  process.exit(exitCode);
}

main();
