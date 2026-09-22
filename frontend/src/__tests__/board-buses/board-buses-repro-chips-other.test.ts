/**
 * Board buses F0: reproduction of the chips-other findings
 * (project/board-buses-2026-09/evidence/f0-repro-areas.json, key "chips-other").
 *
 * Every case drives the REAL path: avr8js through AVRSimulator, sketches built
 * with the production toolchain (fixtures/chips-other-<sketch>/), custom chips
 * compiled from C with wasi-sdk (fixtures/chips-other-chips/, rebuild with its
 * build.sh), the real CustomChipPart attached through PartSimulationRegistry,
 * the real tilt-switch part, the real store, Interconnect and DynamicComponent.
 * Nothing under test is mocked; the only thing swapped is the clock (fake
 * timers) in the cases whose finding is about wall-clock pacing, and there
 * the real AVRSimulator.start() frame loop runs on the fake rAF.
 *
 * The file runs in the node environment with a jsdom window installed by hand
 * (below), not under `@vitest-environment jsdom`: that environment transforms
 * modules for the web, and in a worktree whose node_modules is a symlink out
 * of the Vite fs allow-list the store's `littlefs.wasm?url` import is refused.
 * DynamicComponent and react-dom are imported only after the window exists.
 *
 * Convention (TESTS.md): an `it.fails` states the hardware-faithful behaviour
 * and fails today for the reason the finding gives; its sibling `setup` test
 * proves the scenario itself works (firmware boots, the chip attached, bytes
 * reach the engine), so the `it.fails` cannot pass on a broken setup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createElement, act } from 'react';
import type { Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { populateGlobal } from 'vitest/runtime';
import { AVRSimulator } from '../../simulation/AVRSimulator';
import { PinManager } from '../../simulation/PinManager';
import { PartSimulationRegistry } from '../../simulation/parts';
import { ChipInstance } from '../../simulation/customChips/ChipRuntime';
import { getSimulatorBridges } from '../../simulation/customChips/simulatorBridges';
import { resetBusNets } from '../../simulation/customChips/busNets';
import {
  setChipBusEnabledForTest,
  resetChipNetIndexForTest,
  resolveCrossBoardChipNets,
} from '../../simulation/customChips/chipNets';
import { resetInterconnect } from '../../simulation/Interconnect';
import { traceDetailed } from '../../simulation/PinTrace';
import {
  useSimulatorStore,
  getBoardSimulator,
  getBoardPinManager,
} from '../../store/useSimulatorStore';
import { resetStore, clearAllPinManagerState } from '../helpers/multiBoardSetup';

populateGlobal(
  globalThis,
  new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost:3000',
  }).window,
  { bindFunctions: true },
);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Fixtures ────────────────────────────────────────────────────────────────

// Not `new URL(`./fixtures/${p}`, import.meta.url)`: Vite rewrites that pattern
// into an asset glob and the lookup comes back undefined.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (p: string) => join(FIXTURES, p);
const sketch = (dir: string, name: string) =>
  readFileSync(fx(`chips-other-${dir}/${name}.ino.hex`), 'utf8');
const chipB64 = (name: string) =>
  readFileSync(fx(`chips-other-chips/${name}.wasm`)).toString('base64');
const chipBytes = (name: string) => new Uint8Array(readFileSync(fx(`chips-other-chips/${name}.wasm`)));

const HEX = {
  uartPing: sketch('uart-ping', 'uart-ping'),
  clock: sketch('clock', 'clock-probe'),
  openDrain: sketch('open-drain', 'open-drain'),
  pulseSnoop: sketch('pulse-snoop', 'pulse-snoop'),
  i2cScan: sketch('i2c-scan', 'i2c-scan'),
  spiRead: sketch('spi-read', 'spi-read'),
};

// ── Harness ─────────────────────────────────────────────────────────────────

/** Everything console.log saw: the chips speak through it (CustomChipPart
 *  prefixes each line with `[chip:<id>]`), and the simulators are chatty. */
let logLines: string[] = [];
/** Uno simulators built by a test, so teardown can stop their loops. */
let sims: AVRSimulator[] = [];
/** Chip cleanups not yet run by the test itself. */
let cleanups: Array<() => void> = [];

beforeEach(() => {
  logLines = [];
  sims = [];
  cleanups = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logLines.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* already gone */
    }
  }
  for (const sim of sims) {
    sim.stop();
    // The AVR chip-to-board FIFO re-arms a 1 ms timer while it holds bytes
    // and the CPU is not stepping; empty it so no test leaves a timer chain
    // running into the next one.
    getSimulatorBridges(sim).uartRxQueue.length = 0;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  useSimulatorStore.setState((s) => ({ boards: s.boards.map((b) => ({ ...b, running: false })) }));
});

