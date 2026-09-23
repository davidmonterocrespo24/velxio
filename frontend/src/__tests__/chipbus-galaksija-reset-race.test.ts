/**
 * Phase 3 — multi-chip RESET ordering race (project/multichip-bus/).
 *
 * The Galaksija example boots through a power-on-reset chip (reset-gen) wired to
 * the Z80's RESET line, NOT a manual RESET pulse like the other tests. reset-gen
 * holds RESET low, then a one-shot timer drives it high to release the CPU.
 *
 * The Z80 chip releases from reset on the RISING EDGE of RESET (vx_pin_watch).
 * In the browser the 7 chips instantiate ASYNCHRONOUSLY and the host feeds a
 * wall-clock now, so reset-gen (small, loads first) fires its release timer on
 * its first tick — potentially BEFORE the larger Z80 finishes registering its
 * RESET watch. If the Z80 misses that one rising edge it stays in reset forever
 * and the machine never boots (the live symptom: a frozen, garbled display).
 *
 * This reproduces both orderings:
 *   - race:  reset-gen releases RESET, THEN the Z80 is created  -> must still boot
 *   - safe:  the Z80 is created first, THEN reset-gen releases   -> boots
 * Both must boot once the Z80 samples the RESET level (not just the edge).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PinManager } from '../simulation/PinManager';
import { ChipInstance } from '../simulation/customChips/ChipRuntime';
import {
  resolveChipNetKey, setChipBusEnabledForTest, resetChipNetIndexForTest, type ChipNetState,
} from '../simulation/customChips/chipNets';
import { syntheticChipPin } from '../simulation/customChips/syntheticPins';
import { resetBusNets } from '../simulation/customChips/busNets';

const f = (n: string) => fileURLToPath(new URL(`./fixtures/chipbus/${n}`, import.meta.url));
const P = {
  z80: f('z80.wasm'), rom: f('galaksija-rom.wasm'), ram: f('galaksija-ram.wasm'),
  inv: f('inverter.wasm'), disp: f('galaksija-display.wasm'), rst: f('reset-gen.wasm'),
};
const have = Object.values(P).every(existsSync);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const Z80 = [...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'M1', 'MREQ', 'IORQ', 'RD', 'WR', 'RFSH', 'HALT', 'WAIT', 'INT', 'NMI', 'RESET', 'BUSREQ', 'BUSACK', 'CLK', 'VCC', 'GND'];
const ROM = [...range(13).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE'];
const RAM = [...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE', 'WE', 'VCC', 'GND'];
const INV = ['IN', 'OUT'];
const DISP = [...range(14).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'WR'];
const RST = ['RESET', 'WAIT', 'BUSREQ', 'INT', 'NMI'];

const W: ChipNetState['wires'] = [];
const wire = (a: string, ap: string, b: string, bp: string) => (W as { start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } }[]).push({ start: { componentId: a, pinName: ap }, end: { componentId: b, pinName: bp } });
for (const i of range(13)) for (const c of ['rom', 'ram', 'disp']) wire('z80', `A${i}`, c, `A${i}`);
wire('z80', 'A13', 'rom', 'CE'); wire('z80', 'A13', 'inv', 'IN'); wire('inv', 'OUT', 'ram', 'CE');
wire('z80', 'A13', 'disp', 'A13');
for (const i of range(8)) for (const c of ['rom', 'ram', 'disp']) wire('z80', `D${i}`, c, `D${i}`);
wire('z80', 'RD', 'rom', 'OE'); wire('z80', 'RD', 'ram', 'OE');
wire('z80', 'WR', 'ram', 'WE'); wire('z80', 'WR', 'disp', 'WR');
// reset-gen drives the Z80 control lines (the example wiring).
wire('rst', 'RESET', 'z80', 'RESET'); wire('rst', 'WAIT', 'z80', 'WAIT');
wire('rst', 'BUSREQ', 'z80', 'BUSREQ'); wire('rst', 'INT', 'z80', 'INT'); wire('rst', 'NMI', 'z80', 'NMI');

const STATE: ChipNetState = { wires: W, components: ['z80', 'rom', 'ram', 'inv', 'disp', 'rst'].map((id) => ({ id, metadataId: 'custom-chip' })), boards: [] };
const pk = (c: string, p: string): number => resolveChipNetKey(STATE, c, p) ?? syntheticChipPin(c, p);
const wf = (c: string, pins: string[]) => new Map(pins.map((p) => [p, pk(c, p)] as [string, number]));

const cellLit = (fb: Uint8Array, col: number, row: number): number => {
  let n = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (fb[((row * 8 + y) * 256 + (col * 8 + x)) * 4 + 1] > 0x80) n++;
  return n;
};

/**
 * Gated behind `RUN_CHIPBUS_TESTS=1` so the default `npm test` skips the whole
 * Galaksija set. It is a real Z80 home computer booting over the chip-to-chip
 * bus: five WASM chips clocked against each other, minutes of CPU across the
 * seven files, and it dominated the wall clock of a suite of ~470 files. Run
 * it with `npm run test:chipbus`, or set the variable and run the file.
 */
