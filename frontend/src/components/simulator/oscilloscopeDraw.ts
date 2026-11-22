/**
 * Drawing of the oscilloscope's rows and time ruler.
 *
 * Every function here draws in CSS pixels, on a context the caller has
 * already scaled to the canvas's backing store (prepareCanvas). The size is
 * passed in rather than read from canvas.width/height: those are DEVICE
 * pixels, and drawing with them on a context scaled by devicePixelRatio drew
 * everything devicePixelRatio times too large, so at DPR 2 (a Retina screen,
 * Windows at 200 %, or browser zoom) the digital rows showed half the time
 * window and the ruler lost its labels (velxio/velxio-prod#115).
 */
import { cssVar } from '../../lib/theme';
import type { OscSample } from '../../store/useOscilloscopeStore';

/** Horizontal (time) divisions across every row. */
export const NUM_DIVS = 10;

/** A drawing area in CSS pixels. */
export interface CanvasSize {
  width: number;
  height: number;
}

/**
 * Size a canvas's backing store for the screen and return its context, scaled
 * so the drawing code works in CSS pixels; null when there is nothing to draw
 * on (no context, or an area of zero size before layout).
 */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  size: CanvasSize,
): CanvasRenderingContext2D | null {
  if (size.width <= 0 || size.height <= 0) return null;
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  // Setting the size also clears the canvas and resets its transform.
  canvas.width = Math.max(1, Math.round(size.width * dpr));
  canvas.height = Math.max(1, Math.round(size.height * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(canvas.width / size.width, 0, 0, canvas.height / size.height, 0, 0);
  return ctx;
}

/** Chrome colours for the scope's 2D canvases.
 *
 * A canvas cannot inherit a CSS custom property, so the grid, the axes and
 * the trigger cursor read their values from the token layer at draw time.
 * The channel TRACE colour is not in here on purpose — it comes from the
 * channel's own configuration and identifies the signal, so it stays put
 * across themes the way a probe's clip colour does.
 */
function scopeChrome() {
  return {
    grid: cssVar('--wb-2'),
    centre: cssVar('--wb-4'),
    zero: cssVar('--color-border-strong'),
    axisText: cssVar('--wb-10'),
    rulerLine: cssVar('--wb-7'),
    rulerText: cssVar('--wb-10'),
    trigger: cssVar('--color-feedback-warning'),
    noData: cssVar('--wb-4'),
  };
}

type Chrome = ReturnType<typeof scopeChrome>;

/**
 * The graticule every row shares: NUM_DIVS time divisions at the same x on
 * every row (and under every tick of the ruler), and, when `vDivs` is given,
 * that many volts divisions. The centre line is drawn stronger, as on a
 * bench scope.
 */
function drawGraticule(
  ctx: CanvasRenderingContext2D,
  { width, height }: CanvasSize,
  chrome: Chrome,
  vDivs: number | null,
): void {
  ctx.strokeStyle = chrome.grid;
  ctx.lineWidth = 1;
  for (let d = 0; d <= NUM_DIVS; d++) {
    const x = Math.round((d / NUM_DIVS) * width);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  if (vDivs !== null) {
    for (let k = 1; k < vDivs; k++) {
      if (2 * k === vDivs) continue; // the centre line, below
      const y = Math.round((k / vDivs) * height);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = chrome.centre;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(height / 2));
  ctx.lineTo(width, Math.round(height / 2));
  ctx.stroke();
}

/**
 * Trigger marker — a vertical orange line at this X fraction (0..1) of the
 * row, where the trigger event landed. Mirrors the orange "T" cursor on a
 * real Tektronix / Rigol. Drawn under the trace so the waveform sits on top.
 */
function drawTriggerMarker(
  ctx: CanvasRenderingContext2D,
  { width, height }: CanvasSize,
  chrome: Chrome,
  triggerXFrac: number | null,
): void {
  if (triggerXFrac === null) return;
  const x = Math.round(triggerXFrac * width);
  ctx.strokeStyle = chrome.trigger;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = chrome.trigger;
  ctx.font = 'bold 9px monospace';
  ctx.fillText('T', x + 2, 10);
}

/**
 * A stretch of a row the scope holds no samples for (velxio/velxio-prod#196):
 * diagonal hatching between x0 and x1, and `label` in it when there is room.
 * Drawn with plain paths (no clip), so every context that can draw a trace
 * can draw it.
 */
function drawNoData(
  ctx: CanvasRenderingContext2D,
  { width, height }: CanvasSize,
  chrome: Chrome,
  x0: number,
  x1: number,
  label: string | null,
): void {
  const a = Math.max(0, Math.min(width, x0));
  const b = Math.max(0, Math.min(width, x1));
  if (b - a < 1) return;
  ctx.strokeStyle = chrome.noData;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Lines of slope -1, every 8 px, each cut to the [a, b] band: a point
  // (x, height) rises to (x + height, 0).
  const STEP = 8;
  for (let x = a - height; x < b; x += STEP) {
    const xs = Math.max(x, a);
    const xe = Math.min(x + height, b);
    if (xe <= xs) continue;
    ctx.moveTo(xs, height - (xs - x));
    ctx.lineTo(xe, height - (xe - x));
  }
  ctx.stroke();
  if (label && b - a >= 60) {
    ctx.fillStyle = chrome.axisText;
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, (a + b) / 2, height / 2 + 3);
    ctx.textAlign = 'left';
  }
}

/** One digital channel: a step function between its HIGH and LOW levels. */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  samples: OscSample[],
  color: string,
  windowEndMs: number,
  windowMs: number,
  /** X fraction (0..1) of the trigger marker, or null for none. */
  triggerXFrac: number | null = null,
  /** What the stretch before a first sample that says `unknownBefore` reads. */
  noDataLabel: string | null = null,
): void {
  const { width, height } = size;
  ctx.clearRect(0, 0, width, height);
  const chrome = scopeChrome();
  drawGraticule(ctx, size, chrome, null);
  drawTriggerMarker(ctx, size, chrome, triggerXFrac);

  if (samples.length === 0) return;

  const windowStartMs = windowEndMs - windowMs;
  const toX = (t: number) => ((t - windowStartMs) / windowMs) * width;
  const HIGH_Y = Math.round(height * 0.15);
  const LOW_Y = Math.round(height * 0.85);

  let initState = false;
  let known = false;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i]!.timeMs <= windowStartMs) {
      initState = samples[i]!.state;
      known = true;
      break;
    }
  }
  // Before a first sample that says so, the level is not known: the buffer
  // dropped what came before it, or the channel began on a running board.
  // That stretch is "no data", not the LOW it used to be drawn as
  // (velxio/velxio-prod#196); the trace starts at the sample, at its level.
  let startX = 0;
  if (!known && samples[0]!.unknownBefore) {
    startX = Math.max(0, Math.min(width, toX(samples[0]!.timeMs)));
    drawNoData(ctx, size, chrome, 0, startX, noDataLabel);
    initState = samples[0]!.state;
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  let currentY = initState ? HIGH_Y : LOW_Y;
  ctx.moveTo(startX, currentY);

  for (const s of samples) {
    if (s.timeMs < windowStartMs) continue;
    if (s.timeMs > windowEndMs) break;

    const x = Math.max(0, Math.min(width, toX(s.timeMs)));
    const nextY = s.state ? HIGH_Y : LOW_Y;
    ctx.lineTo(x, currentY);
    ctx.lineTo(x, nextY);
    currentY = nextY;
  }

  ctx.lineTo(width, currentY);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = '9px monospace';
  ctx.fillText('H', width - 12, HIGH_Y + 3);
  ctx.fillText('L', width - 12, LOW_Y + 3);
}

