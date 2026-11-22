/**
 * Hardware I2C and SPI on the oscilloscope (velxio/velxio-prod#160).
 *
 * avr8js and rp2040js simulate their TWI / I2C and SPI controllers a byte at a
 * time and move no pin, so a scope on SDA and SCL (A4/A5, GP4/GP5) or on SCK,
 * MOSI and MISO showed a flat line through every Wire and SPI transfer, while
 * a bit-banged bus showed every bit. The synthesizers (simulation/busScope.ts)
 * now draw each step on those pads, for the scope only.
 *
 * The firmware is real: avr-i2c-spi-bus-time on an Uno (a BMP280 chip-id read
 * at 0x76 with a repeated START, then 64 SPI bytes 0..63 at 4 MHz and at
 * 125 kHz) and rp2040-i2c-spi-scope on a Pico (the same read, four SPI bytes
 * in mode 0 at 1 MHz and one in mode 3 at 500 kHz). The edges the scope
 * receives are decoded here by the rules of NXP UM10204: START and STOP are
 * SDA edges while SCL is HIGH, data is read on SCL's rising edge, the ninth
 * clock is the ACK. SPI is read on the edge its mode samples.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { RP2040Simulator } from '../simulation/RP2040Simulator';
import { PinManager } from '../simulation/PinManager';

vi.stubGlobal('requestAnimationFrame', () => 1);
vi.stubGlobal('cancelAnimationFrame', () => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

const fixture = (name: string, ext: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}/${name}.ino.${ext}`, import.meta.url)));

interface Edge {
  pin: number;
  state: boolean;
  timeMs: number;
}

/**
 * The board's scope feed as the store builds it: one edge at a time, `wants`
 * for the pins on the scope, `runs` for many at once (a run per pin). Records
 * what arrives as one edge list, a batch's runs merged in time order.
 */
function scopeFeed(pins: number[]) {
  const edges: Edge[] = [];
  const watched = new Set(pins);
  const feed = Object.assign(
    (pin: number, state: boolean, timeMs: number) => {
      if (watched.has(pin)) edges.push({ pin, state, timeMs });
    },
    {
      wants: (pin: number) => watched.has(pin),
      runs: (runs: ReadonlyArray<{ pin: number; samples: ReadonlyArray<{ timeMs: number; state: boolean }> }>) => {
        const batch = runs
          .filter((r) => watched.has(r.pin))
          .flatMap((r) => r.samples.map((x) => ({ pin: r.pin, state: x.state, timeMs: x.timeMs })));
        // Stable: samples at one instant keep the order they were drawn in.
        batch.sort((a, b) => a.timeMs - b.timeMs);
        edges.push(...batch);
      },
    },
  );
  return { feed, edges };
}

/** The edges of one pin, with the times they arrived at. */
const on = (edges: Edge[], pin: number) => edges.filter((e) => e.pin === pin);

/**
 * How many of a pin's samples arrived after one later than them: the scope
 * stores a channel's samples in the order they arrive, and draws each such
 * sample as a stroke backwards.
 */
function late(edges: Edge[]): number {
  let latest = -Infinity;
  let n = 0;
  for (const e of edges) {
    if (e.timeMs < latest) n++;
    else latest = e.timeMs;
  }
  return n;
}

type I2cEvent =
  | { kind: 'S' | 'Sr' | 'P'; t: number }
  | { kind: 'byte'; value: number; ack: boolean; t: number };

/**
 * Decode SDA and SCL as a probe on the wire would (UM10204 3.1.4 to 3.1.6):
 * both idle HIGH; SDA falling while SCL is HIGH is a START (a repeated START
 * inside a transaction), rising is a STOP; otherwise SDA only changes while
 * SCL is LOW, and every SCL rising edge reads one bit, nine to a byte.
 */
