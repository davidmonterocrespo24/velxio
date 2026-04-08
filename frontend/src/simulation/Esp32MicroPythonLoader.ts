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
  'esp32': {
    remote: 'https://micropython.org/resources/firmware/ESP32_GENERIC-20230426-v1.20.0.bin',
    cacheKey: 'micropython-esp32-v1.20.0',
    fallback: '/firmware/micropython-esp32.bin',
  },
  'esp32-s3': {
    remote: 'https://micropython.org/resources/firmware/ESP32_GENERIC_S3-20230426-v1.20.0.bin',
    cacheKey: 'micropython-esp32s3-v1.20.0',
    fallback: '/firmware/micropython-esp32s3.bin',
  },
  'esp32-c3': {
    remote: 'https://micropython.org/resources/firmware/ESP32_GENERIC_C3-20230426-v1.20.0.bin',
    cacheKey: 'micropython-esp32c3-v1.20.0',
    fallback: '/firmware/micropython-esp32c3.bin',
  },
};

/** Map any ESP32-family board kind to firmware variant key */
function toFirmwareVariant(boardKind: BoardKind): 'esp32' | 'esp32-s3' | 'esp32-c3' {
  if (boardKind === 'esp32-s3' || boardKind === 'xiao-esp32-s3' || boardKind === 'arduino-nano-esp32') {
    return 'esp32-s3';
  }
  if (boardKind === 'esp32-c3' || boardKind === 'xiao-esp32-c3' || boardKind === 'aitewinrobot-esp32c3-supermini') {
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
  const config = FIRMWARE_MAP[variant];
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

        try { await idbSet(config.cacheKey, firmware); } catch { /* non-fatal */ }

        console.log(`[ESP32-MicroPython] Firmware downloaded (${variant}, ${firmware.length} bytes)`);
        return firmware;
      }
    }
  } catch {
    console.warn(`[ESP32-MicroPython] Remote download failed for ${variant}, trying bundled fallback`);
  }

  // 3. Fallback to bundled firmware
  const response = await fetch(config.fallback);
  if (!response.ok) {
    throw new Error(`MicroPython firmware not available for ${variant} (remote and bundled both failed)`);
  }
  const buffer = await response.arrayBuffer();
  const firmware = new Uint8Array(buffer);

  try { await idbSet(config.cacheKey, firmware); } catch { /* non-fatal */ }

  console.log(`[ESP32-MicroPython] Firmware loaded from bundled fallback (${variant}, ${firmware.length} bytes)`);
  return firmware;
}

/** Convert Uint8Array to base64 string */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
