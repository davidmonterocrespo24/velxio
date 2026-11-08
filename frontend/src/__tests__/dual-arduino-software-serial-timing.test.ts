/**
 * Two REAL AVR boards talking SoftwareSerial across a wire (#397).
 *
 * Each board in the browser runs its own animation-frame loop and executes
 * ~16 ms of cycles per frame in one burst. The transmitter therefore produces
 * a whole SoftwareSerial byte (104 us bits at 9600 baud) while the receiver is
 * not executing; delivered as plain setPinState calls the receiver only saw
 * the last level and `mySerial.available()` never rose. This runs the
 * reporter's two sketches (compiled into fixtures/softserial, sources next to
 * them) on two AVRSimulators wired through the interconnect, each executed in
 * 16 ms bursts in turn, exactly the shape of the frame loop.
 *
 * The report's second round ran the same sketches on more boards. The DFRobot
 * ones, overlay boards that run this very AVRSimulator through
 * ProBoardDef.createSimulator, received nothing: the interconnect routed a
 * closed list of OSS kinds and nothing else. Two Arduino Megas rebooted the
 * receiver on every byte: the Mega's PORTB carried the ATmega328P's PCINT0
 * vector, which is INT2's slot on the ATmega2560, and the sketch's missing
 * INT2 handler is avr-libc's __bad_interrupt, a jump to the reset vector.
 * The *-mega.hex fixtures are the same two sources compiled for
 * arduino:avr:mega.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import {
  bindBoard,
  resetInterconnect,
  setInterconnectRuntime,
  updateWires,
} from '../simulation/Interconnect';
import { registerProBoards, type ProBoardSimulator } from '../lib/proBoardRegistry';
import type { Wire } from '../types/wire';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/softserial/${name}`, import.meta.url)), 'utf8');

const FRAME_CYCLES = 16_000_000 * 0.016; // one 16 ms browser frame at 16 MHz

function wire(id: string, a: [string, string], b: [string, string]): Wire {
  return {
    id,
    start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
    end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
    color: '#000',
  } as unknown as Wire;
}

/**
 * A DFRduino Uno as the overlay registers it: the OSS AVRSimulator behind
 * createSimulator, and the pads named as that art labels them (D10 is "SS"
 * and D11 "MOSI" on its silk, which is how the reporter's wires read).
 */
const DFRDUINO_KIND = 'test-dfrduino-uno';
registerProBoards([
  {
    kind: DFRDUINO_KIND,
    label: 'DFRduino Uno (test)',
    fqbn: 'arduino:avr:uno',
    description: 'test',
    tag: 'velxio-test-dfrduino',
    size: { w: 10, h: 10 },
    createSimulator: (pm) =>
      new AVRSimulator(pm as PinManager, 'uno') as unknown as ProBoardSimulator,
    pinToNumber: (name) => ({ SS: 10, MOSI: 11, 'GND.2': -1 })[name] ?? null,
  },
]);

type Variant = 'uno' | 'mega';

interface Link {
  /** The two boards' kind as the store binds it, and the AVR variant behind it. */
  kind: string;
  variant: Variant;
  /** The reporter's wiring: transmitter TX pad -> receiver RX pad, common ground. */
  txPad: string;
  rxPad: string;
  gndPad: string;
}

/** Boot two boards with the sketches, wire them, and run 1.5 s of simulated
 *  time in 16 ms bursts: the first PING goes out once setup is done. Returns
 *  what the receiver printed on its console. */
function receiverOutput(link: Link): string {
  resetInterconnect();
  const pms = { tx: new PinManager(), rx: new PinManager() };
  const sims: Record<string, AVRSimulator> = {
    tx: new AVRSimulator(pms.tx, link.variant),
    rx: new AVRSimulator(pms.rx, link.variant),
  };
  setInterconnectRuntime({
    getBoardSimulator: (id) => sims[id],
    getBoardPinManager: (id) => pms[id as 'tx' | 'rx'],
    getBoardBridge: () => undefined,
    getEsp32Bridge: () => undefined,
    getStm32Bridge: () => undefined,
  });
  bindBoard('tx', link.kind);
  bindBoard('rx', link.kind);

  const suffix = link.variant === 'mega' ? '-mega' : '';
  sims.tx.loadHex(fixture(`tx${suffix}.hex`));
  sims.rx.loadHex(fixture(`rx${suffix}.hex`));
  updateWires([
    wire('w1', ['tx', link.txPad], ['rx', link.rxPad]),
    wire('w2', ['tx', link.gndPad], ['rx', link.gndPad]),
  ]);

  let rxOut = '';
  sims.rx.onSerialData = (ch: string) => {
    rxOut += ch;
  };

  for (let frame = 1; frame <= 95; frame++) {
    for (const sim of Object.values(sims)) {
      while (sim.getCurrentCycles() < frame * FRAME_CYCLES) sim.step();
    }
  }
  return rxOut;
}

function expectPingReceived(rxOut: string): void {
  expect(rxOut).toContain('Receiver Ready');
  // "PING\r\n": P = 80, I = 73, N = 78, G = 71.
  expect(rxOut).toContain('Byte: 80 | HEX: 0x50');
  expect(rxOut).toContain('Byte: 73 | HEX: 0x49');
  expect(rxOut).toContain('Byte: 78 | HEX: 0x4E');
  expect(rxOut).toContain('Byte: 71 | HEX: 0x47');
}

