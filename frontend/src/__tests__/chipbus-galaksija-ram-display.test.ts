/**
 * Phase 3 — Galaksija RAM+display chip renders from real video RAM
 * (project/multichip-bus/).
 *
 * galaksija-ram-display is the 64 KB RAM with the screen folded in: it renders
 * the 32x16 text screen from its OWN video RAM (0x2800-0x2BFF) on a ~30 fps
 * timer, instead of snooping bus writes. That makes the picture correct
 * regardless of when its paint timer first fires — the failure mode of the old
 * passive-snoop display (which lost the boot screen if it came up late). Here
 * the CPU boots and writes the whole screen FIRST, and the display's very first
 * paint happens only AFTER all writes are done; it must still show the ">"
 * prompt because it reads the memory it owns.
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
const P = { z80: f('z80.wasm'), rom: f('galaksija-rom.wasm'), ramdisp: f('galaksija-ram-display.wasm'), inv: f('inverter.wasm') };
const have = Object.values(P).every(existsSync);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const Z80 = [...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'M1', 'MREQ', 'IORQ', 'RD', 'WR', 'RFSH', 'HALT', 'WAIT', 'INT', 'NMI', 'RESET', 'BUSREQ', 'BUSACK', 'CLK', 'VCC', 'GND'];
const ROM = [...range(13).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE'];
const RD = [...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE', 'WE', 'VCC', 'GND'];
const INV = ['IN', 'OUT'];

const W: ChipNetState['wires'] = [];
const wire = (a: string, ap: string, b: string, bp: string) => (W as { start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } }[]).push({ start: { componentId: a, pinName: ap }, end: { componentId: b, pinName: bp } });
// A0-A12 to the RAM (A13 selects it via CE), exactly like the gallery example.
for (const i of range(13)) wire('z80', `A${i}`, 'rd', `A${i}`);
for (const i of range(13)) wire('z80', `A${i}`, 'rom', `A${i}`);
wire('z80', 'A13', 'rom', 'CE'); wire('z80', 'A13', 'inv', 'IN'); wire('inv', 'OUT', 'rd', 'CE');
for (const i of range(8)) { wire('z80', `D${i}`, 'rom', `D${i}`); wire('z80', `D${i}`, 'rd', `D${i}`); }
wire('z80', 'RD', 'rom', 'OE'); wire('z80', 'RD', 'rd', 'OE'); wire('z80', 'WR', 'rd', 'WE');

const STATE: ChipNetState = { wires: W, components: ['z80', 'rom', 'rd', 'inv'].map((id) => ({ id, metadataId: 'custom-chip' })), boards: [] };
const pk = (c: string, p: string): number => resolveChipNetKey(STATE, c, p) ?? syntheticChipPin(c, p);
const wf = (c: string, pins: string[]) => new Map(pins.map((p) => [p, pk(c, p)] as [string, number]));
const cellLit = (fb: Uint8Array, col: number, row: number): number => { let n = 0; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (fb[((row * 8 + y) * 256 + (col * 8 + x)) * 4 + 1] > 0x80) n++; return n; };

describe.skipIf(!have)('chipbus Phase 3 — Galaksija RAM+display renders from video RAM', () => {
  beforeEach(() => { setChipBusEnabledForTest(true); resetChipNetIndexForTest(); resetBusNets(); });
  afterEach(() => { setChipBusEnabledForTest(null); resetChipNetIndexForTest(); resetBusNets(); });

  const mk = async (pm: PinManager, k: keyof typeof P, id: string, pins: string[], display?: { width: number; height: number }) =>
    ChipInstance.create({ wasm: new Uint8Array(readFileSync(P[k])), componentId: id, pinManager: pm, wires: wf(id, pins), display });

  it('shows the ">" prompt even when the first paint happens after the boot writes', async () => {
    const pm = new PinManager();
    const z80 = await mk(pm, 'z80', 'z80', Z80); z80.start();
    (await mk(pm, 'rom', 'rom', ROM)).start();
    const rd = await mk(pm, 'ramdisp', 'rd', RD, { width: 256, height: 128 });
    let fb: Uint8Array | null = null; rd.onFramebufferUpdate((r) => { fb = r as Uint8Array; }); rd.start();
    (await mk(pm, 'inv', 'inv', INV)).start();

    for (const p of ['WAIT', 'INT', 'NMI', 'BUSREQ']) pm.triggerPinChange(pk('z80', p), true);
    pm.triggerPinChange(pk('z80', 'RESET'), false); pm.triggerPinChange(pk('z80', 'RESET'), true);

    // Boot fully FIRST — the CPU writes the whole screen into RAM. (chip_setup
    // pushed one initial blank framebuffer; the paint timer has not run yet.)
    z80.tickTimers(BigInt(240000 * 250));

    // The first real paint happens only now, long after every screen write.
    // Reading real video RAM, it still renders the prompt.
    fb = null;
    rd.tickTimers(50_000_000n);
    expect(fb, 'the paint timer pushed a framebuffer').not.toBeNull();
    expect(cellLit(fb!, 0, 1), 'the BASIC ">" prompt rendered from video RAM').toBeGreaterThan(4);

    z80.dispose(); rd.dispose();
    // Z80 emulation against four other WASM chips: CPU-bound, and the
    // whole suite runs ~470 files in parallel on a box that also runs
    // production. It passes alone in well under this; the old budget was
    // wall clock, not a claim about the model. Same reasoning as the
    // keyboard row.
  }, 180_000);
});