function decodeI2c(edges: Edge[], sda: number, scl: number) {
  const events: I2cEvent[] = [];
  const sclRises: number[] = [];
  const problems: string[] = [];
  let sdaLevel = true;
  let sclLevel = true;
  let open = false;
  let bits: boolean[] = [];
  let lastT = -Infinity;
  for (const e of edges) {
    if (e.pin !== sda && e.pin !== scl) continue;
    if (e.timeMs < lastT) problems.push(`edge at ${e.timeMs} before ${lastT}`);
    lastT = e.timeMs;
    if (e.pin === sda) {
      if (e.state === sdaLevel) continue;
      sdaLevel = e.state;
      if (sclLevel) {
        // The clock a repeated START or a STOP raises SCL with reads as one
        // bit; a condition any later inside a byte breaks the protocol.
        if (bits.length > 1) problems.push(`SDA moved with SCL HIGH after ${bits.length} bits`);
        if (!sdaLevel) {
          events.push({ kind: open ? 'Sr' : 'S', t: e.timeMs });
          open = true;
        } else {
          events.push({ kind: 'P', t: e.timeMs });
          open = false;
        }
        bits = [];
      }
    } else {
      if (e.state === sclLevel) continue;
      sclLevel = e.state;
      if (!sclLevel || !open) continue;
      sclRises.push(e.timeMs);
      bits.push(sdaLevel);
      if (bits.length === 9) {
        let value = 0;
        for (let i = 0; i < 8; i++) value = (value << 1) | (bits[i] ? 1 : 0);
        events.push({ kind: 'byte', value, ack: !bits[8], t: e.timeMs });
        bits = [];
      }
    }
  }
  return { events, sclRises, problems };
}

/** A transaction written as text: "S EC+ D0+ Sr ED+ 58- P" (+ ACK, - NACK). */
function asText(events: I2cEvent[]): string {
  return events
    .map((e) =>
      e.kind === 'byte'
        ? `${e.value.toString(16).toUpperCase().padStart(2, '0')}${e.ack ? '+' : '-'}`
        : e.kind,
    )
    .join(' ');
}

/**
 * Decode SPI frames: the data is read on the sampling edge, the leading one
 * (away from CPOL) with CPHA 0, the trailing one with CPHA 1, MSB first.
 * A frame is `bits` sampling edges; `periods` are the times between leading
 * edges inside a frame.
 */
