/**
 * RGBA bitmap to a monochrome C byte array for SSD1306-class OLEDs. Pure, no DOM;
 * pages/ImageToCodePage.tsx does the canvas decoding.
 *
 * Ported from image2cpp by javl (GPL-3.0), https://github.com/javl/image2cpp.
 * Velxio is AGPL-3.0, so the copyleft carries over.
 *
 * horizontal packs 1 bit per pixel MSB first, rows padded to a byte: the
 * Adafruit_GFX drawBitmap layout. vertical packs page-major, bit 0 the top row of
 * the page: the SSD1306 GDDRAM layout.
 *
 * Upstream quirks are kept so output matches byte for byte. The luminance weights
 * leave grey 128 at 127, every mode binarises through the dither pass,
 * Floyd-Steinberg quantises against a hardcoded 129, and alpha composites over
 * white. See image-to-c-array-parity.test.ts.
 */

export type DrawMode = 'horizontal' | 'vertical';
export type DitherMode = 'none' | 'bayer' | 'floyd-steinberg' | 'atkinson';
export type OutputFormat = 'arduino' | 'plain';
export type ScaleMode = 'original' | 'fit' | 'stretch';

export interface MonoOptions {
  /** 0-255. Without dithering a pixel is lit when its luminance is >= this. */
  threshold: number;
  invert: boolean;
  dither: DitherMode;
  flipH: boolean;
  flipV: boolean;
}

export const DEFAULT_MONO_OPTIONS: MonoOptions = {
  threshold: 128,
  invert: false,
  dither: 'none',
  flipH: false,
  flipV: false,
};

/** The lit-pixel colour the SSD1306 emulator uses (ProtocolParts.ts). */
export const OLED_LIT_RGB: [number, number, number] = [200, 230, 255];

/** 4x4 ordered dither matrix, verbatim from image2cpp's js/dithering.js. */
const BAYER_4X4 = [
  [15, 135, 45, 165],
  [195, 75, 225, 105],
  [60, 180, 30, 150],
  [240, 120, 210, 90],
];

/** Longest byte run per output line; 16 bytes is 98 columns once indented. */
const MAX_BYTES_PER_LINE = 16;

/** Composite over white, then ITU luminance summed r, g, b and floored. */
function toGreyscale(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const grey = new Uint8ClampedArray(width * height);
  for (let p = 0; p < grey.length; p++) {
    const i = p * 4;
    const a = (rgba[i + 3] ?? 255) / 255;
    const r = Math.round((rgba[i] ?? 0) * a + 255 * (1 - a));
    const g = Math.round((rgba[i + 1] ?? 0) * a + 255 * (1 - a));
    const b = Math.round((rgba[i + 2] ?? 0) * a + 255 * (1 - a));
    grey[p] = Math.floor(r * 0.299 + g * 0.587 + b * 0.114);
  }
  return grey;
}

/**
 * image2cpp's dithering passes, in place. Every mode binarises to 0 or 255.
 * Uint8ClampedArray so error diffusion clamps and spills across rows as upstream.
 */
function ditherInPlace(
  buf: Uint8ClampedArray,
  width: number,
  threshold: number,
  mode: DitherMode,
): void {
  const n = buf.length;
  if (mode === 'none') {
    for (let p = 0; p < n; p++) buf[p] = buf[p] < threshold ? 0 : 255;
    return;
  }
  if (mode === 'bayer') {
    for (let p = 0; p < n; p++) {
      const x = p % width;
      const y = Math.floor(p / width);
      const map = Math.floor((buf[p] + BAYER_4X4[x % 4][y % 4]) / 2);
      buf[p] = map < threshold ? 0 : 255;
    }
    return;
  }
  if (mode === 'floyd-steinberg') {
    for (let p = 0; p < n; p++) {
      // image2cpp hardcodes 129 here instead of the threshold; kept for parity.
      const next = buf[p] < 129 ? 0 : 255;
      const err = Math.floor((buf[p] - next) / 16);
      buf[p] = next;
      buf[p + 1] += err * 7;
      buf[p + width - 1] += err * 3;
      buf[p + width] += err * 5;
      buf[p + width + 1] += err;
    }
    return;
  }
  // Atkinson: 6 neighbours, 1/8 of the error each (the other 2/8 is discarded).
  for (let p = 0; p < n; p++) {
    const next = buf[p] < threshold ? 0 : 255;
    const err = Math.floor((buf[p] - next) / 8);
    buf[p] = next;
    buf[p + 1] += err;
    buf[p + 2] += err;
    buf[p + width - 1] += err;
    buf[p + width] += err;
    buf[p + width + 1] += err;
    buf[p + width * 2] += err;
  }
}

