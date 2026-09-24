/**
 * sdCardFiles.ts — assemble the microSD card's FAT16 image from the files that
 * should live on it.
 *
 * Two sources, matching the Wokwi model:
 *   - FREE: the project's workspace files are auto-copied (text sources, etc.).
 *   - PAID: user-uploaded files (binaries included) from the "SD Card" panel.
 *
 * Uploaded files win over a project file of the same name. The result is a
 * Uint8Array disk image handed to the `microsd-card` simulation part via
 * `element.sdImageData`.
 */
import { buildFat16Image, normalizeSdPath, type SdFile, type BuildFatOptions } from './fatImage';

export interface WorkspaceFileLike {
  name: string;
  content: string;
}

/** An uploaded SD file as persisted on the component (`properties.sdFiles`). */
export interface UploadedSdFile {
  /** Path on the card, '/'-separated ("MUSIC/tracklist.txt"); a folder
   *  upload keeps its tree this way. Plain names land in the root. */
  name: string;
  /** Base64 of the raw bytes (binaries included). */
  contentB64: string;
}

/** Max total size of uploaded files — matches the FAT16 volume (Wokwi ~8 MB). */
export const SD_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Decode the persisted `properties.sdFiles` into builder-ready SdFile[]. */
export function decodeSdFiles(raw: unknown): SdFile[] {
  if (!Array.isArray(raw)) return [];
  const out: SdFile[] = [];
  for (const e of raw) {
    if (e && typeof e.name === 'string' && typeof e.contentB64 === 'string') {
      const name = normalizeSdPath(e.name);
      if (!name) continue;
      try {
        out.push({ name, data: b64ToBytes(e.contentB64) });
      } catch {
        /* skip malformed entry */
      }
    }
  }
  return out;
}

/** Source files never land on the card: on real hardware your code lives in
 *  flash, not on the microSD, and a sketch listing the card should see its
 *  DATA (csv, json, txt, wav...), not its own source. Uploads are exempt —
 *  an explicit upload always lands, whatever its extension. */
const SD_EXCLUDED_SOURCES = /\.(ino|h|hpp|c|cpp|py)$/i;

/**
 * Build the SD image from the project workspace files (auto-copied, free) plus
 * any uploaded files (paid). Uploaded files override same-named project files.
 */
export function buildProjectSdImage(
  workspaceFiles: WorkspaceFileLike[],
  uploaded: SdFile[] = [],
  opts?: BuildFatOptions,
): Uint8Array {
  // Keyed by normalised, case-folded PATH: FAT is case-insensitive and
  // "MUSIC/a.txt" and "music/a.txt" are the same file.
  const byName = new Map<string, SdFile>();
  for (const f of workspaceFiles) {
    if (SD_EXCLUDED_SOURCES.test(f.name)) continue;
    const name = normalizeSdPath(f.name);
    if (!name) continue;
    byName.set(name.toLowerCase(), { name, data: new TextEncoder().encode(f.content) });
  }
  for (const f of uploaded) {
    const name = normalizeSdPath(f.name);
    if (!name) continue;
    byName.set(name.toLowerCase(), { name, data: f.data });
  }
  return buildFat16Image([...byName.values()], opts);
}
