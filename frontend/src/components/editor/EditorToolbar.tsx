import { useState, useCallback, useRef, useEffect } from 'react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import type { BoardKind, LanguageMode } from '../../types/board';
import { BOARD_KIND_FQBN, BOARD_KIND_LABELS, BOARD_SUPPORTS_MICROPYTHON } from '../../types/board';
import { compileCode } from '../../services/compilation';
import { reportRunEvent } from '../../services/metricsService';
import { useProjectStore } from '../../store/useProjectStore';
import { LibraryManagerModal } from '../simulator/LibraryManagerModal';
import { InstallLibrariesModal } from '../simulator/InstallLibrariesModal';
import { parseCompileResult } from '../../utils/compilationLogger';
import type { CompilationLog } from '../../utils/compilationLogger';
import { exportToWokwiZip, importFromWokwiZip } from '../../utils/wokwiZip';
import { readFirmwareFile } from '../../utils/firmwareLoader';
import {
  trackCompileCode,
  trackRunSimulation,
  trackStopSimulation,
  trackResetSimulation,
  trackOpenLibraryManager,
} from '../../utils/analytics';
import './EditorToolbar.css';

interface EditorToolbarProps {
  consoleOpen: boolean;
  setConsoleOpen: (open: boolean | ((v: boolean) => boolean)) => void;
  compileLogs: CompilationLog[];
  setCompileLogs: (logs: CompilationLog[] | ((prev: CompilationLog[]) => CompilationLog[])) => void;
  /**
   * Optional element rendered between the left action group and the right
   * action group. The editor passes <FileTabs /> here so the tabs share the
   * same row as the toolbar — keeping every action icon pinned and visible
   * regardless of how narrow the editor pane gets.
   */
  centerSlot?: React.ReactNode;
}

const BOARD_PILL_ICON: Record<BoardKind, string> = {
  'arduino-uno': '⬤',
  'arduino-nano': '▪',
  'arduino-mega': '▬',
  'raspberry-pi-pico': '◆',
  'raspberry-pi-3': '⬛',
  esp32: '⬡',
  'esp32-s3': '⬡',
  'esp32-c3': '⬡',
};

const BOARD_PILL_COLOR: Record<BoardKind, string> = {
  'arduino-uno': '#4fc3f7',
  'arduino-nano': '#4fc3f7',
  'arduino-mega': '#4fc3f7',
  'raspberry-pi-pico': '#ce93d8',
  'raspberry-pi-3': '#ef9a9a',
  esp32: '#a5d6a7',
  'esp32-s3': '#a5d6a7',
  'esp32-c3': '#a5d6a7',
};

