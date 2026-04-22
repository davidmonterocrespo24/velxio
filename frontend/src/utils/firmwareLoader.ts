/**
 * Firmware file loader — reads .hex, .bin, and .elf files and converts them
 * into the string format expected by compileBoardProgram().
 *
 * - AVR boards expect Intel HEX text
 * - RP2040 boards expect base64-encoded raw binary
 * - ESP32 boards expect base64-encoded binary (merged flash image or raw app)
 */

import type { BoardKind } from '../types/board';

// ── Format detection ─────────────────────────────────────────────────────────

export type FirmwareFormat = 'hex' | 'bin' | 'elf';

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // \x7FELF

export function detectFirmwareFormat(filename: string, bytes: Uint8Array): FirmwareFormat {
  // Check ELF magic
  if (
    bytes.length >= 4 &&
    bytes[0] === ELF_MAGIC[0] &&
    bytes[1] === ELF_MAGIC[1] &&
    bytes[2] === ELF_MAGIC[2] &&
    bytes[3] === ELF_MAGIC[3]
  ) {
    return 'elf';
  }

  // Check file extension
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'hex' || ext === 'ihex') return 'hex';
  if (ext === 'elf') return 'elf';

  // Check if content looks like Intel HEX (first non-empty line starts with ':')
  const firstByte = bytes[0];
  if (firstByte === 0x3a) return 'hex'; // ':' character

  return 'bin';
}

// ── ELF architecture detection ───────────────────────────────────────────────

// ELF e_machine values
const EM_ARM = 0x28;
const EM_AVR = 0x53;
const EM_XTENSA = 0x5e;
const EM_RISCV = 0xf3;

export interface ElfInfo {
  machine: number;
  is32bit: boolean;
  isLittleEndian: boolean;
  suggestedBoard: BoardKind | null;
  architectureName: string;
}

export function detectArchitectureFromElf(bytes: Uint8Array): ElfInfo | null {
  if (bytes.length < 20) return null;
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return null;

  const is32bit = bytes[4] === 1;
  const isLittleEndian = bytes[5] === 1;

  // e_machine at offset 18 (2 bytes)
  const machine = isLittleEndian ? bytes[18] | (bytes[19] << 8) : (bytes[18] << 8) | bytes[19];

  let suggestedBoard: BoardKind | null = null;
  let architectureName = 'Unknown';

  switch (machine) {
    case EM_AVR:
      suggestedBoard = 'arduino-uno';
      architectureName = 'AVR';
      break;
    case EM_ARM:
      suggestedBoard = 'raspberry-pi-pico';
      architectureName = 'ARM';
      break;
    case EM_RISCV:
      suggestedBoard = 'esp32-c3';
      architectureName = 'RISC-V';
      break;
    case EM_XTENSA:
      suggestedBoard = 'esp32';
      architectureName = 'Xtensa';
      break;
  }

  return { machine, is32bit, isLittleEndian, suggestedBoard, architectureName };
}

// ── ELF program extraction ───────────────────────────────────────────────────

/**
 * Extract loadable (PT_LOAD) segments from a 32-bit ELF file.
 * Returns a flat binary image starting at the lowest physical address.
 */
export function extractLoadSegmentsFromElf(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const is32bit = bytes[4] === 1;
  const isLE = bytes[5] === 1;

  if (!is32bit) {
    throw new Error('Only 32-bit ELF files are supported');
  }

  const u16 = (off: number) => (isLE ? view.getUint16(off, true) : view.getUint16(off, false));
  const u32 = (off: number) => (isLE ? view.getUint32(off, true) : view.getUint32(off, false));

  // ELF32 header fields
  const e_phoff = u32(28); // program header table offset
  const e_phentsize = u16(42); // program header entry size
  const e_phnum = u16(44); // number of program header entries

  if (e_phoff === 0 || e_phnum === 0) {
    throw new Error('ELF file has no program headers');
  }

  // Collect PT_LOAD segments
  const PT_LOAD = 1;
  const segments: { paddr: number; data: Uint8Array }[] = [];

  for (let i = 0; i < e_phnum; i++) {
    const phOff = e_phoff + i * e_phentsize;
    if (phOff + e_phentsize > bytes.length) break;

    const p_type = u32(phOff);
    if (p_type !== PT_LOAD) continue;

    const p_offset = u32(phOff + 4);
    const p_paddr = u32(phOff + 12);
    const p_filesz = u32(phOff + 16);

    if (p_filesz === 0) continue;
    if (p_offset + p_filesz > bytes.length) {
      throw new Error(`ELF segment at offset 0x${p_offset.toString(16)} extends beyond file`);
    }

    segments.push({
      paddr: p_paddr,
      data: bytes.slice(p_offset, p_offset + p_filesz),
    });
  }

  if (segments.length === 0) {
    throw new Error('No loadable segments found in ELF file');
  }

  // Sort by physical address and create flat binary
  segments.sort((a, b) => a.paddr - b.paddr);
  const baseAddr = segments[0].paddr;
  const lastSeg = segments[segments.length - 1];
  const totalSize = lastSeg.paddr - baseAddr + lastSeg.data.length;
  const result = new Uint8Array(totalSize);

  for (const seg of segments) {
    result.set(seg.data, seg.paddr - baseAddr);
  }

  return result;
}