/** Lines a chip logged with vx_log, in order. */
function chipSaid(id: string): string[] {
  const prefix = `[chip:${id}] [chip] `;
  return logLines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
}

interface Uno {
  sim: AVRSimulator;
  /** Everything the sketch printed on Serial so far. */
  out(): string;
  clear(): void;
}

function uno(hex: string, sim = new AVRSimulator(new PinManager(), 'uno')): Uno {
  sim.loadHex(hex);
  let buf = '';
  sim.onSerialData = (ch) => {
    buf += ch;
  };
  sims.push(sim);
  return { sim, out: () => buf, clear: () => (buf = '') };
}

/** Run the CPU for `ms` of guest time, instruction by instruction. */
function runMs(sim: AVRSimulator, ms: number): void {
  const end = sim.getCurrentCycles() + ms * 16_000;
  while (sim.getCurrentCycles() < end) sim.step();
}

/** Run until `pred` holds or `maxMs` of guest time elapsed. */
function runUntil(sim: AVRSimulator, maxMs: number, pred: () => boolean): void {
  for (let t = 0; t < maxMs && !pred(); t++) runMs(sim, 1);
}

/** Put a custom chip in the store, the way the canvas holds one. */
function placeChip(id: string, wasm: string, pins: string[], attrs: Record<string, number> = {}): void {
  const comp = {
    id,
    metadataId: 'custom-chip',
    x: 0,
    y: 0,
    properties: { wasmBase64: chipB64(wasm), chipJson: JSON.stringify({ name: wasm, pins }), attrs },
  };
  useSimulatorStore.setState((s) => ({
    components: [...s.components.filter((c) => c.id !== id), comp] as never,
  }));
}

/**
 * Attach a chip through the real CustomChipPart, exactly as DynamicComponent
 * does on a hexEpoch change, and wait for its chip_setup to have run. The
 * wiring map stands in for traceDetailed: chip pin name to board pin.
 */
async function attachChip(
  sim: unknown,
  id: string,
  wasm: string,
  pins: string[],
  wiring: Record<string, number>,
  attrs: Record<string, number> = {},
): Promise<() => void> {
  placeChip(id, wasm, pins, attrs);
  const logic = PartSimulationRegistry.get('custom-chip')!;
  const before = chipSaid(id).filter((l) => l === `${wasm} ready`).length;
  const cleanup = logic.attachEvents!(
    document.createElement('div'),
    sim as never,
    (pin: string) => (pin in wiring ? wiring[pin] : null),
    id,
  );
  await vi.waitFor(
    () => expect(chipSaid(id).filter((l) => l === `${wasm} ready`).length).toBe(before + 1),
    { timeout: 5000, interval: 2 },
  );
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    cleanup?.();
  };
  cleanups.push(once);
  return once;
}

/** Bytes a chip reported with its "rx HH" log, as a string. */
function chipHeard(id: string): string {
  return chipSaid(id)
    .filter((l) => l.startsWith('rx '))
    .map((l) => String.fromCharCode(parseInt(l.slice(3), 16)))
    .join('');
}

const FAKE_CLOCK = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'performance',
] as const;

function setBoardsRunning(running: boolean): void {
  useSimulatorStore.setState((s) => ({ boards: s.boards.map((b) => ({ ...b, running })) }));
}

// ── 1. AVR chip UART bridge across the board lifecycle ──────────────────────
//
// Uno + the uart-probe chip on the hardware serial (chip RX on D1, TX on D0).
// The sketch prints "ready\n" at boot; the chip logs every byte it hears.
// D2 is held HIGH so the sketch does not ask for the chip's burst: only the
// board-to-chip direction is under test here.

const UART_PINS = ['RX', 'TX', 'GND', 'VCC'];
const UART_WIRES = { RX: 1, TX: 0 };

