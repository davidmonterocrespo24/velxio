/**
 * A UART between two boards links through a resistor (velxio/velxio-prod#189).
 *
 * The textbook way to join an Uno's 5 V TX to an ESP32's 3.3 V RX is a
 * divider: 10 kOhm in series, 20 kOhm from the ESP32 side to ground (SparkFun,
 * "Voltage Dividers", level shifting; the ESP32's VIH max is VDD + 0.3 V,
 * datasheet table 5-3). A series protection resistor is the other common
 * hookup. Both are one net on the bench as far as the bits go, and the bus
 * fabric links the boards' UARTs only when createStoreNetResolver's resolveAll
 * names both boards. It walked from a board pad along the wires but asked
 * PinTrace one board at a time, and PinTrace answers with the pad on the
 * resistor's near node before it ever crosses the resistor, so the far board
 * was never found: the correct circuit gave two boards with no link and no
 * message, while the out-of-spec direct 5 V wire worked.
 *
 * resolveAll now also walks the net across the parts that conduct DC between
 * their two pins (resistors, inductors), not across capacitors, and stops at a
 * supply or ground node, collecting every board GPIO pad it meets.
 */
import { describe, it, expect } from 'vitest';
import { createStoreNetResolver } from '../simulation/buses/storeResolver';
import { BusRegistry } from '../simulation/buses/registry';
import '../simulation/buses/boardPinTables';
import type {
  BoardPins,
  EngineBinding,
  ResolvedPin,
  UartConfig,
  UartControllerPort,
  UartRouting,
} from '../simulation/buses/types';

const w = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
  waypoints: [],
  color: '#0af',
});
const board = (id: string, boardKind: string) => ({ id, boardKind, x: 0, y: 0, running: true });
const part = (id: string, metadataId: string, value: string) => ({ id, metadataId, x: 0, y: 0, properties: { value } });

const boardsOf = (pins: ResolvedPin[]) =>
  pins
    .filter((p): p is Extract<ResolvedPin, { kind: 'board' }> => p.kind === 'board')
    .map((p) => `${p.boardId}:${p.pin}`)
    .sort();

/** Uno TX (pin 1) to ESP32 GPIO16 through `link`, grounds joined. */
function bench(link: 'wire' | 'divider' | 'series' | 'capacitor') {
  const wires =
    link === 'wire'
      ? [w('t1', ['uno', '1'], ['esp', '16'])]
      : link === 'divider'
        ? [
            w('t1', ['uno', '1'], ['r1', '1']),
            w('t2', ['r1', '2'], ['esp', '16']),
            w('t3', ['r1', '2'], ['r2', '1']),
            w('t4', ['r2', '2'], ['uno', 'GND.1']),
          ]
        : link === 'series'
          ? [w('t1', ['uno', '1'], ['r1', '1']), w('t2', ['r1', '2'], ['esp', '16'])]
          : [w('t1', ['uno', '1'], ['c1', '1']), w('t2', ['c1', '2'], ['esp', '16'])];
  const components =
    link === 'divider'
      ? [part('r1', 'resistor', '10k'), part('r2', 'resistor', '20k')]
      : link === 'series'
        ? [part('r1', 'resistor', '1k')]
        : link === 'capacitor'
          ? [part('c1', 'capacitor', '100n')]
          : [];
  return {
    boards: [board('uno', 'arduino-uno'), board('esp', 'esp32')],
    components,
    wires: [...wires, w('g1', ['esp', 'GND.1'], ['uno', 'GND.2'])],
  };
}

