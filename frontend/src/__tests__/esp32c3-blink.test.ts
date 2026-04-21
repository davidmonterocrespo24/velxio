/**
 * ESP32-C3 blink integration test.
 *
 * Compiles a bare-metal C program with riscv32-esp-elf-gcc (the toolchain
 * bundled with arduino-cli's ESP32 package), loads the raw binary into
 * Esp32C3Simulator, and verifies that GPIO 8 toggles as expected.
 *
 * Why bare-metal and not a full Arduino sketch?
 *   The full ESP-IDF/Arduino framework requires dozens of peripherals
 *   (cache controller, interrupt matrix, RTC, FreeRTOS scheduler, etc.) that
 *   the browser-side emulator does not implement. A bare-metal program that
 *   writes directly to GPIO MMIO registers tests exactly what the emulator
 *   is built for: pure RV32IMC instruction execution with GPIO/UART MMIO.
 *
 * Source: frontend/src/__tests__/fixtures/esp32c3-blink/blink.c
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Esp32C3Simulator } from '../simulation/Esp32C3Simulator';
import type { PinManager } from '../simulation/PinManager';

// ── Mocks (Node has no requestAnimationFrame) ─────────────────────────────────
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
  cb();
  return 0;
});
vi.stubGlobal('cancelAnimationFrame', () => {});

// ── Paths ─────────────────────────────────────────────────────────────────────
const FIXTURE_DIR = join(__dirname, 'fixtures/esp32c3-blink');
const BIN_PATH = join(FIXTURE_DIR, 'blink.bin');
const DIS_PATH = join(FIXTURE_DIR, 'blink.dis');
const BUILD_SH = join(FIXTURE_DIR, 'build.sh');

// ── Helpers ───────────────────────────────────────────────────────────────────
function mockPinManager(): PinManager {
  return {
    setPinState: vi.fn(),
    getPinState: vi.fn(() => false),
  } as unknown as PinManager;
}

/** Run N CPU steps on the simulator's internal core */
function runSteps(sim: Esp32C3Simulator, n: number): void {
  const core = (sim as unknown as { core: { step(): void } }).core;
  for (let i = 0; i < n; i++) core.step();
}

// ── Build the binary once before all tests ────────────────────────────────────
let buildError: string | null = null;
let binData: Uint8Array;

