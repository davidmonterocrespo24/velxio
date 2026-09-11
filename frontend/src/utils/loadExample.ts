/**
 * Shared utility to load an example project into the editor and simulator stores.
 * Used by both ExamplesPage (gallery click) and ExampleLoaderPage (direct URL).
 */

import type { ExampleProject } from '../data/examples';
import type { BoardKind } from '../types/board';
import { isPiBoardKind } from '../types/board';
import { useEditorStore, chipFileGroupId, CHIP_GROUP_PREFIX } from '../store/useEditorStore';
import { useSimulatorStore, DEFAULT_BOARD_POSITION } from '../store/useSimulatorStore';
import { useElectricalStore } from '../store/useElectricalStore';
import { useProjectStore } from '../store/useProjectStore';
import { useVfsStore } from '../store/useVfsStore';
import { serverProvidesGalleryLibraries } from '../services/galleryLibrariesGate';
import { isBoardComponent } from './boardPinMapping';
import { getInstalledLibraries, installLibrary } from '../services/libraryService';
import { trackOpenExample } from './analytics';
import { stripBrandPrefix } from './exampleToBuildNetlistInput';

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
 * Programmable custom-chips (those with a `programFile`) keep their program
 * (ROM source / C) in their OWN editor file group — group-chip-<chipId> — so
 * it shows as a separate collapsible section in the file explorer, never mixed
 * into the board's sketch. This mirrors how every board owns a group.
 *
 * Seeds those groups from the example's `files[]` (matched by programFile
 * name), clearing any chip groups left over from a previously-loaded example.
 * Returns the set of program filenames (so the caller keeps them OUT of the
 * board's own group) and the created group ids (so a board-less example can
 * open the program as the active group).
 */
