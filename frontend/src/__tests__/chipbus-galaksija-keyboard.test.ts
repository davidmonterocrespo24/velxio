/**
 * Phase 3 — typing on the Galaksija over the chip-to-chip bus
 * (project/multichip-bus/). The full machine plus a memory-mapped keyboard:
 *   Z80 + galaksija-rom + galaksija-ram + inverter + galaksija-display +
 *   galaksija-keyboard.
 *
 * Galaksija reads its keyboard as memory: reading 0x2000+offset returns 0xFE
 * when the key at that matrix offset is held, 0xFF otherwise (the scheme used by
 * the libretro Galaksija core; offsets from its keyMap, e.g. 'A' = 1). The
 * keyboard chip drives those reads from a keys[] table that the host pushes via
 * the exported set_key(offset, down); galaksija-ram yields reads of 0x2000-0x203F
 * so the two never fight for the bus. Pressing 'A' (offset 1) makes the BASIC
 * monitor echo "A" after its ">" prompt — proving end-to-end keyboard input.
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
const P = { z80: f('z80.wasm'), rom: f('galaksija-rom.wasm'), ram: f('galaksija-ram.wasm'), inv: f('inverter.wasm'), disp: f('galaksija-display.wasm'), kbd: f('galaksija-keyboard.wasm') };
const have = Object.values(P).every(existsSync);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const Z80 = [...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'M1', 'MREQ', 'IORQ', 'RD', 'WR', 'RFSH', 'HALT', 'WAIT', 'INT', 'NMI', 'RESET', 'BUSREQ', 'BUSACK', 'CLK', 'VCC', 'GND'];
const ROM = [...range(13).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE'];
const RAM = [...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE', 'WE', 'VCC', 'GND'];
const INV = ['IN', 'OUT'];
const DISP = [...range(14).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'WR'];
const KBD = [...range(14).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'RD'];

const W: ChipNetState['wires'] = [];
const wire = (a: string, ap: string, b: string, bp: string) => (W as { start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } }[]).push({ start: { componentId: a, pinName: ap }, end: { componentId: b, pinName: bp } });
for (const i of range(13)) for (const c of ['rom', 'ram', 'disp', 'kbd']) wire('z80', `A${i}`, c, `A${i}`);
wire('z80', 'A13', 'rom', 'CE'); wire('z80', 'A13', 'inv', 'IN'); wire('inv', 'OUT', 'ram', 'CE');
wire('z80', 'A13', 'disp', 'A13'); wire('z80', 'A13', 'kbd', 'A13');
for (const i of range(8)) for (const c of ['rom', 'ram', 'disp', 'kbd']) wire('z80', `D${i}`, c, `D${i}`);
wire('z80', 'RD', 'rom', 'OE'); wire('z80', 'RD', 'ram', 'OE'); wire('z80', 'RD', 'kbd', 'RD');
wire('z80', 'WR', 'ram', 'WE'); wire('z80', 'WR', 'disp', 'WR');

const STATE: ChipNetState = { wires: W, components: ['z80', 'rom', 'ram', 'inv', 'disp', 'kbd'].map((id) => ({ id, metadataId: 'custom-chip' })), boards: [] };
const pk = (c: string, p: string): number => resolveChipNetKey(STATE, c, p) ?? syntheticChipPin(c, p);
const wf = (c: string, pins: string[]) => new Map(pins.map((p) => [p, pk(c, p)] as [string, number]));

// Lit pixels (bright green) inside character cell (col,row).
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

describe.skipIf(!RUN_CHIPBUS || !have)('chipbus Phase 3 — typing on the Galaksija', () => {
  beforeEach(() => { setChipBusEnabledForTest(true); resetChipNetIndexForTest(); resetBusNets(); });
  afterEach(() => { setChipBusEnabledForTest(null); resetChipNetIndexForTest(); resetBusNets(); });

  it('pressing A echoes "A" after the BASIC prompt', async () => {
    const pm = new PinManager();
    const mk = async (k: keyof typeof P, id: string, pins: string[], display?: { width: number; height: number }) => ChipInstance.create({ wasm: new Uint8Array(readFileSync(P[k])), componentId: id, pinManager: pm, wires: wf(id, pins), display });
    const z80 = await mk('z80', 'z80', Z80); z80.start();
    (await mk('rom', 'rom', ROM)).start();
    (await mk('ram', 'ram', RAM)).start();
    (await mk('inv', 'inv', INV)).start();
    const disp = await mk('disp', 'disp', DISP, { width: 256, height: 128 });
    let fb: Uint8Array | null = null; disp.onFramebufferUpdate((r) => { fb = r as Uint8Array; }); disp.start();
    const kbd = await mk('kbd', 'kbd', KBD); kbd.start();

    for (const p of ['WAIT', 'INT', 'NMI', 'BUSREQ']) pm.triggerPinChange(pk('z80', p), true);
    pm.triggerPinChange(pk('z80', 'RESET'), false); pm.triggerPinChange(pk('z80', 'RESET'), true);
    z80.tickTimers(BigInt(120000 * 250)); // boot to the READY prompt
    disp.tickTimers(50_000_000n);
    expect(fb).not.toBeNull();
    // Boot screen row 1 is ">_": ">" at col 0, the cursor at col 1, col 2 blank.
    expect(cellLit(fb!, 2, 1)).toBe(0);

    // Press 'A' (offset 1), let the monitor scan + echo, then release.
    const setKey = (off: number, down: number) => (kbd.exports as { set_key: (o: number, d: number) => void }).set_key(off, down);
    setKey(1, 1);
    z80.tickTimers(BigInt(240000 * 250));
    setKey(1, 0);
    z80.tickTimers(BigInt(360000 * 250));
    disp.tickTimers(420_000_000n);

    // "A" was echoed at col 1 and the cursor advanced to col 2: row 1 now reads
    // ">A_". The cursor at col 2 (previously blank) proves a character was typed.
    expect(cellLit(fb!, 2, 1), 'the cursor advanced — a character was typed').toBeGreaterThan(0);
    expect(cellLit(fb!, 1, 1), 'the "A" glyph is at the input column').toBeGreaterThan(6);

    z80.dispose(); kbd.dispose(); disp.dispose();
  }, 180_000);
});
