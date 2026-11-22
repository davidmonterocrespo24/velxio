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
 * until the clock catches up. What is drawn is a complete, correctly timed
 * transfer, unless a pad cuts it short (below).
 *
 * Order. The scope stores each line's samples in the order it gets them, and
 * the pads' own edges (the GPIO path, the levels the circuit puts on a pad)
 * reach it at the board clock as they happen. So a drawn edge is handed over
 * only once the clock has reached it (release(), when the engine's frame
 * ends), never ahead of it but at a stop; and before a pad's own edge reaches
 * the scope, the engine tells the synthesizer that drew on that pad
 * (padEdge()), which hands over what it drew up to that moment and takes
 * back what it drew after. That happens on the RP2040 when arduino-pico
 * bit-bangs an address probe (a zero-length write, which its controller
 * cannot send) on the I2C pads while the transfer before is still being
 * drawn: that transfer is drawn cut short where the probe starts, and the
 * probe follows in order (velxio/velxio-prod#160).
 *
 * Cost. Nothing is built or read for a pin the scope does not watch, so a
 * sketch that streams Wire or SPI pays a lookup per step (the feed's `wants`,
 * a set it keeps per channel list). When the scope watches the bus, each
 * edge is one sample object, appended as it will be stored, and they are
 * handed over a run per pin in one store update: when the engine's frame
 * ends, so once a frame for a bus that is not saturated, and in between each
 * time FLUSH_EDGES more were drawn.
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

/** One sample of a line, as the scope stores a digital one (OscSample). */
export interface ScopeSample {
  timeMs: number;
  state: boolean;
}

/** The samples drawn for one pin, in time order. */
export interface ScopeRun {
  pin: number;
  samples: ScopeSample[];
}

/**
 * The board's scope feed (useSimulatorStore's getOscilloscopeCallback): one
 * edge at a time, `wants` to ask whether a pin is on the scope at all, and
 * `runs` to hand many samples over in one store update, a run per pin. A
 * callback with `wants` and no `runs` gets every edge it wants one by one, in
 * time order. A callback without `wants` gets none: it is a part that listens
 * to the same slot for edges of its own (the RP2040 servo, ComplexParts.ts),
 * and drawing every Wire and SPI transfer for it cost a sketch that streams
 * I2C about 30 % more CPU with the scope closed.
 */
export type ScopeSink = ((pin: number, state: boolean, timeMs: number) => void) & {
  wants?: (pin: number) => boolean;
  runs?: (runs: readonly ScopeRun[]) => void;
};

/**
 * How far ahead of the board clock the bus-busy cursor may run before the
 * transfers that start are left out of the picture. 50 ms holds a whole
 * Adafruit_SSD1306 display() at 400 kHz (1 KiB, about 25 ms on the wire),
 * which an RP2040 queues in about a millisecond of its own time.
 */
export const MAX_LEAD_MS = 50;

/**
 * Samples a synthesizer draws, within a frame, before it hands the scope
 * those the clock has reached. The ones still ahead of the clock wait on (at
 * most MAX_LEAD_MS of drawing and the transfer that crosses it).
 */
export const FLUSH_EDGES = 4096;

/**
 * A line's level as the synthesizer last drew it, and the samples drawn on
 * it. `level` null: not known, because nothing was drawn on it since a reset
 * or since a step nobody looked at, or the pad moved by itself since. The next
 * step then draws every level it sets, so the trace never keeps a level the
 * scope did not get from here (the HIGH a pull-up seeded, the LOW SPI.begin()
 * left on MOSI).
 */
class Line {
  level: boolean | null = null;
  /** The samples drawn, oldest first; the scope has those before `head`. */
  pending: ScopeSample[] = [];
  head = 0;
  /** The pin `pending` was drawn for. */
  pendingPin = -1;
  /** The level of the last sample the scope was handed on this line. */
  handedLevel: boolean | null = null;
  /** The pad the line is routed to now. */
  readonly pin: () => number | undefined;
  constructor(pin: () => number | undefined) {
    this.pin = pin;
  }
}

/** The lines of one synthesizer, and the scope their samples go to. */
class Drawing {
  private sink: ScopeSink | null = null;
  /** Samples drawn that the scope has not been handed yet, on every line. */
  private count = 0;
  /** Samples drawn since settle() last handed some over. */
  private drawnSinceSettle = 0;
  private readonly lines: Line[];

  constructor(lines: Line[]) {
    this.lines = lines;
  }

  /** Draw `level` on `line` at `at`, for `sink`, if the scope watches the pin. */
  put(sink: ScopeSink, line: Line, pin: number, watched: boolean, at: number, level: boolean): void {
    if (!watched) {
      line.level = null;
      return;
    }
    if (line.level === level) return;
    line.level = level;
    if (this.sink !== sink || (line.pending.length > line.head && line.pendingPin !== pin)) this.flush();
    this.sink = sink;
    line.pendingPin = pin;
    line.pending.push({ timeMs: at, state: level });
    this.count++;
    this.drawnSinceSettle++;
  }

  /** Put `line` back to `level` at `at` where the drawing left it at the other level. */
  restore(line: Line, at: number, level: boolean): void {
    if (this.sink && line.pendingPin >= 0 && line.level === !level) {
      this.put(this.sink, line, line.pendingPin, true, at, level);
    }
  }

  /**
   * Hand over what the clock (`nowMs`) has reached each time a batch's worth
   * more was drawn: counted from the last time, not from what waits, which a
   * drawing ahead of the clock keeps above a batch for a whole frame (one
   * store update per byte cost a Pico streaming SSD1306 frames 1.35 times
   * the CPU with the scope on SDA and SCL).
   */
  settle(nowMs: number): void {
    if (this.drawnSinceSettle < FLUSH_EDGES) return;
    this.drawnSinceSettle = 0;
    this.flush(nowMs);
  }

  /**
   * Hand the scope the samples drawn up to `uptoMs`, all of them by default: a
   * run per pin, in one update. The rest wait for a later call.
   */
  flush(uptoMs = Infinity): void {
    const sink = this.sink;
    if (!sink || this.count === 0) return;
    let runs: ScopeRun[] | null = null;
    for (const line of this.lines) {
      const p = line.pending;
      const from = line.head;
      let to = from;
      while (to < p.length && p[to]!.timeMs <= uptoMs) to++;
      if (to === from) continue;
      (runs ??= []).push({
        pin: line.pendingPin,
        samples: from === 0 && to === p.length ? p : p.slice(from, to),
      });
      line.handedLevel = p[to - 1]!.state;
      this.count -= to - from;
      if (to === p.length) {
        line.pending = [];
        line.head = 0;
      } else if (2 * to > p.length) {
        // What waits moves down once most of the array is handed over: a
        // copy of fewer samples than were just handed.
        line.pending = p.slice(to);
        line.head = 0;
      } else {
        line.head = to;
      }
    }
    if (!runs) return;
    if (sink.runs) {
      sink.runs(runs);
      return;
    }
    // One edge at a time, in time order across the lines. The sort is
    // stable: samples at one instant come line by line in the order the
    // lines were made (SCK before MOSI, which is the order a CPHA 1 frame
    // draws them in; I2C draws no two lines at one instant).
    const edges = runs.flatMap((r) => r.samples.map((x) => ({ pin: r.pin, ...x })));
    edges.sort((a, b) => a.timeMs - b.timeMs);
    for (const e of edges) sink(e.pin, e.state, e.timeMs);
  }

  /**
   * Take back every sample drawn after `t`. The scope was never handed one
   * (flush hands nothing later than the clock but at a stop), so nothing it
   * shows is taken back. Returns whether there was any.
   */
  dropAfter(t: number): boolean {
    let dropped = false;
    for (const line of this.lines) {
      const p = line.pending;
      let k = p.length;
      while (k > line.head && p[k - 1]!.timeMs > t) k--;
      if (k === p.length) continue;
      this.count -= p.length - k;
      p.length = k;
      dropped = true;
      // What the trace shows from `t` on: the last sample it keeps.
      line.level = k > 0 ? p[k - 1]!.state : line.handedLevel;
    }
    return dropped;
  }
}

/** Whether the scope watches `pin` (a callback without `wants` watches none). */
const watches = (sink: ScopeSink, pin: number | undefined): boolean =>
  pin !== undefined && sink.wants !== undefined && sink.wants(pin);

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
  private readonly drawing: Drawing;
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
    this.drawing = new Drawing([this.sdaLine, this.sclLine]);
  }

  /** Hand the scope the edges the board clock has reached (the engine's frame ended). */
  release(): void {
    this.drawing.flush(this.opts.nowMs());
  }

  /** Hand the scope every edge drawn so far, reached or not (the run stopped). */
  flush(): void {
    this.drawing.flush();
  }

  /**
   * The pad `pin` moved by itself at `t` (the sketch drove it through the
   * GPIO path, or the circuit put a level on it), and the scope gets that edge
   * next. If this synthesizer draws on that pad, the drawing gives way, so the
   * scope keeps both lines in time order: what was drawn up to `t` is handed
   * over, what was drawn after `t` is taken back (the clock had not reached
   * it, so the scope never had it), and the other line goes back to the idle
   * HIGH its pull-up holds a pad at that nothing drives. arduino-pico
   * bit-bangs its address probes on these pads while the drawing of the
   * transfer before is still ahead of the clock; that transfer is then drawn
   * cut short where the probe starts.
   */
  padEdge(pin: number, t: number): void {
    const onSda = pin === this.sdaLine.pendingPin;
    if (!onSda && pin !== this.sclLine.pendingPin) return;
    const d = this.drawing;
    if (d.dropAfter(t)) {
      if (this.cursorMs > t) this.cursorMs = t;
      // Nor is the rest of a transaction cut short drawn.
      if (this.open) this.skipping = true;
      d.restore(onSda ? this.sclLine : this.sdaLine, t, true);
    }
    d.flush(t);
    (onSda ? this.sdaLine : this.sclLine).level = null;
  }

  /** The MCU was reset: the bus is idle and the cursor starts over. */
  reset(): void {
    this.drawing.flush();
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
    // rises while SCL is HIGH (UM10204 3.1.4). The bus is idle after it.
    this.step(1, (t, L, H, sda, scl) => {
      scl(t, false);
      sda(t + L / 2, false);
      scl(t + L, true);
      sda(t + L + H / 2, true);
    });
    this.open = false;
    this.skipping = false;
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
    const d = this.drawing;
    draw(
      t0,
      timing.lowMs,
      timing.highMs,
      (at, level) => d.put(sink, this.sdaLine, sdaPin, wantSda, at, level),
      (at, level) => d.put(sink, this.sclLine, sclPin, wantScl, at, level),
    );
    d.settle(now);
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
  private readonly drawing: Drawing;
  private cursorMs = 0;
  /** Frames left out so far (see MAX_LEAD_MS), for whoever asks. */
  skippedFrames = 0;

  constructor(opts: SpiScopeOptions) {
    this.opts = opts;
    this.sckLine = new Line(opts.sck);
    this.mosiLine = new Line(opts.mosi);
    this.misoLine = new Line(opts.miso);
    this.drawing = new Drawing([this.sckLine, this.mosiLine, this.misoLine]);
  }

  /** Hand the scope the edges the board clock has reached (the engine's frame ended). */
  release(): void {
    this.drawing.flush(this.opts.nowMs());
  }

  /** Hand the scope every edge drawn so far, reached or not (the run stopped). */
  flush(): void {
    this.drawing.flush();
  }

  /**
   * The pad `pin` moved by itself at `t`: as I2cScopeSynth.padEdge, the
   * drawing on it hands over what it drew up to `t` and takes back the rest.
   * The other lines keep the level the drawing left them at: nothing says
   * where an SPI pad rests that no frame drives.
   */
  padEdge(pin: number, t: number): void {
    const line =
      pin === this.sckLine.pendingPin
        ? this.sckLine
        : pin === this.mosiLine.pendingPin
          ? this.mosiLine
          : pin === this.misoLine.pendingPin
            ? this.misoLine
            : null;
    if (!line) return;
    const d = this.drawing;
    if (d.dropAfter(t) && this.cursorMs > t) this.cursorMs = t;
    d.flush(t);
    line.level = null;
  }

  /** The MCU was reset: the cursor starts over. */
  reset(): void {
    this.drawing.flush();
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
    const d = this.drawing;
    const sck = (at: number, level: boolean) => d.put(sink, this.sckLine, sckPin, wantSck, at, level);
    const mo = (at: number, level: boolean) =>
      d.put(sink, this.mosiLine, mosiPin ?? -1, wantMosi, at, level);
    const mi = (at: number, level: boolean) =>
      d.put(sink, this.misoLine, misoPin ?? -1, wantMiso, at, level);
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
    d.settle(now);
  }
}