describe('AVR: chip UART bridge after recompile, Stop/Run and Reset', () => {
  const IDS = 'avr-uart-dispatcher-lost-after-recompile-or-stop, avr-uart-dispatcher-lost-on-reload';

  async function firstRun() {
    const board = uno(HEX.uartPing);
    board.sim.setPinState(2, true);
    const detach = await attachChip(board.sim, 'uart1', 'uart-probe', UART_PINS, UART_WIRES);
    runMs(board.sim, 20);
    return { board, detach };
  }

  it(`${IDS} setup: on the first Run the sketch's bytes reach the chip`, async () => {
    const { board } = await firstRun();
    expect(board.out()).toContain('ready\n');
    expect(chipHeard('uart1')).toBe('ready\n');
  });

  // The three it.fails below also check the monitor, but an it.fails passes on
  // ANY failed assertion, so the second boot has to be proven here.
  it(`${IDS} setup: the sketch boots and prints again after a recompile, a Stop/Run and a Reset`, async () => {
    for (const step of ['recompile', 'stop-run', 'reset'] as const) {
      const { board, detach } = await firstRun();
      if (step === 'recompile') {
        detach();
        board.sim.loadHex(HEX.uartPing);
      } else {
        board.sim.reset();
        if (step === 'reset') detach();
      }
      board.sim.setPinState(2, true);
      if (step !== 'stop-run') await attachChip(board.sim, 'uart1', 'uart-probe', UART_PINS, UART_WIRES);
      board.clear();
      runMs(board.sim, 20);
      expect(board.out(), step).toBe('ready\n');
    }
  });

  it.fails(`${IDS}: after a recompile (loadHex on the same simulator, part re-attached) the chip still hears the sketch`, async () => {
    const { board, detach } = await firstRun();
    // compileBoardProgram: loadHex on the SAME AVRSimulator, then the hexEpoch
    // bump makes DynamicComponent run the part's cleanup and attach again.
    detach();
    board.sim.loadHex(HEX.uartPing);
    board.sim.setPinState(2, true);
    await attachChip(board.sim, 'uart1', 'uart-probe', UART_PINS, UART_WIRES);
    board.clear();
    runMs(board.sim, 20);
    expect(board.out()).toContain('ready\n');
    expect(chipHeard('uart1')).toBe('ready\nready\n');
  });

  it.fails(`${IDS}: after Stop then Run (reset, no re-attach) the chip still hears the sketch`, async () => {
    const { board } = await firstRun();
    // stopBoard on an AVR: sim.reset() (a new AVRUSART), no hexEpoch bump.
    board.sim.reset();
    board.sim.setPinState(2, true);
    board.clear();
    runMs(board.sim, 20);
    expect(board.out()).toContain('ready\n');
    expect(chipHeard('uart1')).toBe('ready\nready\n');
  });

  it.fails(`${IDS}: after Reset (reset plus re-attach) the chip still hears the sketch`, async () => {
    const { board, detach } = await firstRun();
    // resetBoard: sim.reset() and a hexEpoch bump, so the part re-attaches.
    board.sim.reset();
    detach();
    board.sim.setPinState(2, true);
    await attachChip(board.sim, 'uart1', 'uart-probe', UART_PINS, UART_WIRES);
    board.clear();
    runMs(board.sim, 20);
    expect(board.out()).toContain('ready\n');
    expect(chipHeard('uart1')).toBe('ready\nready\n');
  });
});

// ── 2. AVR chip-to-board RX FIFO ────────────────────────────────────────────
//
// Same wiring, D2 LOW: the sketch sends 'G', the chip answers with 96 bytes
// ("0123456789" repeated, 100 ms of line at 9600 baud), the sketch counts what
// it receives and reports "n=<count> f=<first byte>" 300 ms after boot. These
// run the real AVRSimulator.start() frame loop on fake rAF/timers/performance,
// so the FIFO drainer interleaves with the CPU frames as it does in a browser.

describe('AVR: chip-to-board UART FIFO pacing and lifetime', () => {
  const ID = 'avr-rx-queue-stale-and-throttled';

  function report(out: string): { n: number; f: number } | null {
    const m = /n=(\d+) f=(-?\d+)/.exec(out);
    return m ? { n: Number(m[1]), f: Number(m[2]) } : null;
  }

  async function burstRun(ms: number) {
    const board = uno(HEX.uartPing);
    await attachChip(board.sim, 'uart2', 'uart-probe', UART_PINS, UART_WIRES);
    vi.useFakeTimers({ toFake: [...FAKE_CLOCK] });
    board.sim.start();
    vi.advanceTimersByTime(ms);
    return board;
  }

  it(`${ID} setup: the request reaches the chip and its answer reaches the sketch`, async () => {
    const board = await burstRun(400);
    board.sim.stop();
    expect(chipHeard('uart2')).toContain('G');
    const r = report(board.out());
    expect(r).not.toBeNull();
    expect(r!.n).toBeGreaterThan(0);
    expect(r!.f).toBe('0'.charCodeAt(0));
  });

  it.fails(`${ID}: a 96-byte answer at 9600 baud reaches the sketch within 300 ms of guest time`, async () => {
    const board = await burstRun(400);
    board.sim.stop();
    expect(report(board.out())).toEqual({ n: 96, f: '0'.charCodeAt(0) });
  });

  it(`${ID} setup: Stop in the middle of the answer, then a listen-only Run boots and reports`, async () => {
    const board = await burstRun(32);
    expect(chipHeard('uart2')).toContain('G');
    board.sim.reset(); // Stop
    board.sim.setPinState(2, true); // this run only listens
    board.clear();
    board.sim.start(); // Run
    vi.advanceTimersByTime(400);
    board.sim.stop();
    expect(board.out()).toContain('ready\n');
    expect(report(board.out())).not.toBeNull();
  });

  it.fails(`${ID}: after Stop, the next Run does not receive bytes the previous run never read`, async () => {
    const board = await burstRun(32);
    board.sim.reset(); // Stop: on hardware, the power is cut and the line empties
    board.sim.setPinState(2, true);
    board.clear();
    board.sim.start();
    vi.advanceTimersByTime(400);
    board.sim.stop();
    expect(report(board.out())).toEqual({ n: 0, f: -1 });
  });
});

