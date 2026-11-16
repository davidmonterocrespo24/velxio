/**
 * Esp32MicroPythonLoader — Downloads and caches MicroPython firmware for ESP32 boards
 *
 * Supports ESP32 (Xtensa LX6) and ESP32-S3 (Xtensa LX7).
 * Firmware is cached in IndexedDB for fast subsequent loads.
 * Falls back to bundled firmware in public/firmware/ if remote download fails.
 */

import { get as idbGet, set as idbSet } from 'idb-keyval';
import type { BoardKind } from '../types/board';

interface FirmwareConfig {
  remote: string;
  cacheKey: string;
  fallback: string;
}

const FIRMWARE_MAP: Record<string, FirmwareConfig> = {
  esp32: {
    remote: 'https://micropython.org/resources/firmware/ESP32_GENERIC-20260406-v1.28.0.bin',
    cacheKey: 'micropython-esp32-v1.28.0',
    fallback: '/firmware/micropython-esp32.bin',
  },
  'esp32-s3': {
    remote: 'https://micropython.org/resources/firmware/ESP32_GENERIC_S3-20260406-v1.28.0.bin',
    cacheKey: 'micropython-esp32s3-v1.28.0',
    fallback: '/firmware/micropython-esp32s3.bin',
  },
  'esp32-c3': {
    remote: 'https://micropython.org/resources/firmware/ESP32_GENERIC_C3-20260406-v1.28.0.bin',
    cacheKey: 'micropython-esp32c3-v1.28.0',
    fallback: '/firmware/micropython-esp32c3.bin',
  },
};

/** The MicroPython image an overlay serves for a board kind: where it is (same
 *  origin), its IndexedDB key, and the flash offset of its first byte. */
export interface Esp32MicroPythonImage {
  url: string;
  cacheKey: string;
  flashOffset: number;
}

type Esp32MicroPythonImageResolver = (boardKind: BoardKind) => Esp32MicroPythonImage | null;

let overlayImageFor: Esp32MicroPythonImageResolver = () => null;

/**
 * Overlay seam (velxio/velxio-prod#219): the image a board kind boots, when an
 * overlay serves it. The table above knows this edition's kinds and asks
 * micropython.org first; an overlay board fell through to the classic ESP32
 * image there. The default answers nothing, and the table decides.
 */
export function installEsp32MicroPythonImages(resolve: Esp32MicroPythonImageResolver | null): void {
  overlayImageFor = resolve ?? (() => null);
}

function overlayFirmware(boardKind: BoardKind): FirmwareConfig | null {
  const image = overlayImageFor(boardKind);
  return image ? { remote: image.url, cacheKey: image.cacheKey, fallback: image.url } : null;
}

function overlayFlashOffset(boardKind: BoardKind | undefined): number | null {
  return boardKind ? (overlayImageFor(boardKind)?.flashOffset ?? null) : null;
}

/** Map any ESP32-family board kind to firmware variant key */
export function toFirmwareVariant(boardKind: BoardKind): 'esp32' | 'esp32-s3' | 'esp32-c3' {
  if (
    boardKind === 'esp32-s3' ||
    boardKind === 'xiao-esp32-s3' ||
    boardKind === 'arduino-nano-esp32'
  ) {
    return 'esp32-s3';
  }
  if (
    boardKind === 'esp32-c3' ||
    boardKind === 'xiao-esp32-c3' ||
    boardKind === 'aitewinrobot-esp32c3-supermini'
  ) {
    return 'esp32-c3';
  }
  return 'esp32';
}

/**
 * Get MicroPython firmware binary for an ESP32 board.
 * Checks IndexedDB cache first, then remote, then bundled fallback.
 */
