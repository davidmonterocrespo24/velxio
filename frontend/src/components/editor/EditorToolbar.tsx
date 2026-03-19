import { useState, useCallback, useRef } from 'react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore, BOARD_FQBN, BOARD_LABELS } from '../../store/useSimulatorStore';
import { compileCode } from '../../services/compilation';
import { LibraryManagerModal } from '../simulator/LibraryManagerModal';
import { InstallLibrariesModal } from '../simulator/InstallLibrariesModal';
import { parseCompileResult } from '../../utils/compilationLogger';
import type { CompilationLog } from '../../utils/compilationLogger';
import { exportToWokwiZip, importFromWokwiZip } from '../../utils/wokwiZip';
import { trackCompileCode, trackRunSimulation } from '../../utils/analytics';
import './EditorToolbar.css';

interface EditorToolbarProps {
  consoleOpen: boolean;
  setConsoleOpen: (open: boolean | ((v: boolean) => boolean)) => void;
  compileLogs: CompilationLog[];
  setCompileLogs: (logs: CompilationLog[] | ((prev: CompilationLog[]) => CompilationLog[])) => void;
}

export const EditorToolbar = ({ consoleOpen, setConsoleOpen, compileLogs: _compileLogs, setCompileLogs }: EditorToolbarProps) => {
  const { files } = useEditorStore();
  const {
    boardType,
    setCompiledHex,
    setCompiledBinary,
    startSimulation,
    stopSimulation,
    resetSimulation,
    running,
    compiledHex,
  } = useSimulatorStore();
  const [compiling, setCompiling] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [libManagerOpen, setLibManagerOpen] = useState(false);
  const [pendingLibraries, setPendingLibraries] = useState<string[]>([]);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const addLog = useCallback((log: CompilationLog) => {
    setCompileLogs((prev: CompilationLog[]) => [...prev, log]);
  }, [setCompileLogs]);

  const handleCompile = async () => {
    setCompiling(true);
    setMessage(null);
    setConsoleOpen(true);
    trackCompileCode();

    const fqbn = BOARD_FQBN[boardType];
    const boardLabel = BOARD_LABELS[boardType];

    addLog({ timestamp: new Date(), type: 'info', message: `Starting compilation for ${boardLabel} (${fqbn})...` });

    try {
      const sketchFiles = files.map((f) => ({ name: f.name, content: f.content }));
      const result = await compileCode(sketchFiles, fqbn);

      // Parse the full result into log entries
      const resultLogs = parseCompileResult(result, boardLabel);
      setCompileLogs((prev: CompilationLog[]) => [...prev, ...resultLogs]);

      if (result.success) {
        if (result.hex_content) {
          setCompiledHex(result.hex_content);
          setMessage({ type: 'success', text: 'Compiled successfully' });
        } else if (result.binary_content) {
          setCompiledBinary(result.binary_content);
          setMessage({ type: 'success', text: 'Compiled successfully' });
        } else {
          setMessage({ type: 'error', text: 'No output' });
        }
      } else {
        setMessage({ type: 'error', text: result.error || result.stderr || 'Compile failed' });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Compile failed';
      addLog({ timestamp: new Date(), type: 'error', message: errMsg });
      setMessage({ type: 'error', text: errMsg });
    } finally {
      setCompiling(false);
    }
  };

  const handleRun = () => {
    if (compiledHex) {
      trackRunSimulation();
      startSimulation();
      setMessage(null);
    } else {
      setMessage({ type: 'error', text: 'Compile first' });
    }
  };

  const handleStop = () => {
    stopSimulation();
    setMessage(null);
  };

  const handleReset = () => {
    resetSimulation();
    setMessage(null);
  };

  const handleExport = async () => {
    try {
      const { components, wires, boardPosition } = useSimulatorStore.getState();
      const projectName = files.find((f) => f.name.endsWith('.ino'))?.name.replace('.ino', '') || 'velxio-project';
      await exportToWokwiZip(files, components, wires, boardType, projectName, boardPosition);
    } catch (err) {
      setMessage({ type: 'error', text: 'Export failed.' });
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
      const { setComponents, setWires, setBoardType, setBoardPosition, stopSimulation } = useSimulatorStore.getState();
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
      <div className="editor-toolbar">
        <div className="toolbar-group">
          {/* Compile */}
          <button
            onClick={handleCompile}
            disabled={compiling}
            className="tb-btn tb-btn-compile"
            title={compiling ? 'Compiling…' : 'Compile (Ctrl+B)'}
          >
            {compiling ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spin">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
            )}
          </button>

          <div className="tb-divider" />

          {/* Run */}
          <button
            onClick={handleRun}
            disabled={running || !compiledHex}
            className="tb-btn tb-btn-run"
            title="Run"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none">
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
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
          </button>

          {/* Reset */}
          <button
            onClick={handleReset}
            disabled={!compiledHex}
            className="tb-btn tb-btn-reset"
            title="Reset"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </div>

        <div className="toolbar-group toolbar-group-right">
          {/* Status message */}
          {message && (
            <span className={`tb-status tb-status-${message.type}`} title={message.text}>
              {message.type === 'success' ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              )}
              <span className="tb-status-text">{message.text}</span>
            </span>
          )}

          {/* Import Wokwi zip */}
          <input
            ref={importInputRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            className="tb-btn tb-btn-lib"
            title="Import Wokwi zip"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>

          {/* Export Wokwi zip */}
          <button
            onClick={handleExport}
            className="tb-btn tb-btn-lib"
            title="Export as Wokwi zip"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </button>

          {/* Libraries */}
          <button
            onClick={() => setLibManagerOpen(true)}
            className="tb-btn tb-btn-lib"
            title="Library Manager"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
              <path d="m3.3 7 8.7 5 8.7-5" />
              <path d="M12 22V12" />
            </svg>
          </button>

          <div className="tb-divider" />

          {/* Output Console toggle */}
          <button
            onClick={() => setConsoleOpen((v) => !v)}
            className={`tb-btn tb-btn-output${consoleOpen ? ' tb-btn-output-active' : ''}`}
            title="Toggle Output Console"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>
        </div>
      </div>

      {/* Error detail bar */}
      {message?.type === 'error' && message.text.length > 40 && !consoleOpen && (
        <div className="toolbar-error-detail">{message.text}</div>
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