export const EditorToolbar = ({
  consoleOpen,
  setConsoleOpen,
  compileLogs: _compileLogs,
  setCompileLogs,
  centerSlot,
}: EditorToolbarProps) => {
  const { files, codeChangedSinceLastCompile, markCompiled } = useEditorStore();
  const {
    boards,
    activeBoardId,
    compileBoardProgram,
    loadMicroPythonProgram,
    setBoardLanguageMode,
    updateBoard,
    startBoard,
    stopBoard,
    resetBoard,
    // legacy compat
    startSimulation,
    stopSimulation,
    resetSimulation,
    running,
    compiledHex,
  } = useSimulatorStore();

  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? boards[0];
  const currentProject = useProjectStore((s) => s.currentProject);

  // Helper: report a Run event to the backend for analytics. Resolves the
  // FQBN from the board kind so the backend can group by family/fqbn.
  const reportRun = useCallback(
    (boardKind: BoardKind | undefined) => {
      const fqbn = boardKind ? BOARD_KIND_FQBN[boardKind] : null;
      void reportRunEvent({
        project_id: currentProject?.id ?? null,
        board_fqbn: fqbn ?? null,
      });
    },
    [currentProject],
  );
  const [compiling, setCompiling] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [libManagerOpen, setLibManagerOpen] = useState(false);
  const [pendingLibraries, setPendingLibraries] = useState<string[]>([]);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const firmwareInputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const [missingLibHint, setMissingLibHint] = useState(false);

  // (ResizeObserver removed — Library Manager is always visible now,
  // only import/export live in the overflow menu)

  // Close overflow dropdown on outside click
  useEffect(() => {
    if (!overflowOpen) return;
    const handler = (e: MouseEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [overflowOpen]);

  // Compile All / Run All — runs sequentially, logs to console (no dialog)
  const [compileAllRunning, setCompileAllRunning] = useState(false);

  const addLog = useCallback(
    (log: CompilationLog) => {
      setCompileLogs((prev: CompilationLog[]) => [...prev, log]);
    },
    [setCompileLogs],
  );

  const handleCompile = async () => {
    setCompiling(true);
    setMessage(null);
    setConsoleOpen(true);
    trackCompileCode();

    const kind = activeBoard?.boardKind;

    // Raspberry Pi 3B doesn't need arduino-cli compilation
    if (kind === 'raspberry-pi-3') {
      addLog({
        timestamp: new Date(),
        type: 'info',
        message: 'Raspberry Pi 3B: no compilation needed — run Python scripts directly.',
      });
      setMessage({ type: 'success', text: 'Ready (no compilation needed)' });
      setCompiling(false);
      return;
    }

    // MicroPython mode — no backend compilation needed
    if (activeBoard?.languageMode === 'micropython' && activeBoardId) {
      addLog({
        timestamp: new Date(),
        type: 'info',
        message: 'MicroPython: loading firmware and user files...',
      });
      try {
        const groupFiles = useEditorStore.getState().getGroupFiles(activeBoard.activeFileGroupId);
        const pyFiles = groupFiles.map((f) => ({ name: f.name, content: f.content }));
        await loadMicroPythonProgram(activeBoardId, pyFiles);
        addLog({
          timestamp: new Date(),
          type: 'success',
          message: 'MicroPython firmware loaded successfully',
        });
        setMessage({ type: 'success', text: 'MicroPython ready' });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Failed to load MicroPython';
        addLog({ timestamp: new Date(), type: 'error', message: errMsg });
        setMessage({ type: 'error', text: errMsg });
      } finally {
        setCompiling(false);
      }
      return;
    }

    const fqbn = kind ? BOARD_KIND_FQBN[kind] : null;
    const boardLabel = kind ? BOARD_KIND_LABELS[kind] : 'Unknown';

    if (!fqbn) {
      addLog({ timestamp: new Date(), type: 'error', message: `No FQBN for board kind: ${kind}` });
      setMessage({ type: 'error', text: 'Unknown board' });
      setCompiling(false);
      return;
    }

    addLog({
      timestamp: new Date(),
      type: 'info',
      message: `Starting compilation for ${boardLabel} (${fqbn})...`,
    });

    try {
      const groupFiles = activeBoard?.activeFileGroupId
        ? useEditorStore.getState().getGroupFiles(activeBoard.activeFileGroupId)
        : files;
      const sketchFiles = (groupFiles.length > 0 ? groupFiles : files).map((f) => ({
        name: f.name,
        content: f.content,
      }));
      const result = await compileCode(sketchFiles, fqbn, currentProject?.id ?? null);

      const resultLogs = parseCompileResult(result, boardLabel);
      setCompileLogs((prev: CompilationLog[]) => [...prev, ...resultLogs]);

      if (result.success) {
        const program = result.hex_content ?? result.binary_content ?? null;
        if (program && activeBoardId) {
          compileBoardProgram(activeBoardId, program);
          if (result.has_wifi !== undefined) {
            updateBoard(activeBoardId, { hasWifi: result.has_wifi });
          }
        }
        setMessage({ type: 'success', text: 'Compiled successfully' });
        markCompiled();
        setMissingLibHint(false);
      } else {
        const errText = result.error || result.stderr || 'Compile failed';
        setMessage({ type: 'error', text: errText });
        // Detect missing library errors — common patterns:
        // "No such file or directory" for #include, "fatal error: XXX.h"
        const looksLikeMissingLib =
          /No such file or directory|fatal error:.*\.h|library not found/i.test(errText);
        setMissingLibHint(looksLikeMissingLib);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Compile failed';
      addLog({ timestamp: new Date(), type: 'error', message: errMsg });
      setMessage({ type: 'error', text: errMsg });
    } finally {
      setCompiling(false);
    }
  };

  // Track whether we should auto-run after compilation completes
  const autoRunAfterCompile = useRef(false);

  const handleRun = async () => {
    console.log('[handleRun] click', { activeBoardId, running, codeChangedSinceLastCompile });
    if (activeBoardId) {
      const board = boards.find((b) => b.id === activeBoardId);
      console.log('[handleRun] active board', {
        id: board?.id,
        kind: board?.boardKind,
        hasCompiledProgram: !!board?.compiledProgram,
        compiledProgramLen: board?.compiledProgram?.length ?? 0,
      });

      // MicroPython mode: stop any running session first, then reload firmware + start
      if (board?.languageMode === 'micropython') {
        trackRunSimulation(board.boardKind);
        reportRun(board.boardKind);

        // Always stop the current session so the new run gets a clean QEMU boot.
        // This also prevents the double start_esp32 that occurs when the bridge
        // is already connected and startBoard() is called again.
        if (board.running) {
          stopBoard(activeBoardId);
          // Give the WebSocket a moment to close cleanly before reconnecting.
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        setCompiling(true);
        setMessage(null);
        addLog({
          timestamp: new Date(),
          type: 'info',
          message: 'MicroPython: loading firmware and user files...',
        });
        try {
          const groupFiles = useEditorStore.getState().getGroupFiles(board.activeFileGroupId);
          const pyFiles = groupFiles.map((f) => ({ name: f.name, content: f.content }));
          await loadMicroPythonProgram(activeBoardId, pyFiles);
          addLog({
            timestamp: new Date(),
            type: 'success',
            message: 'MicroPython firmware loaded',
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Failed to load MicroPython';
          addLog({ timestamp: new Date(), type: 'error', message: errMsg });
          setMessage({ type: 'error', text: errMsg });
          setCompiling(false);
          return;
        }
        setCompiling(false);
        startBoard(activeBoardId);
        setMessage(null);
        return;
      }

      const isQemuBoard =
        board?.boardKind === 'raspberry-pi-3' ||
        board?.boardKind === 'esp32' ||
        board?.boardKind === 'esp32-s3' ||
        board?.boardKind === 'esp32-cam' ||
        board?.boardKind === 'esp32-c3' ||
        board?.boardKind === 'esp32-devkit-c-v4' ||
        board?.boardKind === 'wemos-lolin32-lite' ||
        board?.boardKind === 'xiao-esp32-s3' ||
        board?.boardKind === 'arduino-nano-esp32' ||
        board?.boardKind === 'xiao-esp32-c3' ||
        board?.boardKind === 'aitewinrobot-esp32c3-supermini';

      // QEMU boards: auto-compile if no firmware available yet
      if (isQemuBoard) {
        console.log('[handleRun] QEMU path');
        if (!board?.compiledProgram || codeChangedSinceLastCompile) {
          console.log('[handleRun] auto-compile + run');
          autoRunAfterCompile.current = true;
          await handleCompile();
          const updatedBoard = useSimulatorStore
            .getState()
            .boards.find((b) => b.id === activeBoardId);
          console.log('[handleRun] after compile', {
            hasCompiledProgram: !!updatedBoard?.compiledProgram,
            compiledProgramLen: updatedBoard?.compiledProgram?.length ?? 0,
            autoRunFlag: autoRunAfterCompile.current,
          });
          // For QEMU boards, always start even if compiledProgram is empty —
          // the bridge can be told to start without firmware (for waiting on
          // a later upload) and is the safest path when the binary may be
          // present on the bridge but not yet reflected in the store.
          if (autoRunAfterCompile.current) {
            autoRunAfterCompile.current = false;
            if (updatedBoard?.compiledProgram) {
              trackRunSimulation(updatedBoard.boardKind);
              reportRun(updatedBoard.boardKind);
              console.log('[handleRun] → startBoard', activeBoardId);
              startBoard(activeBoardId);
              setMessage(null);
            } else {
              console.warn('[handleRun] compile finished but no compiledProgram — not starting');
            }
          }
          return;
        }
        trackRunSimulation(board?.boardKind);
        reportRun(board?.boardKind);
        console.log('[handleRun] → startBoard (already compiled)', activeBoardId);
        startBoard(activeBoardId);
        setMessage(null);
        return;
      }

      // Auto-compile if no program or code changed since last compile
      if (!board?.compiledProgram || codeChangedSinceLastCompile) {
        autoRunAfterCompile.current = true;
        await handleCompile();
        // After compile, check if it succeeded and run
        const updatedBoard = useSimulatorStore
          .getState()
          .boards.find((b) => b.id === activeBoardId);
        if (autoRunAfterCompile.current && updatedBoard?.compiledProgram) {
          autoRunAfterCompile.current = false;
          trackRunSimulation(updatedBoard.boardKind);
          reportRun(updatedBoard.boardKind);
          startBoard(activeBoardId);
          setMessage(null);
        } else {
          autoRunAfterCompile.current = false;
        }
        return;
      }

      trackRunSimulation(board?.boardKind);
      reportRun(board?.boardKind);
      startBoard(activeBoardId);
      setMessage(null);
      return;
    }

    // Legacy fallback
    if (!compiledHex || codeChangedSinceLastCompile) {
      autoRunAfterCompile.current = true;
      await handleCompile();
      const hex = useSimulatorStore.getState().compiledHex;
      if (autoRunAfterCompile.current && hex) {
        autoRunAfterCompile.current = false;
        trackRunSimulation();
        reportRun(undefined);
        startSimulation();
        setMessage(null);
      } else {
        autoRunAfterCompile.current = false;
      }
    } else {
      trackRunSimulation();
      reportRun(undefined);
      startSimulation();
      setMessage(null);
    }
  };

  const handleStop = () => {
    trackStopSimulation();
    if (activeBoardId) stopBoard(activeBoardId);
    else stopSimulation();
    setMessage(null);
  };

  const handleReset = () => {
    trackResetSimulation();
    if (activeBoardId) resetBoard(activeBoardId);
    else resetSimulation();
    setMessage(null);
  };

  /**
   * Compile every board on the canvas sequentially. Progress + per-board
   * results stream to the existing compilation console — no separate dialog.
   * Returns the count of boards that ended up with a runnable program (so
   * Run All can use it to decide whether to proceed to start them).
   */
  const compileAllBoards = async (): Promise<{ ok: number; failed: number }> => {
    const boardsList = useSimulatorStore.getState().boards;
    if (boardsList.length === 0) return { ok: 0, failed: 0 };

    setCompileAllRunning(true);
    setConsoleOpen(true);
    addLog({
      timestamp: new Date(),
      type: 'info',
      message: `Compiling all ${boardsList.length} board${boardsList.length === 1 ? '' : 's'}...`,
    });

    let ok = 0;
    let failed = 0;

    for (const board of boardsList) {
      const label = BOARD_KIND_LABELS[board.boardKind] ?? board.boardKind;

      if (board.boardKind === 'raspberry-pi-3') {
        addLog({
          timestamp: new Date(),
          type: 'info',
          message: `${label}: skipped (no compilation needed)`,
        });
        ok++;
        continue;
      }

      const fqbn = BOARD_KIND_FQBN[board.boardKind];
      if (!fqbn) {
        addLog({
          timestamp: new Date(),
          type: 'error',
          message: `${label}: no FQBN configured`,
        });
        failed++;
        continue;
      }

      addLog({ timestamp: new Date(), type: 'info', message: `${label}: compiling...` });

      try {
        const groupFiles = useEditorStore.getState().getGroupFiles(board.activeFileGroupId);
        const sketchFiles = groupFiles.map((f) => ({ name: f.name, content: f.content }));
        const result = await compileCode(sketchFiles, fqbn, currentProject?.id ?? null);
        const resultLogs = parseCompileResult(result, label);
        setCompileLogs((prev: CompilationLog[]) => [...prev, ...resultLogs]);

        if (result.success) {
          const program = result.hex_content ?? result.binary_content ?? null;
          if (program) {
            compileBoardProgram(board.id, program);
            if (result.has_wifi !== undefined) {
              updateBoard(board.id, { hasWifi: result.has_wifi });
            }
          }
          ok++;
        } else {
          failed++;
        }
      } catch (err) {
        addLog({
          timestamp: new Date(),
          type: 'error',
          message: `${label}: ${err instanceof Error ? err.message : String(err)}`,
        });
        failed++;
      }
    }

    addLog({
      timestamp: new Date(),
      type: ok > 0 && failed === 0 ? 'success' : failed > 0 ? 'error' : 'info',
      message: `Done — ${ok} succeeded, ${failed} failed`,
    });
    if (ok > 0 && failed === 0) markCompiled();
    setCompileAllRunning(false);
    return { ok, failed };
  };

  const handleCompileAll = () => {
    trackCompileCode();
    void compileAllBoards();
  };

  /** Run All = compile all (if needed) + start every board, mirroring single Run. */
  const handleRunAll = async () => {
    const boardsList = useSimulatorStore.getState().boards;
    if (boardsList.length === 0) return;

    // Compile if anything is missing a program or code changed since last compile
    const needsCompile =
      codeChangedSinceLastCompile ||
      boardsList.some(
        (b) =>
          b.boardKind !== 'raspberry-pi-3' &&
          b.languageMode !== 'micropython' &&
          !b.compiledProgram,
      );

    if (needsCompile) {
      const { failed } = await compileAllBoards();
      if (failed > 0) return; // Don't start anything if any board failed
    }

    // Refresh list after compile (compiledProgram may have changed)
    const refreshed = useSimulatorStore.getState().boards;
    for (const board of refreshed) {
      if (board.running) continue;
      const isQemu =
        board.boardKind === 'raspberry-pi-3' ||
        board.boardKind === 'esp32' ||
        board.boardKind === 'esp32-s3';
      if (isQemu || board.compiledProgram || board.languageMode === 'micropython') {
        trackRunSimulation(board.boardKind);
        reportRun(board.boardKind);
        startBoard(board.id);
      }
    }
  };

  const handleExport = async () => {
    try {
      const {
        components,
        wires,
        boardPosition,
        boardType: legacyBoardType,
      } = useSimulatorStore.getState();
      const projectName =
        files.find((f) => f.name.endsWith('.ino'))?.name.replace('.ino', '') || 'velxio-project';
      await exportToWokwiZip(files, components, wires, legacyBoardType, projectName, boardPosition);
    } catch (err) {
      setMessage({ type: 'error', text: 'Export failed.' });
    }
  };

  const handleFirmwareUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (firmwareInputRef.current) firmwareInputRef.current.value = '';
    if (!file) return;

    setConsoleOpen(true);
    addLog({ timestamp: new Date(), type: 'info', message: `Loading firmware: ${file.name}...` });

    try {
      const boardKind = activeBoard?.boardKind;
      if (!boardKind) {
        setMessage({ type: 'error', text: 'No board selected' });
        return;
      }

      const result = await readFirmwareFile(file, boardKind);

      // Architecture mismatch warning for ELF files
      if (result.elfInfo?.suggestedBoard && result.elfInfo.suggestedBoard !== boardKind) {
        const detected = result.elfInfo.architectureName;
        const current = activeBoard ? BOARD_KIND_LABELS[activeBoard.boardKind] : boardKind;
        addLog({
          timestamp: new Date(),
          type: 'info',
          message: `Note: Detected ${detected} architecture, but current board is ${current}. Loading anyway.`,
        });
      }

      if (activeBoardId) {
        compileBoardProgram(activeBoardId, result.program);
        markCompiled();
        addLog({ timestamp: new Date(), type: 'info', message: result.message });
        setMessage({ type: 'success', text: `Firmware loaded: ${file.name}` });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to load firmware';
      addLog({ timestamp: new Date(), type: 'error', message: errMsg });
      setMessage({ type: 'error', text: errMsg });
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!importInputRef.current) return;
    importInputRef.current.value = '';
    if (!file) return;
    try {
      const result = await importFromWokwiZip(file);
      const { loadFiles } = useEditorStore.getState();
      const { setComponents, setWires, setBoardType, setBoardPosition, stopSimulation } =
        useSimulatorStore.getState();
      stopSimulation();
      if (result.boardType) setBoardType(result.boardType);
      setBoardPosition(result.boardPosition);
      setComponents(result.components);
      setWires(result.wires);
      if (result.files.length > 0) loadFiles(result.files);
      setMessage({ type: 'success', text: `Imported ${file.name}` });
      if (result.libraries.length > 0) {
        setPendingLibraries(result.libraries);
        setInstallModalOpen(true);
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Import failed.' });
    }
  };

  return (
    <>
      <div className="editor-toolbar-wrapper" style={{ position: 'relative' }}>
        <div className="editor-toolbar" ref={toolbarRef}>
          {/* Active board context pill */}
          {activeBoard && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div
                className="tb-board-pill"
                style={{
                  borderColor: BOARD_PILL_COLOR[activeBoard.boardKind],
                  color: BOARD_PILL_COLOR[activeBoard.boardKind],
                }}
                title={`Editing: ${BOARD_KIND_LABELS[activeBoard.boardKind]}`}
              >
                <span className="tb-board-pill-icon">{BOARD_PILL_ICON[activeBoard.boardKind]}</span>
                <span className="tb-board-pill-label">
                  {BOARD_KIND_LABELS[activeBoard.boardKind]}
                </span>
                {activeBoard.running && <span className="tb-board-pill-running" title="Running" />}
              </div>
              {BOARD_SUPPORTS_MICROPYTHON.has(activeBoard.boardKind) && (
                <select
                  className="tb-lang-select"
                  value={activeBoard.languageMode ?? 'arduino'}
                  onChange={(e) => {
                    if (activeBoardId)
                      setBoardLanguageMode(activeBoardId, e.target.value as LanguageMode);
                  }}
                  title="Language mode"
                  style={{
                    background: '#2d2d2d',
                    color: '#ccc',
                    border: '1px solid #444',
                    borderRadius: 4,
                    padding: '2px 4px',
                    fontSize: 11,
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  <option value="arduino">Arduino C++</option>
                  <option value="micropython">MicroPython</option>
                </select>
              )}
            </div>
          )}

          <div className="toolbar-group">
            {/* Compile */}
            <button
              onClick={handleCompile}
              disabled={compiling || !activeBoard}
              className="tb-btn tb-btn-compile"
              title={
                !activeBoard
                  ? 'Add a board to compile'
                  : compiling
                    ? 'Loading…'
                    : activeBoard?.languageMode === 'micropython'
                      ? 'Load MicroPython'
                      : 'Compile (Ctrl+B)'
              }
            >
              {compiling ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="spin"
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </svg>
              )}
            </button>

            <div className="tb-divider" />

            {/* Run */}
            <button
              onClick={handleRun}
              disabled={running || compiling || !activeBoard}
              className="tb-btn tb-btn-run"
              title={
                !activeBoard
                  ? 'Add a board to run'
                  : activeBoard?.languageMode === 'micropython'
                    ? 'Run MicroPython'
                    : 'Run (auto-compiles if needed)'
              }
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            </button>

            {/* Stop */}
            <button
              onClick={handleStop}
              disabled={!running}
              className="tb-btn tb-btn-stop"
              title="Stop"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
            </button>

            {/* Reset */}
            <button
              onClick={handleReset}
              disabled={!compiledHex && !activeBoard?.compiledProgram}
              className="tb-btn tb-btn-reset"
              title="Reset"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>

            {boards.length > 1 && (
              <>
                <div className="tb-divider" />

                {/* Compile All */}
                <button
                  onClick={handleCompileAll}
                  disabled={compileAllRunning}
                  className="tb-btn tb-btn-compile-all"
                  title="Compile all boards"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    <path d="M6 20h4M14 4l4 4" strokeDasharray="2 2" />
                  </svg>
                </button>

                {/* Run All */}
                <button
                  onClick={handleRunAll}
                  disabled={running}
                  className="tb-btn tb-btn-run-all"
                  title="Run all boards"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <polygon points="3,3 11,12 3,21" />
                    <polygon points="13,3 21,12 13,21" />
                  </svg>
                </button>
              </>
            )}
          </div>

          {/* Center slot — file tabs share the row so action icons stay pinned. */}
          {centerSlot && <div className="toolbar-center-slot">{centerSlot}</div>}

          <div className="toolbar-group toolbar-group-right">
            {/* Hidden file input for import (always present) */}
            <input
              ref={importInputRef}
              type="file"
              accept=".zip"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
            {/* Hidden file input for firmware upload */}
            <input
              ref={firmwareInputRef}
              type="file"
              accept=".hex,.bin,.elf,.ihex"
              style={{ display: 'none' }}
              onChange={handleFirmwareUpload}
            />

            {/* Library Manager — always visible with label */}
            <button
              onClick={() => {
                trackOpenLibraryManager();
                setLibManagerOpen(true);
              }}
              className="tb-btn-libraries"
              title="Search and install Arduino libraries"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                <path d="m3.3 7 8.7 5 8.7-5" />
                <path d="M12 22V12" />
              </svg>
              <span className="tb-libraries-label">Libraries</span>
            </button>

            {/* Import / Export — overflow menu */}
            <div className="tb-overflow-wrap" ref={overflowMenuRef}>
              <button
                onClick={() => setOverflowOpen((v) => !v)}
                className={`tb-btn tb-btn-overflow${overflowOpen ? ' tb-btn-overflow-active' : ''}`}
                title="Import / Export"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <circle cx="5" cy="12" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="19" cy="12" r="2" />
                </svg>
              </button>

              {overflowOpen && (
                <div className="tb-overflow-menu">
                  <button
                    className="tb-overflow-item"
                    onClick={() => {
                      importInputRef.current?.click();
                      setOverflowOpen(false);
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Import zip
                  </button>
                  <button
                    className="tb-overflow-item"
                    onClick={() => {
                      handleExport();
                      setOverflowOpen(false);
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    Export zip
                  </button>
                  <div style={{ borderTop: '1px solid #3c3c3c', margin: '4px 0' }} />
                  <button
                    className="tb-overflow-item"
                    onClick={() => {
                      firmwareInputRef.current?.click();
                      setOverflowOpen(false);
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                      <line x1="12" y1="15" x2="12" y2="22" />
                      <polyline points="8 18 12 22 16 18" />
                    </svg>
                    Upload firmware (.hex, .bin, .elf)
                  </button>
                </div>
              )}
            </div>

            <div className="tb-divider" />

            {/* Output Console toggle */}
            <button
              onClick={() => setConsoleOpen((v) => !v)}
              className={`tb-btn tb-btn-output${consoleOpen ? ' tb-btn-output-active' : ''}`}
              title="Toggle Output Console"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Error detail bar */}
      {message?.type === 'error' && message.text.length > 40 && !consoleOpen && (
        <div className="toolbar-error-detail">{message.text}</div>
      )}

      {/* Missing library hint */}
      {missingLibHint && (
        <div className="tb-lib-hint">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>Missing library? Install it from the</span>
          <button
            className="tb-lib-hint-btn"
            onClick={() => {
              trackOpenLibraryManager();
              setLibManagerOpen(true);
              setMissingLibHint(false);
            }}
          >
            Library Manager
          </button>
          <button
            className="tb-lib-hint-close"
            onClick={() => setMissingLibHint(false)}
            title="Dismiss"
          >
            &times;
          </button>
        </div>
      )}

      <LibraryManagerModal isOpen={libManagerOpen} onClose={() => setLibManagerOpen(false)} />
      <InstallLibrariesModal
        isOpen={installModalOpen}
        onClose={() => setInstallModalOpen(false)}
        libraries={pendingLibraries}
      />
    </>
  );
};
