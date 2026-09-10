/**
 * Packing, dithering and formatting for utils/imageToCArray.ts.
 *
 * Pixel patterns are ASCII art ('#' lit, '.' dark) via art(). Dither expectations
 * are checked against referenceMono(), an independent restatement of image2cpp's
 * js/dithering.js. Parity with the real tool is in image-to-c-array-parity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MONO_OPTIONS,
  formatCArray,
  frameOnOled,
  horizontalStride,
  monoToRgba,
  packHorizontal,
  packMono,
  packVertical,
  placeOnWhite,
  sanitizeIdentifier,
  toMonochrome,
  unpackHorizontal,
  unpackVertical,
  type DitherMode,
  type MonoOptions,
} from '../utils/imageToCArray';

// ── helpers ─────────────────────────────────────────────────────────────────

interface Art {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

/** ASCII art to opaque RGBA: '#' is white (255), anything else black (0). */
function art(rows: string[]): Art {
  const height = rows.length;
  const width = rows[0].length;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = rows[y][x] === '#' ? 255 : 0;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return { rgba, width, height };
}

/** Flat RGBA from per-pixel greyscale values, alpha 255. */
function grey(values: number[], width: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, p) => {
    rgba[p * 4] = v;
    rgba[p * 4 + 1] = v;
    rgba[p * 4 + 2] = v;
    rgba[p * 4 + 3] = 255;
  });
  expect(values.length % width).toBe(0);
  return rgba;
}

/** Mono buffer back to ASCII art, for readable assertions. */
function show(mono: Uint8Array, width: number, height: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) row += mono[y * width + x] ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

function opts(over: Partial<MonoOptions> = {}): MonoOptions {
  return { ...DEFAULT_MONO_OPTIONS, ...over };
}

/**
 * Independent reference for the dithering passes, written like image2cpp's
 * js/dithering.js: luminance lookup tables over an RGBA array. Input must be opaque.
 */
function referenceMono(
  rgba: Uint8ClampedArray,
  width: number,
  threshold: number,
  mode: DitherMode,
): Uint8Array {
  const data = new Uint8ClampedArray(rgba);
  const len = data.length;
  const w = width;
  const bayer = [
    [15, 135, 45, 165],
    [195, 75, 225, 105],
    [60, 180, 30, 150],
    [240, 120, 210, 90],
  ];

  const lumR: number[] = [];
  const lumG: number[] = [];
  const lumB: number[] = [];
  for (let i = 0; i < 256; i++) {
    lumR[i] = i * 0.299;
    lumG[i] = i * 0.587;
    lumB[i] = i * 0.114;
  }
  for (let i = 0; i < len; i += 4) {
    data[i] = Math.floor(lumR[data[i]] + lumG[data[i + 1]] + lumB[data[i + 2]]);
  }

  for (let cur = 0; cur < len; cur += 4) {
    if (mode === 'none') {
      data[cur] = data[cur] < threshold ? 0 : 255;
    } else if (mode === 'bayer') {
      const x = (cur / 4) % w;
      const y = Math.floor(cur / 4 / w);
      const map = Math.floor((data[cur] + bayer[x % 4][y % 4]) / 2);
      data[cur] = map < threshold ? 0 : 255;
    } else if (mode === 'floyd-steinberg') {
      const next = data[cur] < 129 ? 0 : 255;
      const err = Math.floor((data[cur] - next) / 16);
      data[cur] = next;
      data[cur + 4] += err * 7;
      data[cur + 4 * w - 4] += err * 3;
      data[cur + 4 * w] += err * 5;
      data[cur + 4 * w + 4] += err * 1;
    } else {
      const next = data[cur] < threshold ? 0 : 255;
      const err = Math.floor((data[cur] - next) / 8);
      data[cur] = next;
      data[cur + 4] += err;
      data[cur + 8] += err;
      data[cur + 4 * w - 4] += err;
      data[cur + 4 * w] += err;
      data[cur + 4 * w + 4] += err;
      data[cur + 8 * w] += err;
    }
  }

  const mono = new Uint8Array(len / 4);
  for (let p = 0; p < mono.length; p++) mono[p] = data[p * 4] > threshold ? 1 : 0;
  return mono;
}

