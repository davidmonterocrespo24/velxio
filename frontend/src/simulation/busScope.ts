/**
 * Hardware I2C and SPI drawn on the oscilloscope (velxio/velxio-prod#160).
 *
 * avr8js and rp2040js simulate their TWI / I2C and SPI controllers a byte at a
 * time: a transfer is a register event, and no pin moves. Wire and SPI then
 * showed a flat line on SDA, SCL, SCK, MOSI and MISO while a bit-banged bus,
 * which toggles GPIOs, showed every bit. These synthesizers turn each step
 * the controller takes into the edges the pads would show, for the scope
 * ONLY: they go to the board's scope feed (`onPinChangeWithTime`), never to
 * the PinManager or the bus fabric, where a software-I2C decoder on the same
 * pads would read every byte a second time. The UART TX frames are drawn the
 * same way (AVRSimulator.emitUartTxFrame).
 *
 * Timing. A step starts at the board clock or where the previous one ended,
 * whichever is later: the synthesizer keeps its own bus-busy cursor. On the
 * ATmega the controller already spends a step's bus time before it completes
 * (velxio/velxio-prod#159), so the cursor never runs ahead. On the RP2040
 * every step completes at once and the guest can queue transfers faster than
 * the wire carries them: the cursor runs ahead of the clock, and once it is
 * more than MAX_LEAD_MS ahead, the transfers that start then are left out of
 * the picture whole (an I2C transaction from START to STOP, an SPI frame)
 * until the clock catches up. What is drawn is always a complete, correctly
 * timed transfer.
 *
 * Cost. Nothing is built or read for a pin the scope does not watch, so a
 * sketch that streams Wire or SPI pays a lookup per step (the feed's `wants`,
 * a set it keeps per channel list). When the scope watches the bus,
 * the edges are handed over in batches: at each I2C STOP, every
 * FLUSH_EDGES edges, and when the engine's frame ends (flush()), one store
 * update for many bytes instead of one per edge.
 *
 * I2C (NXP UM10204, sections 3.1.4 to 3.1.6): both lines idle HIGH; START is
 * SDA falling while SCL is HIGH, STOP is SDA rising while SCL is HIGH; data
 * changes only while SCL is LOW, MSB first; the ninth clock carries the ACK,
 * SDA LOW, or the NACK, SDA left HIGH. SPI: SCK idles at CPOL; with CPHA 0
 * the data is on the line half a period before the leading edge, with CPHA 1
 * it changes on the leading edge and is read on the trailing one.
 */

import type { I2cScopeTap } from './I2CBusManager';
import type { SpiControllerConfig } from './buses/types';

/** One edge for the scope: the pin as the board's scope numbers it. */
export interface ScopeEdge {
  pin: number;
  state: boolean;
  timeMs: number;
}

/**
 * The board's scope feed (useSimulatorStore's getOscilloscopeCallback): one
 * edge at a time, `wants` to ask whether a pin is on the scope at all, and
 * `batch` to hand many edges over in one store update. A plain callback (a
 * test, a part that listens to the same slot) gets every edge one by one.
 */
export type ScopeSink = ((pin: number, state: boolean, timeMs: number) => void) & {
  wants?: (pin: number) => boolean;
  batch?: (edges: readonly ScopeEdge[]) => void;
};

/**
 * How far ahead of the board clock the bus-busy cursor may run before the
 * transfers that start are left out of the picture. 50 ms holds a whole
 * Adafruit_SSD1306 display() at 400 kHz (1 KiB, about 25 ms on the wire),
 * which an RP2040 queues in about a millisecond of its own time.
 */
export const MAX_LEAD_MS = 50;

/** Edges a synthesizer holds at most before it hands them to the scope. */
export const FLUSH_EDGES = 512;

/**
 * A line's level as the synthesizer last drew it, and where its edges go.
 * null: not known, because nothing was drawn on it since a reset or since a
 * step nobody looked at. The next step then draws every level it sets, so
 * the trace never keeps a level the scope did not get from here (the HIGH a
 * pull-up seeded, the LOW SPI.begin() left on MOSI).
 */