function decodeSpi(
  edges: Edge[],
  pins: { sck: number; mosi: number; miso: number },
  mode: 0 | 1 | 2 | 3,
  bits = 8,
  /** MOSI and MISO before the first edge given (they hold between frames). */
  start: { mosi: boolean; miso: boolean } = { mosi: false, miso: false },
) {
  const cpol = (mode & 2) !== 0;
  const cpha = (mode & 1) !== 0;
  let sck = cpol;
  let mosi = start.mosi;
  let miso = start.miso;
  const out: Array<{ mosi: number; miso: number; t: number }> = [];
  const periods: number[] = [];
  let lastLeading: number | null = null;
  let n = 0;
  let vo = 0;
  let vi = 0;
  for (const e of edges) {
    if (e.pin === pins.mosi) mosi = e.state;
    else if (e.pin === pins.miso) miso = e.state;
    else if (e.pin === pins.sck) {
      if (e.state === sck) continue;
      sck = e.state;
      const leading = sck !== cpol;
      if (leading) {
        if (lastLeading !== null && n > 0) periods.push(e.timeMs - lastLeading);
        lastLeading = e.timeMs;
      }
      if (leading === !cpha) {
        vo = (vo << 1) | (mosi ? 1 : 0);
        vi = (vi << 1) | (miso ? 1 : 0);
        if (++n === bits) {
          out.push({ mosi: vo, miso: vi, t: e.timeMs });
          n = 0;
          vo = 0;
          vi = 0;
          lastLeading = null;
        }
      }
    }
  }
  return { frames: out, periods };
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// ── Arduino Uno ─────────────────────────────────────────────────────────────

describe('Arduino Uno: Wire and SPI on the scope', () => {
  const UNO = { sda: 18, scl: 19, sck: 13, mosi: 11, miso: 12 };
  let edges: Edge[] = [];
  let line = '';
  let pmEdges = 0;

  beforeAll(() => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm, 'uno');
    sim.loadHex(fixture('avr-i2c-spi-bus-time', 'hex').toString('utf8'));
    const scope = scopeFeed(Object.values(UNO));
    sim.onPinChangeWithTime = scope.feed;
    edges = scope.edges;
    // A BMP280 at 0x76: the register pointer write, then its chip id 0x58.
    sim.getBusBinding().i2c![0]!.setTransactionHandler({
      start: (address) => address === 0x76,
      write: () => true,
      read: () => 0x58,
      stop: () => {},
    });
    let out = '';
    sim.onSerialData = (ch) => {
      if (ch !== '\n') out += ch;
      else if (!line) line = out;
    };
    const cpu = (sim as unknown as { cpu: { cycles: number } }).cpu;
    // Through Wire.begin(), then count what the board's own pins hear.
    while (cpu.cycles < 16_000 * 20) sim.step();
    for (const pin of [UNO.sda, UNO.scl, UNO.sck, UNO.mosi]) pm.onPinChange(pin, () => pmEdges++);
    while (!line && cpu.cycles < 300 * 16_000) sim.step();
    // The frame loop hands the scope what was drawn at each frame's end;
    // stepping by hand, the test does (an engine without it drew nothing).
    sim.flushScopeEdges?.();
  });

  it('the sketch ran its round', () => {
    expect(line).toMatch(/^id=0x58 i2c_us=\d+ spi4M_64B_us=\d+ spi125k_64B_us=\d+/);
  });

  it('draws the register read: START, 0x76 write, 0xD0, repeated START, 0x76 read, 0x58 NACKed, STOP', () => {
    const { events, problems } = decodeI2c(edges, UNO.sda, UNO.scl);
    expect(problems.join('; ')).toBe('');
    expect(asText(events.slice(0, 7))).toBe('S EC+ D0+ Sr ED+ 58- P');
  });

  it('clocks SCL at Wire\'s 100 kHz, and the transaction lasts the bus time the sketch measured', () => {
    const { events, sclRises } = decodeI2c(edges, UNO.sda, UNO.scl);
    // Inside a byte, one rising edge every 10 us.
    const inByte = sclRises.slice(1, 9).map((t, i) => t - sclRises[i]!);
    for (const d of inByte) expect(close(d, 0.01)).toBe(true);
    // START to STOP: four packets of nine clocks and three conditions at
    // least, and no more than the time the sketch measured around it.
    const span = (events[6]!.t - events[0]!.t) * 1000;
    const measured = Number(/i2c_us=(\d+)/.exec(line)![1]);
    expect(span).toBeGreaterThan(4 * 9 * 10);
    expect(span).toBeLessThanOrEqual(measured);
  });

  it('draws the 64 SPI bytes at 4 MHz and at 125 kHz, mode 0, MSB first', () => {
    const { frames, periods } = decodeSpi(edges, UNO, 0);
    expect(frames.length).toBeGreaterThanOrEqual(128);
    const sent = Array.from({ length: 64 }, (_, i) => i);
    expect(frames.slice(0, 64).map((f) => f.mosi)).toEqual(sent);
    expect(frames.slice(64, 128).map((f) => f.mosi)).toEqual(sent);
    // Nothing answers: MISO idles HIGH.
    expect(frames.slice(0, 128).every((f) => f.miso === 0xff)).toBe(true);
    // 4 MHz is a 0.25 us SCK period, 125 kHz an 8 us one.
    expect(periods.filter((p) => close(p, 0.00025)).length).toBeGreaterThanOrEqual(64 * 7);
    expect(periods.filter((p) => close(p, 0.008)).length).toBeGreaterThanOrEqual(64 * 7);
  });

  it('puts those edges on the scope only: the board\'s pins hear none of them', () => {
    expect(on(edges, UNO.scl).length).toBeGreaterThan(30);
    expect(on(edges, UNO.sck).length).toBeGreaterThan(1000);
    // The pins (and the bus fabric's software-I2C decoder that listens to
    // them) heard nothing of the transfers, so no byte is read twice.
    expect(pmEdges).toBe(0);
  });
});

// ── Raspberry Pi Pico ───────────────────────────────────────────────────────