// ── Binary ↔ Intel HEX conversion ───────────────────────────────────────────

/** Convert a flat binary to Intel HEX text format (16 bytes per data record). */
export function binaryToIntelHex(data: Uint8Array): string {
  const lines: string[] = [];
  const BYTES_PER_LINE = 16;

  for (let addr = 0; addr < data.length; addr += BYTES_PER_LINE) {
    const count = Math.min(BYTES_PER_LINE, data.length - addr);
    let line = ':';

    // Byte count
    line += count.toString(16).padStart(2, '0').toUpperCase();
    // Address (16-bit)
    line += (addr & 0xffff).toString(16).padStart(4, '0').toUpperCase();
    // Record type 0x00 = data
    line += '00';

    let checksum = count + ((addr >> 8) & 0xff) + (addr & 0xff) + 0x00;
    for (let i = 0; i < count; i++) {
      const b = data[addr + i];
      line += b.toString(16).padStart(2, '0').toUpperCase();
      checksum += b;
    }

    // Two's complement checksum
    line += ((~checksum + 1) & 0xff).toString(16).padStart(2, '0').toUpperCase();
    lines.push(line);
  }

  // EOF record
  lines.push(':00000001FF');
  return lines.join('\n');
}

/** Convert ArrayBuffer to base64 string. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── Board classification helpers ─────────────────────────────────────────────

const AVR_BOARDS = new Set<BoardKind>(['arduino-uno', 'arduino-nano', 'arduino-mega', 'attiny85']);

const RP2040_BOARDS = new Set<BoardKind>(['raspberry-pi-pico', 'pi-pico-w']);

function isAvrBoard(kind: BoardKind): boolean {
  return AVR_BOARDS.has(kind);
}

function isRp2040Board(kind: BoardKind): boolean {
  return RP2040_BOARDS.has(kind);
}

// ── Main entry point ─────────────────────────────────────────────────────────

export interface FirmwareLoadResult {
  /** Program string ready for compileBoardProgram() */
  program: string;
  /** Detected format */
  format: FirmwareFormat;
  /** ELF info if available */
  elfInfo: ElfInfo | null;
  /** Human-readable status */
  message: string;
}

const MAX_FILE_SIZE = 16 * 1024 * 1024; // 16 MB absolute max

/**
 * Read a firmware file and convert it to the format expected by compileBoardProgram().
 *
 * @param file - The File object from the file input
 * @param boardKind - The current board's kind (determines output format)
 * @returns The program string + metadata
 */
export async function readFirmwareFile(
  file: File,
  boardKind: BoardKind,
): Promise<FirmwareLoadResult> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max ${MAX_FILE_SIZE / 1024 / 1024} MB.`,
    );
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const format = detectFirmwareFormat(file.name, bytes);

  let elfInfo: ElfInfo | null = null;
  let program: string;
  let message: string;

  switch (format) {
    case 'hex': {
      // Intel HEX — read as text
      const text = new TextDecoder().decode(bytes);
      if (isAvrBoard(boardKind)) {
        // AVR/RISC-V: pass HEX text directly
        program = text;
      } else {
        // Non-AVR boards: we could parse HEX → binary → base64, but loadHex also exists
        // for ESP32-C3 and RISC-V. Pass as text and let compileBoardProgram route it.
        program = text;
      }
      message = `Loaded Intel HEX firmware (${(file.size / 1024).toFixed(1)} KB)`;
      break;
    }

    case 'bin': {
      // Raw binary — convert to base64
      program = arrayBufferToBase64(buffer);
      message = `Loaded binary firmware (${(file.size / 1024).toFixed(1)} KB)`;
      break;
    }

    case 'elf': {
      elfInfo = detectArchitectureFromElf(bytes);
      const archName = elfInfo?.architectureName ?? 'unknown';

      // Extract loadable segments
      const loadData = extractLoadSegmentsFromElf(bytes);

      if (isAvrBoard(boardKind)) {
        // AVR needs Intel HEX text
        program = binaryToIntelHex(loadData);
        message = `Loaded ELF firmware (${archName}, ${(file.size / 1024).toFixed(1)} KB) → Intel HEX`;
      } else {
        // RP2040/ESP32 need base64 binary
        program = arrayBufferToBase64(loadData.buffer);
        message = `Loaded ELF firmware (${archName}, ${(file.size / 1024).toFixed(1)} KB) → binary`;
      }
      break;
    }
  }

  return { program, format, elfInfo, message };
}