function seedChipProgramGroups(example: ExampleProject): {
  programFileNames: Set<string>;
  chipGroupIds: string[];
} {
  const editor = useEditorStore.getState();
  // Drop chip groups from a previously-loaded example so they don't linger.
  Object.keys(editor.fileGroups)
    .filter((g) => g.startsWith(CHIP_GROUP_PREFIX))
    .forEach((g) => editor.deleteFileGroup(g));

  const programFileNames = new Set<string>();
  const chipGroupIds: string[] = [];
  for (const comp of example.components ?? []) {
    if (stripBrandPrefix(comp.type) !== 'custom-chip') continue;
    const pf = String(
      (comp.properties as Record<string, unknown>)?.programFile ?? '',
    ).trim();
    if (!pf) continue; // behaviour / predefined chips have no editable program
    programFileNames.add(pf);
    const content = example.files?.find((f) => f.name === pf)?.content ?? '';
    const gid = chipFileGroupId(comp.id);
    editor.createFileGroup(gid, [{ name: pf, content }]);
    chipGroupIds.push(gid);
  }
  return { programFileNames, chipGroupIds };
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

  // CRITICAL — clear currentProject FIRST, before touching any other store.
  //
  // Otherwise: user has a saved project open (currentProject = { id, slug, …}),
  // navigates to /examples, clicks an example. We mutate the simulator +
  // editor stores below; the auto-save hook is still subscribed and still
  // thinks the active project is the user's saved one. It debounces a
  // PUT /api/projects/<old-id> with the example's components/wires/files
  // and OVERWRITES the user's saved project with the example contents.
  //
  // The auto-save hook is subscribed to useProjectStore and resets its
  // baseline (projectId=null, lastSavedHash=null) whenever currentProject?.id
  // changes. Clearing here BEFORE the mutations below guarantees the hook
  // sees null as projectId during every subsequent simulator/editor change,
  // so no PUT goes out.
  useProjectStore.getState().clearCurrentProject();
  // Analytics context: compiles/runs from this workspace stamp the example id.
  useProjectStore.getState().setCurrentExampleId(example.id);

  // P2.4 — this example's declared manifest (compile scope) is assigned to each
  // board it creates at the END of this function (the boards don't exist yet).

  // Loading a new example always starts unpaused — otherwise the canvas
  // would open with every LED frozen at the previous example's state.
  useElectricalStore.getState().setPaused(false);

  // Auto-install required libraries. A deployment that seeds every gallery
  // library at boot says so on /health and the round-trips are skipped; an
  // OSS self-host (or a deployment whose seed failed) installs on load, as
  // it always did. That call is the only thing that installs an example's
  // libraries there, so it must never be removed outright.
  if (example.libraries && example.libraries.length > 0) {
    if (!(await serverProvidesGalleryLibraries())) {
      await ensureLibraries(example.libraries, onLibraryProgress);
    }
  }

  const {
    setComponents,
    setWires,
    setBoardLanguageMode,
    boards,
    addBoard,
    removeBoard,
    setActiveBoardId,
    recalculateAllWirePositions,
  } = useSimulatorStore.getState();

  if (example.boards && example.boards.length > 0) {
    // ── Multi-board loading ───────────────────────────────────────────────
    const currentIds = boards.map((b) => b.id);
    currentIds.forEach((id) => removeBoard(id));

    example.boards.forEach((eb) => {
      addBoard(eb.boardKind as BoardKind, eb.x, eb.y);
    });

    // Match addBoard's deterministic ID rule (useSimulatorStore.addBoard):
    //   1st board of a kind  → id = boardKind
    //   2nd board of a kind  → id = `${boardKind}-2`
    //   Nth board of a kind  → id = `${boardKind}-N`
    // This is what wires reference, so the loader must compute the same IDs
    // when loading per-board code/vfs.
    const kindCount = new Map<string, number>();
    const boardIds: string[] = example.boards.map((eb) => {
      const n = (kindCount.get(eb.boardKind) ?? 0) + 1;
      kindCount.set(eb.boardKind, n);
      return n === 1 ? eb.boardKind : `${eb.boardKind}-${n}`;
    });

    const { boards: newBoards } = useSimulatorStore.getState();
    example.boards.forEach((eb, idx) => {
      const boardId = boardIds[idx];
      const board = newBoards.find((b) => b.id === boardId);
      if (!board) return;

      if (eb.files?.length) {
        // Full multi-file workspace (may carry '/' folder paths). First
        // entry is the main/active file — the example must lead with the
        // sketch so compile picks it up.
        useEditorStore.getState().setActiveGroup(board.activeFileGroupId);
        useEditorStore.getState().loadFiles(eb.files);
      } else if (eb.code) {
        // Arduino-style boards (AVR, RP2040, ESP32, …) all need the `.ino`
        // extension so arduino-cli auto-includes <Arduino.h>. Only the Pi 3B
        // uses a different toolchain (Python via VFS or g++ for `.cpp`).
        const filename = isPiBoardKind(eb.boardKind) ? 'main.cpp' : 'sketch.ino';
        useEditorStore.getState().setActiveGroup(board.activeFileGroupId);
        useEditorStore.getState().loadFiles([{ name: filename, content: eb.code }]);
      }

      // Built-in SD slot uploads (XIAO Sense): land on the board exactly as
      // the SD Card panel would put them, so the Run path finds them.
      if (eb.sdFiles?.length) {
        useSimulatorStore.getState().updateBoard(boardId, { sdFiles: eb.sdFiles });
      }

      // `vfsFiles` IS the declaration that this board's code is a guest
      // script — no isPiBoardKind() check. That guard read the Pi-family
      // registry, which an overlay fills at mount: a direct /example/<id>
      // link to an overlay QEMU-Linux board (UNIHIKER M10) could load before
      // its kind was registered, the branch was skipped, and the editor
      // opened on the board group's Arduino blink default instead of the
      // example's script. Only QEMU-Linux examples carry vfsFiles.
      if (eb.vfsFiles) {
        // Pi example scripts go into the board's REGULAR file group — they
        // are edited in Monaco like any other board's code, and the run
        // path uploads the group into the guest home. (The old separate
        // VFS tree + panel + editor confused users with three file
        // surfaces; the VFS store is still updated for back-compat with
        // anything reading it, but the editor group is the source of truth.)
        const groupFiles = Object.entries(eb.vfsFiles).map(([name, content]) => ({
          name,
          content,
        }));
        useEditorStore.getState().setActiveGroup(board.activeFileGroupId);
        useEditorStore.getState().loadFiles(groupFiles);
        const vfsState = useVfsStore.getState();
        const tree = vfsState.getTree(boardId);
        for (const [nodeId, node] of Object.entries(tree)) {
          if (node.type === 'file' && eb.vfsFiles[node.name] !== undefined) {
            vfsState.setContent(boardId, nodeId, eb.vfsFiles[node.name]);
          }
        }
      }
    });

    const firstArduinoIdx = example.boards.findIndex(
      (eb) =>
        !isPiBoardKind(eb.boardKind) &&
        eb.boardKind !== 'esp32' &&
        eb.boardKind !== 'esp32-s3' &&
        eb.boardKind !== 'esp32-c3',
    );
    if (firstArduinoIdx !== -1) {
      setActiveBoardId(boardIds[firstArduinoIdx]);
    }

    // Programmable chips own their program in a dedicated editor group so it
    // shows as its own section (the per-board code came from eb.code above).
    seedChipProgramGroups(example);

    const componentsWithoutBoard = (example.components ?? []).filter(
      (comp) =>
        !comp.type.includes('arduino') &&
        !comp.type.includes('pico') &&
        !comp.type.includes('raspberry') &&
        !comp.type.includes('esp32'),
    );
    setComponents(
      componentsWithoutBoard.map((comp) => ({
        id: comp.id,
        metadataId: stripBrandPrefix(comp.type),
        x: comp.x,
        y: comp.y,
        properties: comp.properties,
      })),
    );

    setWires(
      (example.wires ?? []).map((wire) => ({
        id: wire.id,
        start: { componentId: wire.start.componentId, pinName: wire.start.pinName, x: 0, y: 0 },
        end: { componentId: wire.end.componentId, pinName: wire.end.pinName, x: 0, y: 0 },
        color: wire.color,
        waypoints: [],
      })),
    );
    recalculateAllWirePositions();
  } else {
    // ── Single-board loading ─────────────────────────────────────────────
    // Tear the canvas down to nothing first, then (unless the example is
    // board-less) add exactly one fresh board of the target kind.
    //
    // Analog-only and digital-only SPICE examples are board-less — they open
    // with just the circuit (boards are optional: 0, 1, or many at any time).
    //
    // Rebuilding from scratch — rather than reusing and retyping a leftover
    // board from a previous (possibly multi-board) example — is what keeps
    // this prolijo: a single-board example always ends with exactly one
    // board whose id matches its kind. The old reuse path left a stale id
    // (e.g. "stm32-bluepill" on what was now an Arduino Uno) and any extra
    // boards as residue. This mirrors the multi-board path above; the
    // setComponents/setWires calls below replace components and wires
    // wholesale.
    const filter = (example as { boardFilter?: string }).boardFilter;
    const isBoardless = filter === 'analog' || filter === 'digital';

    boards.forEach((b) => removeBoard(b.id));

    if (!isBoardless) {
      const targetBoard = example.boardType || 'arduino-uno';
      const newId = addBoard(
        targetBoard as BoardKind,
        DEFAULT_BOARD_POSITION.x,
        DEFAULT_BOARD_POSITION.y,
      );
      setActiveBoardId(newId);
    }

    // ── Program / file routing ───────────────────────────────────────────
    // A programmable chip's program (larson.s, chaser.c, …) goes into the
    // chip's OWN editor group — its own collapsible section — never into the
    // board's sketch group. Everything else (sketch.ino) stays with the board.
    const { programFileNames, chipGroupIds } = seedChipProgramGroups(example);
    const boardOwnedFiles = (example.files ?? []).filter(
      (f) => !programFileNames.has(f.name),
    );

    // When the example specifies languageMode='micropython' or ships a
    // files[] array, we go through setBoardLanguageMode + loadFiles instead
    // of the legacy setCode() path so the editor opens the right file
    // (main.py) with the right language mode.
    const liveBoardId = useSimulatorStore.getState().activeBoardId;
    const liveBoard = useSimulatorStore
      .getState()
      .boards.find((b) => b.id === liveBoardId);

    if (
      (example.languageMode === 'micropython' || example.languageMode === 'espidf') &&
      liveBoard
    ) {
      setBoardLanguageMode(liveBoard.id, example.languageMode);
    }

    const editorStore = useEditorStore.getState();
    if (liveBoard) {
      // Board present: the board group shows the sketch; chip programs sit in
      // their own sections. Re-resolve the group ID — setBoardLanguageMode
      // replaces it. We use `loadFiles` (not legacy `setCode`) and switch the
      // editor to the board's group first: after a board-less → board
      // transition the editor's `activeFileId` still points at an orphan ID
      // from the deleted group, so `setCode` would silently no-op and the
      // editor would appear blank. (Regression: load-example-transitions.test.ts.)
      const updatedBoard = useSimulatorStore
        .getState()
        .boards.find((b) => b.id === liveBoard.id);
      const groupId = updatedBoard?.activeFileGroupId ?? liveBoard.activeFileGroupId;
      editorStore.setActiveGroup(groupId);
      if (boardOwnedFiles.length > 0) {
        editorStore.loadFiles(boardOwnedFiles);
      } else {
        // The name must match the mode the board was just switched into:
        // MicroPython pastes main.py, ESP-IDF builds main.c — a bare `code:`
        // example otherwise lands its Python in a file called sketch.ino.
        const filename = isPiBoardKind(liveBoard.boardKind)
          ? 'main.cpp'
          : example.languageMode === 'micropython'
            ? 'main.py'
            : example.languageMode === 'espidf'
              ? 'main.c'
              : 'sketch.ino';
        editorStore.loadFiles([{ name: filename, content: example.code }]);
      }
    } else if (chipGroupIds.length > 0) {
      // Board-less custom-chip example. The chip's program IS the only code
      // here, so open its group on the left, editable — just like an Arduino
      // sketch. (This is what makes /example/z80-larson-no-board show larson.s.)
      editorStore.setActiveGroup(chipGroupIds[0]);
    } else if (boardOwnedFiles.length > 0) {
      // Board-less but ships plain files (rare) — point the editor at the
      // default group and load them there so it isn't blank/uneditable.
      editorStore.setActiveGroup('group-arduino-uno'); // = DEFAULT_GROUP_ID
      editorStore.loadFiles(boardOwnedFiles);
    } else {
      // Pure analog/digital circuit, no editable program — keep the legacy
      // behaviour (write the placeholder to the current file).
      editorStore.setCode(example.code);
    }

    const componentsWithoutBoard = (example.components ?? []).filter(
      (comp) =>
        !comp.type.includes('arduino') &&
        !comp.type.includes('pico') &&
        !comp.type.includes('esp32'),
    );
    setComponents(
      componentsWithoutBoard.map((comp) => ({
        id: comp.id,
        metadataId: stripBrandPrefix(comp.type),
        x: comp.x,
        y: comp.y,
        properties: comp.properties,
      })),
    );

    // A board-less example with a custom chip must START STOPPED so the Run
    // button is enabled: the chip needs an explicit Run to compile its
    // WASM/ROM and begin executing. Pure analog/digital circuits stay live
    // (paused=false) as before.
    if (isBoardless) {
      const hasCustomChip = componentsWithoutBoard.some(
        (c) => stripBrandPrefix(c.type) === 'custom-chip',
      );
      useElectricalStore.getState().setPaused(hasCustomChip);
    }

    // After possibly removing every board, re-read activeBoardId.
    const liveActiveBoardId = useSimulatorStore.getState().activeBoardId;
    // For analog (board-less) examples we leave any 'arduino-uno' references
    // in wires untouched — there shouldn't be any, but if there are we'd
    // rather emit a dangling endpoint than silently graft them onto a board
    // that no longer exists.
    const remapBoardId = (id: string) =>
      isBoardComponent(id) && liveActiveBoardId ? liveActiveBoardId : id;

    setWires(
      (example.wires ?? []).map((wire) => ({
        id: wire.id,
        start: {
          componentId: remapBoardId(wire.start.componentId),
          pinName: wire.start.pinName,
          x: 0,
          y: 0,
        },
        end: {
          componentId: remapBoardId(wire.end.componentId),
          pinName: wire.end.pinName,
          x: 0,
          y: 0,
        },
        color: wire.color,
        waypoints: [],
      })),
    );
    recalculateAllWirePositions();
  }

  // P2.4 — assign this example's declared manifest to every board it created
  // (the per-board compile scope). Examples declare one library set today, so
  // each board gets it; the user can refine per board via velxio.json.
  {
    const sim = useSimulatorStore.getState();
    const libs =
      example.libraries && example.libraries.length ? example.libraries : undefined;
    for (const b of sim.boards) sim.updateBoard(b.id, { libraries: libs });
  }
}
