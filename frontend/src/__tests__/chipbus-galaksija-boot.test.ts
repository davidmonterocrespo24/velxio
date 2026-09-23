/**
 * Phase 3 — a REAL 1983 home computer boots over the chip-to-chip bus.
 * (project/multichip-bus/).
 *
 * Galaksija (Voja Antonic, 1983; ROM placed in the public domain by the author)
 * is a Z80 home computer. Here its real 8 KB ROM (ROM A monitor + integer BASIC
 * at 0x0000, ROM B float BASIC at 0x1000) runs on a standalone Z80 + external
 * ROM + RAM + an inverter for address decode, all chip-to-chip over a shared
 * bus, no board:
 *   ROM 0x0000-0x1FFF   rom.CE = A13
 *   RAM 0x2000-0x3FFF   ram.CE = NOT A13  (the inverter chip)
 *   RD -> both OE ; WR -> RAM WE
 *
 * Boot proof is pin-level, mirroring test/test_intel/test_z80/galaksija.test.js:
 * watch M1, read the address bus on each opcode fetch, and confirm the Z80
 * leaves the reset vector (DI; SUB A; JP 0x03DA), reaches the init routine at
 * 0x03DA, and runs a thousand-plus fetches across many ROM addresses — i.e. the
 * real Galaksija firmware executes end-to-end through the settle-kernel bus. The
 * on-screen "READY" prompt is the next milestone (it needs the video display
 * chip rendering the 0x2800 video RAM).
 *
 * Fixtures (wasi-sdk): z80.wasm from examples/intel/z80.c; galaksija-rom.wasm
 * holds the public-domain ROM A+B; ram-64k/inverter from the committed examples.
 * Skips cleanly if absent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PinManager } from '../simulation/PinManager';
import { ChipInstance } from '../simulation/customChips/ChipRuntime';
import {
  resolveChipNetKey,
  setChipBusEnabledForTest,
  resetChipNetIndexForTest,
  type ChipNetState,
} from '../simulation/customChips/chipNets';
import { syntheticChipPin } from '../simulation/customChips/syntheticPins';
import { resetBusNets } from '../simulation/customChips/busNets';

const f = (n: string) => fileURLToPath(new URL(`./fixtures/chipbus/${n}`, import.meta.url));
const paths = { z80: f('z80.wasm'), rom: f('galaksija-rom.wasm'), ram: f('ram-64k.wasm'), inv: f('inverter.wasm') };
const haveFixtures = Object.values(paths).every(existsSync);

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const Z80_PINS = [
  ...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`),
  'M1', 'MREQ', 'IORQ', 'RD', 'WR', 'RFSH', 'HALT', 'WAIT',
  'INT', 'NMI', 'RESET', 'BUSREQ', 'BUSACK', 'CLK', 'VCC', 'GND',
];
const ROM_PINS = [...range(13).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE'];
const RAM_PINS = [...range(16).map((i) => `A${i}`), ...range(8).map((i) => `D${i}`), 'CE', 'OE', 'WE', 'VCC', 'GND'];
const INV_PINS = ['IN', 'OUT'];

const W: ChipNetState['wires'] = [];
const wire = (a: string, ap: string, b: string, bp: string) =>
  (W as { start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } }[]).push(
    { start: { componentId: a, pinName: ap }, end: { componentId: b, pinName: bp } });
for (const i of range(13)) { wire('z80', `A${i}`, 'rom', `A${i}`); wire('z80', `A${i}`, 'ram', `A${i}`); }
wire('z80', 'A13', 'rom', 'CE');
wire('z80', 'A13', 'inv', 'IN');
wire('inv', 'OUT', 'ram', 'CE');
for (const i of range(8)) { wire('z80', `D${i}`, 'rom', `D${i}`); wire('z80', `D${i}`, 'ram', `D${i}`); }
wire('z80', 'RD', 'rom', 'OE');
wire('z80', 'RD', 'ram', 'OE');
wire('z80', 'WR', 'ram', 'WE');

const STATE: ChipNetState = {
  wires: W,
  components: [
    { id: 'z80', metadataId: 'custom-chip' }, { id: 'rom', metadataId: 'custom-chip' },
    { id: 'ram', metadataId: 'custom-chip' }, { id: 'inv', metadataId: 'custom-chip' },
  ],
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

describe.skipIf(!RUN_CHIPBUS || !haveFixtures)('chipbus Phase 3 — Galaksija (real Z80 home computer) boots over the bus', () => {
  beforeEach(() => { setChipBusEnabledForTest(true); resetChipNetIndexForTest(); resetBusNets(); });
  afterEach(() => { setChipBusEnabledForTest(null); resetChipNetIndexForTest(); resetBusNets(); });

  it('runs the public-domain Galaksija ROM: leaves reset, reaches init 0x03DA, executes 1000+ fetches', async () => {
    const pm = new PinManager();
    const z80 = await ChipInstance.create({ wasm: new Uint8Array(readFileSync(paths.z80)), componentId: 'z80', pinManager: pm, wires: wiresFor('z80', Z80_PINS) });
    z80.start();
    const rom = await ChipInstance.create({ wasm: new Uint8Array(readFileSync(paths.rom)), componentId: 'rom', pinManager: pm, wires: wiresFor('rom', ROM_PINS) });
    rom.start();
    const ram = await ChipInstance.create({ wasm: new Uint8Array(readFileSync(paths.ram)), componentId: 'ram', pinManager: pm, wires: wiresFor('ram', RAM_PINS) });
    ram.start();
    const inv = await ChipInstance.create({ wasm: new Uint8Array(readFileSync(paths.inv)), componentId: 'inv', pinManager: pm, wires: wiresFor('inv', INV_PINS) });
    inv.start();

    // Watch M1: on each opcode fetch, read the address bus = PC.
    const addrKeys = range(16).map((i) => pinKey('z80', `A${i}`));
    const readPc = () => { let pc = 0; for (let i = 0; i < 16; i++) if (pm.getPinState(addrKeys[i])) pc |= 1 << i; return pc; };
    let fetches = 0, reached03DA = false, everMoved = false, lastPc = -1;
    const seen = new Set<number>();
    pm.onPinChange(pinKey('z80', 'M1'), (_p, state) => {
      if (state) return; // only on M1 asserted (low)
      const pc = readPc();
      fetches++; seen.add(pc);
      if (pc === 0x03da) reached03DA = true;
      if (pc !== lastPc && lastPc !== -1) everMoved = true;
      lastPc = pc;
    });

    // Deassert control inputs, then release RESET (rising edge).
    for (const p of ['WAIT', 'INT', 'NMI', 'BUSREQ']) pm.triggerPinChange(pinKey('z80', p), true);
    pm.triggerPinChange(pinKey('z80', 'RESET'), false);
    pm.triggerPinChange(pinKey('z80', 'RESET'), true);

    // ~60000 instructions of the 4 MHz pseudo-clock (250 ns period) — enough
    // to clear the screen, set up the stack, and run the welcome-banner init.
    z80.tickTimers(BigInt(60000 * 250));

    expect(everMoved, 'PC advances past the reset vector').toBe(true);
    expect(reached03DA, 'PC reaches the init routine at 0x03DA (JP target from reset)').toBe(true);
    expect(fetches, 'opcode fetches over the run').toBeGreaterThan(1000);
    expect(seen.size, 'distinct fetch addresses (init really runs through the ROM)').toBeGreaterThan(50);

    z80.dispose(); rom.dispose(); ram.dispose(); inv.dispose();
  }, 30_000);
});