/**
 * Draw one analog channel: a continuous trace on a volts axis.
 *
 * Not the digital step function with a different colour — an analog capture is
 * a dense block of samples where consecutive points can land on the same pixel
 * column, so the trace is drawn as a polyline and collapsed to a vertical
 * min/max bar wherever more than one sample shares a column. Plotting only
 * every Nth point instead would silently smooth away exactly the spikes a
 * scope exists to show.
 *
 * The vertical mapping is the scope's own: `voltsPerDiv` per division over
 * `vDivs` divisions, centred on `yOffsetV`, on a graticule of those divisions
 * and the time divisions every row shares, so a time constant, a period or
 * a phase can be read off the trace.
 */
export function drawAnalogWaveform(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  samples: OscSample[],
  color: string,
  windowEndMs: number,
  windowMs: number,
  voltsPerDiv: number,
  yOffsetV: number,
  vDivs: number,
  triggerXFrac: number | null = null,
  /** Volts taken from every sample before it is drawn: the capture's mean
   *  under AC coupling, 0 otherwise. The axis is in the volts drawn. */
  shiftV = 0,
  /** The row's scale, written in its top right corner ("500mV/div AC"). */
  scaleText: string | null = null,
  /** What the stretches of the window outside the capture read. */
  noDataLabel: string | null = null,
): void {
  const { width, height } = size;
  ctx.clearRect(0, 0, width, height);
  const chrome = scopeChrome();
  drawGraticule(ctx, size, chrome, vDivs);
  drawTriggerMarker(ctx, size, chrome, triggerXFrac);

  const windowStartMs = windowEndMs - windowMs;
  const toX = (t: number) => ((t - windowStartMs) / windowMs) * width;

  // A capture is one sweep of the solver, as long as its window: 0.4 s at
  // most for a pin stepping a capacitor, four periods of the slowest source
  // for a generator, 20 ms for a circuit that is only DC. On a longer time
  // base the rest of the screen is not a flat line at 0 V, it is "no data"
  // (velxio/velxio-prod#196).
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const smp of samples) {
    if (smp.volts === undefined) continue;
    if (smp.timeMs < firstMs) firstMs = smp.timeMs;
    if (smp.timeMs > lastMs) lastMs = smp.timeMs;
  }
  if (firstMs <= lastMs) {
    drawNoData(ctx, size, chrome, 0, toX(firstMs), noDataLabel);
    drawNoData(ctx, size, chrome, toX(lastMs), width, noDataLabel);
  }
  const spanV = voltsPerDiv * vDivs;
  // Volts increase upward; y grows downward.
  const toY = (v: number) => height / 2 - ((v - yOffsetV) / spanV) * height;

  // Zero-volt reference, so the reader can see where ground sits.
  const zeroY = toY(0);
  if (zeroY > 0 && zeroY < height) {
    ctx.strokeStyle = chrome.zero;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(width, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (samples.length > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    let started = false;
    let col = -1;
    let colMin = 0;
    let colMax = 0;

    const flushColumn = () => {
      if (col < 0) return;
      const yA = toY(colMax);
      const yB = toY(colMin);
      if (!started) {
        ctx.moveTo(col, yA);
        started = true;
      } else {
        ctx.lineTo(col, yA);
      }
      if (yB !== yA) ctx.lineTo(col, yB);
    };

    for (const smp of samples) {
      if (smp.volts === undefined) continue;
      if (smp.timeMs < windowStartMs || smp.timeMs > windowEndMs) continue;
      const v = smp.volts - shiftV;
      const x = Math.round(Math.max(0, Math.min(width, toX(smp.timeMs))));
      if (x !== col) {
        flushColumn();
        col = x;
        colMin = v;
        colMax = v;
      } else {
        if (v < colMin) colMin = v;
        if (v > colMax) colMax = v;
      }
    }
    flushColumn();
    if (started) ctx.stroke();
  }

  // Volts axis: the top and bottom of the visible span, plus the centre.
  ctx.fillStyle = chrome.axisText;
  ctx.font = '9px monospace';
  ctx.fillText(formatVolts(yOffsetV + spanV / 2), 2, 9);
  ctx.fillText(formatVolts(yOffsetV), 2, height / 2 + 3);
  ctx.fillText(formatVolts(yOffsetV - spanV / 2), 2, height - 3);
  if (scaleText) {
    ctx.textAlign = 'right';
    ctx.fillText(scaleText, width - 4, 9);
    ctx.textAlign = 'left';
  }
}

/**
 * Volts as a scope writes them, with the digits the scale needs: an axis at
 * 5 mV/div must not print every label as "4.8V" (the old one-decimal
 * format), so below a volt it is millivolts.
 */
export function formatVolts(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0V';
  if (a >= 10) return `${trim(v.toFixed(1))}V`;
  if (a >= 1) return `${trim(v.toFixed(3))}V`;
  if (a >= 1e-3) return `${trim((v * 1e3).toFixed(1))}mV`;
  return `${trim((v * 1e6).toFixed(0))}µV`;
}

/** V/div as a scope writes it: "500mV", "2V", "0.5mV". */
export function formatVoltsPerDiv(v: number): string {
  return v >= 1 ? `${trim(String(v))}V` : `${trim(String(Number((v * 1e3).toPrecision(6))))}mV`;
}

function trim(num: string): string {
  return num.includes('.') ? num.replace(/\.?0+$/, '') : num;
}

/** The time ruler: a tick and a time under each of the NUM_DIVS divisions. */
export function drawRuler(
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  windowEndMs: number,
  windowMs: number,
  timeDivMs: number,
): void {
  const { width, height } = size;
  ctx.clearRect(0, 0, width, height);
  const chrome = scopeChrome();
  ctx.strokeStyle = chrome.rulerLine;
  ctx.fillStyle = chrome.rulerText;
  ctx.font = '9px monospace';
  ctx.lineWidth = 1;

  const windowStartMs = windowEndMs - windowMs;

  for (let d = 0; d <= NUM_DIVS; d++) {
    const timeAtDiv = windowStartMs + d * timeDivMs;
    const x = Math.round((d / NUM_DIVS) * width);

    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 5);
    ctx.stroke();

    const absMs = Math.abs(timeAtDiv);
    const label =
      absMs >= 1000
        ? `${(timeAtDiv / 1000).toFixed(1)}s`
        : `${timeAtDiv.toFixed(absMs < 1 ? 2 : 1)}ms`;

    if (d < NUM_DIVS) {
      ctx.fillText(label, x + 2, height - 3);
    }
  }
}