// ── 3. Chip time in the browser ─────────────────────────────────────────────
//
// Uno + clock-probe: the sketch drives a 20 ms square wave on D3 (chip IN) and
// measures the chip's OUT (D2) in guest time. The chip logs "dt <us>" per IN
// rising edge from vx_sim_now_nanos, and toggles OUT from a 1 ms timer.

describe('browser-hosted chip clock', () => {
  const ID = 'browser-chip-clock-always-zero';
  const PINS = ['IN', 'OUT', 'GND', 'VCC'];
  const WIRES = { IN: 3, OUT: 2 };

  const dts = (id: string) =>
    chipSaid(id)
      .filter((l) => l.startsWith('dt '))
      .map((l) => Number(l.slice(3)));

  it(`${ID} setup: the sketch runs and the chip sees every rising edge on IN`, async () => {
    const board = uno(HEX.clock);
    await attachChip(board.sim, 'clk1', 'clock-probe', PINS, WIRES);
    runMs(board.sim, 130);
    expect(board.out()).toContain('READY');
    expect(dts('clk1').length).toBeGreaterThanOrEqual(4);
  });

  it.fails(`${ID}: vx_sim_now_nanos measures the 20 ms period the sketch drives, in guest time`, async () => {
    const board = uno(HEX.clock);
    await attachChip(board.sim, 'clk1', 'clock-probe', PINS, WIRES);
    runMs(board.sim, 130);
    const measured = dts('clk1');
    expect(measured.length).toBeGreaterThanOrEqual(4);
    for (const dt of measured) {
      expect(dt).toBeGreaterThan(19_900);
      expect(dt).toBeLessThan(20_100);
    }
  });

  /** The production pacing: the page has been open 10 s when the user presses
   *  Run, the board's frame loop and the chip's rAF tick both run. */
  async function timerRun() {
    vi.useFakeTimers({ toFake: [...FAKE_CLOCK] });
    vi.advanceTimersByTime(10_000);
    const board = uno(HEX.clock);
    const moves: boolean[] = [];
    board.sim.pinManager.onPinChange(2, (_p, s) => moves.push(s));
    await attachChip(board.sim, 'clk2', 'clock-probe', PINS, WIRES);
    setBoardsRunning(true);
    const c0 = board.sim.getCurrentCycles();
    board.sim.start();
    vi.advanceTimersByTime(300);
    board.sim.stop();
    setBoardsRunning(false);
    const guestMs = (board.sim.getCurrentCycles() - c0) / 16_000;
    const periods = [...board.out().matchAll(/P=(\d+)/g)].map((m) => Number(m[1]));
    return { board, moves, periods, guestMs };
  }

  it(`${ID} setup: with the board running, the chip timer fires and drives D2`, async () => {
    const { board, moves, guestMs } = await timerRun();
    expect(board.out()).toContain('READY');
    expect(chipSaid('clk2')).toContain('tick');
    expect(moves.length).toBeGreaterThan(0);
    expect(guestMs).toBeGreaterThan(250);
  });

  it(`${ID} setup: the sketch measures a 2000 us period when D2 toggles every 1 ms of guest time`, () => {
    const board = uno(HEX.clock);
    let level = false;
    for (let ms = 0; ms < 30; ms++) {
      runMs(board.sim, 1);
      level = !level;
      board.sim.setPinState(2, level);
    }
    const periods = [...board.out().matchAll(/P=(\d+)/g)].map((m) => Number(m[1]));
    expect(periods.length).toBeGreaterThanOrEqual(4);
    for (const p of periods) {
      expect(p).toBeGreaterThan(1_800);
      expect(p).toBeLessThan(2_200);
    }
  });

  // Every fire toggles OUT, and each toggle is one PinManager change on D2, so
  // `moves` counts the fires. On hardware a 1 ms timer fires once per ms of
  // the run. Today the first tick replays the page's whole age (about 10 000
  // fires for 10 s) and the rest follow the wall clock, not the guest: the
  // mismatch the finding names. Ticking the timers on the guest clock, the
  // finding's fix, makes this pass on its own.
  it.fails(`${ID}: a 1 ms chip timer fires once per ms of guest time after Run, not once per ms the page has been open`, async () => {
    const { moves, guestMs } = await timerRun();
    expect(moves.length).toBeLessThan(guestMs * 1.1);
    expect(moves.length).toBeGreaterThan(guestMs * 0.9);
  });

  // Stricter than the finding's fix, and the TESTS.md C01 target: this fails
  // the same way with the page open 0 s. The chip ticks between CPU frames, so
  // a frame's fires (an even count) land together and the sketch never sees
  // an edge. It passes only when each fire lands at its guest-time instant
  // inside the frame.
  it.fails(`${ID}: a 1 ms chip timer toggles OUT every 1 ms of guest time (the sketch measures a 2000 us period)`, async () => {
    const { periods } = await timerRun();
    expect(periods.length).toBeGreaterThanOrEqual(4);
    for (const p of periods) {
      expect(p).toBeGreaterThan(1_800);
      expect(p).toBeLessThan(2_200);
    }
  });
});