/**
 * RGBA to one byte per pixel, 1 = lit. Order: composite, greyscale, dither,
 * threshold, invert, flip.
 */
export function toMonochrome(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: MonoOptions,
): Uint8Array {
  const n = width * height;
  const buf = toGreyscale(rgba, width, height);
  const mono = new Uint8Array(n);

  ditherInPlace(buf, width, opts.threshold, opts.dither);
  // buf is 0 or 255 by now, so this is upstream's second threshold test. At
  // threshold 255 nothing is ever lit, which is upstream's behaviour too.
  for (let p = 0; p < n; p++) mono[p] = buf[p] > opts.threshold ? 1 : 0;

  if (opts.invert) {
    for (let p = 0; p < n; p++) mono[p] ^= 1;
  }
  if (!opts.flipH && !opts.flipV) return mono;

  const out = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    const sy = opts.flipV ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const sx = opts.flipH ? width - 1 - x : x;
      out[y * width + x] = mono[sy * width + sx];
    }
  }
  return out;
}

/** Bytes per row in horizontal draw mode. */
export function horizontalStride(width: number): number {
  return Math.ceil(width / 8);
}

/** 1bpp, MSB first, each row padded to a whole byte (Adafruit_GFX layout). */
export function packHorizontal(mono: Uint8Array, width: number, height: number): Uint8Array {
  const stride = horizontalStride(width);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mono[y * width + x]) out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** Page-major, bit 0 = top row of the page (SSD1306 GDDRAM layout). */
export function packVertical(mono: Uint8Array, width: number, height: number): Uint8Array {
  const pages = Math.ceil(height / 8);
  const out = new Uint8Array(pages * width);
  for (let page = 0; page < pages; page++) {
    for (let x = 0; x < width; x++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const y = page * 8 + bit;
        if (y < height && mono[y * width + x]) byte |= 1 << bit;
      }
      out[page * width + x] = byte;
    }
  }
  return out;
}

/** Inverse of packHorizontal. */
export function unpackHorizontal(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const stride = horizontalStride(width);
  const mono = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = bytes[y * stride + (x >> 3)] ?? 0;
      mono[y * width + x] = (byte >> (7 - (x & 7))) & 1;
    }
  }
  return mono;
}

/** Inverse of packVertical. */
export function unpackVertical(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const mono = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const page = Math.floor(y / 8);
    for (let x = 0; x < width; x++) {
      const byte = bytes[page * width + x] ?? 0;
      mono[y * width + x] = (byte >> (y % 8)) & 1;
    }
  }
  return mono;
}

/** Pack in whichever layout the draw mode calls for. */
export function packMono(
  mono: Uint8Array,
  width: number,
  height: number,
  drawMode: DrawMode,
): Uint8Array {
  return drawMode === 'vertical'
    ? packVertical(mono, width, height)
    : packHorizontal(mono, width, height);
}

/** Coerce a name into a valid C identifier, falling back to `myBitmap`. */
export function sanitizeIdentifier(name: string): string {
  const cleaned = (name ?? '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!cleaned || /^_+$/.test(cleaned)) return 'myBitmap';
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

function drawModeNote(drawMode: DrawMode): string {
  return drawMode === 'vertical'
    ? 'vertical draw mode (SSD1306 page buffer)'
    : 'horizontal draw mode (Adafruit_GFX drawBitmap)';
}

function hexBody(bytes: Uint8Array, perLine: number, indent: string): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    const chunk: string[] = [];
    for (let j = i; j < Math.min(i + perLine, bytes.length); j++) {
      chunk.push(`0x${bytes[j].toString(16).padStart(2, '0')}`);
    }
    lines.push(indent + chunk.join(', '));
  }
  return lines.join(',\n');
}

export interface FormatOptions {
  format: OutputFormat;
  name: string;
  width: number;
  height: number;
  drawMode: DrawMode;
  /** Bytes per output line. Defaults to one image row, capped at 16. */
  bytesPerLine?: number;
}

