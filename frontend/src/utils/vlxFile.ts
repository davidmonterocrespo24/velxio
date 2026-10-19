/**
 * .vlx file format — portable project export/import for OSS Velxio.
 *
 * Phase 4 of the OSS / pro split. The OSS image has no auth, no DB, no
 * server-side project persistence. The user's work is otherwise ephemeral
 * (lost on tab refresh). `.vlx` is a single-file JSON snapshot that
 * round-trips everything the server-side Save flow captures:
 *
 *   {
 *     "format": "velxio-project",
 *     "version": 1,
 *     "exportedAt": "ISO timestamp",
 *     "name": "project name (optional)",
 *     "boards": [...],
 *     "fileGroups": { "<groupId>": [{ name, content }, ...] },
 *     "components": [...],
 *     "wires": [...],
 *     "activeBoardId": "..." | null
 *   }
 *
 * Reading: `parseVlxFile(File) → payload` validates and returns a shape
 *  directly consumable by `useSimulatorStore.loadProjectState(...)`.
 *
 * Writing: `buildVlxBlob()` snapshots the current store state into a
 *  `Blob`, ready to feed an `<a download>` link.
 *
 * The format is INTENTIONALLY identical to the server's POST/PUT body
 * for `/api/projects/`, so a pro user can export-from-Pro / import-into-
 * OSS (and vice-versa) without surprises.
 */

import type { BoardInstance } from '../types/board';
import type { Component } from '../types/component';
import type { Wire } from '../types/wire';
import { useEditorStore, chipFileGroupId } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useProjectStore } from '../store/useProjectStore';

const VLX_FORMAT = 'velxio-project';
const VLX_VERSION = 1;

export interface VlxPayload {
  format: typeof VLX_FORMAT;
  version: number;
  exportedAt: string;
  name?: string;
  boards: Array<{
    id: string;
    name?: string;
    boardKind: string;
    x: number;
    y: number;
    activeFileGroupId: string;
    languageMode?: string;
    serialBaudRate?: number;
    sdFiles?: Array<{ name: string; contentB64: string }>;
    /** Declared library manifest (compile scope). Absent in old files. */
    libraries?: string[];
  }>;
  fileGroups: Record<string, Array<{ name: string; content: string }>>;
  /** EMPTY folders per group (folders holding files exist via name prefixes).
   *  Optional — absent in projects saved before folders shipped. */
  folderGroups?: Record<string, string[]>;
  components: Component[];
  wires: Wire[];
  activeBoardId: string | null;
}

function serialisableBoard(b: BoardInstance) {
  return {
    id: b.id,
    name: b.name,
    boardKind: b.boardKind,
    x: b.x,
    y: b.y,
    // Only a turned board carries it, so unrotated projects save unchanged.
    ...(b.rotation ? { rotation: b.rotation } : {}),
    activeFileGroupId: b.activeFileGroupId,
    languageMode: b.languageMode,
    serialBaudRate: b.serialBaudRate,
    // Built-in SD slot uploads (XIAO Sense etc.) travel with the project,
    // exactly like a microsd-card component's properties.sdFiles do.
    sdFiles: b.sdFiles,
    // The declared manifest must survive the .vlx round-trip: dropping it
    // silently reverted re-imported projects to scan-all resolution
    // (2026-08 library-contamination investigation).
    libraries: b.libraries,
  };
}

/**
 * Snapshot the current editor + simulator state into a VlxPayload object.
 * Pure function: no side effects.
 */
export function buildVlxPayload(opts: { name?: string } = {}): VlxPayload {
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();

  // Persist file groups referenced by a board, plus each programmable chip's
  // own program group (group-chip-<id>) — otherwise the chip's program would
  // be dropped on export. Stray groups from deleted boards don't round-trip.
  const referencedGroupIds = new Set(sim.boards.map((b) => b.activeFileGroupId));
  for (const c of sim.components) {
    if (c.metadataId !== 'custom-chip') continue;
    const gid = chipFileGroupId(c.id);
    if (editor.fileGroups[gid]?.length) referencedGroupIds.add(gid);
  }
  const fileGroups: VlxPayload['fileGroups'] = {};
  const folderGroups: NonNullable<VlxPayload['folderGroups']> = {};
  for (const gid of referencedGroupIds) {
    fileGroups[gid] = (editor.fileGroups[gid] ?? []).map((f) => ({
      name: f.name,
      content: f.content,
    }));
    const folders = editor.folderGroups[gid] ?? [];
    if (folders.length) folderGroups[gid] = folders;
  }

  return {
    format: VLX_FORMAT,
    version: VLX_VERSION,
    exportedAt: new Date().toISOString(),
    name: opts.name,
    boards: sim.boards.map(serialisableBoard),
    fileGroups,
    ...(Object.keys(folderGroups).length ? { folderGroups } : {}),
    components: sim.components,
    wires: sim.wires,
    activeBoardId: sim.activeBoardId,
  };
}