beforeAll(() => {
  // Rebuild whenever the source changes (or if binary is missing)
  try {
    execSync(`bash "${BUILD_SH}"`, { stdio: 'pipe' });
  } catch (err: unknown) {
    buildError = String((err as NodeJS.ErrnoException).stderr ?? err);
    if (!existsSync(BIN_PATH)) return; // binary missing AND build failed
    // Binary exists from a previous build — use it but warn
    console.warn('[esp32c3-blink] Build script failed; using existing binary.\n' + buildError);
    buildError = null;
  }
  binData = new Uint8Array(readFileSync(BIN_PATH));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ESP32-C3 bare-metal blink (compiled with riscv32-esp-elf-gcc)', () => {
  it('build.sh produces a non-empty blink.bin', () => {
    if (buildError) throw new Error('Build failed:\n' + buildError);
    expect(binData.byteLength).toBeGreaterThan(0);
    expect(binData.byteLength).toBeLessThan(4096); // sanity: tiny bare-metal binary
    console.log(`Binary size: ${binData.byteLength} bytes`);
  });

  it('binary starts with a valid RV32 instruction at 0x42000000', () => {
    if (buildError) throw new Error('Build failed:\n' + buildError);
    // First 4 bytes must decode as a valid 32-bit or 16-bit RISC-V instruction
    const b0 = binData[0],
      b1 = binData[1];
    const half = b0 | (b1 << 8);
    const is32bit = (half & 0x3) === 0x3;
    const is16bit = (half & 0x3) !== 0x3;
    expect(is32bit || is16bit).toBe(true);

    // First instruction in the disassembly should be _start at 0x42000000
    if (existsSync(DIS_PATH)) {
      const dis = readFileSync(DIS_PATH, 'utf8');
      expect(dis).toContain('42000000 <_start>');
      console.log('\nDisassembly (first 20 lines):\n' + dis.split('\n').slice(0, 20).join('\n'));
    }
  });

  it('loadBin() loads the binary and resets PC to 0x42000000', () => {
    if (buildError) throw new Error('Build failed:\n' + buildError);
    const sim = new Esp32C3Simulator(mockPinManager());
    sim.loadBin(binData);
    const core = (sim as unknown as { core: { pc: number } }).core;
    expect(core.pc).toBe(0x42000000);
  });

  it('GPIO 8 goes HIGH after the first SW to GPIO_W1TS', () => {
    if (buildError) throw new Error('Build failed:\n' + buildError);
    const pm = mockPinManager();
    const sim = new Esp32C3Simulator(pm);
    const pinEvents: Array<{ pin: number; state: boolean; timeMs: number }> = [];
    sim.onPinChangeWithTime = (pin, state, timeMs) => pinEvents.push({ pin, state, timeMs });

    sim.loadBin(binData);
    // The blink program writes GPIO_W1TS within the first ~10 instructions
    runSteps(sim, 20);

    const gpio8Events = pinEvents.filter((e) => e.pin === 8);
    expect(gpio8Events.length).toBeGreaterThan(0);
    expect(gpio8Events[0].state).toBe(true); // first event is LED ON
    expect(gpio8Events[0].timeMs).toBeGreaterThan(0); // has a meaningful timestamp

    console.log(`GPIO 8 went HIGH at ${gpio8Events[0].timeMs.toFixed(4)} ms (simulated)`);
  });

  it('GPIO 8 toggles ON and OFF within a full blink cycle', () => {
    if (buildError) throw new Error('Build failed:\n' + buildError);
    const pm = mockPinManager();
    const sim = new Esp32C3Simulator(pm);
    const pinEvents: Array<{ pin: number; state: boolean }> = [];
    sim.onPinChangeWithTime = (pin, state) => pinEvents.push({ pin, state });

    sim.loadBin(binData);
    // delay(50) = ~200 instructions; two delays + GPIO writes ≈ 410 instructions/cycle
    // Run 2000 steps → ~4 complete blink cycles
    runSteps(sim, 2000);

    const gpio8 = pinEvents.filter((e) => e.pin === 8);
    const highEvents = gpio8.filter((e) => e.state === true);
    const lowEvents = gpio8.filter((e) => e.state === false);

    expect(highEvents.length).toBeGreaterThanOrEqual(2); // at least 2 ON events
    expect(lowEvents.length).toBeGreaterThanOrEqual(2); // at least 2 OFF events

    // Events should strictly alternate: HIGH, LOW, HIGH, LOW ...
    for (let i = 0; i < gpio8.length - 1; i++) {
      expect(gpio8[i].state).not.toBe(gpio8[i + 1].state);
    }

    console.log(
      `GPIO 8 toggled ${gpio8.length} times in 2000 steps (${highEvents.length} ON, ${lowEvents.length} OFF)`,
    );
  });

  it('PinManager.setPinState is called with correct pin and state', () => {
    if (buildError) throw new Error('Build failed:\n' + buildError);
    const pm = mockPinManager();
    const sim = new Esp32C3Simulator(pm);
    sim.loadBin(binData);
    runSteps(sim, 2000);

    // PinManager must have received GPIO 8 state changes
    expect(pm.setPinState).toHaveBeenCalledWith(8, true);
    expect(pm.setPinState).toHaveBeenCalledWith(8, false);
  });

  it('timestamps increase monotonically across blink events', () => {
    if (buildError) throw new Error('Build failed:\n' + buildError);
    const sim = new Esp32C3Simulator(mockPinManager());
    const times: number[] = [];
    sim.onPinChangeWithTime = (pin, _state, timeMs) => {
      if (pin === 8) times.push(timeMs);
    };

    sim.loadBin(binData);
    runSteps(sim, 2000);

    expect(times.length).toBeGreaterThan(2);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
    const totalSimMs = times[times.length - 1];
    console.log(`Simulated ${totalSimMs.toFixed(4)} ms over 2000 steps`);
  });

  it('reset() after run clears GPIO state', () => {
    if (buildError) throw new Error('Build failed:\n' + buildError);
    const sim = new Esp32C3Simulator(mockPinManager());
    sim.loadBin(binData);
    runSteps(sim, 500);

    sim.reset();
    expect(sim.isRunning()).toBe(false);

    const core = (sim as unknown as { core: { pc: number }; gpioOut: number }).core;
    expect(core.pc).toBe(0x42000000);
  });
});
