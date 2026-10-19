/**
 * Shared helpers for serialising the simulator + editor state into a project
 * save payload, and for hashing that state to detect dirty changes.
 *
 * Used by SaveProjectModal (manual save) and useAutoSaveProject (silent
 * background updates).
 */

import type { ProjectSaveData } from '../services/projectService';
import type { BoardInstance } from '../types/board';
import type { Wire } from '../types/wire';
import { useEditorStore, chipFileGroupId } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';

/**
 * Editor groups owned by programmable custom-chips on the canvas (those whose
 * `group-chip-<id>` group exists). A chip's program (ROM source / C) lives in
 * its own group, exactly like a board sketch, so it must be serialised and
 * dirty-checked alongside the board groups — otherwise saving would drop it.
 */
function chipGroupIdsWithFiles(): string[] {
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();
  return sim.components
    .filter((c) => c.metadataId === 'custom-chip')
    .map((c) => chipFileGroupId(c.id))
    .filter((gid) => (editor.fileGroups[gid]?.length ?? 0) > 0);
}

/** Strip BoardInstance down to JSON-safe fields (drop runtime state). */
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
    // compiledProgram is deliberately NOT persisted. The firmware blob was
    // 99.99% of a typical ESP32 save payload (~1.04 MB base64 for a bare
    // board), pushing every real project against the request-size ceiling,
    // and a restored binary is stale the moment the code differs from what
    // was compiled. Sources are saved; the binary is recompiled on demand.
    // (Loaders still accept compiledProgram from old rows.)
    // ESP32 board options + uploaded SPIFFS files. Optional, only present
    // after the user has opened Board Options... at least once. Both ride
    // inside boards_json so there's no DB migration.
    boardOptions: b.boardOptions,
    spiffsFiles: b.spiffsFiles,
    // Files the user put on the board's built-in microSD. Same shape and same
    // reasoning as spiffsFiles above — an upload is the user's input, not
    // derived data like compiledProgram, so it belongs to the project. Without
    // this a project saved with files on its card came back with an empty one.
    sdFiles: b.sdFiles,
    // P2.4 — this board's declared library manifest (compile scope). Rides in
    // boards_json so it round-trips, dirty-checks and autosaves for free.
    libraries: b.libraries,
  };
}

/** Union of every board's declared library manifest, sorted + de-duped.
 *  Persisted as the project-level `libraries_json` for backward-compat readers
 *  and as the backend's fallback scope when a client sends no per-board list. */
function unionBoardLibraries(boards: BoardInstance[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of boards) {
    for (const lib of b.libraries ?? []) {
      if (!seen.has(lib)) {
        seen.add(lib);
        out.push(lib);
      }
    }
  }
  return out.sort();
}

interface SnapshotInputs {
  name?: string;
  description?: string;
  isPublic?: boolean;
}

/**
 * Build the payload sent to POST/PUT /api/projects. Includes everything the
 * server cares about: boards_json, file_groups, components, wires, and the
 * legacy `files` / `code` fields for backwards compat.
 */
export function buildSavePayload(meta: SnapshotInputs = {}): ProjectSaveData {
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();

  const activeBoard =
    sim.boards.find((b) => b.id === sim.activeBoardId) ?? sim.boards[0];
  const boardKind = activeBoard?.boardKind ?? 'arduino-uno';

  const activeGroupId = activeBoard?.activeFileGroupId ?? '';
  const activeFiles =
    (editor.fileGroups[activeGroupId]?.length
      ? editor.fileGroups[activeGroupId]
      : editor.files) ?? editor.files;

  // Legacy `code` field — primary .ino content of the active board.
  const code =
    activeFiles.find((f) => f.name.endsWith('.ino'))?.content ??
    activeFiles[0]?.content ??
    '';

  const boardGroups = sim.boards.map((b) => ({
    groupId: b.activeFileGroupId,
    files: (editor.fileGroups[b.activeFileGroupId] ?? []).map((f) => ({
      name: f.name,
      content: f.content,
    })),
  }));
  // Programmable-chip program groups round-trip too — same shape, restored on
  // load by replaceFileGroups (the group id is derived from the chip's id).
  const chipGroups = chipGroupIdsWithFiles().map((gid) => ({
    groupId: gid,
    files: (editor.fileGroups[gid] ?? []).map((f) => ({
      name: f.name,
      content: f.content,
    })),
  }));
  const fileGroups = [...boardGroups, ...chipGroups];

  // P2.4 — per-board manifests live inside boards_json (serialisableBoard).
  // The project-level libraries_json is their UNION: kept for backward-compat
  // readers and as the backend's fallback compile scope when a client sends no
  // per-board list. Always sent (no clobber risk: boards_json is the source of
  // truth and round-trips natively, so the union is always recomputable).
  const unionLibs = unionBoardLibraries(sim.boards);

  return {
    name: meta.name ?? '',
    description: meta.description,
    is_public: meta.isPublic ?? true,
    board_type: boardKind,
    files: activeFiles.map((f) => ({ name: f.name, content: f.content })),
    file_groups: fileGroups,
    code,
    components_json: JSON.stringify(sim.components),
    wires_json: JSON.stringify(sim.wires),
    boards_json: JSON.stringify(sim.boards.map(serialisableBoard)),
    libraries_json: JSON.stringify(unionLibs),
  };
}

/**
 * Compact deterministic fingerprint of the parts of the workspace that the
 * server persists. Used for dirty-checking by the auto-save hook.
 *
 * Excludes meta fields (name/description/isPublic) — those only change via
 * the manual save modal.
 */
export function computeProjectStateHash(): string {
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();

  // Group file contents only for groups referenced by an existing board, in
  // a stable order (sorted by groupId).
  const referencedGroups = Array.from(
    new Set([...sim.boards.map((b) => b.activeFileGroupId), ...chipGroupIdsWithFiles()]),
  ).sort();
  const groupsForHash = referencedGroups.map((gid) => ({
    g: gid,
    f: (editor.fileGroups[gid] ?? []).map((f) => [f.name, f.content]),
  }));

  // Wires/components: serialise as-is. Object key order is stable in JSON.stringify
  // when the keys are insertion-ordered (which Zustand state respects).
  const wiresHash = (sim.wires as Wire[]).map((w) => ({
    id: w.id,
    s: [w.start.componentId, w.start.pinName],
    e: [w.end.componentId, w.end.pinName],
    c: w.color,
    sig: w.signalType,
    wp: w.waypoints,
  }));

  const payload = {
    // boards carry their per-board `libraries` via serialisableBoard, so
    // declaring/removing a library marks the project dirty and autosaves.
    boards: sim.boards.map(serialisableBoard),
    activeId: sim.activeBoardId,
    components: sim.components,
    wires: wiresHash,
    groups: groupsForHash,
  };
  return JSON.stringify(payload);
}