// ── 4. A chip releasing a board pin ─────────────────────────────────────────
//
// Uno: D2 INPUT_PULLUP with a FALLING interrupt, D3 = TRIG. The open-drain
// chip pulls IRQ (D2) low while TRIG is high and releases it (VX_INPUT) when
// TRIG goes low. Five pulses. On hardware: every line "held=0 rel=1", irqs=5.

describe('chip releases a board pin', () => {
  const ID = 'chip-release-to-input-keeps-board-pin-driven';
  const PINS = ['IRQ', 'TRIG', 'GND', 'VCC'];
  const WIRES = { IRQ: 2, TRIG: 3 };

  async function pulses(idiom: 0 | 1) {
    const board = uno(HEX.openDrain);
    await attachChip(board.sim, 'od', 'open-drain', PINS, WIRES, { idiom });
    runUntil(board.sim, 100, () => board.out().includes('irqs='));
    const lines = board.out().split('\n').filter((l) => l.startsWith('held='));
    const irqs = /irqs=(\d+)/.exec(board.out());
    return { board, lines, irqs: irqs ? Number(irqs[1]) : -1 };
  }

  it(`${ID} setup: the chip hears TRIG and its first pull (set_mode OUTPUT + write 0) reaches D2`, async () => {
    const { board, lines, irqs } = await pulses(0);
    expect(board.out()).toContain('READY');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^held=0 /);
    expect(irqs).toBeGreaterThanOrEqual(1);
  });

  it.fails(`${ID}: releasing with vx_pin_set_mode(VX_INPUT) lets the pull-up restore HIGH (write-0 pull)`, async () => {
    const { lines, irqs } = await pulses(0);
    expect(lines).toEqual(Array(5).fill('held=0 rel=1'));
    expect(irqs).toBe(5);
  });

  it.fails(`${ID}: a pull made with vx_pin_set_mode(VX_OUTPUT_LOW) reaches the board, and the release restores HIGH`, async () => {
    const { lines, irqs } = await pulses(1);
    expect(lines).toEqual(Array(5).fill('held=0 rel=1'));
    expect(irqs).toBe(5);
  });
});

// ── 5. A chip input on a pin another part drives ────────────────────────────
//
// Uno + the gallery pulse counter (threshold 4) on D2, OVF back on D4, and a
// real tilt-switch part driving D2. Phase 1: the MCU pulses D2 four times.
// Phase 2: D2 is an input and the tilt switch makes four rising edges.

describe('chip reads a board pin another part drives', () => {
  const ID = 'chip-board-pin-read-blind-to-other-parts';

  async function scenario() {
    const board = uno(HEX.pulseSnoop);
    await attachChip(board.sim, 'pc', 'pulse-counter', ['PULSE', 'OVF', 'RST', 'GND', 'VCC'], {
      PULSE: 2,
      OVF: 4,
    });
    const tilt = document.createElement('div');
    const detachTilt = PartSimulationRegistry.get('tilt-switch')!.attachEvents!(
      tilt,
      board.sim as never,
      (pin: string) => (pin === 'OUT' ? 2 : null),
      'tilt1',
    );
    if (detachTilt) cleanups.push(detachTilt);
    runUntil(board.sim, 100, () => board.out().includes('phase2'));
    runMs(board.sim, 2);
    const phase1 = board.out();
    board.clear();
    for (let i = 0; i < 8; i++) {
      tilt.dispatchEvent(new Event('click'));
      runMs(board.sim, 3);
    }
    runMs(board.sim, 3);
    return { phase1, phase2: board.out() };
  }

  it(`${ID} setup: the chip counts MCU-driven edges, and the sketch sees the tilt switch's edges`, async () => {
    const { phase1, phase2 } = await scenario();
    expect(phase1).toContain('READY');
    expect(phase1).toContain('mcu ovf=1');
    expect(phase2).toContain('rise 4');
  });

  it.fails(`${ID}: the chip counts the four edges the tilt switch puts on D2, and OVF toggles back to 0`, async () => {
    const { phase2 } = await scenario();
    expect(phase2).toContain('rise 4');
    expect(phase2).toContain('ovf=0');
  });
});

