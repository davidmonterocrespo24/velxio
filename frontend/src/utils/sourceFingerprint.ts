/**
 * Cheap, stable fingerprint of what a board compile depends on: its
 * workspace files (name + content), the language mode and the per-board
 * build options. Stored on the board when a program is recorded
 * (`compileBoardProgram`) and compared against the live sources to detect a
 * stale build (code edited after the last compile).
 *
 * FNV-1a over a canonical string; collisions are irrelevant here (a false
 * "fresh" only skips a warning) and speed matters (runs on every render of
 * the Flash dialog).
 */
import type { BoardInstance } from '../types/board';
import { deviceFiles } from './projectOnlyFiles';

export interface FingerprintFile {
  name: string;
  content: string;
}

export function fingerprintSources(
  board: Pick<BoardInstance, 'languageMode' | 'boardOptions'>,
  files: readonly FingerprintFile[],
): string {
  // Project-only files (utils/projectOnlyFiles) are not built, so editing one
  // does not make the last build stale.
  const canonical =
    deviceFiles(files)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => `${f.name}\u0000${f.content}`)
      .join('\u0001') +
    `\u0002${board.languageMode ?? ''}\u0002${JSON.stringify(board.boardOptions ?? null)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${canonical.length.toString(36)}-${h.toString(16).padStart(8, '0')}`;
}