class Line {
  level: boolean | null = null;
  constructor(readonly pin: () => number | undefined) {}
}

/** The edges drawn and not yet handed over, for one sink. */
class EdgeQueue {
  private pending: ScopeEdge[] = [];
  private sink: ScopeSink | null = null;

  /** Draw `level` on `line` at `at`, for `sink`, if the scope watches the pin. */
  put(sink: ScopeSink, line: Line, pin: number, watched: boolean, at: number, level: boolean): void {
    if (!watched) {
      line.level = null;
      return;
    }
    if (line.level === level) return;
    line.level = level;
    if (this.sink !== sink) {
      this.flush();
      this.sink = sink;
    }
    this.pending.push({ pin, state: level, timeMs: at });
  }

  /** Hand over what was drawn when there is a batch's worth of it. */
  settle(): void {
    if (this.pending.length >= FLUSH_EDGES) this.flush();
  }

  /** Hand every edge drawn so far to the scope, in one batch when it can. */
  flush(): void {
    const sink = this.sink;
    const edges = this.pending;
    if (!sink || edges.length === 0) return;
    this.pending = [];
    if (sink.batch) {
      sink.batch(edges);
      return;
    }
    for (const e of edges) sink(e.pin, e.state, e.timeMs);
  }
}

/** Whether the scope watches `pin` (a plain callback watches every pin). */
const watches = (sink: ScopeSink, pin: number | undefined): boolean =>
  pin !== undefined && (!sink.wants || sink.wants(pin));

// ── I2C ─────────────────────────────────────────────────────────────────────

/** SCL's LOW and HIGH time, in ms. */
export interface I2cScopeTiming {
  lowMs: number;
  highMs: number;
}

export interface I2cScopeOptions {
  /** The board's scope feed now (the simulator's onPinChangeWithTime). */
  sink: () => ScopeSink | null;
  /** The pads SDA and SCL are routed to now (undefined: not routed). */
  sda: () => number | undefined;
  scl: () => number | undefined;
  /** The board clock, in the base its scope samples use (ms). */
  nowMs: () => number;
  /** SCL's timing now, or null when the controller has none to give. */
  timing: () => I2cScopeTiming | null;
}

type I2cDraw = (
  t: number,
  lowMs: number,
  highMs: number,
  sda: (at: number, level: boolean) => void,
  scl: (at: number, level: boolean) => void,
) => void;

/**
 * The SDA and SCL edges of a hardware I2C controller, built from the steps
 * its I2CBusManager hears (I2cScopeTap). One per controller, kept across
 * resets like the manager.
 */
export class I2cScopeSynth implements I2cScopeTap {
  private readonly opts: I2cScopeOptions;
  private readonly sdaLine: Line;
  private readonly sclLine: Line;
  private readonly queue = new EdgeQueue();
  /** Where the bus is free again, in ms on the board clock. */
  private cursorMs = 0;
  /** A START was heard and its STOP not yet. */
  private open = false;
  /** This transaction is left out of the picture (see MAX_LEAD_MS). */
  private skipping = false;
  /** Transactions left out so far, for whoever asks. */
  skippedTransactions = 0;

  constructor(opts: I2cScopeOptions) {
    this.opts = opts;
    this.sdaLine = new Line(opts.sda);
    this.sclLine = new Line(opts.scl);
  }

  /** Hand the scope every edge drawn so far (the engine's frame ended). */
  flush(): void {
    this.queue.flush();
  }

  /** The MCU was reset: the bus is idle and the cursor starts over. */
  reset(): void {
    this.queue.flush();
    this.cursorMs = 0;
    this.open = false;
    this.skipping = false;
    this.sdaLine.level = null;
    this.sclLine.level = null;
  }

