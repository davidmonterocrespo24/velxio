/**
 * Phase 3 — the COMPLETE Galaksija computer renders "READY" on screen
 * (project/multichip-bus/). The full machine over the chip-to-chip bus:
 *   Z80 + galaksija-rom (0x0000-0x1FFF) + ram-64k (0x2000-0x3FFF) +
 *   inverter (address decode) + galaksija-display (snoops video RAM 0x2800).
 *
 * Boot the public-domain ROM; the monitor clears the 32x16 screen and writes
 * its "READY" prompt to video RAM at 0x2802. The display chip snoops those bus
 * writes and renders them with the CHRGEN font. We assert the on-screen "READY"
 * cells (row 0, cols 2..6) light up — i.e. a real 1983 home computer boots AND
 * draws its prompt, fully through the simulated bus.
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
const paths = { z80: f('z80.wasm'), rom: f('galaksija-rom.wasm'), ram: f('ram-64k.wasm'), inv: f('inverter.wasm'), disp: f('galaksija-display.wasm') };
const have = Object.values(paths).every(existsSync);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const Z80_PINS = [...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`),
  'M1', 'MREQ', 'IORQ', 'RD', 'WR', 'RFSH', 'HALT', 'WAIT', 'INT', 'NMI', 'RESET', 'BUSREQ', 'BUSACK', 'CLK', 'VCC', 'GND'];
const ROM_PINS = [...range(13).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE'];
const RAM_PINS = [...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE', 'WE', 'VCC', 'GND'];
const INV_PINS = ['IN', 'OUT'];
const DISP_PINS = [...range(14).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'WR'];

const W: ChipNetState['wires'] = [];
const wire = (a: string, ap: string, b: string, bp: string) =>
  (W as { start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } }[]).push(
    { start: { componentId: a, pinName: ap }, end: { componentId: b, pinName: bp } });
for (const i of range(13)) { wire('z80', `A${i}`, 'rom', `A${i}`); wire('z80', `A${i}`, 'ram', `A${i}`); wire('z80', `A${i}`, 'disp', `A${i}`); }
wire('z80', 'A13', 'rom', 'CE'); wire('z80', 'A13', 'inv', 'IN'); wire('z80', 'A13', 'disp', 'A13');
wire('inv', 'OUT', 'ram', 'CE');
for (const i of range(8)) { wire('z80', `D${i}`, 'rom', `D${i}`); wire('z80', `D${i}`, 'ram', `D${i}`); wire('z80', `D${i}`, 'disp', `D${i}`); }
wire('z80', 'RD', 'rom', 'OE'); wire('z80', 'RD', 'ram', 'OE');
wire('z80', 'WR', 'ram', 'WE'); wire('z80', 'WR', 'disp', 'WR');

const STATE: ChipNetState = {
  wires: W,
  components: ['z80', 'rom', 'ram', 'inv', 'disp'].map((id) => ({ id, metadataId: 'custom-chip' })),
  boards: [],
};
const pinKey = (c: string, p: string): number => resolveChipNetKey(STATE, c, p) ?? syntheticChipPin(c, p);
const wiresFor = (c: string, pins: string[]) => new Map(pins.map((p) => [p, pinKey(c, p)] as [string, number]));

/**
 * Gated behind `RUN_CHIPBUS_TESTS=1` so the default `npm test` skips the whole
 * Galaksija set. It is a real Z80 home computer booting over the chip-to-chip
 * bus: five WASM chips clocked against each other, minutes of CPU across the
 * seven files, and it dominated the wall clock of a suite of ~470 files. Run
 * it with `npm run test:chipbus`, or set the variable and run the file.
 */
const RUN_CHIPBUS = process.env.RUN_CHIPBUS_TESTS === '1';

describe.skipIf(!RUN_CHIPBUS || !have)('chipbus Phase 3 — full Galaksija computer renders READY', () => {
  beforeEach(() => { setChipBusEnabledForTest(true); resetChipNetIndexForTest(); resetBusNets(); });
  afterEach(() => { setChipBusEnabledForTest(null); resetChipNetIndexForTest(); resetBusNets(); });

  it('boots the ROM and renders the READY prompt on the video display', async () => {
    const pm = new PinManager();
    const mk = async (k: keyof typeof paths, id: string, pins: string[], display?: { width: number; height: number }) =>
      ChipInstance.create({ wasm: new Uint8Array(readFileSync(paths[k])), componentId: id, pinManager: pm, wires: wiresFor(id, pins), display });
    const z80 = await mk('z80', 'z80', Z80_PINS); z80.start();
    const rom = await mk('rom', 'rom', ROM_PINS); rom.start();
    const ram = await mk('ram', 'ram', RAM_PINS); ram.start();
    const inv = await mk('inv', 'inv', INV_PINS); inv.start();
    const disp = await mk('disp', 'disp', DISP_PINS, { width: 256, height: 128 });
    let fb: Uint8Array | null = null;
    disp.onFramebufferUpdate((rgba) => { fb = rgba as Uint8Array; });
    disp.start();

    for (const p of ['WAIT', 'INT', 'NMI', 'BUSREQ']) pm.triggerPinChange(pinKey('z80', p), true);
    pm.triggerPinChange(pinKey('z80', 'RESET'), false);
    pm.triggerPinChange(pinKey('z80', 'RESET'), true);

    z80.tickTimers(BigInt(120000 * 250)); // enough for clear + banner
    disp.tickTimers(50_000_000n); // fire the display's ~30 fps blit timer to paint

    expect(fb, 'display produced a framebuffer').not.toBeNull();
    // "READY" lives at video offset 2 (0x2802) -> row 0, cols 2..6. Count lit
    // pixels (bright-green G channel) across those five character cells.
    let litReady = 0;
    for (let y = 0; y < 8; y++) for (let x = 16; x < 56; x++) if (fb![(y * 256 + x) * 4 + 1] > 0x80) litReady++;
    expect(litReady, 'the READY prompt is rendered on screen').toBeGreaterThan(20);

    z80.dispose(); rom.dispose(); ram.dispose(); inv.dispose(); disp.dispose();
  }, 120_000);
});
