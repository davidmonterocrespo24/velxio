/**
 * Two REAL Arduino Unos talking SoftwareSerial across a wire (#397).
 *
 * Each board in the browser runs its own animation-frame loop and executes
 * ~16 ms of cycles per frame in one burst. The transmitter therefore produces
 * a whole SoftwareSerial byte (104 us bits at 9600 baud) while the receiver is
 * not executing; delivered as plain setPinState calls the receiver only saw
 * the last level and `mySerial.available()` never rose. This runs the
 * reporter's two sketches (compiled into fixtures/softserial, sources next to
 * them) on two AVRSimulators wired through the interconnect, each executed in
 * 16 ms bursts in turn, exactly the shape of the frame loop.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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

describe('SoftwareSerial between two real Unos (#397)', () => {
  let sims: Record<string, AVRSimulator>;
  let pms: Record<string, PinManager>;

  beforeEach(() => {
    resetInterconnect();
    pms = { tx: new PinManager(), rx: new PinManager() };
    sims = { tx: new AVRSimulator(pms.tx), rx: new AVRSimulator(pms.rx) };
    setInterconnectRuntime({
      getBoardSimulator: (id) => sims[id],
      getBoardPinManager: (id) => pms[id],
      getBoardBridge: () => undefined,
      getEsp32Bridge: () => undefined,
      getStm32Bridge: () => undefined,
    });
    bindBoard('tx', 'arduino-uno');
    bindBoard('rx', 'arduino-uno');
  });

  it('the receiver reads the bytes the transmitter sends, run in 16 ms bursts', () => {
    sims.tx.loadHex(fixture('tx.hex'));
    sims.rx.loadHex(fixture('rx.hex'));
    // The reporter's wiring: TX pin 11 -> RX pin 10, common ground.
    updateWires([wire('w1', ['tx', '11'], ['rx', '10']), wire('w2', ['tx', 'GND'], ['rx', 'GND'])]);

    let rxOut = '';
    sims.rx.onSerialData = (ch: string) => {
      rxOut += ch;
    };

    // 1.5 s of simulated time: the first PING goes out once setup is done.
    for (let frame = 1; frame <= 95; frame++) {
      for (const id of ['tx', 'rx']) {
        const sim = sims[id];
        while (sim.getCurrentCycles() < frame * FRAME_CYCLES) sim.step();
      }
    }

    expect(rxOut).toContain('Receiver Ready');
    // "PING\r\n": P = 80, I = 73, N = 78, G = 71.
    expect(rxOut).toContain('Byte: 80 | HEX: 0x50');
    expect(rxOut).toContain('Byte: 73 | HEX: 0x49');
    expect(rxOut).toContain('Byte: 78 | HEX: 0x4E');
    expect(rxOut).toContain('Byte: 71 | HEX: 0x47');
  });
});