export async function getEsp32Firmware(
  boardKind: BoardKind,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const variant = toFirmwareVariant(boardKind);
  const config = overlayFirmware(boardKind) ?? FIRMWARE_MAP[variant];
  if (!config) throw new Error(`No MicroPython firmware for board: ${boardKind}`);

  // 1. Check IndexedDB cache
  try {
    const cached = await idbGet(config.cacheKey);
    if (cached instanceof Uint8Array && cached.length > 0) {
      console.log(`[ESP32-MicroPython] Firmware loaded from cache (${variant})`);
      return cached;
    }
  } catch {
    // IndexedDB unavailable
  }

  // 2. Try remote download
  try {
    const response = await fetch(config.remote);
    if (response.ok) {
      const total = Number(response.headers.get('content-length') || 0);
      const reader = response.body?.getReader();

      if (reader) {
        const chunks: Uint8Array[] = [];
        let loaded = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          onProgress?.(loaded, total);
        }

        const firmware = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
          firmware.set(chunk, offset);
          offset += chunk.length;
        }

        try {
          await idbSet(config.cacheKey, firmware);
        } catch {
          /* non-fatal */
        }

        console.log(
          `[ESP32-MicroPython] Firmware downloaded (${variant}, ${firmware.length} bytes)`,
        );
        return firmware;
      }
    }
  } catch {
    console.warn(
      `[ESP32-MicroPython] Remote download failed for ${variant}, trying bundled fallback`,
    );
  }

  // 3. Fallback to bundled firmware
  const response = await fetch(config.fallback);
  if (!response.ok) {
    throw new Error(
      `MicroPython firmware not available for ${variant} (remote and bundled both failed)`,
    );
  }
  const buffer = await response.arrayBuffer();
  const firmware = new Uint8Array(buffer);

  try {
    await idbSet(config.cacheKey, firmware);
  } catch {
    /* non-fatal */
  }

  console.log(
    `[ESP32-MicroPython] Firmware loaded from bundled fallback (${variant}, ${firmware.length} bytes)`,
  );
  return firmware;
}

/**
 * Build a QEMU-compatible flash image from a MicroPython firmware binary.
 *
 * Flash layout rules (same as esptool.py flashing offsets):
 *   ESP32 (LX6)  — firmware starts at 0x1000 (ROM bootloader reads 2nd-stage from there)
 *   ESP32-S3     — combined image starts at 0x0
 *   ESP32-C3     — combined image starts at 0x0
 *
 * The returned image is padded with 0xFF to the nearest valid QEMU flash size
 * (2, 4, 8, or 16 MB). QEMU esp32-picsimlab rejects any other size.
 */
export function padToFlashSize(firmware: Uint8Array, boardKind?: BoardKind): Uint8Array {
  const variant = boardKind ? toFirmwareVariant(boardKind) : 'esp32';
  // ESP32 (LX6): 2nd-stage bootloader header must sit at flash offset 0x1000.
  // Placing the .bin at 0x0 puts arbitrary bytes at 0x1000, triggering
  // "invalid header" loops from the ROM bootloader.
  const flashOffset = overlayFlashOffset(boardKind) ?? (variant === 'esp32' ? 0x1000 : 0x0);

  // Every official MicroPython ESP32 build (LX6, S3, C3) is compiled with
  // CONFIG_ESPTOOLPY_FLASHSIZE_4MB, so the firmware header declares 4 MB.
  // Using a smaller image makes the SPI flash driver fail with:
  //   E (141) spi_flash: Detected size(2048k) smaller than the size in the
  //                      binary image header(4096k). Probe failed.
  // (See https://github.com/davidmonterocrespo24/velxio/issues/122)
  const MIN_BYTES = 4 * 1024 * 1024;
  const VALID_BYTES = [2, 4, 8, 16].map((mb) => mb * 1024 * 1024);
  const target = VALID_BYTES.find(
    (size) => size >= Math.max(firmware.length + flashOffset, MIN_BYTES),
  );
  if (!target) {
    throw new Error(
      `MicroPython firmware too large for QEMU: ${firmware.length} bytes (max 16 MB)`,
    );
  }
  const padded = new Uint8Array(target).fill(0xff);
  padded.set(firmware, flashOffset);
  return padded;
}

/** Convert Uint8Array to base64 string */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