describe('Raspberry Pi Pico: Wire and SPI on the scope', () => {
  const PICO = { sda: 4, scl: 5, sck: 18, mosi: 19, miso: 16 };
  let edges: Edge[] = [];
  let sim: RP2040Simulator;
  const lines: string[] = [];

  beforeAll(() => {
    sim = new RP2040Simulator(new PinManager());
    sim.loadBinary(fixture('rp2040-i2c-spi-scope', 'bin').toString('base64'));
    const scope = scopeFeed(Object.values(PICO));
    sim.onPinChangeWithTime = scope.feed;
    edges = scope.edges;
    sim.getBusBinding().i2c![0]!.setTransactionHandler({
      start: (address) => address === 0x76,
      write: () => true,
      read: () => 0x58,
      stop: () => {},
    });
    let out = '';
    sim.onSerialData = (ch) => {
      if (ch === '\n') {
        lines.push(out.replace(/\r$/, ''));
        out = '';
      } else out += ch;
    };
    for (let f = 0; f < 600 && lines.length < 2; f++) sim.runFrameForTime(16);
  });

  it('the sketch ran its rounds', () => {
    expect(lines.slice(0, 2)).toEqual(['id=0x58', 'id=0x58']);
  });

  it('draws the register read on GP4 and GP5', () => {
    const { events, problems } = decodeI2c(edges, PICO.sda, PICO.scl);
    expect(problems.join('; ')).toBe('');
    // Wire.begin() hands the pads to the controller with a glitch on SDA the
    // GPIO path reports (it reads as a START and a STOP); the transfers follow.
    const first = events.findIndex((e) => e.kind === 'byte') - 1;
    expect(asText(events.slice(first, first + 7))).toBe('S EC+ D0+ Sr ED+ 58- P');
    expect(asText(events.slice(first + 7, first + 14))).toBe('S EC+ D0+ Sr ED+ 58- P');
  });

  it('clocks SCL at the 100 kHz Wire asked for, counted for the guest\'s 200 MHz clk_sys', () => {
    // pico-sdk counts SCL in clk_sys cycles: 1200 LOW + 800 HIGH is 10 us at
    // the 200 MHz the guest set up, though the engine itself runs at 125 MHz.
    const mcu = (sim as unknown as { rp2040: { i2c: Array<{ sclLowPeriod: number; sclHighPeriod: number }> } }).rp2040;
    expect([mcu.i2c[0]!.sclLowPeriod, mcu.i2c[0]!.sclHighPeriod]).toEqual([1200, 800]);
    const { sclRises } = decodeI2c(edges, PICO.sda, PICO.scl);
    const inByte = sclRises.slice(1, 9).map((t, i) => t - sclRises[i]!);
    expect(inByte).toHaveLength(8);
    for (const d of inByte) expect(close(d, 0.01)).toBe(true);
  });

  it('draws SPI in mode 0 at 1 MHz and in mode 3 at 500 kHz on GP18, GP19 and GP16', () => {
    const spi = edges.filter((e) => e.pin === PICO.sck || e.pin === PICO.mosi || e.pin === PICO.miso);
    // The round's four mode 0 frames: SCK idles LOW, data read on its rise.
    const mode0 = decodeSpi(spi, PICO, 0);
    expect(mode0.frames.slice(0, 4).map((f) => f.mosi)).toEqual([0xa0, 0xa1, 0xa2, 0xa3]);
    expect(mode0.frames.slice(0, 4).every((f) => f.miso === 0xff)).toBe(true);
    expect(mode0.periods.slice(0, 7).every((p) => close(p, 0.001))).toBe(true);
    // Then the mode 3 frame, after the fourth one's last falling edge: SCK
    // goes to its HIGH idle level first, and the data is read on the rise.
    const end0 = mode0.frames[3]!.t + 0.0005;
    const before = spi.filter((e) => e.timeMs <= end0 + 1e-9);
    const rest = spi.slice(before.length);
    expect(rest[0]).toMatchObject({ pin: PICO.sck, state: true });
    const level = (pin: number) => before.filter((e) => e.pin === pin).at(-1)?.state ?? false;
    const mode3 = decodeSpi(rest, PICO, 3, 8, { mosi: level(PICO.mosi), miso: level(PICO.miso) });
    expect(mode3.frames[0]!.mosi).toBe(0x81);
    expect(mode3.periods.slice(0, 7).every((p) => close(p, 0.002))).toBe(true);
  });

  it('lays the steps out one after the other, though the engine completes them at once', () => {
    // Every edge of SDA and SCL arrives at or after the one before it.
    const { problems } = decodeI2c(edges, PICO.sda, PICO.scl);
    expect(problems.join('; ')).toBe('');
  });
});

// ── Raspberry Pi Pico: a probe bit-banged on the pads of a drawn transfer ──