  start(): void {
    const repeated = this.open;
    this.open = true;
    if (!repeated) {
      // A transaction that would start too far ahead of the clock is left
      // out whole, so what is drawn is never a fragment.
      this.skipping = this.cursorMs - this.opts.nowMs() > MAX_LEAD_MS;
      if (this.skipping) this.skippedTransactions++;
    }
    // START (or repeated START), one SCL period: SDA released, SCL HIGH, SDA
    // falls while SCL is HIGH, then SCL falls (UM10204 3.1.4, Figure 5).
    this.step(1, (t, L, H, sda, scl) => {
      sda(t + L / 4, true);
      scl(t + L / 2, true);
      sda(t + L, false);
      scl(t + L + H, false);
    });
  }

  address(address: number, read: boolean, ack: boolean): void {
    this.byte(((address & 0x7f) << 1) | (read ? 1 : 0), !ack);
  }

  write(value: number, ack: boolean): void {
    this.byte(value, !ack);
  }

  read(value: number, ack: boolean): void {
    // The target drives the eight bits, the controller the ninth.
    this.byte(value, !ack);
  }

  stop(): void {
    // STOP, one SCL period: SDA LOW while SCL is LOW, SCL HIGH, then SDA
    // rises while SCL is HIGH (UM10204 3.1.4). The bus is idle after it, and
    // the transaction goes to the scope.
    this.step(1, (t, L, H, sda, scl) => {
      scl(t, false);
      sda(t + L / 2, false);
      scl(t + L, true);
      sda(t + L + H / 2, true);
    });
    this.open = false;
    this.skipping = false;
    this.queue.flush();
  }

  /** Eight bits MSB first and the ninth (SDA HIGH for a NACK), nine SCL periods. */
  private byte(value: number, nack: boolean): void {
    this.step(9, (t, L, H, sda, scl) => {
      const T = L + H;
      for (let i = 0; i < 9; i++) {
        const ti = t + i * T;
        scl(ti, false);
        // Data changes in the middle of SCL's LOW time (UM10204 3.1.3).
        sda(ti + L / 2, i < 8 ? ((value >> (7 - i)) & 1) !== 0 : nack);
        scl(ti + L, true);
      }
      const end = t + 9 * T;
      scl(end, false);
      // Whoever drove the ninth bit lets SDA go after SCL falls.
      sda(end + L / 8, true);
    });
  }

  /**
   * One step of `periods` SCL periods, from the bus-busy cursor: `draw` puts
   * its edges (SDA and SCL, at times from `t`), and the ones that move a
   * watched line are queued for the scope.
   */
  private step(periods: number, draw: I2cDraw): void {
    if (this.skipping) return;
    const sink = this.opts.sink();
    if (!sink) return;
    const sdaPin = this.sdaLine.pin();
    const sclPin = this.sclLine.pin();
    if (sdaPin === undefined || sclPin === undefined) return;
    const wantSda = watches(sink, sdaPin);
    const wantScl = watches(sink, sclPin);
    // Nobody looks: nothing is built (that is all a step costs then), and
    // the levels are not known any more to whoever looks next. The cursor
    // waits too: a step that starts when someone looks again starts at the
    // clock.
    if (!wantSda && !wantScl) {
      this.sdaLine.level = null;
      this.sclLine.level = null;
      return;
    }
    const timing = this.opts.timing();
    if (!timing || !(timing.lowMs > 0) || !(timing.highMs > 0)) return;
    const now = this.opts.nowMs();
    const t0 = Math.max(now, this.cursorMs);
    this.cursorMs = t0 + periods * (timing.lowMs + timing.highMs);
    const q = this.queue;
    draw(
      t0,
      timing.lowMs,
      timing.highMs,
      (at, level) => q.put(sink, this.sdaLine, sdaPin, wantSda, at, level),
      (at, level) => q.put(sink, this.sclLine, sclPin, wantScl, at, level),
    );
    q.settle();
  }
}

// ── SPI ─────────────────────────────────────────────────────────────────────

export interface SpiScopeOptions {
  sink: () => ScopeSink | null;
  /** The pads SCK, MOSI and MISO are routed to now. */
  sck: () => number | undefined;
  mosi: () => number | undefined;
  miso: () => number | undefined;
  nowMs: () => number;
  /** The controller's mode, bit order and clock now (SpiControllerPort.config). */
  config: () => SpiControllerConfig;
}

