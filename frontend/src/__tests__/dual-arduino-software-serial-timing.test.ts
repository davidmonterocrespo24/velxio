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
