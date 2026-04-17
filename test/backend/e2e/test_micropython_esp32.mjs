/**
 * test_micropython_esp32.mjs
 *
 * End-to-end diagnostic test for MicroPython on ESP32 via QEMU simulation.
 *
 * What it tests:
 *   1. MicroPython firmware is downloaded, correctly placed at flash offset 0x1000,
 *      and padded to 4 MB (required by the firmware's CONFIG_ESPTOOLPY_FLASHSIZE_4MB).
 *   2. QEMU boots without flash-size errors.
 *   3. MicroPython REPL prompt ">>>" appears in serial output.
 *   4. A simple Python snippet is injected via raw REPL (Ctrl+A / code / Ctrl+D)
 *      and the expected output line is observed.
 *
 * Flash layout:
 *   [0x0000–0x0FFF] = 0xFF  (ROM bootloader reads its own code from chip, not flash)
 *   [0x1000–...   ] = MicroPython .bin (2nd-stage bootloader at file offset 0)
 *   Padded to 4 MB  (firmware header declares 4 MB flash)
 *
 * Run:
 *   node test/backend/e2e/test_micropython_esp32.mjs [--timeout=120] [--backend=http://localhost:8001]
 *
 * Prerequisites: Backend running on http://localhost:8001
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const BACKEND   = process.env.BACKEND_URL
  ?? process.argv.find(a => a.startsWith('--backend='))?.slice(10)
  ?? 'http://localhost:8001';
const WS_BASE   = BACKEND.replace(/^https?:/, m => m === 'https:' ? 'wss:' : 'ws:');
const SESSION   = `test-micropython-${Date.now()}`;
const TIMEOUT_S = parseInt(
  process.argv.find(a => a.startsWith('--timeout='))?.slice(10) ?? '120'
);

// MicroPython firmware for ESP32 (LX6 / Xtensa dual-core)
// Flash command: esptool.py write_flash -z 0x1000 <file>  → offset = 0x1000
const FIRMWARE_URL  = 'https://micropython.org/resources/firmware/ESP32_GENERIC-20230426-v1.20.0.bin';
const FLASH_OFFSET  = 0x1000;          // bytes — 2nd-stage bootloader must start here
const FLASH_SIZE    = 4 * 1024 * 1024; // 4 MB — matches firmware's built-in flash config

// Python code injected once ">>>" is seen
const INJECT_CODE = [
  'import sys',
  'print("velxio_micropython_ok")',
  'print("py_version:" + sys.version.split(" ")[0])',
  'print("math_check:" + str(6 * 7))',
].join('\n');

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

// ─── Step 1: Download MicroPython firmware ────────────────────────────────────
async function downloadFirmware() {
  info(`Downloading MicroPython firmware from ${FIRMWARE_URL} ...`);
  const controller = new AbortController();
  const dlTimeout  = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(FIRMWARE_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from firmware URL`);
    const buf = await res.arrayBuffer();
    clearTimeout(dlTimeout);
    const bytes = new Uint8Array(buf);
    ok(`Downloaded ${bytes.length} bytes (${(bytes.length / 1024).toFixed(1)} KB)`);
    return bytes;
  } catch (e) {
    clearTimeout(dlTimeout);
    throw new Error(`Firmware download failed: ${e.message}`);
  }
}

// ─── Step 2: Build 4 MB flash image ──────────────────────────────────────────
function buildFlashImage(firmware) {
  if (firmware.length + FLASH_OFFSET > FLASH_SIZE) {
    throw new Error(`Firmware (${firmware.length} B) + offset (${FLASH_OFFSET} B) > 4 MB`);
  }
  const image = new Uint8Array(FLASH_SIZE).fill(0xFF);
  image.set(firmware, FLASH_OFFSET);
  info(`Flash image: 4 MB, firmware at offset 0x${FLASH_OFFSET.toString(16).padStart(4, '0')}`);

  // Sanity-check: first byte at offset must be 0xE9 (ESP32 image magic)
  const magic = image[FLASH_OFFSET];
  if (magic !== 0xE9) {
    warn(`Unexpected magic byte at 0x${FLASH_OFFSET.toString(16)}: 0x${magic.toString(16)} (expected 0xE9)`);
  } else {
    ok(`Magic byte 0xE9 confirmed at flash offset 0x${FLASH_OFFSET.toString(16)}`);
  }
  return image;
}

// ─── Step 3: Base64-encode ────────────────────────────────────────────────────
function toBase64(bytes) {
  // Node.js Buffer is the fastest path; fall back to btoa for browser compat
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ─── Step 4: Run simulation via WebSocket ────────────────────────────────────
function runSimulation(firmware_b64) {
  return new Promise((resolve) => {
    const wsUrl = `${WS_BASE}/api/simulation/ws/${SESSION}`;
    info(`Connecting WebSocket → ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    // ── Collected evidence ──────────────────────────────────────────────
    const serialLines  = [];
    let   replState    = 'idle';    // idle → banner_seen → prompt_seen → raw_repl_entered
    let   replReady    = false;     // true once ">>>" confirmed (for result reporting)
    let   codeInjected = false;     // true once code bytes sent
    let   outputOk     = false;     // "velxio_micropython_ok" received
    let   mathCheck    = false;     // "math_check:42" received
    let   flashError   = false;     // flash-size warning seen
    let   bootError    = false;     // OSError/_boot.py error seen
    let   serialBuf    = '';

    const globalTimer = setTimeout(() => {
      info(`Global timeout (${TIMEOUT_S}s)`);
      ws.close();
      resolve({ timedOut: true, serialLines, replReady, outputOk, mathCheck,
                flashError, bootError, codeInjected });
    }, TIMEOUT_S * 1000);

    // ── 4-stage state machine (mirrors Esp32Bridge.ts) ──────────────────
    function sendCodeInRawRepl() {
      if (codeInjected) return;
      codeInjected = true;
      info('Stage 3: raw REPL confirmed → sending code in 64-byte chunks');
      diag(`Code:\n${INJECT_CODE}`);
      const codeBytes = Array.from(new TextEncoder().encode(INJECT_CODE));
      const CHUNK_SIZE = 64;
      const CHUNK_DELAY_MS = 150;
      let offset = 0;

      const sendChunk = () => {
        if (offset >= codeBytes.length) {
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'esp32_serial_input', data: { bytes: [0x04] } }));
            replState = 'done';
            info('Ctrl+D sent — code executing');
          }, 300);
          return;
        }
        const chunk = codeBytes.slice(offset, offset + CHUNK_SIZE);
        ws.send(JSON.stringify({ type: 'esp32_serial_input', data: { bytes: chunk } }));
        offset += CHUNK_SIZE;
        setTimeout(sendChunk, CHUNK_DELAY_MS);
      };
      sendChunk();
    }

    ws.addEventListener('open', () => {
      ok('WebSocket connected');
      ws.send(JSON.stringify({
        type: 'start_esp32',
        data: {
          board:        'esp32',
          firmware_b64,
          sensors:      [],
          wifi_enabled: false,
        },
      }));
      info('Sent start_esp32 with MicroPython firmware (4 MB flash image)');
    });

    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const { type, data } = msg;

      if (type === 'serial_output') {
        const text = data?.data ?? '';
        serialBuf += text;

        for (const ch of text) process.stdout.write(ch);

        // ── 4-stage state machine (mirrors Esp32Bridge.ts) ──────────────
        // Stage 1: "Type help()" banner → poke \r to flush ">>> " from UART FIFO
        if (replState === 'idle' && serialBuf.includes('Type "help()"')) {
          replState = 'banner_seen';
          info('Stage 1: banner seen → poking UART with \\r');
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'esp32_serial_input', data: { bytes: [0x0D] } }));
          }, 800);
        }

        // Stage 2: ">>>" visible → send Ctrl+A to enter raw REPL
        if (replState === 'banner_seen' && serialBuf.includes('>>>')) {
          replState = 'prompt_seen';
          replReady = true;
          serialBuf = '';
          ok('Stage 2: >>> seen → sending Ctrl+A');
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'esp32_serial_input', data: { bytes: [0x01] } }));
          }, 200);
        }

        // Stage 3: "raw REPL" confirmation → now safe to send code
        if (replState === 'prompt_seen' && serialBuf.includes('raw REPL')) {
          replState = 'raw_repl_entered';
          serialBuf = '';
          setTimeout(sendCodeInRawRepl, 200);
        }

        // Split on newlines for line-by-line error/output analysis
        let nl;
        while ((nl = serialBuf.indexOf('\n')) !== -1) {
          const line = serialBuf.slice(0, nl).replace(/\r$/, '');
          serialBuf  = serialBuf.slice(nl + 1);
          if (!line.trim()) continue;

          serialLines.push(line);
          serial(`UART: ${line}`);

          if (line.includes('smaller than the size in the binary image header')) {
            flashError = true;
            warn('Flash size mismatch!');
          }
          if (line.includes('OSError') && line.includes('FLASH_NOT_INITIALISED')) {
            bootError = true;
            warn('_boot.py OSError — VFS init failed');
          }
          if (line.startsWith('MicroPython ')) {
            ok(`MicroPython booted: ${line}`);
          }
          if (line.includes('velxio_micropython_ok')) {
            outputOk = true;
            ok('Output marker "velxio_micropython_ok" received ✓');
          }
          if (line.includes('math_check:42')) {
            mathCheck = true;
            ok('Math check "6*7=42" confirmed ✓');
          }
          if (outputOk && mathCheck) {
            clearTimeout(globalTimer);
            ws.close();
            resolve({ timedOut: false, serialLines, replReady, outputOk, mathCheck,
                      flashError, bootError, codeInjected });
          }
        }

        if (serialBuf.length > 8192) serialBuf = serialBuf.slice(-1024);
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
      resolve({ timedOut: false, serialLines, replReady, outputOk, mathCheck,
                flashError, bootError, codeInjected });
    });

    ws.addEventListener('error', ev => {
      err('WebSocket error', ev.message ?? '');
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  MicroPython ESP32 QEMU Simulation — E2E Diagnostic Test');
  console.log('='.repeat(60) + '\n');
  info(`Backend: ${BACKEND}`);
  info(`Timeout: ${TIMEOUT_S}s`);

  let exitCode = 0;

  try {
    // 1. Download firmware
    const rawFirmware = await downloadFirmware();

    // 2. Build flash image (firmware at 0x1000, padded to 4 MB)
    const flashImage = buildFlashImage(rawFirmware);

    // 3. Base64 encode
    const firmware_b64 = toBase64(flashImage);
    info(`Flash image base64: ${Math.round(firmware_b64.length / 1024)} KB`);

    // 4. Run simulation
    const result = await runSimulation(firmware_b64);

    // ── Report ──────────────────────────────────────────────────────────
    console.log('\n' + '─'.repeat(60));
    console.log('  Results');
    console.log('─'.repeat(60));
    console.log(`  Timed out:        ${result.timedOut}`);
    console.log(`  Flash error:      ${result.flashError}  (should be false after 4 MB fix)`);
    console.log(`  Boot error:       ${result.bootError}   (should be false after 4 MB fix)`);
    console.log(`  REPL appeared:    ${result.replReady}`);
    console.log(`  Code injected:    ${result.codeInjected}`);
    console.log(`  Output received:  ${result.outputOk}`);
    console.log(`  Math check (42):  ${result.mathCheck}`);
    console.log(`  Serial lines:     ${result.serialLines.length}`);
    console.log('─'.repeat(60) + '\n');

    // ── Assertions ──────────────────────────────────────────────────────
    const FAIL = (msg) => { err(`FAIL: ${msg}`); exitCode = 1; };

    if (result.flashError)  FAIL('Flash size mismatch — padToFlashSize must produce a 4 MB image for ESP32');
    if (result.bootError)   FAIL('_boot.py OSError — flash not initialised (likely flash size mismatch)');
    if (!result.replReady)  FAIL('MicroPython REPL prompt ">>>" never appeared');
    if (!result.outputOk)   FAIL('"velxio_micropython_ok" not found in serial output (code injection failed?)');
    if (!result.mathCheck)  FAIL('"math_check:42" not found (6*7 computation did not execute)');

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