// ── 6. Chip I2C targets: attach and removal ─────────────────────────────────
//
// Uno running an I2C scanner on A4/A5 that also reads one byte from 0x44 per
// pass ("scan: <addrs>" then "r44:<byte|none>"). Chips: i2c-probe, which
// answers at addr1 (and addr2) and returns its `id` on every read.

interface Pass {
  addrs: string[];
  r44: string;
}

/** Run until one full scan pass that STARTED after this call has printed. */
function nextPass(board: Uno): Pass {
  const mark = board.out().length;
  const re = /scan:([ 0-9A-F]*)\nr44:(\w+)\n/;
  runUntil(board.sim, 300, () => re.test(board.out().slice(mark)));
  const m = re.exec(board.out().slice(mark));
  if (!m) throw new Error(`no scan pass in:\n${board.out().slice(mark)}`);
  return { addrs: m[1].trim() ? m[1].trim().split(' ') : [], r44: m[2] };
}

const I2C_PINS = ['SCL', 'SDA', 'GND', 'VCC'];
const HW_I2C = { SDA: 18, SCL: 19 };

describe('chip I2C: several addresses, removal', () => {
  it('multi-address-chip-ghost-slave setup: a two-address chip answers at both', async () => {
    const board = uno(HEX.i2cScan);
    await attachChip(board.sim, 'lcd', 'i2c-probe', I2C_PINS, HW_I2C, { addr1: 0x3e, addr2: 0x62 });
    expect(nextPass(board).addrs).toEqual(['3E', '62']);
  });

  it.fails('multi-address-chip-ghost-slave: after the chip is deleted, neither of its addresses answers', async () => {
    const board = uno(HEX.i2cScan);
    const detach = await attachChip(board.sim, 'lcd', 'i2c-probe', I2C_PINS, HW_I2C, {
      addr1: 0x3e,
      addr2: 0x62,
    });
    expect(nextPass(board).addrs).toEqual(['3E', '62']);
    detach();
    expect(nextPass(board).addrs).toEqual([]);
  });

  it('i2c-remove-by-address-evicts-other-part setup: a replacement at the same address takes over', async () => {
    const board = uno(HEX.i2cScan);
    await attachChip(board.sim, 'sht-a', 'i2c-probe', I2C_PINS, HW_I2C, { addr1: 0x44, id: 0x11 });
    expect(nextPass(board).r44).toBe('11');
    await attachChip(board.sim, 'sht-b', 'i2c-probe', I2C_PINS, HW_I2C, { addr1: 0x44, id: 0x22 });
    expect(nextPass(board).r44).toBe('22');
  });

  it.fails('i2c-remove-by-address-evicts-other-part: deleting the original leaves the replacement answering', async () => {
    const board = uno(HEX.i2cScan);
    const detachA = await attachChip(board.sim, 'sht-a', 'i2c-probe', I2C_PINS, HW_I2C, {
      addr1: 0x44,
      id: 0x11,
    });
    await attachChip(board.sim, 'sht-b', 'i2c-probe', I2C_PINS, HW_I2C, { addr1: 0x44, id: 0x22 });
    expect(nextPass(board).r44).toBe('22');
    detachA();
    expect(nextPass(board).r44).toBe('22');
  });
});

describe('chip I2C: membership follows the wiring', () => {
  const ID = 'chip-i2c-attached-regardless-of-wiring';

  it(`${ID} setup: a chip with SDA/SCL on A4/A5 is found by the scanner`, async () => {
    const board = uno(HEX.i2cScan);
    await attachChip(board.sim, 'ee', 'i2c-probe', I2C_PINS, HW_I2C, { addr1: 0x50 });
    expect(nextPass(board).addrs).toEqual(['50']);
  });

  it.fails(`${ID}: a chip whose SDA/SCL are not wired is invisible to the hardware Wire bus`, async () => {
    const board = uno(HEX.i2cScan);
    await attachChip(board.sim, 'ee', 'i2c-probe', I2C_PINS, {}, { addr1: 0x50 });
    expect(nextPass(board).addrs).toEqual([]);
  });

  it.fails(`${ID}: a chip whose SDA/SCL go to D2/D3 is invisible to the scanner on A4/A5`, async () => {
    const board = uno(HEX.i2cScan);
    await attachChip(board.sim, 'ee', 'i2c-probe', I2C_PINS, { SDA: 2, SCL: 3 }, { addr1: 0x50 });
    expect(nextPass(board).addrs).toEqual([]);
  });
});

