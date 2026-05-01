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
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';

/** Strip BoardInstance down to JSON-safe fields (drop runtime state). */
function serialisableBoard(b: BoardInstance) {
  return {
    id: b.id,
    boardKind: b.boardKind,
    x: b.x,
    y: b.y,
    activeFileGroupId: b.activeFileGroupId,
    languageMode: b.languageMode,
    serialBaudRate: b.serialBaudRate,
    compiledProgram: b.compiledProgram,
  };
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

  const fileGroups = sim.boards.map((b) => ({
    groupId: b.activeFileGroupId,
    files: (editor.fileGroups[b.activeFileGroupId] ?? []).map((f) => ({
      name: f.name,
      content: f.content,
    })),
  }));

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
    new Set(sim.boards.map((b) => b.activeFileGroupId)),
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
    boards: sim.boards.map(serialisableBoard),
    activeId: sim.activeBoardId,
    components: sim.components,
    wires: wiresHash,
    groups: groupsForHash,
  };
  return JSON.stringify(payload);
}
