/**
 * A board's OWN microSD slot on the QEMU lane (project board-buses-2026-09,
 * F4).
 *
 * The slot is a device of the bus fabric like a card on the canvas: it is on
 * the bus its clock pin is on, and it answers only while its own chip select
 * is low, which is what lets the board's panel and its card share the other
 * three wires. Until F4 the worker was handed the image in its start config
 * and served it from a Python card of its own, a third hand-kept copy of the
 * protocol; the slot now travels in the bus map and the portable model answers
 * beside the guest.
 *
 * Its own file because it registers an overlay board definition, and that
 * registry is module state for the whole run.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});
vi.stubGlobal('document', { getElementById: () => null });

class ScriptedSocket {
  static OPEN = 1;
  static last: ScriptedSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  sent: Array<{ type: string; data?: Record<string, unknown> }> = [];
  constructor(_url: string) {
    ScriptedSocket.last = this;
  }
  send(frame: string): void {
    this.sent.push(JSON.parse(frame));
  }
  close(): void {}
  open(): void {
    this.readyState = ScriptedSocket.OPEN;
    this.onopen?.();
  }
}
vi.stubGlobal('WebSocket', ScriptedSocket);

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useSimulatorStore, getBoardSimulator, getEsp32Bridge } from '../../store/useSimulatorStore';
import {
  busRegistry,
  createStoreNetResolver,
  primeBusChip,
  resetBusChipsForTest,
} from '../../simulation/buses';
import { registerProBoards, type ProBoardDef } from '../../lib/proBoardRegistry';

// The slot of the board the overlay declares: the M5Stack Core's, on VSPI.
const SLOT = { csPin: 4, sck: 18, mosi: 23, miso: 19 };

registerProBoards([
  {
    kind: 'esp32',
    label: 'ESP32 with a card slot',
    fqbn: null,
    description: 'test double for a board that declares a built-in slot',
    tag: 'velxio-esp32',
    size: { w: 10, h: 10 },
    esp32Family: 'esp32',
    builtInSd: { bus: 'spi', ...SLOT },
  } as unknown as ProBoardDef,
]);

const WASM = readFileSync(resolve(process.cwd(), 'public/bus-chips/microsd.wasm'));

afterEach(() => {
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
  busRegistry.clear();
  // clear() drops the resolver as well, and the store installs its own once
  // when the module loads: without this every test after the first would be
  // asking a registry that cannot place a device anywhere, and would pass by
  // finding nothing.
  busRegistry.setResolver(createStoreNetResolver(() => useSimulatorStore.getState()));
  resetBusChipsForTest();
});

function board() {
  const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
  const bridge = getEsp32Bridge(id)!;
  bridge.connect();
  ScriptedSocket.last!.open();
  return { id, bridge, sim: getBoardSimulator(id) as { syncBuiltinSdCard?: () => void } };
}

describe("a board's own microSD slot on a QEMU board", () => {
  it('reaches the bus map as a portable model on the slot pins', () => {
    primeBusChip('microsd', new Uint8Array(WASM));
    const { id, bridge, sim } = board();
    bridge.sdImageB64 = Buffer.from(new Uint8Array(1024).fill(7)).toString('base64');
    sim.syncBuiltinSdCard!();

    const map = busRegistry.remoteSpiMap(id);
    expect(map).toHaveLength(1);
    expect(map[0].owner, 'the owner the overlay uses too, so an engine swap replaces it').toBe(
      `builtin:${id}:sd`,
    );
    expect(map[0].cs).toEqual({ kind: 'pin', gpio: SLOT.csPin, active_low: true });
    // A built-in names BOARD pins, not pad names, so the model's own
    // chip-select watch has to be given the map explicitly.
    expect(map[0].model.pin_map).toEqual({
      SCK: SLOT.sck,
      DI: SLOT.mosi,
      DO: SLOT.miso,
      CS: SLOT.csPin,
    });
    expect(
      new Uint8Array(Buffer.from(map[0].model.blobs.card, 'base64')).every((b) => b === 7),
    ).toBe(true);
  });

  it('leaves the slot to the engine when the CPU runs in this tab', () => {
    // An in-browser engine puts the same slot on the bus under the same owner,
    // from its own card. Two cards built from two images racing for one owner
    // is the attach-order bug this project exists to remove, so the shim only
    // takes the slot when the bridge publishes no ports of its own.
    primeBusChip('microsd', new Uint8Array(WASM));
    const { id, bridge, sim } = board();
    (bridge as unknown as { getBusBinding: () => unknown }).getBusBinding = () => ({
      pins: {},
      spi: [],
    });
    bridge.sdImageB64 = Buffer.from(new Uint8Array(1024).fill(7)).toString('base64');
    sim.syncBuiltinSdCard!();
    expect(busRegistry.remoteSpiMap(id)).toEqual([]);
  });

  it('leaves the bus alone for a board with no image in its slot', () => {
    primeBusChip('microsd', new Uint8Array(WASM));
    const { id, sim } = board();
    sim.syncBuiltinSdCard!();
    expect(busRegistry.remoteSpiMap(id)).toEqual([]);
  });

  it('does not ship the image in the start config any more', () => {
    // It used to, and a Python card in the worker served it. That card is
    // gone; anything still sending `sd_card` would be a second card answering
    // the same chip select. The image is set BEFORE connect, which is when the
    // store sets it and the only moment the start message could pick it up.
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const bridge = getEsp32Bridge(id)!;
    bridge.sdImageB64 = Buffer.from(new Uint8Array(512).fill(3)).toString('base64');
    bridge.connect();
    ScriptedSocket.last!.open();
    const start = ScriptedSocket.last!.sent.find((m) => m.type === 'start_esp32');
    expect(start, 'the board did start').toBeTruthy();
    expect('sd_card' in (start!.data ?? {})).toBe(false);
  });
});
