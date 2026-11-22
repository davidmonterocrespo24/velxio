/**
 * Cheap, stable fingerprint of what a board compile depends on: its
 * workspace files (name + content), the language mode, and the per-board
 * build settings. Stored on the board when a program is recorded
 * (`compileBoardProgram`) and compared against the live sources to detect a
 * stale build (code edited after the last compile).
 *
 * FNV-1a over a canonical string; collisions are irrelevant here (a false
 * "fresh" only skips a warning) and speed matters (runs on every render of
 * the Flash dialog).
 */
import type { BoardInstance } from '../types/board';
import { deviceFiles } from './projectOnlyFiles';

export type BoardBuildSettings = Pick<BoardInstance, 'boardOptions' | 'libraries' | 'spiffsFiles'>;

export interface FingerprintFile {
  name: string;
  content: string;
}

const spiffsHashes = new WeakMap<NonNullable<BoardBuildSettings['spiffsFiles']>, string>();

export function fingerprintSources(
  board: Pick<BoardInstance, 'languageMode'> & BoardBuildSettings,
  files: readonly FingerprintFile[],
): string {
  // Project-only files (utils/projectOnlyFiles) are not built, so editing one
  // does not make the last build stale.
  const canonical =
    deviceFiles(files)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => `${f.name}\u0000${f.content}`)
      .join('\u0001') +
    `\u0002${board.languageMode ?? ''}\u0002${JSON.stringify(board.boardOptions ?? null)}` +
    `\u0002${JSON.stringify(board.libraries ?? null)}\u0002${fingerprintSpiffs(board.spiffsFiles)}`;
  return hash(canonical);
}

function fingerprintSpiffs(files: BoardBuildSettings['spiffsFiles']): string {
  if (!files?.length) return '';
  // SPIFFS files carry base64 payloads. Reuse the hash until the upload list changes.
  const cached = spiffsHashes.get(files);
  if (cached !== undefined) return cached;
  const fingerprint = hash(JSON.stringify(files));
  spiffsHashes.set(files, fingerprint);
  return fingerprint;
}

function hash(canonical: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${canonical.length.toString(36)}-${h.toString(16).padStart(8, '0')}`;
}
