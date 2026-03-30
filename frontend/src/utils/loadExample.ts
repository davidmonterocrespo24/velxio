/**
 * Shared utility to load an example project into the editor and simulator stores.
 * Used by both ExamplesPage (gallery click) and ExampleLoaderPage (direct URL).
 */

import type { ExampleProject } from '../data/examples';
import type { BoardKind } from '../types/board';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useVfsStore } from '../store/useVfsStore';
import { isBoardComponent } from './boardPinMapping';
import { getInstalledLibraries, installLibrary } from '../services/libraryService';
import { trackOpenExample } from './analytics';

export interface LibraryInstallProgress {
  total: number;
  done: number;
  current: string;
}

/**
 * Install any missing Arduino libraries required by an example.
 * Calls onProgress for UI updates; silently continues on failure.
 */
export async function ensureLibraries(
  libs: string[],
  onProgress?: (progress: LibraryInstallProgress | null) => void,
): Promise<void> {
  if (libs.length === 0) return;
  try {
    const installed = await getInstalledLibraries();
    const installedNames = new Set(
      installed.map((l) => (l.library?.name ?? l.name ?? '').toLowerCase()),
    );
    const missing = libs.filter((l) => !installedNames.has(l.toLowerCase()));
    if (missing.length === 0) return;

    onProgress?.({ total: missing.length, done: 0, current: missing[0] });
    for (let i = 0; i < missing.length; i++) {
      onProgress?.({ total: missing.length, done: i, current: missing[i] });
      await installLibrary(missing[i]);
    }
    onProgress?.(null);
  } catch {
    onProgress?.(null);
  }
}

/**
 * Load an example project into the editor + simulator stores.
 * Does NOT navigate — the caller is responsible for navigation.
 */
export async function loadExample(
  example: ExampleProject,
  onLibraryProgress?: (progress: LibraryInstallProgress | null) => void,
): Promise<void> {
  trackOpenExample(example.title);

  // Auto-install required libraries
  if (example.libraries && example.libraries.length > 0) {
    await ensureLibraries(example.libraries, onLibraryProgress);
  }

  const {
    setComponents, setWires, setBoardType,
    activeBoardId, boards, addBoard, removeBoard, setActiveBoardId,
  } = useSimulatorStore.getState();

  if (example.boards && example.boards.length > 0) {
    // ── Multi-board loading ───────────────────────────────────────────────
    const currentIds = boards.map((b) => b.id);
    currentIds.forEach((id) => removeBoard(id));

    example.boards.forEach((eb) => {
      addBoard(eb.boardKind as BoardKind, eb.x, eb.y);
    });

    const { boards: newBoards } = useSimulatorStore.getState();
    example.boards.forEach((eb) => {
      const boardId = eb.boardKind;
      const board = newBoards.find((b) => b.id === boardId);
      if (!board) return;

      if (eb.code) {
        const filename =
          boardId === 'arduino-uno' || boardId === 'arduino-nano' || boardId === 'arduino-mega'
            ? 'sketch.ino'
            : 'main.cpp';
        useEditorStore.getState().setActiveGroup(board.activeFileGroupId);
        useEditorStore.getState().loadFiles([{ name: filename, content: eb.code }]);
      }

      if (eb.vfsFiles && boardId === 'raspberry-pi-3') {
        const vfsState = useVfsStore.getState();
        const tree = vfsState.getTree(boardId);
        for (const [nodeId, node] of Object.entries(tree)) {
          if (node.type === 'file' && eb.vfsFiles[node.name] !== undefined) {
            vfsState.setContent(boardId, nodeId, eb.vfsFiles[node.name]);
          }
        }
      }
    });

    const firstArduino = example.boards.find(
      (eb) =>
        eb.boardKind !== 'raspberry-pi-3' &&
        eb.boardKind !== 'esp32' &&
        eb.boardKind !== 'esp32-s3' &&
        eb.boardKind !== 'esp32-c3',
    );
    if (firstArduino) {
      setActiveBoardId(firstArduino.boardKind);
    }

    const componentsWithoutBoard = example.components.filter(
      (comp) =>
        !comp.type.includes('arduino') &&
        !comp.type.includes('pico') &&
        !comp.type.includes('raspberry') &&
        !comp.type.includes('esp32'),
    );
    setComponents(
      componentsWithoutBoard.map((comp) => ({
        id: comp.id,
        metadataId: comp.type.replace('wokwi-', ''),
        x: comp.x,
        y: comp.y,
        properties: comp.properties,
      })),
    );

    setWires(
      example.wires.map((wire) => ({
        id: wire.id,
        start: { componentId: wire.start.componentId, pinName: wire.start.pinName, x: 0, y: 0 },
        end: { componentId: wire.end.componentId, pinName: wire.end.pinName, x: 0, y: 0 },
        color: wire.color,
        waypoints: [],
      })),
    );
  } else {
    // ── Single-board loading ─────────────────────────────────────────────
    const targetBoard = example.boardType || 'arduino-uno';
    setBoardType(targetBoard);
    useEditorStore.getState().setCode(example.code);

    const componentsWithoutBoard = example.components.filter(
      (comp) =>
        !comp.type.includes('arduino') &&
        !comp.type.includes('pico') &&
        !comp.type.includes('esp32'),
    );
    setComponents(
      componentsWithoutBoard.map((comp) => ({
        id: comp.id,
        metadataId: comp.type.replace('wokwi-', ''),
        x: comp.x,
        y: comp.y,
        properties: comp.properties,
      })),
    );

    const boardInstanceId = activeBoardId ?? 'arduino-uno';
    const remapBoardId = (id: string) => (isBoardComponent(id) ? boardInstanceId : id);

    setWires(
      example.wires.map((wire) => ({
        id: wire.id,
        start: { componentId: remapBoardId(wire.start.componentId), pinName: wire.start.pinName, x: 0, y: 0 },
        end: { componentId: remapBoardId(wire.end.componentId), pinName: wire.end.pinName, x: 0, y: 0 },
        color: wire.color,
        waypoints: [],
      })),
    );
  }
}
