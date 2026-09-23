/**
 * microsd-real-firmware.test.ts — end-to-end proof that a REAL Arduino SD
 * library (SD.h on avr8js) mounts the FAT16 image our microsd-card part serves
 * over SPI, reads a file, writes a new one, and reads it back.
 *
 * Firmware fixture (`fixtures/microsd-rw/`) was compiled with arduino-cli
 * (arduino:avr:uno) from the committed .ino. It exercises:
 *   - SD.begin()  -> the SD-over-SPI init handshake (CMD0/8/55+41/58)
 *   - SD.open()   -> mount FAT16 volume + read directory (CMD17 byte-addressed)
 *   - read/write  -> CMD17 reads from the FAT image; CMD24 writes persist
 *
 * This caught three real bugs the unit tests (with a synthetic SPI driver)
 * could not: the engine adapter's frame API, the N_CR command->response
 * latency, and SDSC byte addressing.
 *
 * The card reaches the board through the bus fabric (board-buses-2026-09), so
 * the rig supplies what the app supplies: a circuit that says where the card's
 * SCK/DI/DO/CS land (an Uno: 13/11/12/10, the CS pin the sketch passes to
 * SD.begin) and the board's engine binding. Everything else is the real thing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { buildFat16Image } from '../utils/fatImage';
import { busRegistry } from '../simulation/buses';
import type { NetResolver } from '../simulation/buses';

const BOARD = 'uno-1';
const CARD = 'sd-1';
/** The Uno's SPI pads, and the chip select the sketch drives. */
const WIRING: Record<string, number> = { SCK: 13, DI: 11, DO: 12, CS: 10 };

const circuit: NetResolver = {
  resolve: (ref) =>
    ref.kind === 'board'
      ? { kind: 'board', boardId: ref.boardId, pin: ref.pin }
      : ref.componentId === CARD && WIRING[ref.pinName] !== undefined
        ? { kind: 'board', boardId: BOARD, pin: WIRING[ref.pinName] }
        : { kind: 'floating' },
  boardKind: () => 'arduino-uno',
  boards: () => [BOARD],
};

const HEX = readFileSync(
  fileURLToPath(new URL('./fixtures/microsd-rw/microsd-rw.ino.hex', import.meta.url)),
  'utf-8',
);

function runUntil(sim: AVRSimulator, budget: number, pred: () => boolean): void {
  for (let i = 0; i < budget; i++) {
    sim.step();
    if ((i & 0x3ff) === 0 && pred()) return;
  }
}

describe('microSD — real AVR SD.h firmware', () => {
  // No board and no device of this file left on the fabric for the next one,
  // even when an assertion above throws.
  afterEach(() => busRegistry.clear());

  it('reads a file from the FAT image, writes a new one, and reads it back', () => {
    const sim = new AVRSimulator(new PinManager(), 'uno');
    sim.loadHex(HEX);
    busRegistry.setResolver(circuit);
    busRegistry.bindEngine(BOARD, sim.getBusBinding());
    const img = buildFat16Image([
      { name: 'hello.txt', data: new TextEncoder().encode('SD WORKS 123') },
    ]);
    const el = { id: CARD, sdImageData: img } as unknown as HTMLElement;
    PartSimulationRegistry.get('microsd-card')!.attachEvents!(el, sim as any, () => null, CARD);

    let out = '';
    sim.onSerialData = (ch) => {
      out += ch;
    };
    runUntil(sim, 60_000_000, () => out.includes('DONE') || out.includes('FAIL'));

    expect(out).toContain('READ:SD WORKS 123'); // read the pre-loaded file
    expect(out).toContain('RBACK:written-123'); // wrote + read back a new file
    expect(out).toContain('DONE');
    expect(out).not.toContain('FAIL');
  });
});
