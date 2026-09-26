/**
 * Board buses F5, third part: I2C between boards goes through the fabric.
 *
 * Two boards of the real store, an Arduino Uno (avr8js) and a Raspberry Pi
 * Pico (rp2040js), each running the conformance guest of its family
 * (fixtures/conf-i2c-console: 'x U AA N HH ..' over the serial port, Wire's
 * status and the bytes read back). A BMP280 model is wired to the Pico's
 * GP4/GP5 the way a part is, and the Pico's GP4/GP5 are wired to the Uno's
 * A4/A5: one SDA net and one SCL net that reach both boards. On the bench
 * both masters find the chip; here the registry places the target on both
 * boards' buses from the store's own resolver (createStoreNetResolver's
 * resolveAll, walking the wires once per board).
 *
 * This is the case STATUS.md listed as uncovered when the I2CBusManager
 * bridge graph (Interconnect.updateI2CBridges) went: that bridge only ever
 * saw the manager's device map, which no part registered in any more.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
let nextFrame = 1;
vi.stubGlobal('requestAnimationFrame', () => nextFrame++);
vi.stubGlobal('cancelAnimationFrame', () => {});

import { useSimulatorStore, getBoardSimulator } from '../../store/useSimulatorStore';
import type { AVRSimulator } from '../../simulation/AVRSimulator';
import type { RP2040Simulator } from '../../simulation/RP2040Simulator';
import { VirtualBMP280 } from '../../simulation/I2CBusManager';
import { attachI2cTarget, busRegistry } from '../../simulation/buses';
import type { BusHandle } from '../../simulation/buses/types';
import { i2cTargetOf } from '../../simulation/parts/i2cPart';

const here = (rel: string) => fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));
const UNO_HEX = readFileSync(here('conf-i2c-console/uno/conf-i2c-console.ino.hex'), 'utf-8');
const PICO_BIN = readFileSync(here('conf-i2c-console/pico/conf-i2c-console.ino.bin')).toString('base64');

const hex2 = (b: number) => b.toString(16).padStart(2, '0');

interface Exchange {
  status: number;
  read: number[];
}

/** Wire's status and bytes from the guest's '=<status> <hh> ..' answer. */
function parse(answer: string): Exchange {
  const words = answer.split(/\s+/).filter(Boolean);
  return { status: parseInt(words[0], 10), read: words.slice(1).map((h) => parseInt(h, 16)) };
}

/** The Uno's guest, stepped instruction by instruction (the store's frame clock never fires here). */
class UnoConsole {
  out = '';
  readonly id: string;
  private booted = false;
  constructor(id: string) {
    this.id = id;
    const st = useSimulatorStore.getState();
    this.sim.onSerialData = (ch: string) => {
      this.out += ch;
    };
    st.compileBoardProgram(id, UNO_HEX);
    st.startBoard(id);
  }
  get sim(): AVRSimulator {
    return getBoardSimulator(this.id) as unknown as AVRSimulator;
  }
  exchange(address: number, write: number[], read: number): Exchange {
    if (!this.booted) {
      this.stepUntil(() => /READY\r?\n/.test(this.out), 3_000_000, 'the Uno never printed READY');
      this.booted = true;
    }
    const mark = this.out.length;
    this.sim.serialWrite(`x 0 ${hex2(address)} ${read} ${write.map(hex2).join(' ')}\n`);
    let answer = '';
    this.stepUntil(
      () => {
        const m = /=([^\r\n]*)\r?\n/.exec(this.out.slice(mark));
        if (m) answer = m[1].trim();
        return m !== null;
      },
      8_000_000,
      'the Uno did not answer',
    );
    return parse(answer);
  }
  private stepUntil(done: () => boolean, budget: number, what: string): void {
    for (let i = 0; i < budget; i++) {
      this.sim.step();
      if ((i & 0xff) === 0 && done()) return;
    }
    if (!done()) throw new Error(`${what}; serial: ${JSON.stringify(this.out.slice(-160))}`);
  }
}

/** The Pico's guest, run in 1 ms frames of the production frame body. */
class PicoConsole {
  out = '';
  readonly id: string;
  private booted = false;
  constructor(id: string) {
    this.id = id;
    this.sim.onSerialData = (ch: string) => {
      this.out += ch;
    };
    useSimulatorStore.getState().compileBoardProgram(id, PICO_BIN);
  }
  get sim(): RP2040Simulator {
    return getBoardSimulator(this.id) as unknown as RP2040Simulator;
  }
  exchange(address: number, write: number[], read: number): Exchange {
    if (!this.booted) {
      this.waitFor('READY', 0, 3000);
      this.booted = true;
    }
    const mark = this.out.length;
    const text = `x 0 ${hex2(address)} ${read} ${write.map(hex2).join(' ')}\n`;
    // The PL011 RX FIFO is 32 deep: hand the line over in slices.
    for (let i = 0; i < text.length; i += 16) {
      this.sim.serialWrite(text.slice(i, i + 16));
      this.sim.runFrameForTime(1);
    }
    for (let t = 0; t < 800; t++) {
      const m = /=([^\r\n]*)\r?\n/.exec(this.out.slice(mark));
      if (m) return parse(m[1].trim());
      this.sim.runFrameForTime(1);
    }
    throw new Error(`the Pico did not answer; got ${JSON.stringify(this.out.slice(mark))}`);
  }
  private waitFor(text: string, from: number, maxMs: number): void {
    for (let t = 0; t < maxMs && this.out.indexOf(text, from) < 0; t++) this.sim.runFrameForTime(1);
    if (this.out.indexOf(text, from) < 0) {
      throw new Error(`the Pico never printed ${text}; got ${JSON.stringify(this.out.slice(from))}`);
    }
  }
}