/** Render packed bytes as either a bare hex list or an Arduino PROGMEM array. */
export function formatCArray(bytes: Uint8Array, o: FormatOptions): string {
  const natural = o.drawMode === 'vertical' ? o.width : horizontalStride(o.width);
  const perLine =
    o.bytesPerLine !== undefined
      ? Math.max(1, Math.floor(o.bytesPerLine))
      : Math.max(1, Math.min(natural, MAX_BYTES_PER_LINE));

  if (o.format === 'plain') return hexBody(bytes, perLine, '');

  const name = sanitizeIdentifier(o.name);
  return [
    `// '${name}', ${o.width}x${o.height}px, ${drawModeNote(o.drawMode)}`,
    `const unsigned char ${name} [] PROGMEM = {`,
    hexBody(bytes, perLine, '  '),
    '};',
    `// ${o.width}x${o.height}px`,
  ].join('\n');
}

export interface Placement {
  scaleMode: ScaleMode;
  center: boolean;
}

/**
 * Place a bitmap on a white dw x dh canvas, box-filtered. Mirrors image2cpp's
 * placeImage() arithmetically so the pipeline stays pure. Uncovered area is white.
 */
export function placeOnWhite(
  src: Uint8ClampedArray | Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  placement: Placement,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4).fill(255);
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return out;

  let boxW = sw;
  let boxH = sh;
  if (placement.scaleMode === 'fit') {
    const ratio = Math.min(dw / sw, dh / sh);
    boxW = sw * ratio;
    boxH = sh * ratio;
  } else if (placement.scaleMode === 'stretch') {
    boxW = dw;
    boxH = dh;
  }
  const offX = placement.center ? Math.round((dw - boxW) / 2) : 0;
  const offY = placement.center ? Math.round((dh - boxH) / 2) : 0;

  const x0 = Math.max(0, Math.ceil(offX));
  const y0 = Math.max(0, Math.ceil(offY));
  const x1 = Math.min(dw, Math.ceil(offX + boxW));
  const y1 = Math.min(dh, Math.ceil(offY + boxH));

  for (let y = y0; y < y1; y++) {
    // Source span this output row covers, in source pixel coordinates.
    const sy0 = ((y - offY) * sh) / boxH;
    const sy1 = ((y + 1 - offY) * sh) / boxH;
    for (let x = x0; x < x1; x++) {
      const sx0 = ((x - offX) * sw) / boxW;
      const sx1 = ((x + 1 - offX) * sw) / boxW;
      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;
      for (let iy = Math.max(0, Math.floor(sy0)); iy < Math.min(sh, Math.ceil(sy1)); iy++) {
        const wy = Math.min(sy1, iy + 1) - Math.max(sy0, iy);
        if (wy <= 0) continue;
        for (let ix = Math.max(0, Math.floor(sx0)); ix < Math.min(sw, Math.ceil(sx1)); ix++) {
          const wx = Math.min(sx1, ix + 1) - Math.max(sx0, ix);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const i = (iy * sw + ix) * 4;
          const a = (src[i + 3] ?? 255) / 255;
          r += (src[i] * a + 255 * (1 - a)) * weight;
          g += (src[i + 1] * a + 255 * (1 - a)) * weight;
          b += (src[i + 2] * a + 255 * (1 - a)) * weight;
          total += weight;
        }
      }
      if (total <= 0) continue;
      const o = (y * dw + x) * 4;
      out[o] = r / total;
      out[o + 1] = g / total;
      out[o + 2] = b / total;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Mono buffer to RGBA, for canvas previews and the emulated OLED. */
export function monoToRgba(
  mono: Uint8Array,
  width: number,
  height: number,
  lit: [number, number, number] = OLED_LIT_RGB,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    if (mono[p]) {
      out[i] = lit[0];
      out[i + 1] = lit[1];
      out[i + 2] = lit[2];
    }
    out[i + 3] = 255;
  }
  return out;
}

/** Centre a mono bitmap on a blank OLED buffer, cropping whatever overflows. */
export function frameOnOled(
  mono: Uint8Array,
  width: number,
  height: number,
  oledW = 128,
  oledH = 64,
): Uint8Array {
  const out = new Uint8Array(oledW * oledH);
  const offX = Math.floor((oledW - width) / 2);
  const offY = Math.floor((oledH - height) / 2);
  for (let y = 0; y < height; y++) {
    const dy = offY + y;
    if (dy < 0 || dy >= oledH) continue;
    for (let x = 0; x < width; x++) {
      const dx = offX + x;
      if (dx < 0 || dx >= oledW) continue;
      out[dy * oledW + dx] = mono[y * width + x];
    }
  }
  return out;
}