/** Build a Blob (MIME: application/json) carrying the current state. */
export function buildVlxBlob(opts: { name?: string } = {}): Blob {
  const payload = buildVlxPayload(opts);
  const json = JSON.stringify(payload, null, 2);
  return new Blob([json], { type: 'application/json' });
}

/** Sanitise a filename: keep letters, digits, dashes, dots, underscores. */
function safeFilename(name?: string): string {
  const base = (name ?? 'velxio-project').trim() || 'velxio-project';
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${cleaned || 'velxio-project'}.vlx`;
}

/**
 * Trigger a browser download of the current state as `<name>.vlx`.
 * Returns the filename actually used (for UI feedback).
 */
export function triggerDownloadVlx(opts: { name?: string } = {}): string {
  const blob = buildVlxBlob(opts);
  const filename = safeFilename(opts.name);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // The browser starts the download immediately. Revoke the URL on the
  // next tick so the click handler has time to settle before GC.
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
  return filename;
}

/** Thrown by parseVlxFile when the file isn't a valid .vlx payload. */
export class VlxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlxParseError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate that `data` is shaped like a VlxPayload. Throws VlxParseError
 * on mismatch with a human-readable reason. Keep the checks defensive —
 * users may edit .vlx files by hand or feed us a wrong file by accident.
 */
function validatePayload(data: unknown): VlxPayload {
  if (!isPlainObject(data)) {
    throw new VlxParseError('File is not a JSON object.');
  }
  if (data.format !== VLX_FORMAT) {
    throw new VlxParseError(
      `Not a Velxio project file (expected format="${VLX_FORMAT}", got ${JSON.stringify(
        data.format,
      )}).`,
    );
  }
  if (typeof data.version !== 'number') {
    throw new VlxParseError('Missing or invalid "version" field.');
  }
  if (data.version > VLX_VERSION) {
    throw new VlxParseError(
      `This file uses .vlx format version ${data.version}, but this Velxio supports up to v${VLX_VERSION}. Update Velxio to open it.`,
    );
  }
  if (!Array.isArray(data.boards)) {
    throw new VlxParseError('Missing or invalid "boards" array.');
  }
  if (!isPlainObject(data.fileGroups)) {
    throw new VlxParseError('Missing or invalid "fileGroups" object.');
  }
  if (data.folderGroups !== undefined && !isPlainObject(data.folderGroups)) {
    // Optional field (empty folders per group) — drop silently if malformed.
    delete data.folderGroups;
  }
  if (!Array.isArray(data.components)) {
    throw new VlxParseError('Missing or invalid "components" array.');
  }
  if (!Array.isArray(data.wires)) {
    throw new VlxParseError('Missing or invalid "wires" array.');
  }
  return data as unknown as VlxPayload;
}

/**
 * Read a File object (from a `<input type="file">` change event or a
 * drop), parse it as JSON, validate, and return the payload. Throws
 * VlxParseError on any failure.
 */
export async function parseVlxFile(file: File): Promise<VlxPayload> {
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    throw new VlxParseError(`Could not read file: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new VlxParseError(`Invalid JSON: ${(err as Error).message}`);
  }
  return validatePayload(parsed);
}

/**
 * Convenience wrapper: parse the file AND load its contents into the
 * simulator stores via `loadProjectState`. Returns the parsed payload
 * so the caller can show a confirmation toast or similar.
 */
export async function importVlxFile(file: File): Promise<VlxPayload> {
  const payload = await parseVlxFile(file);
  // CRITICAL — sever the current project identity BEFORE mutating any store
  // (same guard as loadExample.ts). With a saved project open, the auto-save
  // hook would otherwise see the imported content as dirty edits on the OLD
  // projectId and silently PUT the .vlx contents over the user's saved
  // project (and push the clobber to GitHub when the project is linked).
  useProjectStore.getState().clearCurrentProject();
  useSimulatorStore.getState().loadProjectState({
    boards: payload.boards as unknown as BoardInstance[],
    fileGroups: payload.fileGroups,
    folderGroups: payload.folderGroups,
    components: payload.components,
    wires: payload.wires,
    activeBoardId: payload.activeBoardId,
  });
  return payload;
}