describe('SoftwareSerial between two real AVR boards (#397)', () => {
  it('two Unos: the receiver reads the bytes the transmitter sends, run in 16 ms bursts', () => {
    expectPingReceived(
      receiverOutput({ kind: 'arduino-uno', variant: 'uno', txPad: '11', rxPad: '10', gndPad: 'GND' }),
    );
  });

  it('two overlay AVR boards (createSimulator) are routed like the Unos', () => {
    expectPingReceived(
      receiverOutput({
        kind: DFRDUINO_KIND,
        variant: 'uno',
        txPad: 'MOSI',
        rxPad: 'SS',
        gndPad: 'GND.2',
      }),
    );
  });

  it('two Megas: the receiver reads the bytes and boots exactly once', () => {
    const rxOut = receiverOutput({
      kind: 'arduino-mega',
      variant: 'mega',
      txPad: '11',
      rxPad: '10',
      gndPad: 'GND.1',
    });
    // Every edge on pin 10 used to vector into INT2 and reset the board,
    // which printed the banner again and again ("RReRRReceiver Ready...").
    expect(rxOut.split('Receiver Ready').length - 1).toBe(1);
    expectPingReceived(rxOut);
  });
});

/**
 * The review of velxio/velxio-prod#74 found #397's anchor breaking a line
 * that crosses the end of the transmitter's burst (about a third of them over
 * a run): a line after a quiet link was anchored at the receiver's present,
 * the receiver then ran a whole frame before the transmitter's next burst, and
 * the line's edges after the boundary, spaced from that anchor, fell where it
 * had already run; they were moved up to its present and the line broke there.
 * The frame loop may end a burst anywhere. Here the transmitter's second line
 * (a second after the first, so the link has been quiet) starts 8 ms into a
 * burst that ends 300 us into the line, after the start bit of 'P' and before
 * its first 1 bit.
 */
describe('SoftwareSerial between two Unos, a line across the end of the transmitter’s burst (#74)', () => {
  /** The cycles the transmitter's lines start at (alone): its first fall, and every fall after 3 ms of a quiet line. */
  function lineStarts(count: number): number[] {
    const pm = new PinManager();
    const tx = new AVRSimulator(pm, 'uno');
    tx.loadHex(fixture('tx.hex'));
    const starts: number[] = [];
    let lastEdge = -Infinity;
    let high = false;
    pm.onPinChange(11, (_p: number, level: boolean) => {
      const now = tx.getCurrentCycles();
      if (!level && high && (starts.length === 0 || now - lastEdge > 3 * 16_000)) starts.push(now);
      if (level) high = true;
      lastEdge = now;
    });
    while (starts.length < count && tx.getCurrentCycles() < 3 * 16_000_000) tx.step();
    return starts;
  }

  it('the line arrives whole, its first byte too', () => {
    const [, t2] = lineStarts(2);
    expect(t2, 'the transmitter sent a second line').toBeGreaterThan(0);
    resetInterconnect();
    const pms = { tx: new PinManager(), rx: new PinManager() };
    const sims: Record<string, AVRSimulator> = {
      tx: new AVRSimulator(pms.tx, 'uno'),
      rx: new AVRSimulator(pms.rx, 'uno'),
    };
    setInterconnectRuntime({
      getBoardSimulator: (id) => sims[id],
      getBoardPinManager: (id) => pms[id as 'tx' | 'rx'],
      getBoardBridge: () => undefined,
      getEsp32Bridge: () => undefined,
      getStm32Bridge: () => undefined,
    });
    bindBoard('tx', 'arduino-uno');
    bindBoard('rx', 'arduino-uno');
    sims.tx.loadHex(fixture('tx.hex'));
    sims.rx.loadHex(fixture('rx.hex'));
    updateWires([wire('w1', ['tx', '11'], ['rx', '10']), wire('w2', ['tx', 'GND'], ['rx', 'GND'])]);
    let rxOut = '';
    sims.rx.onSerialData = (ch: string) => {
      rxOut += ch;
    };
    // 16 ms bursts, then one from 8 ms before the second line to 300 us into
    // it, then 16 ms again until the second line has been printed (a byte
    // prints in 23 ms at 9600 baud); the third line, a second later, is not sent.
    const ends: number[] = [];
    for (let end = FRAME_CYCLES; end < t2 - 8 * 16_000; end += FRAME_CYCLES) ends.push(end);
    ends.push(t2 - 8 * 16_000, t2 + 300 * 16);
    for (let end = t2 + 300 * 16 + FRAME_CYCLES; end < t2 + 300 * 16_000; end += FRAME_CYCLES) ends.push(end);
    for (const end of ends) {
      for (const sim of [sims.tx, sims.rx]) {
        while (sim.getCurrentCycles() < end) sim.step();
      }
    }
    const bytes = [...rxOut.matchAll(/Byte: (\d+) \| HEX/g)].map((m) => Number(m[1]));
    // Both lines whole, in order.
    expect(String.fromCharCode(...bytes), rxOut.slice(-400)).toBe('PING\r\nPING\r\n');
  });
});