// ── 7. Multi-board: which board a chip belongs to ───────────────────────────
//
// Two Unos in the real store. The spi-echo chip (answers 0xA5 while CS is low)
// has SCK/MOSI/MISO/CS on board B's D13/D11/D12/D10; board B runs the SPI
// sketch. The chip is rendered through the real DynamicComponent, whose
// attach effect decides which board's simulator the part gets.

const CUSTOM_CHIP_METADATA = {
  id: 'custom-chip',
  tagName: 'velxio-custom-chip',
  name: 'Custom Chip',
  category: 'logic',
  description: '',
  thumbnail: '',
  properties: [],
  defaultValues: {},
  pinCount: 0,
  tags: [],
};

function storeReset(): void {
  clearAllPinManagerState(useSimulatorStore, getBoardPinManager);
  resetInterconnect();
  resetStore(useSimulatorStore);
  resetChipNetIndexForTest();
}

const wire = (i: number, aId: string, aPin: string, bId: string, bPin: string) => ({
  id: `w${i}`,
  start: { componentId: aId, pinName: aPin, x: 0, y: 0 },
  end: { componentId: bId, pinName: bPin, x: 0, y: 0 },
  waypoints: [],
  color: '#0a0',
});

describe('multi-board: the board a chip attaches to', () => {
  const ID = 'multiboard-chip-owner-first-wire';
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => storeReset());
  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    storeReset();
  });

  /** Board B runs the SPI sketch; the chip's rails go to `railBoard`. */
  async function spiOnB(railBoard: 'A' | 'B'): Promise<string> {
    const idA = useSimulatorStore.getState().boards[0].id;
    const idB = useSimulatorStore.getState().addBoard('arduino-uno', 600, 100);
    const simB = getBoardSimulator(idB) as unknown as AVRSimulator;
    const board = uno(HEX.spiRead, simB);
    const rail = railBoard === 'A' ? idA : idB;
    placeChip('spichip', 'spi-echo', ['VCC', 'GND', 'SCK', 'MOSI', 'MISO', 'CS']);
    // Drawn in this order: the supply first, as users do.
    useSimulatorStore.getState().setWires([
      wire(1, 'spichip', 'VCC', rail, '5V'),
      wire(2, 'spichip', 'GND', rail, 'GND.1'),
      wire(3, 'spichip', 'SCK', idB, '13'),
      wire(4, 'spichip', 'MOSI', idB, '11'),
      wire(5, 'spichip', 'MISO', idB, '12'),
      wire(6, 'spichip', 'CS', idB, '10'),
    ] as never);
    const comp = useSimulatorStore.getState().components.find((c) => c.id === 'spichip')!;
    const { DynamicComponent } = await import('../../components/DynamicComponent');
    const { createRoot } = await import('react-dom/client');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(DynamicComponent, {
          id: 'spichip',
          metadata: CUSTOM_CHIP_METADATA as never,
          properties: comp.properties as Record<string, unknown>,
        }),
      );
    });
    await vi.waitFor(() => expect(chipSaid('spichip')).toContain('spi-echo ready'), {
      timeout: 5000,
      interval: 2,
    });
    runUntil(board.sim, 50, () => (board.out().match(/spi=/g) ?? []).length >= 3);
    return board.out();
  }

  it(`${ID} setup: with every pin on board B, board B's sketch reads the chip`, async () => {
    const out = await spiOnB('B');
    expect(out).toContain('READY');
    expect(out.match(/spi=\w+/g)).toEqual(['spi=A5', 'spi=A5', 'spi=A5']);
  });

  it.fails(`${ID}: with only VCC/GND on board A, the chip still serves board B's SPI, where its signal pins are`, async () => {
    const out = await spiOnB('A');
    expect(out).toContain('READY');
    expect(out.match(/spi=\w+/g)).toEqual(['spi=A5', 'spi=A5', 'spi=A5']);
  });
});

// ── 8. Multi-board: the chip-bus settle kernel ──────────────────────────────
//
// Two Unos in the real store and the real Interconnect. Buffer chips:
//   board A: srcA (IN on A.D7, OUT on net N), fwdA (IN on N, OUT on net L),
//            sinkA (IN on L)
//   board B: fwdB (IN on N, OUT on net M), sinkB (IN on M)
// N is a cross-board chip net (resolveCrossBoardChipNets); L and M are local
// chip-to-chip buses. A.D7 going high must reach sinkA through L on board A
// and sinkB through M on board B, like a real wire.

