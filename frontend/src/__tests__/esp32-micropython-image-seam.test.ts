/**
 * The MicroPython loader's overlay seam (velxio/velxio-prod#219): an overlay
 * that serves a board's image says which one a kind boots, and the loader asks
 * for it first and places it at its offset. With no overlay the table decides,
 * as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEsp32Firmware,
  installEsp32MicroPythonImages,
  padToFlashSize,
} from '../simulation/Esp32MicroPythonLoader';
import type { BoardKind } from '../types/board';

const fetched: string[] = [];

beforeEach(() => {
  fetched.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      fetched.push(url);
      if (!url.startsWith('/')) throw new TypeError('Failed to fetch');
      return new Response(new TextEncoder().encode(url), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  installEsp32MicroPythonImages(null);
});

const IMAGE = { url: '/firmware/overlay-s3.bin', cacheKey: 'overlay-s3-test', flashOffset: 0 };

describe('the MicroPython image seam', () => {
  it('leaves the table in charge without an overlay', async () => {
    await getEsp32Firmware('overlay-s3-board' as BoardKind);
    expect(fetched[0]).toMatch(/^https:\/\/micropython\.org\/.*ESP32_GENERIC-/);
    const flash = padToFlashSize(new Uint8Array([0xe9]), 'overlay-s3-board' as BoardKind);
    expect(flash[0x1000]).toBe(0xe9);
  });

  it('asks for the overlay image first and places it at its offset', async () => {
    installEsp32MicroPythonImages((kind) => (kind === 'overlay-s3-board' ? IMAGE : null));
    const image = await getEsp32Firmware('overlay-s3-board' as BoardKind);
    expect(fetched).toEqual(['/firmware/overlay-s3.bin']);
    expect(new TextDecoder().decode(image)).toBe('/firmware/overlay-s3.bin');
    expect(padToFlashSize(new Uint8Array([0xe9]), 'overlay-s3-board' as BoardKind)[0]).toBe(0xe9);
    // A kind it does not answer for keeps the table.
    fetched.length = 0;
    await getEsp32Firmware('esp32-s3' as BoardKind);
    expect(fetched[0]).toMatch(/ESP32_GENERIC_S3-/);
  });

  it('gives the table back when the overlay is removed', async () => {
    installEsp32MicroPythonImages(() => IMAGE);
    installEsp32MicroPythonImages(null);
    await getEsp32Firmware('esp32' as BoardKind);
    expect(fetched[0]).toMatch(/^https:\/\/micropython\.org\//);
  });
});
