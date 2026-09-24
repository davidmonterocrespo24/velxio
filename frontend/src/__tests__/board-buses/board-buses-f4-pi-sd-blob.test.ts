// @vitest-environment jsdom
/**
 * The microSD on a Raspberry Pi whose relay hosts it (project
 * board-buses-2026-09, F4).
 *
 * The relay answers the guest from the portable model and sends back what the
 * model wrote as `bus_blob {owner, name, offset, data}`, the same event the
 * QEMU worker sends. The relay keeps its model across republishes, so the
 * guest reads its own writes during the run either way; what depends on the
 * tab taking the span is everything after that: the SD panel listing the file
 * the sketch just saved, and the next Run building the card from what is on
 * it rather than from the image it started with.
 *
 * Runs through the real store and the real PiBridgeShim, with the bridge
 * replaced at the module boundary, so the store's own wiring of the event is
 * what is under test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const piSent: Array<{ type: string; data: unknown }> = [];
vi.mock('../../simulation/RaspberryPi3Bridge', () => ({
  RaspberryPi3Bridge: class {
    boardId: string;
    boardKind: string;
    connected = false;
    onSerialData: unknown = null;
    onPinChange: unknown = null;
    onPinPull: unknown = null;
    onBusRequest: unknown = null;
    onBusRelay: unknown = null;
    onSystemEvent: ((event: string, data: Record<string, unknown>) => void) | null = null;
    onGpioPwm: unknown = null;
    onBooted: unknown = null;
    onDisconnected: unknown = null;
    onError: unknown = null;
    quietBootDefault = false;
    quietBootLabel = '';
    constructor(id: string, kind: string) {
      this.boardId = id;
      this.boardKind = kind;
    }
    connect() {}
    disconnect() {}
    sendPinEvent() {}
    sendBusTopology(t: unknown) {
      piSent.push({ type: 'pi_bus_topology', data: t });
    }
    sendBusAttrs() {}
  },
}));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useSimulatorStore, getBoardSimulator, getBoardBridge } from '../../store/useSimulatorStore';
import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import '../../simulation/parts/ProtocolParts';
import { busRegistry, primeBusChip, resetBusChipsForTest } from '../../simulation/buses';
import type { RemoteSpiMapEntry } from '../../simulation/buses';

const WASM = readFileSync(resolve(process.cwd(), 'public/bus-chips/microsd.wasm'));

type Bridge = { onSystemEvent: ((event: string, data: Record<string, unknown>) => void) | null };
type Shim = { startBusSync(): void; stopBusSync(): void };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
  resetBusChipsForTest();
  piSent.length = 0;
});

let seq = 0;

/** A Pi with a canvas microSD on SPI0 CE0, the relay listening. */
function piWithCard(image: Uint8Array): { id: string; card: string; bridge: Bridge } {
  primeBusChip('microsd', new Uint8Array(WASM));
  const id = `pi-sd-${++seq}`;
  useSimulatorStore.getState().addBoard('raspberry-pi-4' as never, 0, 0, id);
  const shim = getBoardSimulator(id) as unknown as Shim;
  cleanups.push(() => shim.stopBusSync());
  const card = `sd-${seq}`;
  const legs = { SCK: 'GPIO11', DI: 'GPIO10', DO: 'GPIO9', CS: 'GPIO8' };
  useSimulatorStore.setState((s) => ({
    wires: [
      ...s.wires,
      ...Object.entries(legs).map(([pinName, pad]) => ({
        id: `w-${card}-${pinName}`,
        start: { componentId: card, pinName, x: 0, y: 0 },
        end: { componentId: id, pinName: pad, x: 0, y: 0 },
        waypoints: [],
        color: '#0a0',
      })),
    ],
  }) as never);
  const off = PartSimulationRegistry.get('microsd-card')!.attachEvents!(
    { id: card, sdImageData: image } as unknown as HTMLElement,
    getBoardSimulator(id) as never,
    () => null,
    card,
  ) as (() => void) | undefined;
  if (off) cleanups.push(off);
  shim.startBusSync();
  return { id, card, bridge: getBoardBridge(id) as unknown as Bridge };
}

function hostedCard(boardId: string, owner: string): Uint8Array {
  const entry = busRegistry.remoteSpiMap(boardId).find((e: RemoteSpiMapEntry) => e.owner === owner);
  expect(entry, `${owner} is hosted`).toBeDefined();
  return new Uint8Array(Buffer.from(entry!.model.blobs.card, 'base64'));
}

describe('a Pi-hosted card hands its writes back to the tab', () => {
  it('the relay has the card as a responder, so there is a span to come back', () => {
    const { card } = piWithCard(new Uint8Array(2048));
    const topo = [...piSent].reverse().find((m) => m.type === 'pi_bus_topology')!.data as {
      spi: { responders?: RemoteSpiMapEntry[] };
    };
    expect(topo.spi.responders?.map((e) => e.owner)).toContain(card);
  });

  it('a bus_blob from the relay lands on the card the next map and the panel read', () => {
    const { id, card, bridge } = piWithCard(new Uint8Array(2048));
    const span = new Uint8Array(512).fill(0xa7);
    bridge.onSystemEvent!('bus_blob', {
      event: 'bus_blob',
      owner: card,
      bus: 0,
      cs: 0,
      name: 'card',
      offset: 1024,
      data: Buffer.from(span).toString('base64'),
    });
    const blob = hostedCard(id, card);
    expect(blob.slice(1024, 1536).every((b) => b === 0xa7), 'the sector the guest wrote').toBe(true);
    expect(blob.slice(0, 1024).every((b) => b === 0), 'and nothing before it').toBe(true);
  });

  it('a span for a card that left the board is dropped without throwing', () => {
    const { id, card, bridge } = piWithCard(new Uint8Array(1024));
    expect(() =>
      bridge.onSystemEvent!('bus_blob', {
        event: 'bus_blob',
        owner: 'gone',
        name: 'card',
        offset: 0,
        data: Buffer.from([1, 2, 3]).toString('base64'),
      }),
    ).not.toThrow();
    expect(hostedCard(id, card).every((b) => b === 0)).toBe(true);
  });
});