describe('multi-board: chip-bus settle kernel', () => {
  const ID = 'buskernel-global-pinmanager-misroutes-multiboard';

  beforeEach(() => {
    setChipBusEnabledForTest(true);
    resetBusNets();
    storeReset();
  });
  afterEach(() => {
    storeReset();
    resetBusNets();
    setChipBusEnabledForTest(null);
  });

  const chip = (id: string) => ({ id, metadataId: 'custom-chip', x: 0, y: 0, properties: {} });

  async function build(withBoardB: boolean) {
    const idA = useSimulatorStore.getState().boards[0].id;
    const idB = useSimulatorStore.getState().addBoard('arduino-uno', 600, 100);
    const onA = ['srcA', 'fwdA', 'sinkA'];
    const onB = withBoardB ? ['fwdB', 'sinkB'] : [];
    useSimulatorStore.getState().setComponents([...onA, ...onB].map(chip) as never);
    let i = 0;
    const wires = [
      ...onA.map((c) => wire(i++, c, 'VCC', idA, '5V')),
      ...onB.map((c) => wire(i++, c, 'VCC', idB, '5V')),
      wire(i++, 'srcA', 'IN', idA, '7'),
      wire(i++, 'srcA', 'OUT', 'fwdA', 'IN'),
      wire(i++, 'fwdA', 'OUT', 'sinkA', 'IN'),
      ...(withBoardB
        ? [wire(i++, 'fwdA', 'IN', 'fwdB', 'IN'), wire(i++, 'fwdB', 'OUT', 'sinkB', 'IN')]
        : []),
    ];
    useSimulatorStore.getState().setWires(wires as never);
    const st = useSimulatorStore.getState();
    const key = (c: string, p: string) => traceDetailed(st, c, p, 0).arduinoPin!;
    const make = async (id: string, boardId: string) => {
      const inst = await ChipInstance.create({
        wasm: chipBytes('buffer'),
        componentId: id,
        pinManager: getBoardPinManager(boardId)!,
        wires: new Map([
          ['IN', key(id, 'IN')],
          ['OUT', key(id, 'OUT')],
        ]),
      });
      inst.start();
      return inst;
    };
    const chips: ChipInstance[] = [];
    // Readers first, so every watch is in place before the source drives.
    for (const id of ['sinkA', 'fwdA']) chips.push(await make(id, idA));
    if (withBoardB) for (const id of ['sinkB', 'fwdB']) chips.push(await make(id, idB));
    chips.push(await make('srcA', idA));
    const pmA = getBoardPinManager(idA)!;
    const pmB = getBoardPinManager(idB)!;
    return {
      pmA,
      pmB,
      net: {
        N: key('fwdA', 'IN'),
        L: key('fwdA', 'OUT'),
        M: withBoardB ? key('fwdB', 'OUT') : -1,
        sinkA: key('sinkA', 'OUT'),
        sinkB: withBoardB ? key('sinkB', 'OUT') : -1,
      },
      crossNets: resolveCrossBoardChipNets({ wires: st.wires, components: st.components, boards: st.boards }),
      dispose: () => chips.forEach((c) => c.dispose()),
    };
  }

  it(`${ID} setup: on one board the chain settles, and N is a cross-board net Interconnect mirrors`, async () => {
    const one = await build(false);
    one.pmA.triggerPinChange(7, true, 'mcu');
    expect(one.pmA.getPinState(one.net.L)).toBe(true);
    expect(one.pmA.getPinState(one.net.sinkA)).toBe(true);
    one.dispose();
    storeReset();
    resetBusNets();

    const two = await build(true);
    expect(two.crossNets.map((n) => n.pin)).toEqual([two.net.N]);
    two.pmA.triggerPinChange(7, true, 'mcu');
    expect(two.pmB.getPinState(two.net.N)).toBe(true);
    two.dispose();
  });

  it.fails(`${ID}: a drive of the cross-board net settles L on board A and M on board B`, async () => {
    const two = await build(true);
    two.pmA.triggerPinChange(7, true, 'mcu');
    // M lives on board B only: its level must never be written into board A.
    expect({
      L_on_A: two.pmA.getPinState(two.net.L),
      sinkA: two.pmA.getPinState(two.net.sinkA),
      M_on_B: two.pmB.getPinState(two.net.M),
      sinkB: two.pmB.getPinState(two.net.sinkB),
      M_on_A: two.pmA.getPinState(two.net.M),
    }).toEqual({ L_on_A: true, sinkA: true, M_on_B: true, sinkB: true, M_on_A: false });
    two.dispose();
  });
});