let seq = 0;
const live: Array<() => void> = [];
afterEach(() => {
  for (const f of live.splice(0)) f();
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

/** Both boards, the part on the Pico, the two headers wired together. */
function bench() {
  const st = useSimulatorStore.getState();
  const uno = `uno-xb${++seq}`;
  const pico = `pico-xb${seq}`;
  st.addBoard('arduino-uno', 0, 0, uno);
  st.addBoard('raspberry-pi-pico', 0, 300, pico);
  const part = `bme-xb${seq}`;
  const wire = (id: string, a: [string, string], b: [string, string]) =>
    useSimulatorStore.getState().addWire({
      id,
      start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
      end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
      waypoints: [],
      color: '#0a0',
    } as never);
  wire(`${part}-sda`, [part, 'SDA'], [pico, 'GP4']);
  wire(`${part}-scl`, [part, 'SCL'], [pico, 'GP5']);
  wire(`${part}-x-sda`, [uno, '18'], [pico, 'GP4']);
  wire(`${part}-x-scl`, [uno, '19'], [pico, 'GP5']);
  const chip = new VirtualBMP280(0x76);
  const handle: BusHandle = attachI2cTarget(
    { owner: part, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x76] },
    i2cTargetOf(chip),
  );
  live.push(() => {
    handle.dispose();
    const s = useSimulatorStore.getState();
    s.removeBoard(uno);
    s.removeBoard(pico);
  });
  const placements = () =>
    busRegistry
      .i2cPlacements(part)
      .map((p) => `${p.boardId === uno ? 'uno' : p.boardId === pico ? 'pico' : p.boardId}:${p.sdaPin}/${p.sclPin}:${p.clocked}`)
      .sort();
  // The store recomputes the fabric's membership a microtask after a wire
  // changes (one recompute per drag, not per pixel), so the case waits for it
  // the way the app does.
  const unwire = async (id: string): Promise<void> => {
    useSimulatorStore.getState().removeWire(id);
    await new Promise<void>((r) => queueMicrotask(r));
  };
  return { uno, pico, part, chip, handle, placements, unwire };
}

describe('I2C between boards through the fabric: a part on the Pico, the Uno wired to the same header', () => {
  it('the target is on both boards\' buses, from the store\'s own wires', () => {
    const b = bench();
    expect(b.placements()).toEqual(['pico:4/5:true', 'uno:18/19:true']);
    expect(busRegistry.unplacedI2cOwners(b.uno)).toEqual([]);
    expect(busRegistry.unplacedI2cOwners(b.pico)).toEqual([]);
  });

  it('the Uno\'s firmware reads the BMP280 that sits on the Pico\'s header', () => {
    const b = bench();
    const uno = new UnoConsole(b.uno);
    // chip_id at 0xD0: 0x58 is a BMP280.
    expect(uno.exchange(0x76, [0xd0], 1)).toEqual({ status: 0, read: [0x58] });
    b.chip.temperatureC = 31;
    expect(uno.exchange(0x76, [0xfa], 3).status, 'the same chip, live').toBe(0);
    expect(uno.exchange(0x77, [0xd0], 1).status, 'the other strap is nobody').toBe(2);
  });

  it('the Pico\'s firmware reads it too: one chip, two masters', () => {
    const b = bench();
    const pico = new PicoConsole(b.pico);
    expect(pico.exchange(0x76, [0xd0], 1)).toEqual({ status: 0, read: [0x58] });
    const uno = new UnoConsole(b.uno);
    expect(uno.exchange(0x76, [0xd0], 1)).toEqual({ status: 0, read: [0x58] });
    expect(pico.exchange(0x76, [0xd0], 1)).toEqual({ status: 0, read: [0x58] });
  });

  it('lifting the SCL wire between the headers takes the chip off the Uno\'s bus and leaves it on the Pico\'s', async () => {
    const b = bench();
    const uno = new UnoConsole(b.uno);
    expect(uno.exchange(0x76, [0xd0], 1).status).toBe(0);
    await b.unwire(`${b.part}-x-scl`);
    expect(b.placements()).toEqual(['pico:4/5:true']);
    expect(busRegistry.unplacedI2cOwners(b.uno)).toEqual([b.part]);
    expect(uno.exchange(0x76, [0xd0], 1).status, 'half a bus is no bus').toBe(2);
    const pico = new PicoConsole(b.pico);
    expect(pico.exchange(0x76, [0xd0], 1)).toEqual({ status: 0, read: [0x58] });
  });

  it('deleting the part takes it off both boards', () => {
    const b = bench();
    const uno = new UnoConsole(b.uno);
    const pico = new PicoConsole(b.pico);
    expect(uno.exchange(0x76, [0xd0], 1).status).toBe(0);
    expect(pico.exchange(0x76, [0xd0], 1).status).toBe(0);
    b.handle.dispose();
    expect(b.placements()).toEqual([]);
    expect(uno.exchange(0x76, [0xd0], 1).status).toBe(2);
    expect(pico.exchange(0x76, [0xd0], 1).status).toBe(2);
  });
});
