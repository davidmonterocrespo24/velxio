/**
 * Phase 3 — the display-snoop load-order race (project/multichip-bus/).
 *
 * galaksija-display is a PASSIVE bus snoop: it renders a cell only when it
 * catches a WR rising edge into video RAM (0x2800-0x2BFF). The Galaksija ROM
 * writes the whole screen ONCE during boot, then idles polling the keyboard. So
 * if the display chip is instantiated AFTER the CPU has already written the
 * screen — which happens in the browser, where the 7 chips load asynchronously
 * and the display can come up after the (smaller, faster) reset path has already
 * let the CPU run — the display misses every write and shows stale/blank content
 * forever. A write-snoop cannot recover writes it never saw.
 *
 * This test demonstrates the failure: boot the machine, THEN attach the display,
 * and confirm it never shows the ">" prompt. (The fix is to render from actual
 * video RAM instead of snooping writes — see galaksija-vram-display.)
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
const P = { z80: f('z80.wasm'), rom: f('galaksija-rom.wasm'), ram: f('galaksija-ram.wasm'), inv: f('inverter.wasm'), disp: f('galaksija-display.wasm') };
const have = Object.values(P).every(existsSync);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const Z80 = [...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'M1', 'MREQ', 'IORQ', 'RD', 'WR', 'RFSH', 'HALT', 'WAIT', 'INT', 'NMI', 'RESET', 'BUSREQ', 'BUSACK', 'CLK', 'VCC', 'GND'];
const ROM = [...range(13).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE'];
const RAM = [...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE', 'WE', 'VCC', 'GND'];
const INV = ['IN', 'OUT'];
const DISP = [...range(14).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'WR'];

const W: ChipNetState['wires'] = [];
const wire = (a: string, ap: string, b: string, bp: string) => (W as { start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } }[]).push({ start: { componentId: a, pinName: ap }, end: { componentId: b, pinName: bp } });
for (const i of range(13)) for (const c of ['rom', 'ram', 'disp']) wire('z80', `A${i}`, c, `A${i}`);
wire('z80', 'A13', 'rom', 'CE'); wire('z80', 'A13', 'inv', 'IN'); wire('inv', 'OUT', 'ram', 'CE'); wire('z80', 'A13', 'disp', 'A13');
for (const i of range(8)) for (const c of ['rom', 'ram', 'disp']) wire('z80', `D${i}`, c, `D${i}`);
wire('z80', 'RD', 'rom', 'OE'); wire('z80', 'RD', 'ram', 'OE');
wire('z80', 'WR', 'ram', 'WE'); wire('z80', 'WR', 'disp', 'WR');

const STATE: ChipNetState = { wires: W, components: ['z80', 'rom', 'ram', 'inv', 'disp'].map((id) => ({ id, metadataId: 'custom-chip' })), boards: [] };
const pk = (c: string, p: string): number => resolveChipNetKey(STATE, c, p) ?? syntheticChipPin(c, p);
const wf = (c: string, pins: string[]) => new Map(pins.map((p) => [p, pk(c, p)] as [string, number]));
const cellLit = (fb: Uint8Array, col: number, row: number): number => { let n = 0; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (fb[((row * 8 + y) * 256 + (col * 8 + x)) * 4 + 1] > 0x80) n++; return n; };

describe.skipIf(!have)('chipbus Phase 3 — display-snoop load-order race', () => {
  beforeEach(() => { setChipBusEnabledForTest(true); resetChipNetIndexForTest(); resetBusNets(); });
  afterEach(() => { setChipBusEnabledForTest(null); resetChipNetIndexForTest(); resetBusNets(); });

  const mk = async (pm: PinManager, k: keyof typeof P, id: string, pins: string[], display?: { width: number; height: number }) =>
    ChipInstance.create({ wasm: new Uint8Array(readFileSync(P[k])), componentId: id, pinManager: pm, wires: wf(id, pins), display });

  it('a display attached AFTER boot misses the screen (write-snoop limitation)', async () => {
    const pm = new PinManager();
    const z80 = await mk(pm, 'z80', 'z80', Z80); z80.start();
    (await mk(pm, 'rom', 'rom', ROM)).start();
    (await mk(pm, 'ram', 'ram', RAM)).start();
    (await mk(pm, 'inv', 'inv', INV)).start();

    for (const p of ['WAIT', 'INT', 'NMI', 'BUSREQ']) pm.triggerPinChange(pk('z80', p), true);
    pm.triggerPinChange(pk('z80', 'RESET'), false); pm.triggerPinChange(pk('z80', 'RESET'), true);
    z80.tickTimers(BigInt(120000 * 250)); // CPU writes the whole screen during boot

    // Display arrives late — every screen write already happened.
    const disp = await mk(pm, 'disp', 'disp', DISP, { width: 256, height: 128 });
    let fb: Uint8Array | null = null; disp.onFramebufferUpdate((r) => { fb = r as Uint8Array; }); disp.start();
    z80.tickTimers(BigInt(240000 * 250)); // CPU now idles in the keyboard loop, no screen writes
    disp.tickTimers(50_000_000n);

    expect(fb).not.toBeNull();
    // The prompt never appears: the snoop saw none of the boot writes.
    expect(cellLit(fb!, 0, 1), 'a late-attached snoop display shows no prompt').toBe(0);
    z80.dispose(); disp.dispose();
    // Z80 emulation against four other WASM chips: CPU-bound, and the
    // whole suite runs ~470 files in parallel on a box that also runs
    // production. It passes alone in well under this; the old budget was
    // wall clock, not a claim about the model. Same reasoning as the
    // keyboard row.
  }, 180_000);
});
