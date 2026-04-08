/**
 * MicroPythonLoader — Loads MicroPython firmware + user files into RP2040 flash
 *
 * 1. Parses UF2 firmware and writes it to flash
 * 2. Creates a LittleFS image with user .py files and writes it to flash at 0xa0000
 * 3. Caches the MicroPython firmware UF2 in IndexedDB for fast subsequent loads
 */

import { get as idbGet, set as idbSet } from 'idb-keyval';
import createLittleFS from 'littlefs';

// Flash geometry (matches rp2040js and MicroPython defaults)
const FLASH_START_ADDRESS = 0x10000000;
const MICROPYTHON_FS_FLASH_START = 0xa0000;
const MICROPYTHON_FS_BLOCK_SIZE = 4096;
const MICROPYTHON_FS_BLOCK_COUNT = 352;

// UF2 block constants
const UF2_MAGIC_START0 = 0x0a324655;
const UF2_MAGIC_START1 = 0x9e5d5157;
const UF2_BLOCK_SIZE = 512;
const UF2_PAYLOAD_SIZE = 256;
const UF2_DATA_OFFSET = 32;
const UF2_ADDR_OFFSET = 12;

// Firmware cache key for IndexedDB
const FIRMWARE_CACHE_KEY = 'micropython-rp2040-uf2-v1.20.0';

// Bundled fallback path (placed in public/firmware/)
const FIRMWARE_FALLBACK_PATH = '/firmware/micropython-rp2040.uf2';

// Remote firmware URL
const FIRMWARE_REMOTE_URL =
  'https://micropython.org/resources/firmware/RPI_PICO-20230426-v1.20.0.uf2';

/**
 * Parse UF2 binary and write payload blocks into RP2040 flash.
 * UF2 format: 512-byte blocks, each with a 256-byte payload targeted at a flash address.
 */
export function loadUF2(uf2Data: Uint8Array, flash: Uint8Array): void {
  const view = new DataView(uf2Data.buffer, uf2Data.byteOffset, uf2Data.byteLength);

  for (let offset = 0; offset + UF2_BLOCK_SIZE <= uf2Data.length; offset += UF2_BLOCK_SIZE) {
    const magic0 = view.getUint32(offset, true);
    const magic1 = view.getUint32(offset + 4, true);
    if (magic0 !== UF2_MAGIC_START0 || magic1 !== UF2_MAGIC_START1) {
      continue; // skip non-UF2 blocks
    }

    const flashAddress = view.getUint32(offset + UF2_ADDR_OFFSET, true);
    const payload = uf2Data.subarray(offset + UF2_DATA_OFFSET, offset + UF2_DATA_OFFSET + UF2_PAYLOAD_SIZE);
    const flashOffset = flashAddress - FLASH_START_ADDRESS;

    if (flashOffset >= 0 && flashOffset + UF2_PAYLOAD_SIZE <= flash.length) {
      flash.set(payload, flashOffset);
    }
  }
}

/**
 * Create a LittleFS filesystem image containing the user's Python files
 * and write it into RP2040 flash at the MicroPython filesystem offset.
 */
export async function loadUserFiles(
  files: Array<{ name: string; content: string }>,
  flash: Uint8Array,
): Promise<void> {
  // Create a backing buffer for the LittleFS filesystem
  const fsBuffer = new Uint8Array(MICROPYTHON_FS_BLOCK_COUNT * MICROPYTHON_FS_BLOCK_SIZE);

  // Initialize the littlefs WASM module
  const lfs = await createLittleFS({});

  // Register flash read/write callbacks for the WASM module
  const flashRead = lfs.addFunction(
    (_cfg: number, block: number, off: number, buffer: number, size: number) => {
      const start = block * MICROPYTHON_FS_BLOCK_SIZE + off;
      lfs.HEAPU8.set(fsBuffer.subarray(start, start + size), buffer);
      return 0;
    },
    'iiiiii',
  );

  const flashProg = lfs.addFunction(
    (_cfg: number, block: number, off: number, buffer: number, size: number) => {
      const start = block * MICROPYTHON_FS_BLOCK_SIZE + off;
      fsBuffer.set(lfs.HEAPU8.subarray(buffer, buffer + size), start);
      return 0;
    },
    'iiiiii',
  );

  const flashErase = lfs.addFunction(
    (_cfg: number, _block: number) => 0,
    'iii',
  );

  const flashSync = lfs.addFunction(() => 0, 'ii');

  // Create LittleFS config and instance
  const config = lfs._new_lfs_config(
    flashRead, flashProg, flashErase, flashSync,
    MICROPYTHON_FS_BLOCK_COUNT, MICROPYTHON_FS_BLOCK_SIZE,
  );
  const lfsInstance = lfs._new_lfs();

  // Format and mount
  lfs._lfs_format(lfsInstance, config);
  lfs._lfs_mount(lfsInstance, config);

  // Write user files using cwrap for automatic string marshalling
  const writeFile = lfs.cwrap('lfs_write_file', 'number', ['number', 'string', 'string', 'number']);

  for (const file of files) {
    const fileName = file.name;
    const content = file.content;
    writeFile(lfsInstance, fileName, content, content.length);
  }

  // Unmount and free
  lfs._lfs_unmount(lfsInstance);
  lfs._free(lfsInstance);
  lfs._free(config);

  // Copy the LittleFS image into RP2040 flash at the filesystem offset
  flash.set(fsBuffer, MICROPYTHON_FS_FLASH_START);
}

/**
 * Get the MicroPython UF2 firmware binary.
 * Checks IndexedDB cache first, then tries remote download, then bundled fallback.
 */
export async function getFirmware(
  onProgress?: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  // 1. Check IndexedDB cache
  try {
    const cached = await idbGet(FIRMWARE_CACHE_KEY);
    if (cached instanceof Uint8Array && cached.length > 0) {
      console.log('[MicroPython] Firmware loaded from cache');
      return cached;
    }
  } catch {
    // IndexedDB unavailable, continue
  }

  // 2. Try remote download
  try {
    const response = await fetch(FIRMWARE_REMOTE_URL);
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

        // Cache for next time
        try {
          await idbSet(FIRMWARE_CACHE_KEY, firmware);
        } catch {
          // Cache write failure is non-fatal
        }

        console.log(`[MicroPython] Firmware downloaded (${firmware.length} bytes)`);
        return firmware;
      }
    }
  } catch {
    console.warn('[MicroPython] Remote firmware download failed, trying bundled fallback');
  }

  // 3. Fallback to bundled firmware
  const response = await fetch(FIRMWARE_FALLBACK_PATH);
  if (!response.ok) {
    throw new Error('MicroPython firmware not available (remote and bundled both failed)');
  }
  const buffer = await response.arrayBuffer();
  const firmware = new Uint8Array(buffer);

  // Cache for next time
  try {
    await idbSet(FIRMWARE_CACHE_KEY, firmware);
  } catch {
    // non-fatal
  }

  console.log(`[MicroPython] Firmware loaded from bundled fallback (${firmware.length} bytes)`);
  return firmware;
}
