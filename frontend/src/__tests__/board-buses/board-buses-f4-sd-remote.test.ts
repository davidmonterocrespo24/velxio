// @vitest-environment jsdom
/**
 * The microSD card on a board whose CPU is not in this tab (project
 * board-buses-2026-09, F4).
 *
 * The card used to exist three times: the state machine inside this part, the
 * pro overlay's SdSpiCard for a board's own slot, and a third in Python that
 * the QEMU worker was handed the image for (`esp32_sd_slave.py`). They had
 * drifted, and each drift was a card that mounted on one engine and not
 * another. F4 leaves two things: ONE JavaScript card in this tab, which is
 * what the SD panel lists, and ONE portable model, which is what answers the
 * guest wherever the guest runs.
 *
 * This suite is about the second one: that the card the user put on the canvas
 * reaches the worker as that model, carrying what is actually on it. The
 * artifact is the REAL committed one, read off disk, so a rebuild that changes
 * the bytes is seen here too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import '../../simulation/parts/ProtocolParts';
import { busRegistry, primeBusChip, resetBusChipsForTest } from '../../simulation/buses';
import type { NetResolver } from '../../simulation/buses';
import { sdSpiFabricDevice } from '../../simulation/parts/sdSpiCard';

const BOARD = 'esp32-1';
const CARD = 'sd-1';
/** The pads the card's silkscreen prints, and the GPIOs they are wired to. */
const WIRING: Record<string, number> = { SCK: 18, DI: 23, DO: 19, CS: 5 };

const circuit: NetResolver = {
  resolve: (ref) =>
    ref.kind === 'board'
      ? { kind: 'board', boardId: ref.boardId, pin: ref.pin }
      : ref.componentId === CARD && WIRING[ref.pinName] !== undefined
        ? { kind: 'board', boardId: BOARD, pin: WIRING[ref.pinName] }
        : { kind: 'floating' },
  boardKind: () => 'esp32',
  boards: () => [BOARD],
};

const WASM = readFileSync(resolve(process.cwd(), 'public/bus-chips/microsd.wasm'));
const WASM_B64 = WASM.toString('base64');

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  busRegistry.clear();
  resetBusChipsForTest();
});

/** The card as the canvas builds it, on the bus its wires put it on. */
function attachCard(image: Uint8Array | null): void {
  busRegistry.setResolver(circuit);
  const el = { id: CARD, ...(image ? { sdImageData: image } : {}) } as unknown as HTMLElement;
  const detach = PartSimulationRegistry.get('microsd-card')!.attachEvents!(
    el,
    {} as never,
    () => null,
    CARD,
  );
  cleanups.push(() => detach?.());
}

const b64ToBytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

describe('the canvas microSD as a remote responder', () => {
  it('travels as the portable model, with the card image as its blob', () => {
    primeBusChip('microsd', new Uint8Array(WASM));
    const image = new Uint8Array(1024);
    image[0] = 0xeb;
    image[600] = 0x42;
    attachCard(image);

    const map = busRegistry.remoteSpiMap(BOARD);
    expect(map).toHaveLength(1);
    expect(map[0].owner).toBe(CARD);
    expect(map[0].cs).toEqual({ kind: 'pin', gpio: WIRING.CS, active_low: true });
    expect(map[0].model.wasm_b64, 'the committed artifact, not a stand-in').toBe(WASM_B64);
    // The model watches its own chip select to end a command frame, and the
    // worker can only fire that watch through the pin map.
    expect(map[0].model.pin_map).toEqual({
      SCK: WIRING.SCK,
      DI: WIRING.DI,
      DO: WIRING.DO,
      CS: WIRING.CS,
    });
    expect(b64ToBytes(map[0].model.blobs.card)).toEqual(image);
  });

  it('carries no model for a card with no image, rather than an empty one', () => {
    // A blob is the card: no image means nothing to serve, and a model that
    // drives nothing is worse than a gap the bus can name.
    primeBusChip('microsd', new Uint8Array(WASM));
    attachCard(null);
    expect(busRegistry.remoteSpiMap(BOARD)).toEqual([]);
  });

  it('carries no model until the artifact has arrived, and says so by publishing again', () => {
    // The artifact is fetched, so the first map of a page is built without it.
    const boards: string[] = [];
    cleanups.push(busRegistry.onSpiMapChange((id) => boards.push(id)));
    attachCard(new Uint8Array(512).fill(1));
    expect(busRegistry.remoteSpiMap(BOARD), 'nothing to send yet').toEqual([]);

    const before = boards.length;
    primeBusChip('microsd', new Uint8Array(WASM));
    expect(boards.slice(before), 'the board hears about it').toContain(BOARD);
    expect(busRegistry.remoteSpiMap(BOARD)).toHaveLength(1);
  });

  it('takes the span the worker says the model wrote, and is no sink', () => {
    // The worker keeps a card transaction no sink can see to itself (F4-SPEC,
    // "Worker, por byte", step 3) and sends what the model wrote as a span.
    // The card has to take it, or the panel and the next map would forget the
    // guest's file; and because it takes it, the card's bytes need not be
    // relayed, so it is not listed among the sinks.
    primeBusChip('microsd', new Uint8Array(WASM));
    attachCard(new Uint8Array(2048));
    expect(busRegistry.remoteSpiPublication(BOARD).at(-1)).toEqual({ sinks: { all: false, cs: [] } });

    const span = new Uint8Array(512).fill(0x5c);
    expect(busRegistry.applyRemoteBlob(BOARD, CARD, 'card', 1024, span)).toBe(true);
    const blob = b64ToBytes(busRegistry.remoteSpiMap(BOARD)[0].model.blobs.card);
    expect(blob.slice(1024, 1536).every((b) => b === 0x5c), 'the written sector').toBe(true);
    expect(blob.slice(512, 1024).every((b) => b === 0), 'and nothing else').toBe(true);
    expect(busRegistry.applyRemoteBlob('esp32-2', CARD, 'card', 0, span), 'another board').toBe(false);
  });

  it('sends what is on the card NOW, not the image it was built with', () => {
    // Whatever wrote it (the worker's span above, or the bytes themselves on
    // a board the worker still relays for), a map published afterwards has to
    // carry it, or a rewire would hand the guest back a card that forgot what
    // it wrote.
    primeBusChip('microsd', new Uint8Array(WASM));
    attachCard(new Uint8Array(1024));

    const card = (busRegistry as unknown as {
      spi: Map<string, { device: ReturnType<typeof sdSpiFabricDevice> }>;
    }).spi.get(CARD)!.device;
    card.select?.();
    // CMD24 WRITE_BLOCK at byte offset 512 (block 1), then the data token, a
    // sector of 0xA5 and the two CRC bytes the card ignores.
    for (const b of [0x58, 0x00, 0x00, 0x02, 0x00, 0x95]) card.transfer(b, 8);
    for (let i = 0; i < 8; i++) card.transfer(0xff, 8);
    card.transfer(0xfe, 8);
    for (let i = 0; i < 512; i++) card.transfer(0xa5, 8);
    card.transfer(0xff, 8);
    card.transfer(0xff, 8);
    card.deselect?.();

    const blob = b64ToBytes(busRegistry.remoteSpiMap(BOARD)[0].model.blobs.card);
    expect(blob.slice(512, 1024).every((b) => b === 0xa5), 'the written sector').toBe(true);
  });
});