describe('Raspberry Pi Pico: an address probe bit-banged on the pads of a drawn write', () => {
  // arduino-pico bit-bangs a zero-length write (Wire.beginTransmission(a);
  // Wire.endTransmission(), the presence check of scanners and of most
  // Adafruit begin() calls) through the SIO on SDA and SCL, which its
  // controller cannot send. Those pad edges reach the scope at the clock,
  // while the drawing of the write before it ran ahead of the clock (every
  // step completes at once on this engine) and reached the scope only at
  // the end of the frame: the trace stroked backwards (review of book-r,
  // note 1). rp2040-i2c-probe-scope writes 16 bytes to 0x3C and probes 0x3D
  // twice a round: 3 ms after the write, then right behind it.
  const SDA = 4;
  const SCL = 5;
  let edges: Edge[] = [];
  const lines: string[] = [];

  beforeAll(() => {
    const sim = new RP2040Simulator(new PinManager());
    sim.loadBinary(fixture('rp2040-i2c-probe-scope', 'bin').toString('base64'));
    const scope = scopeFeed([SDA, SCL]);
    sim.onPinChangeWithTime = scope.feed;
    edges = scope.edges;
    // A display at 0x3C takes the writes; nobody answers 0x3D.
    sim.getBusBinding().i2c![0]!.setTransactionHandler({
      start: (address) => address === 0x3c,
      write: () => true,
      read: () => 0xff,
      stop: () => {},
    });
    let out = '';
    sim.onSerialData = (ch) => {
      if (ch === '\n') {
        lines.push(out.replace(/\r$/, ''));
        out = '';
      } else out += ch;
    };
    for (let f = 0; f < 600 && lines.length < 2; f++) sim.runFrameForTime(16);
  });

  it('the sketch ran its rounds, and nobody answered the probes', () => {
    expect(lines.slice(0, 2)).toEqual(['a=2 b=2', 'a=2 b=2']);
  });

  it('SDA and SCL reach the scope in time order', () => {
    for (const pin of [SDA, SCL]) {
      expect(`GP${pin}: ${late(on(edges, pin))} samples behind one the scope already had`).toBe(
        `GP${pin}: 0 samples behind one the scope already had`,
      );
    }
  });

  it('a probe 3 ms after the write follows the whole write; one right behind it cuts the drawing short', () => {
    const { events } = decodeI2c(edges, SDA, SCL);
    const data = Array.from({ length: 16 }, (_, i) => `${(0x40 + i).toString(16).toUpperCase()}+`).join(' ');
    const write = `S 78+ ${data} P`;
    // The second write's START, then the probe's START at once: the write
    // was drawn up to the probe's first edge (SCL put back to its idle HIGH
    // there) and no further, and the probe reads as a repeated START.
    const round = `${write} S 7A- P S Sr 7A- P`;
    expect(asText(events)).toContain(`${round} ${round}`);
    const i = asText(events).split(' ').indexOf('Sr');
    expect(events[i]!.t - events[i - 1]!.t).toBeLessThan(0.1);
  });
});

// ── Arduino Uno: A4 moved by the circuit or the sketch after a drawn transfer ──

describe('Arduino Uno: A4 moved by the circuit or the sketch while a drawn transfer waits', () => {
  // The drawing of a Wire transfer reaches the scope when the frame ends; an
  // edge the pad itself makes reaches it at once. Stepped by hand, as here,
  // nothing is handed over until the end, so every edge below comes while
  // the transfer's drawing waits: it has to be handed over first.
  const SDA = 18;
  const SCL = 19;
  let edges: Edge[] = [];

  beforeAll(() => {
    const sim = new AVRSimulator(new PinManager(), 'uno');
    sim.loadHex(fixture('avr-i2c-spi-bus-time', 'hex').toString('utf8'));
    const scope = scopeFeed([SDA, SCL]);
    sim.onPinChangeWithTime = scope.feed;
    edges = scope.edges;
    sim.getBusBinding().i2c![0]!.setTransactionHandler({
      start: (address) => address === 0x76,
      write: () => true,
      read: () => 0x58,
      stop: () => {},
    });
    let line = '';
    let out = '';
    sim.onSerialData = (ch) => {
      if (ch !== '\n') out += ch;
      else if (!line) line = out;
    };
    const cpu = (sim as unknown as { cpu: { cycles: number; data: Uint8Array; writeData(a: number, v: number): void } }).cpu;
    while (!line && cpu.cycles < 300 * 16_000) sim.step();
    // A part on the bus pulls SDA low and lets it go (the circuit's door).
    sim.setPinState(SDA, false);
    sim.setPinState(SDA, true);
    // The sketch takes A4 as an output and drives it LOW (the GPIO path):
    // DDRC and PORTC, bit 4.
    cpu.writeData(0x27, cpu.data[0x27]! | 0x10);
    cpu.writeData(0x28, cpu.data[0x28]! & ~0x10);
    sim.flushScopeEdges();
  });

  it('the transfer comes first, then the pad edges, all in time order', () => {
    expect(late(on(edges, SDA))).toBe(0);
    expect(late(on(edges, SCL))).toBe(0);
    const { events } = decodeI2c(edges, SDA, SCL);
    // The register read, then the part's pulse on SDA with SCL HIGH (a
    // START and a STOP to a decoder), then the sketch's LOW.
    expect(asText(events)).toBe('S EC+ D0+ Sr ED+ 58- P S P S');
  });
});
