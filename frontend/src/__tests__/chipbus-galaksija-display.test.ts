/**
 * Phase 3 — Galaksija video display chip smoke test (project/multichip-bus/).
 * Verifies the snoop + CHRGEN render path mechanically: a write of 'R' to the
 * video address 0x2802 makes the display chip render lit pixels into that cell's
 * framebuffer region. Exact glyph fidelity is verified visually in the browser.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PinManager } from '../simulation/PinManager';
import { ChipInstance } from '../simulation/customChips/ChipRuntime';
import { resetBusNets } from '../simulation/customChips/busNets';

const dispPath = fileURLToPath(new URL('./fixtures/chipbus/galaksija-display.wasm', import.meta.url));
const have = existsSync(dispPath);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/**
 * Gated behind `RUN_CHIPBUS_TESTS=1` so the default `npm test` skips the whole
 * Galaksija set. It is a real Z80 home computer booting over the chip-to-chip
 * bus: five WASM chips clocked against each other, minutes of CPU across the
 * seven files, and it dominated the wall clock of a suite of ~470 files. Run
 * it with `npm run test:chipbus`, or set the variable and run the file.
 */
const RUN_CHIPBUS = process.env.RUN_CHIPBUS_TESTS === '1';

describe.skipIf(!RUN_CHIPBUS || !have)('chipbus Phase 3 — Galaksija display renders a character', () => {
  beforeEach(() => resetBusNets());
  afterEach(() => resetBusNets());

  it('a write of "R" to 0x2802 lights pixels in that cell', async () => {
    const pm = new PinManager();
    // Explicit pin keys (isolated; no net resolution needed for this snoop test).
    const aKey = (i: number) => 1 + i; // A0..A13 -> 1..14
    const dKey = (i: number) => 21 + i; // D0..D7 -> 21..28
    const WR = 30;
    const wires = new Map<string, number>([
      ...range(14).map((i) => [`A${i}`, aKey(i)] as [string, number]),
      ...range(8).map((i) => [`D${i}`, dKey(i)] as [string, number]),
      ['WR', WR],
    ]);

    const disp = await ChipInstance.create({
      wasm: new Uint8Array(readFileSync(dispPath)),
      componentId: 'disp',
      pinManager: pm,
      wires,
      display: { width: 256, height: 128 },
    });
    let fb: Uint8Array | null = null;
    disp.onFramebufferUpdate((rgba) => { fb = rgba as Uint8Array; });
    disp.start();

    // Drive address 0x2802 (A1,A11,A13), data 'R'=0x52 (D1,D4,D6), then pulse WR.
    const setAddr = (addr: number) => { for (let i = 0; i < 14; i++) pm.triggerPinChange(aKey(i), ((addr >> i) & 1) === 1); };
    const setData = (d: number) => { for (let i = 0; i < 8; i++) pm.triggerPinChange(dKey(i), ((d >> i) & 1) === 1); };
    setAddr(0x2802);
    setData(0x52);
    pm.triggerPinChange(WR, false);
    pm.triggerPinChange(WR, true); // rising edge -> latch + render into the buffer
    disp.tickTimers(40_000_000n); // fire the ~30 fps blit timer so it paints

    expect(fb, 'framebuffer produced').not.toBeNull();
    // A lit pixel is bright green (G channel high); background is dark green.
    const lit = (x: number, y: number) => fb![(y * 256 + x) * 4 + 1] > 0x80;
    // Cell (col 2, row 0) spans x 16..23, y 0..7. Count lit pixels there.
    let litCount = 0;
    for (let y = 0; y < 8; y++) for (let x = 16; x < 24; x++) if (lit(x, y)) litCount++;
    expect(litCount, 'the R glyph lit some pixels in its cell').toBeGreaterThan(3);
    // A blank cell elsewhere (col 0) stays dark.
    let litBlank = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (lit(x, y)) litBlank++;
    expect(litBlank, 'an unwritten cell stays blank').toBe(0);

    disp.dispose();
  });
});
