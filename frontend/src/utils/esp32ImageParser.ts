/**
 * ESP32 image format parser.
 *
 * The backend produces a merged 4 MB flash image containing:
 *   offset 0x0000 : empty (0xFF)
 *   offset 0x1000 : bootloader  (ESP32 image format)
 *   offset 0x8000 : partition table
 *   offset 0x10000: application (ESP32 image format)  ← we parse this
 *
 * ESP32 image header (24 bytes, ESP-IDF esp_image_format.h):
 *   +0  magic          0xE9
 *   +1  segment_count
 *   +2  spi_mode
 *   +3  spi_speed_size
 *   +4  entry_addr     uint32 LE
 *   +8  … extended fields …
 *   total: 24 bytes
 *
 * Each segment (8-byte header + data):
 *   +0  load_addr  uint32 LE  — virtual address to load data at
 *   +4  data_len   uint32 LE
 *   +8  data[data_len]
 */

export const ESP32_APP_FLASH_OFFSET = 0x10000;
const ESP32_MAGIC = 0xe9;
const HEADER_SIZE = 24;
const SEG_HDR_SIZE = 8;

export interface Esp32Segment {
  loadAddr: number;
  data: Uint8Array;
}

export interface Esp32ParsedImage {
  entryPoint: number;
  segments: Esp32Segment[];
}

function parseAppAt(img: Uint8Array, base: number): Esp32ParsedImage {
  const view = new DataView(img.buffer, img.byteOffset, img.byteLength);

  if (view.getUint8(base) !== ESP32_MAGIC) {
    throw new Error(
      `Bad ESP32 magic at 0x${base.toString(16)}: ` +
        `expected 0xE9, got 0x${view.getUint8(base).toString(16)}`,
    );
  }

  const segCount = view.getUint8(base + 1);
  const entryPoint = view.getUint32(base + 4, /*littleEndian=*/ true);

  const segments: Esp32Segment[] = [];
  let pos = base + HEADER_SIZE;

  for (let i = 0; i < segCount; i++) {
    if (pos + SEG_HDR_SIZE > img.length) break;

    const loadAddr = view.getUint32(pos, true);
    const dataLen = view.getUint32(pos + 4, true);
    pos += SEG_HDR_SIZE;

    if (pos + dataLen > img.length) {
      console.warn(`[esp32ImageParser] Segment ${i} data truncated`);
      break;
    }

    segments.push({ loadAddr, data: img.slice(pos, pos + dataLen) });
    pos += dataLen;
  }

  return { entryPoint, segments };
}

/**
 * Parse a merged ESP32 flash image or a raw app binary.
 *
 * Accepts:
 *  - 4 MB merged image (bootloader + partitions + app) — reads app at 0x10000
 *  - Raw app binary (magic 0xE9 at offset 0)
 *
 * Throws if no valid image is found.
 */
export function parseMergedFlashImage(data: Uint8Array): Esp32ParsedImage {
  // Standard merged image: app at offset 0x10000
  if (
    data.length >= ESP32_APP_FLASH_OFFSET + HEADER_SIZE &&
    data[ESP32_APP_FLASH_OFFSET] === ESP32_MAGIC
  ) {
    return parseAppAt(data, ESP32_APP_FLASH_OFFSET);
  }

  // Fallback: raw app binary (no bootloader prefix)
  if (data.length >= HEADER_SIZE && data[0] === ESP32_MAGIC) {
    return parseAppAt(data, 0);
  }

  throw new Error(
    `No valid ESP32 image magic found ` +
      `(tried offsets 0x10000 and 0x0, image size ${data.length} bytes)`,
  );
}
