/**
 * Byte-for-byte parity with image2cpp, so a refactor of utils/imageToCArray.ts
 * cannot change what users get.
 *
 * Fixtures: the two images below, run through javl/image2cpp in Chrome with plain
 * bytes output, original scale, white background, no rotation or flips, and the
 * draw mode, dithering, threshold and invert of each case key.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MONO_OPTIONS,
  packHorizontal,
  packVertical,
  toMonochrome,
  type DitherMode,
} from '../utils/imageToCArray';

interface Fixture {
  meta: { image: string; size: string; source?: string };
  [caseKey: string]: unknown;
}

function fixture(name: string): Fixture {
  const path = fileURLToPath(new URL(`./fixtures/image2cpp/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

interface TestImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/** 64x32: a left-hand horizontal ramp, a hard disc and a diagonal hatch. */
function greyImage(): TestImage {
  const width = 64;
  const height = 32;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v: number;
      if (x < 32) {
        v = Math.floor((x * 255) / 31);
      } else {
        const r = Math.hypot(x - 48, y - 16);
        v = r < 10 ? 255 : (x + y) % 7 < 3 ? 0 : 255;
      }
      const i = (y * width + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** 48x24: four saturated colour ramps plus a grey strip, to catch a
 *  greyscale that averages the channels instead of weighting them. */
function colourImage(): TestImage {
  const width = 48;
  const height = 24;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const bases = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c: number[];
      if (x >= 44) {
        const v = Math.floor((y * 255) / (height - 1));
        c = [v, v, v];
      } else {
        const t = y / (height - 1);
        c = bases[Math.min(Math.floor(x / 11), 3)].map((b) => Math.floor(b * t));
      }
      const i = (y * width + x) * 4;
      rgba[i] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}

type Case = [
  key: string,
  drawMode: 'h' | 'v',
  dither: DitherMode,
  threshold: number,
  invert: boolean,
];

const GREY_CASES: Case[] = [
  ['h_none_128', 'h', 'none', 128, false],
  ['v_none_128', 'v', 'none', 128, false],
  ['h_bayer_128', 'h', 'bayer', 128, false],
  ['h_fs_128', 'h', 'floyd-steinberg', 128, false],
  ['h_atk_128', 'h', 'atkinson', 128, false],
  ['h_none_200', 'h', 'none', 200, false],
  ['h_none_128_inv', 'h', 'none', 128, true],
  ['v_fs_128', 'v', 'floyd-steinberg', 128, false],
];

const COLOUR_CASES: Case[] = [
  ['c_h_none_128', 'h', 'none', 128, false],
  ['c_h_none_64', 'h', 'none', 64, false],
  ['c_h_bayer_128', 'h', 'bayer', 128, false],
  ['c_h_fs_128', 'h', 'floyd-steinberg', 128, false],
  ['c_h_atk_128', 'h', 'atkinson', 128, false],
  ['c_h_atk_64', 'h', 'atkinson', 64, false],
  ['c_v_none_128', 'v', 'none', 128, false],
  ['c_v_atk_128', 'v', 'atkinson', 128, false],
];

function ourBytes(img: TestImage, [, drawMode, dither, threshold, invert]: Case): string[] {
  const mono = toMonochrome(img.rgba, img.width, img.height, {
    ...DEFAULT_MONO_OPTIONS,
    dither,
    threshold,
    invert,
  });
  const packed =
    drawMode === 'h'
      ? packHorizontal(mono, img.width, img.height)
      : packVertical(mono, img.width, img.height);
  return [...packed].map((b) => `0x${b.toString(16).padStart(2, '0')}`);
}

describe('image2cpp parity', () => {
  const grey = fixture('grey-64x32.json');
  const colour = fixture('colour-48x24.json');

  it('reads both fixtures', () => {
    expect(grey.meta.size).toBe('64x32');
    expect(colour.meta.size).toBe('48x24');
    expect(GREY_CASES.every((c) => Array.isArray(grey[c[0]]))).toBe(true);
    expect(COLOUR_CASES.every((c) => Array.isArray(colour[c[0]]))).toBe(true);
  });

  describe('64x32 greyscale image', () => {
    const img = greyImage();
    // 64px wide = 8 bytes per row either way, 32 rows / 4 pages.
    it.each(GREY_CASES)('%s', (...c) => {
      expect(ourBytes(img, c as Case)).toEqual(grey[(c as Case)[0]]);
    });
  });

  describe('48x24 colour image', () => {
    const img = colourImage();
    it.each(COLOUR_CASES)('%s', (...c) => {
      expect(ourBytes(img, c as Case)).toEqual(colour[(c as Case)[0]]);
    });
  });
});
