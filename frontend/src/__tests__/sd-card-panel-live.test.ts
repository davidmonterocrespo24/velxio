// @vitest-environment jsdom
/**
 * sd-card-panel-live.test.ts - the SD panel's "Card contents" lists the card
 * the GUEST is talking to, files the sketch wrote included.
 *
 * The card on the canvas is the OSS `microsd-card` part on the bus fabric, on
 * every engine family. The panel used to read its listing back from an ESP32
 * bridge's own SdSpiCard, which existed because every JS bridge built a second
 * card for the canvas part; that duplicate is gone (a board builds a card only
 * for a slot it declares), so the bridge has nothing to say about a canvas
 * card and the live view went blank on every board.
 *
 * Proof at the only altitude that means anything: real Arduino SD.h firmware
 * (the microsd-rw fixture, avr8js) mounts the image, writes out.txt, and the
 * panel - the real component, mounted and rendered - lists out.txt afterwards.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { buildFat16Image } from '../utils/fatImage';
import { busRegistry } from '../simulation/buses';
import type { NetResolver } from '../simulation/buses';
import { SdCardPanel } from '../components/simulator/SdCardPanel';
import { registerSdImageReader } from '../store/useSimulatorStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

// Vitest runs from the frontend root. `import.meta.url` is not a file URL in
// the jsdom environment, so the fixture is read from there instead.
const HEX = readFileSync(
  resolve(process.cwd(), 'src/__tests__/fixtures/microsd-rw/microsd-rw.ino.hex'),
  'utf-8',
);

function runUntil(sim: AVRSimulator, budget: number, pred: () => boolean): void {
  for (let i = 0; i < budget; i++) {
    sim.step();
    if ((i & 0x3ff) === 0 && pred()) return;
  }
}

/** Run the fixture sketch against a card on the canvas. Returns the part's
 *  detach, so the card leaves no reader behind for the next test. */
function runSketchWithCard(): () => void {
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(HEX);
  busRegistry.setResolver(circuit);
  busRegistry.bindEngine(BOARD, sim.getBusBinding());
  const img = buildFat16Image([
    { name: 'hello.txt', data: new TextEncoder().encode('SD WORKS 123') },
  ]);
  const el = { id: CARD, sdImageData: img } as unknown as HTMLElement;
  const detach = PartSimulationRegistry.get('microsd-card')!.attachEvents!(
    el,
    sim as never,
    () => null,
    CARD,
  );

  let out = '';
  sim.onSerialData = (ch) => {
    out += ch;
  };
  runUntil(sim, 60_000_000, () => out.includes('DONE') || out.includes('FAIL'));
  // The panel can only be right about a card the sketch really wrote to.
  expect(out).toContain('RBACK:written-123');
  expect(out).toContain('DONE');
  return detach ?? (() => {});
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Mount the real panel and give back the HTML it rendered. */
async function renderPanel(
  props: { boardId?: string | null; componentId?: string | null } = {},
): Promise<string> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(SdCardPanel, { files: [], onChange: () => {}, ...props }));
  });
  return host.innerHTML;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  busRegistry.clear();
});

describe('SD panel live listing vs the card the guest writes to', () => {
  it('lists the file a real SD.h sketch wrote on the canvas card', async () => {
    const detach = runSketchWithCard();
    try {
      // The property dialog opens on the card without naming it (it passes no
      // board and no component), which is the case that lost its listing.
      const html = await renderPanel();
      // FAT 8.3 names, as the card stores them.
      expect(html).toContain('OUT.TXT'); // written by the sketch, this run
      expect(html).toContain('HELLO.TXT'); // and what the card shipped with
      expect(html).toContain('11 B'); // "written-123"
      expect(html).not.toContain('Run the simulation to mount the card');
    } finally {
      detach();
    }
  });

  it('finds the same card when the panel is told which component it is', async () => {
    const detach = runSketchWithCard();
    try {
      const html = await renderPanel({ componentId: CARD });
      expect(html).toContain('OUT.TXT');
    } finally {
      detach();
    }
  });

  it('a detached card is gone from the panel, not stale', async () => {
    runSketchWithCard()(); // run, then take the card off the canvas
    const html = await renderPanel();
    expect(html).not.toContain('OUT.TXT');
    expect(html).toContain('Run the simulation to mount the card');
  });

  it("a board whose slot publishes nothing lists nothing, not the canvas card", async () => {
    // The ESP32 built-in slots keep their card on the engine bridge, so a
    // board panel can come up with no reader of its own. A card lying on the
    // canvas is a DIFFERENT card: guessing it here would show the user files
    // that are not in that slot.
    const detach = runSketchWithCard();
    try {
      const html = await renderPanel({ boardId: 'board-with-no-reader' });
      expect(html).not.toContain('OUT.TXT');
      expect(html).not.toContain('HELLO.TXT');
      expect(html).toContain('Run the simulation to mount the card');
    } finally {
      detach();
    }
  });

  it("a board's slot panel lists the board's card, never the canvas card", async () => {
    const detach = runSketchWithCard();
    // A board with a built-in slot: its own card, published under the board id
    // (what the XIAO display boards' built-ins do).
    const slotImage = buildFat16Image([
      { name: 'slot.txt', data: new TextEncoder().encode('board slot') },
    ]);
    const unpublish = registerSdImageReader(BOARD, () => slotImage);
    try {
      const html = await renderPanel({ boardId: BOARD });
      expect(html).toContain('SLOT.TXT');
      expect(html).not.toContain('OUT.TXT');
      expect(html).not.toContain('HELLO.TXT');
    } finally {
      unpublish();
      detach();
    }
  });
});