/** The SCK, MOSI and MISO edges of a hardware SPI controller, one frame at a time. */
export class SpiScopeSynth {
  private readonly opts: SpiScopeOptions;
  private readonly sckLine: Line;
  private readonly mosiLine: Line;
  private readonly misoLine: Line;
  private readonly queue = new EdgeQueue();
  private cursorMs = 0;
  /** Frames left out so far (see MAX_LEAD_MS), for whoever asks. */
  skippedFrames = 0;

  constructor(opts: SpiScopeOptions) {
    this.opts = opts;
    this.sckLine = new Line(opts.sck);
    this.mosiLine = new Line(opts.mosi);
    this.misoLine = new Line(opts.miso);
  }

  /** Hand the scope every edge drawn so far (the engine's frame ended). */
  flush(): void {
    this.queue.flush();
  }

  /** The MCU was reset: the cursor starts over. */
  reset(): void {
    this.queue.flush();
    this.cursorMs = 0;
    this.sckLine.level = null;
    this.mosiLine.level = null;
    this.misoLine.level = null;
  }

  /**
   * One frame of `bits` bits: what the controller shifted out on MOSI and
   * what came back on MISO, as `bits` SCK periods at the controller's clock.
   */
  frame(mosi: number, miso: number, bits: number): void {
    const sink = this.opts.sink();
    if (!sink) return;
    const sckPin = this.sckLine.pin();
    if (sckPin === undefined) return;
    const mosiPin = this.mosiLine.pin();
    const misoPin = this.misoLine.pin();
    const wantSck = watches(sink, sckPin);
    const wantMosi = watches(sink, mosiPin);
    const wantMiso = watches(sink, misoPin);
    // Nobody looks: nothing is built, and nothing else is read.
    if (!wantSck && !wantMosi && !wantMiso) {
      this.sckLine.level = null;
      this.mosiLine.level = null;
      this.misoLine.level = null;
      return;
    }
    const cfg = this.opts.config();
    if (!cfg.enabled || !cfg.hz || !(cfg.hz > 0)) return;
    const now = this.opts.nowMs();
    if (this.cursorMs - now > MAX_LEAD_MS) {
      this.skippedFrames++;
      return;
    }
    const P = 1000 / cfg.hz;
    const n = bits > 0 ? bits : (cfg.bits ?? 8);
    const mode = cfg.mode ?? 0;
    const cpol = (mode & 2) !== 0;
    const cpha = (mode & 1) !== 0;
    let t0 = Math.max(now, this.cursorMs);
    // SCK settles at its idle level (CPOL) half a period before the first
    // clock when it is not there already: a new mode, or the first frame.
    const settle = this.sckLine.level !== cpol;
    this.cursorMs = t0 + (settle ? P / 2 : 0) + n * P;

    const lsb = cfg.bitOrder === 'lsb';
    const q = this.queue;
    const sck = (at: number, level: boolean) => q.put(sink, this.sckLine, sckPin, wantSck, at, level);
    const mo = (at: number, level: boolean) =>
      q.put(sink, this.mosiLine, mosiPin ?? -1, wantMosi, at, level);
    const mi = (at: number, level: boolean) =>
      q.put(sink, this.misoLine, misoPin ?? -1, wantMiso, at, level);
    if (settle) {
      sck(t0, cpol);
      t0 += P / 2;
    }
    for (let i = 0; i < n; i++) {
      const shift = lsb ? i : n - 1 - i;
      const outBit = ((mosi >> shift) & 1) !== 0;
      const inBit = ((miso >> shift) & 1) !== 0;
      const ti = t0 + i * P;
      if (!cpha) {
        // Data first, the leading edge half a period later, the trailing
        // edge at the end of the period.
        mo(ti, outBit);
        mi(ti, inBit);
        sck(ti + P / 2, !cpol);
        sck(ti + P, cpol);
      } else {
        // The leading edge puts the data on, the trailing edge reads it.
        sck(ti, !cpol);
        mo(ti, outBit);
        mi(ti, inBit);
        sck(ti + P / 2, cpol);
      }
    }
    q.settle();
  }
}