describe('resolveAll walks a UART net across resistors', () => {
  it('a direct wire links both boards (as before)', () => {
    const r = createStoreNetResolver(() => bench('wire') as never);
    expect(boardsOf(r.resolveAll!({ kind: 'board', boardId: 'uno', pin: 1 }))).toEqual(['esp:16', 'uno:1']);
  });

  it('a 10k/20k level-shifting divider links both boards, from either end', () => {
    const r = createStoreNetResolver(() => bench('divider') as never);
    expect(boardsOf(r.resolveAll!({ kind: 'board', boardId: 'uno', pin: 1 }))).toEqual(['esp:16', 'uno:1']);
    expect(boardsOf(r.resolveAll!({ kind: 'board', boardId: 'esp', pin: 16 }))).toEqual(['esp:16', 'uno:1']);
    // And from the tap, a part pin on the net.
    expect(boardsOf(r.resolveAll!({ kind: 'component', componentId: 'r2', pinName: '1' }))).toEqual([
      'esp:16',
      'uno:1',
    ]);
  });

  it('a single series resistor links both boards', () => {
    const r = createStoreNetResolver(() => bench('series') as never);
    expect(boardsOf(r.resolveAll!({ kind: 'board', boardId: 'uno', pin: 1 }))).toEqual(['esp:16', 'uno:1']);
    expect(boardsOf(r.resolveAll!({ kind: 'board', boardId: 'esp', pin: 16 }))).toEqual(['esp:16', 'uno:1']);
  });

  it('a series capacitor blocks the DC level and does not link', () => {
    const r = createStoreNetResolver(() => bench('capacitor') as never);
    expect(boardsOf(r.resolveAll!({ kind: 'board', boardId: 'uno', pin: 1 }))).toEqual(['uno:1']);
  });

  it('stops at ground: a third board hanging off the divider\'s ground leg is not on the net', () => {
    const st = bench('divider');
    st.boards.push(board('mega', 'arduino-mega'));
    st.components.push(part('r3', 'resistor', '1k'));
    st.wires.push(w('m1', ['mega', '19'], ['r3', '1']), w('m2', ['r3', '2'], ['uno', 'GND.3']));
    const r = createStoreNetResolver(() => st as never);
    expect(boardsOf(r.resolveAll!({ kind: 'board', boardId: 'uno', pin: 1 }))).toEqual(['esp:16', 'uno:1']);
  });
});

// ── The fabric end to end: the byte crosses the divider ────────────────────

class Port implements UartControllerPort {
  readonly bus = 'uart' as const;
  handler: ((byte: number) => void) | null = null;
  rx: number[] = [];
  constructor(
    readonly unit: number,
    readonly name: string,
    private readonly route: UartRouting | 'static' = 'static',
  ) {}
  setTxHandler(h: ((byte: number) => void) | null): void {
    this.handler = h;
  }
  setRoutingChangeHandler(): void {}
  receive(byte: number): void {
    this.rx.push(byte);
  }
  config(): UartConfig {
    return { baud: 9600 };
  }
  routing(): UartRouting | 'static' {
    return this.route;
  }
  tx(...bytes: number[]): void {
    for (const b of bytes) this.handler?.(b);
  }
}

class Pins implements BoardPins {
  onPinChange(): () => void {
    return () => {};
  }
  peekPinState(): boolean | undefined {
    return undefined;
  }
  driveInput(): void {}
}

describe('the fabric links two boards\' UARTs through a level-shifting divider', () => {
  it('what the Uno sends on TX reaches the ESP32\'s UART2 on GPIO16', () => {
    const st = bench('divider');
    const reg = new BusRegistry();
    reg.setResolver(createStoreNetResolver(() => st as never));
    const usart0 = new Port(0, 'USART0');
    const uart2 = new Port(2, 'UART2', { rx: 16, tx: 17 });
    const unoBinding: EngineBinding = { pins: new Pins(), spi: [], uart: [usart0] };
    const espBinding: EngineBinding = { pins: new Pins(), spi: [], uart: [new Port(0, 'UART0', { rx: 3, tx: 1 }), uart2] };
    reg.bindEngine('uno', unoBinding);
    reg.bindEngine('esp', espBinding);
    reg.netlistChanged();

    expect(reg.uartPeers('uno', 1)).toEqual([{ boardId: 'esp', pin: 16 }]);
    usart0.tx(0x48, 0x69);
    expect(uart2.rx).toEqual([0x48, 0x69]);
  });
});
