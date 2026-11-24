/**
 * UF2 download helpers for RP2040 / RP2350 boards.
 *
 * Every Pico-family board ships a bootloader that mounts as a USB drive
 * (RPI-RP2 on RP2040, RP2350 on RP2350) when BOOTSEL is held at plug-in;
 * dropping a .uf2 on that drive programs the chip. That path needs no
 * driver, no Web Serial and no WebUSB, so it is the one route that works
 * in every browser. The compile endpoint returns the .uf2 picotool built
 * (`CompileResult.uf2_content`; the flash dialog asks for a build for real
 * hardware, see utils/boardCompile.ts hardwareBuildDiffers); these helpers
 * turn it into a file the user can save.
 */

import { BOARD_KIND_FQBN } from '../types/board';

/** Whether arduino-cli programs this FQBN with a .uf2 (the rp2040 core). */
export function fqbnUsesUf2(fqbn: string | null | undefined): boolean {
  return !!fqbn && fqbn.startsWith('rp2040:rp2040:');
}

/** Whether boards of this kind produce a .uf2 the user can copy by hand. */
export function boardKindHasUf2(boardKind: string): boolean {
  return fqbnUsesUf2((BOARD_KIND_FQBN as Record<string, string | null>)[boardKind]);
}

/** Decode the base64 the compile endpoint returns. */
export function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * A safe file name for the download: the project (or board) name with
 * anything outside [A-Za-z0-9._-] folded to '-', plus the .uf2 extension.
 */
export function uf2FileName(base: string | null | undefined, fallback: string): string {
  const stem = (base && base.trim()) || fallback;
  const safe = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
  return `${safe}.uf2`;
}

/**
 * Hand the .uf2 to the browser as a download. Uses a transient object URL
 * on an anchor click; the URL is revoked once the click has been dispatched.
 */
export function downloadUf2(uf2Base64: string, fileName: string): void {
  const bytes = base64ToBytes(uf2Base64);
  // base64ToBytes allocates its own ArrayBuffer, so the whole buffer IS
  // the file (a Uint8Array<ArrayBufferLike> is not a BlobPart to TS 5.7+).
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick: some browsers start the download after the
  // click handler returns and need the URL alive until then.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── File System Access: write the .uf2 onto the BOOTSEL drive ─────────────
//
// The bootloader's drive is a plain USB mass-storage volume, so a browser
// with the File System Access API (Chromium) can write the file there
// itself: no driver, no WebUSB claim. It is the route that still works for
// an RP2040 on Windows before WinUSB is installed, and it costs the user a
// directory picker instead of a file manager.

type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;

function directoryPicker(): DirectoryPicker | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { showDirectoryPicker?: DirectoryPicker };
  return typeof w.showDirectoryPicker === 'function' ? w.showDirectoryPicker.bind(window) : null;
}

/** Whether this browser can write to the drive directly. */
export function canSaveToDrive(): boolean {
  return directoryPicker() !== null;
}

/** Thrown when the picked folder is not a BOOTSEL drive. */
export class NotBootselDriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotBootselDriveError';
  }
}

/**
 * Ask for the drive (RPI-RP2 / RP2350), check it is one (every RP2
 * bootloader drive carries INFO_UF2.TXT), and write the file. The chip
 * reboots the instant the last block lands, which some hosts report as an
 * error on close; a close() failure after a complete write is a success.
 * Must be called from a user gesture (the picker needs one).
 */
export async function saveUf2ToDrive(
  uf2Base64: string,
  fileName: string,
  pick: DirectoryPicker | null = directoryPicker(),
): Promise<{ drive: string }> {
  if (!pick) throw new Error('This browser cannot write to the drive directly.');
  const dir = await pick({ mode: 'readwrite', id: 'velxio-bootsel' });
  try {
    await dir.getFileHandle('INFO_UF2.TXT');
  } catch {
    throw new NotBootselDriveError(
      `"${dir.name}" is not a BOOTSEL drive (no INFO_UF2.TXT). Pick the RPI-RP2 or RP2350 drive.`,
    );
  }
  const bytes = base64ToBytes(uf2Base64);
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes.buffer as ArrayBuffer);
  try {
    await writable.close();
  } catch {
    /* the board rebooted mid-close: the write itself completed */
  }
  return { drive: dir.name };
}