/** Deterministic 32-bit LCG, so the round-trip case is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ── horizontal packing ──────────────────────────────────────────────────────

describe('packHorizontal', () => {
  it('packs an 8x2 pattern MSB first, one byte per row', () => {
    const a = art(['#.#.#.#.', '....####']);
    const mono = toMonochrome(a.rgba, a.width, a.height, opts());
    expect([...packHorizontal(mono, a.width, a.height)]).toEqual([0xaa, 0x0f]);
  });

  it('pads a 10px row out to 2 bytes with zero low bits', () => {
    const a = art(['##....###.']);
    const mono = toMonochrome(a.rgba, a.width, a.height, opts());
    expect(horizontalStride(10)).toBe(2);
    // 0b11000011 then x8 in the MSB of the pad byte, x9 and the padding clear.
    expect([...packHorizontal(mono, a.width, a.height)]).toEqual([0xc3, 0x80]);
  });

  it('gives each row its own stride so rows never share a byte', () => {
    const a = art(['#....', '....#']);
    const mono = toMonochrome(a.rgba, a.width, a.height, opts());
    expect([...packHorizontal(mono, a.width, a.height)]).toEqual([0x80, 0x08]);
  });
});

// ── vertical packing ────────────────────────────────────────────────────────

describe('packVertical', () => {
  it('packs an 8x16 pattern as two pages with bit 0 as the top row', () => {
    const a = art([
      '########', // row 0  -> bit 0 of page 0
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
      '#......#', // row 7  -> bit 7 of page 0
      '#.......', // row 8  -> bit 0 of page 1
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
      '.......#', // row 15 -> bit 7 of page 1
    ]);
    const mono = toMonochrome(a.rgba, a.width, a.height, opts());
    expect([...packVertical(mono, a.width, a.height)]).toEqual([
      0x81,
      0x01,
      0x01,
      0x01,
      0x01,
      0x01,
      0x01,
      0x81, // page 0
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x80, // page 1
    ]);
  });

  it('zero-fills the rows past the image in a partial last page', () => {
    const a = art(['#.#', '.#.', '...', '...', '...', '...', '...', '...', '###', '#..']);
    const mono = toMonochrome(a.rgba, a.width, a.height, opts());
    // 3 columns x 2 pages; rows 10-15 do not exist, so they read as 0.
    expect([...packVertical(mono, a.width, a.height)]).toEqual([
      0x01,
      0x02,
      0x01, // page 0 (rows 0-7)
      0x03,
      0x01,
      0x01, // page 1 (rows 8-9 only)
    ]);
  });

  it('packMono dispatches on the draw mode', () => {
    const a = art(['#.#.#.#.', '....####']);
    const mono = toMonochrome(a.rgba, a.width, a.height, opts());
    expect([...packMono(mono, a.width, a.height, 'horizontal')]).toEqual([
      ...packHorizontal(mono, a.width, a.height),
    ]);
    expect([...packMono(mono, a.width, a.height, 'vertical')]).toEqual([
      ...packVertical(mono, a.width, a.height),
    ]);
  });
});

// ── round trip ──────────────────────────────────────────────────────────────

describe('pack / unpack round trip', () => {
  it('survives 13x11 random patterns in both layouts', () => {
    const width = 13;
    const height = 11;
    const rand = lcg(0x5eed);
    for (let trial = 0; trial < 20; trial++) {
      const mono = new Uint8Array(width * height);
      for (let p = 0; p < mono.length; p++) mono[p] = rand() < 0.5 ? 1 : 0;

      const h = packHorizontal(mono, width, height);
      expect(h.length).toBe(2 * height);
      expect([...unpackHorizontal(h, width, height)]).toEqual([...mono]);

      const v = packVertical(mono, width, height);
      expect(v.length).toBe(2 * width);
      expect([...unpackVertical(v, width, height)]).toEqual([...mono]);
    }
  });
});

// ── thresholding, invert, flips, alpha ──────────────────────────────────────

describe('toMonochrome', () => {
  it('lights a pixel when its luminance reaches the threshold', () => {
    // floor(v * 0.299 + v * 0.587 + v * 0.114) for v = 127/128/129/200 gives
    // 126/127/129/200: the weights fall a hair short of 1.0 in doubles, so
    // grey 128 greyscales to 127 and stays dark at threshold 128.
    const rgba = grey([127, 128, 129, 200], 4);
    expect([...toMonochrome(rgba, 4, 1, opts({ threshold: 128 }))]).toEqual([0, 0, 1, 1]);
  });

  it('lights a pixel whose luminance equals the threshold exactly', () => {
    // floor(128*0.299 + 128*0.587 + 130*0.114) = 128, so this one is not
    // "strictly greater" yet still lit: image2cpp binarises with < threshold.
    const rgba = new Uint8ClampedArray([128, 128, 130, 255, 127, 128, 129, 255]);
    expect([...toMonochrome(rgba, 2, 1, opts({ threshold: 128 }))]).toEqual([1, 0]);
  });

  it('weights the channels as ITU luminance, not as a flat average', () => {
    // Pure green is 149, pure red 76, pure blue 29. A flat mean would make
    // all three 85 and all three dark at threshold 128.
    const rgba = new Uint8ClampedArray([
      0,
      255,
      0,
      255, //
      255,
      0,
      0,
      255, //
      0,
      0,
      255,
      255,
    ]);
    expect([...toMonochrome(rgba, 3, 1, opts({ threshold: 128 }))]).toEqual([1, 0, 0]);
    expect([...toMonochrome(rgba, 3, 1, opts({ threshold: 76 }))]).toEqual([1, 1, 0]);
    expect([...toMonochrome(rgba, 3, 1, opts({ threshold: 29 }))]).toEqual([1, 1, 1]);
  });

  it('never lights anything at threshold 255, matching upstream', () => {
    const rgba = grey([255, 255, 255, 255], 4);
    expect([...toMonochrome(rgba, 4, 1, opts({ threshold: 255 }))]).toEqual([0, 0, 0, 0]);
  });

  it('inverts the final bit', () => {
    const a = art(['#.#.']);
    expect([...toMonochrome(a.rgba, 4, 1, opts({ invert: true }))]).toEqual([0, 1, 0, 1]);
  });

  it('mirrors horizontally', () => {
    const a = art(['##..', '#...']);
    const mono = toMonochrome(a.rgba, a.width, a.height, opts({ flipH: true }));
    expect(show(mono, a.width, a.height)).toEqual(['..##', '...#']);
  });

  it('mirrors vertically', () => {
    const a = art(['##..', '#...']);
    const mono = toMonochrome(a.rgba, a.width, a.height, opts({ flipV: true }));
    expect(show(mono, a.width, a.height)).toEqual(['#...', '##..']);
  });

  it('mirrors both axes at once', () => {
    const a = art(['##..', '#...']);
    const mono = toMonochrome(a.rgba, a.width, a.height, opts({ flipH: true, flipV: true }));
    expect(show(mono, a.width, a.height)).toEqual(['...#', '..##']);
  });

  it('composites alpha over white, like drawing onto image2cpp white canvas', () => {
    // Black pixels at alpha 0 / 126 / 127 / 255 composite to 255 / 129 / 128 / 0,
    // whose luminances are 255 / 129 / 127 / 0. Only the first two reach 128.
    const rgba = new Uint8ClampedArray([
      0,
      0,
      0,
      0, //
      0,
      0,
      0,
      126, //
      0,
      0,
      0,
      127, //
      0,
      0,
      0,
      255,
    ]);
    expect([...toMonochrome(rgba, 4, 1, opts({ threshold: 128 }))]).toEqual([1, 1, 0, 0]);
  });
});

// ── dithering ───────────────────────────────────────────────────────────────

describe('dithering', () => {
  // Every case below starts from a flat 4x4 of rgb(128,128,128), which
  // greyscales to 127 (not 128) because the ITU weights fall short of 1.0.
  const flat = () => grey(new Array(16).fill(128), 4);

  it('leaves a flat mid-grey block dark with no dithering', () => {
    // 127 < 128 -> 0, and 0 > 128 is false.
    const mono = toMonochrome(flat(), 4, 4, opts({ dither: 'none', threshold: 128 }));
    expect(show(mono, 4, 4)).toEqual(['....', '....', '....', '....']);
  });

  it('bayer turns a flat mid-grey block into a checkerboard', () => {
    // map = floor((127 + bayer[x][y]) / 2) >= 128 exactly when bayer[x][y] >= 129,
    // and no matrix entry sits between 128 and 129.
    const mono = toMonochrome(flat(), 4, 4, opts({ dither: 'bayer', threshold: 128 }));
    expect(show(mono, 4, 4)).toEqual(['.#.#', '#.#.', '.#.#', '#.#.']);
  });

  it('floyd-steinberg alternates on a flat mid-grey block', () => {
    // Hand-traced: 127 -> 0 with err floor(127/16) = 7, the +7/16 push carries
    // the next pixel past 129, and it settles into an alternation.
    const mono = toMonochrome(flat(), 4, 4, opts({ dither: 'floyd-steinberg', threshold: 128 }));
    expect(show(mono, 4, 4)).toEqual(['.#.#', '.#.#', '.#.#', '.#.#']);
  });

  it('atkinson spreads a flat mid-grey block over its 6-neighbour kernel', () => {
    // Hand-traced from js/dithering.js: err = floor((v - next) / 8) pushed to
    // p+1, p+2, p+w-1, p+w, p+w+1 and p+2w, with 2/8 of the error thrown away.
    // 127 -> 0 with err 15, which lifts the six neighbours to 142 and the
    // alternation drifts as the discarded quarter accumulates.
    const mono = toMonochrome(flat(), 4, 4, opts({ dither: 'atkinson', threshold: 128 }));
    expect(show(mono, 4, 4)).toEqual(['.#.#', '.#.#', '..##', '#...']);
  });

  it('matches the RGBA-space reference on a horizontal gradient', () => {
    const width = 8;
    const height = 4;
    const values: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) values.push(x * 36);
    }
    const rgba = grey(values, width);

    for (const dither of ['none', 'bayer', 'floyd-steinberg', 'atkinson'] as DitherMode[]) {
      const mine = toMonochrome(rgba, width, height, opts({ dither, threshold: 128 }));
      const ref = referenceMono(rgba, width, 128, dither);
      expect([...mine], `dither=${dither}`).toEqual([...ref]);
    }
  });

  it('matches the reference on a wider gradient at a non-default threshold', () => {
    const width = 16;
    const height = 6;
    const values: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) values.push(Math.round((x * 255) / (width - 1)));
    }
    const rgba = grey(values, width);

    for (const dither of ['bayer', 'atkinson'] as DitherMode[]) {
      const mine = toMonochrome(rgba, width, height, opts({ dither, threshold: 90 }));
      const ref = referenceMono(rgba, width, 90, dither);
      expect([...mine], `dither=${dither}`).toEqual([...ref]);
    }
  });
});

// ── output formatting ───────────────────────────────────────────────────────

describe('formatCArray', () => {
  const eightByOne = () => {
    const a = art(['#.#..#.#']); // 0b10100101 = 0xa5
    const mono = toMonochrome(a.rgba, a.width, a.height, opts());
    return packHorizontal(mono, a.width, a.height);
  };

  it('wraps an Arduino PROGMEM array around the bytes', () => {
    const out = formatCArray(eightByOne(), {
      format: 'arduino',
      name: 'myBitmap',
      width: 8,
      height: 1,
      drawMode: 'horizontal',
    });
    expect(out).toBe(
      [
        "// 'myBitmap', 8x1px, horizontal draw mode (Adafruit_GFX drawBitmap)",
        'const unsigned char myBitmap [] PROGMEM = {',
        '  0xa5',
        '};',
        '// 8x1px',
      ].join('\n'),
    );
  });

  it('names the vertical layout in the header comment', () => {
    const out = formatCArray(new Uint8Array([0x01]), {
      format: 'arduino',
      name: 'logo',
      width: 1,
      height: 8,
      drawMode: 'vertical',
    });
    expect(out.split('\n')[0]).toBe("// 'logo', 1x8px, vertical draw mode (SSD1306 page buffer)");
  });

  it('emits bare lowercase hex bytes in plain format', () => {
    const out = formatCArray(new Uint8Array([0x00, 0xff, 0x3c, 0x81]), {
      format: 'plain',
      name: 'myBitmap',
      width: 32,
      height: 1,
      drawMode: 'horizontal',
    });
    expect(out).toBe('0x00, 0xff, 0x3c, 0x81');
  });

  it('wraps at bytesPerLine, with a trailing comma on every byte but the last', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const out = formatCArray(bytes, {
      format: 'plain',
      name: 'x',
      width: 56,
      height: 1,
      drawMode: 'horizontal',
      bytesPerLine: 3,
    });
    expect(out).toBe('0x01, 0x02, 0x03,\n0x04, 0x05, 0x06,\n0x07');
  });

  it('defaults to one image row per line and caps it at 16 bytes', () => {
    const wide = new Uint8Array(64).fill(0x11);
    const out = formatCArray(wide, {
      format: 'plain',
      name: 'x',
      width: 256, // stride 32, capped to 16
      height: 2,
      drawMode: 'horizontal',
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0].split(', ')).toHaveLength(16);
    expect(lines.every((l) => l.length < 100)).toBe(true);
  });

  it('sanitizes the identifier and falls back when nothing usable is left', () => {
    expect(sanitizeIdentifier('1 bad name!')).toBe('_1_bad_name_');
    expect(sanitizeIdentifier('logo-64x32')).toBe('logo_64x32');
    expect(sanitizeIdentifier('ok_name2')).toBe('ok_name2');
    expect(sanitizeIdentifier('')).toBe('myBitmap');
    expect(sanitizeIdentifier('!!!')).toBe('myBitmap');

    const out = formatCArray(new Uint8Array([0x00]), {
      format: 'arduino',
      name: '1 bad name!',
      width: 8,
      height: 1,
      drawMode: 'horizontal',
    });
    expect(out).toContain('const unsigned char _1_bad_name_ [] PROGMEM = {');
  });
});

// ── previews ────────────────────────────────────────────────────────────────

describe('monoToRgba', () => {
  it('paints lit pixels in the emulator colour and the rest opaque black', () => {
    const rgba = monoToRgba(new Uint8Array([1, 0]), 2, 1);
    expect([...rgba]).toEqual([200, 230, 255, 255, 0, 0, 0, 255]);
  });

  it('accepts a custom lit colour', () => {
    const rgba = monoToRgba(new Uint8Array([1]), 1, 1, [10, 20, 30]);
    expect([...rgba]).toEqual([10, 20, 30, 255]);
  });
});

describe('placeOnWhite', () => {
  it('leaves the untouched area white', () => {
    const a = art(['..', '..']); // a black 2x2 block, so the fill shows up lit
    const out = placeOnWhite(a.rgba, 2, 2, 4, 4, { scaleMode: 'original', center: false });
    const mono = toMonochrome(out, 4, 4, opts());
    expect(show(mono, 4, 4)).toEqual(['..##', '..##', '####', '####']);
  });

  it('centres the placed image', () => {
    const a = art(['..', '..']);
    const out = placeOnWhite(a.rgba, 2, 2, 4, 4, { scaleMode: 'original', center: true });
    const mono = toMonochrome(out, 4, 4, opts());
    expect(show(mono, 4, 4)).toEqual(['####', '#..#', '#..#', '####']);
  });

  it('box-averages a 2x downscale', () => {
    // A 2x2 checkerboard of black/white averages to 127.5, stored as 128,
    // whose luminance is 127: lit at threshold 127, dark at 128.
    const a = art(['#.', '.#']);
    const out = placeOnWhite(a.rgba, 2, 2, 1, 1, { scaleMode: 'stretch', center: false });
    expect(out[0]).toBe(128);
    expect([...toMonochrome(out, 1, 1, opts({ threshold: 127 }))]).toEqual([1]);
    expect([...toMonochrome(out, 1, 1, opts({ threshold: 128 }))]).toEqual([0]);
  });

  it('fit keeps the aspect ratio, stretch does not', () => {
    const a = art(['####', '....']); // 4x2, black bottom half
    const fit = placeOnWhite(a.rgba, 4, 2, 8, 8, { scaleMode: 'fit', center: true });
    // 4x2 fitted into 8x8 scales by 2 -> 8x4, centred at y = 2.
    expect(show(toMonochrome(fit, 8, 8, opts()), 8, 8)).toEqual([
      '########',
      '########',
      '########',
      '########',
      '........',
      '........',
      '########',
      '########',
    ]);
    const stretched = placeOnWhite(a.rgba, 4, 2, 8, 8, { scaleMode: 'stretch', center: true });
    expect(show(toMonochrome(stretched, 8, 8, opts()), 8, 8).slice(0, 4)).toEqual([
      '########',
      '########',
      '########',
      '########',
    ]);
  });
});

describe('frameOnOled', () => {
  it('centres a 16x8 image on the 128x64 screen', () => {
    const mono = new Uint8Array(16 * 8).fill(1);
    const framed = frameOnOled(mono, 16, 8);
    expect(framed.length).toBe(128 * 64);
    // offX = (128 - 16) / 2 = 56, offY = (64 - 8) / 2 = 28.
    expect(framed[28 * 128 + 56]).toBe(1);
    expect(framed[28 * 128 + 55]).toBe(0);
    expect(framed[27 * 128 + 56]).toBe(0);
    expect(framed[35 * 128 + 71]).toBe(1);
    expect(framed[36 * 128 + 71]).toBe(0);
    expect(framed.reduce((n, v) => n + v, 0)).toBe(16 * 8);
  });

  it('crops a 200x100 image down to the screen', () => {
    const mono = new Uint8Array(200 * 100).fill(1);
    const framed = frameOnOled(mono, 200, 100);
    expect(framed.reduce((n, v) => n + v, 0)).toBe(128 * 64);
  });

  it('keeps the crop centred on the source image', () => {
    const width = 200;
    const height = 100;
    const mono = new Uint8Array(width * height);
    // offX = floor((128 - 200) / 2) = -36, offY = floor((64 - 100) / 2) = -18.
    mono[18 * width + 36] = 1;
    const framed = frameOnOled(mono, width, height);
    expect(framed[0]).toBe(1);
    expect(framed.reduce((n, v) => n + v, 0)).toBe(1);
  });
});
