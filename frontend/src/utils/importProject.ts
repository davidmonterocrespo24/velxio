/**
 * Unified project import dispatcher.
 *
 * Velxio accepts two on-disk project formats:
 *
 *   - `.vlx`  — Velxio's native single-file JSON (boards + components + wires +
 *               file groups, optionally multi-board).  Handled by importVlxFile,
 *               which writes directly into the simulator + editor stores.
 *
 *   - `.zip`  — Wokwi-compatible bundle (diagram.json + sketch.ino + headers +
 *               libraries.txt).  Handled by importFromWokwiZip, which returns a
 *               structured payload that callers apply to the stores themselves
 *               (so the toolbar can also pop the "install missing libraries"
 *               modal afterwards).
 *
 * Both UI entry points (the toolbar "Import" button and the file-explorer
 * "Open project" button) route through this dispatcher so the user sees the
 * same behaviour regardless of which button they click — and so we have ONE
 * place to extend if a third format ever shows up.
 */

import { importVlxFile, VlxParseError } from './vlxFile';
import { importFromWokwiZip } from './wokwiZip';
import type { ImportResult } from './wokwiZip';
import { useProjectStore } from '../store/useProjectStore';

/**
 * Common result shape: `kind` tells callers which path ran, so they can
 * react appropriately (e.g. only the zip path needs the library-install
 * modal — the .vlx format inlines library state).
 */
export type ProjectImportResult =
  | { kind: 'vlx' }
  // Derived from ImportResult rather than restated. The zip branch used to
  // hand-copy a four-literal board union that the importer also declared, so
  // the two could disagree — and widening one without the other is a compile
  // error nobody would connect to a lost board (#268).
  | ({ kind: 'zip' } & ImportResult);

/**
 * Detect format from the filename + MIME type and dispatch to the right
 * loader.  Returns the loader's result so callers can chain UI behaviour
 * (e.g. show the install-libraries modal for zips).  Throws when the
 * format is unrecognised or the loader fails — callers should catch and
 * surface to the user.
 *
 * Note: `.vlx` loads itself directly into the stores; `.zip` returns a
 * payload that the caller must apply (we keep that asymmetry so the
 * toolbar can still trigger the libraries modal at the end).
 */
export async function importProjectFile(file: File): Promise<ProjectImportResult> {
  const lower = file.name.toLowerCase();

  if (lower.endsWith('.vlx') || (file.type === 'application/json' && !lower.endsWith('.zip'))) {
    try {
      await importVlxFile(file);
      return { kind: 'vlx' };
    } catch (err) {
      // Re-raise with a friendlier prefix.  VlxParseError already has a
      // good message; native errors get a clear context label.
      const msg = err instanceof VlxParseError ? err.message : (err as Error).message;
      throw new Error(`Could not load .vlx file:\n\n${msg}`);
    }
  }

  if (lower.endsWith('.zip')) {
    const result = await importFromWokwiZip(file);
    useProjectStore.getState().clearCurrentProject();
    return { kind: 'zip', ...result };
  }

  throw new Error(
    `Unsupported project file: ${file.name}.\n` +
      `Velxio accepts .vlx (Velxio projects) and .zip (Wokwi bundles).`,
  );
}

/** File-input `accept` attribute that pairs with importProjectFile. */
export const PROJECT_FILE_ACCEPT = '.vlx,.zip,application/json,application/zip';