const RUN_CHIPBUS = process.env.RUN_CHIPBUS_TESTS === '1';

describe.skipIf(!RUN_CHIPBUS || !have)('chipbus Phase 3 — RESET ordering race via reset-gen', () => {
  beforeEach(() => { setChipBusEnabledForTest(true); resetChipNetIndexForTest(); resetBusNets(); });
  afterEach(() => { setChipBusEnabledForTest(null); resetChipNetIndexForTest(); resetBusNets(); });

  const mk = async (pm: PinManager, k: keyof typeof P, id: string, pins: string[], display?: { width: number; height: number }) =>
    ChipInstance.create({ wasm: new Uint8Array(readFileSync(P[k])), componentId: id, pinManager: pm, wires: wf(id, pins), display });

  // Wall-clock-ish: a huge `now` so reset-gen's 2 ms one-shot is already due on
  // the first tick (exactly what the browser feeds via performance.now()*1e6).
  const NOW = BigInt(120_000 * 250);

  it('RACE: reset-gen releases RESET before the Z80 exists — must still boot', async () => {
    const pm = new PinManager();
    // reset-gen loads and ticks FIRST: it drives RESET low at setup then high on
    // this tick — the rising edge happens with no Z80 watching yet.
    const rst = await mk(pm, 'rst', 'rst', RST); rst.start();
    rst.tickTimers(NOW); // release RESET high (edge lost — nothing is listening)

    // Only now does the (larger) Z80 finish instantiating + register its watch.
    const z80 = await mk(pm, 'z80', 'z80', Z80); z80.start();
    (await mk(pm, 'rom', 'rom', ROM)).start();
    (await mk(pm, 'ram', 'ram', RAM)).start();
    (await mk(pm, 'inv', 'inv', INV)).start();
    const disp = await mk(pm, 'disp', 'disp', DISP, { width: 256, height: 128 });
    let fb: Uint8Array | null = null; disp.onFramebufferUpdate((r) => { fb = r as Uint8Array; }); disp.start();

    rst.tickTimers(NOW);     // re-assert reset-gen outputs (WAIT/INT/NMI high)
    z80.tickTimers(NOW);     // boot
    disp.tickTimers(50_000_000n);

    expect(fb).not.toBeNull();
    // The ">" prompt at col 0 of row 1 proves the CPU left reset and ran the ROM.
    expect(cellLit(fb!, 0, 1), 'the BASIC ">" prompt rendered — the Z80 left reset').toBeGreaterThan(4);

    z80.dispose(); rst.dispose(); disp.dispose();
  }, 60_000);

  it('SAFE: Z80 created first, then reset-gen releases RESET — boots', async () => {
    const pm = new PinManager();
    const z80 = await mk(pm, 'z80', 'z80', Z80); z80.start();
    (await mk(pm, 'rom', 'rom', ROM)).start();
    (await mk(pm, 'ram', 'ram', RAM)).start();
    (await mk(pm, 'inv', 'inv', INV)).start();
    const disp = await mk(pm, 'disp', 'disp', DISP, { width: 256, height: 128 });
    let fb: Uint8Array | null = null; disp.onFramebufferUpdate((r) => { fb = r as Uint8Array; }); disp.start();
    const rst = await mk(pm, 'rst', 'rst', RST); rst.start();

    rst.tickTimers(NOW);     // NOW the rising edge is delivered to a live watch
    z80.tickTimers(NOW);
    disp.tickTimers(50_000_000n);

    expect(fb).not.toBeNull();
    expect(cellLit(fb!, 0, 1), 'the BASIC ">" prompt rendered').toBeGreaterThan(4);

    z80.dispose(); rst.dispose(); disp.dispose();
  }, 60_000);
});
