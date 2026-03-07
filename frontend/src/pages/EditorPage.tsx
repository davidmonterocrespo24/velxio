/**
 * Editor Page — main editor + simulator with resizable panels
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { CodeEditor } from '../components/editor/CodeEditor';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { FileTabs } from '../components/editor/FileTabs';
import { FileExplorer } from '../components/editor/FileExplorer';
import { CompilationConsole } from '../components/editor/CompilationConsole';
import { SimulatorCanvas } from '../components/simulator/SimulatorCanvas';
import { SerialMonitor } from '../components/simulator/SerialMonitor';
import { AppHeader } from '../components/layout/AppHeader';
import { SaveProjectModal } from '../components/layout/SaveProjectModal';
import { LoginPromptModal } from '../components/layout/LoginPromptModal';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useAuthStore } from '../store/useAuthStore';
import type { CompilationLog } from '../utils/compilationLogger';
import '../App.css';

const BOTTOM_PANEL_MIN = 80;
const BOTTOM_PANEL_MAX = 600;
const BOTTOM_PANEL_DEFAULT = 200;

const EXPLORER_MIN = 120;
const EXPLORER_MAX = 500;
const EXPLORER_DEFAULT = 210;

const resizeHandleStyle: React.CSSProperties = {
  height: 5,
  flexShrink: 0,
  cursor: 'row-resize',
  background: '#2a2d2e',
  borderTop: '1px solid #3c3c3c',
  borderBottom: '1px solid #3c3c3c',
};

export const EditorPage: React.FC = () => {
  const [editorWidthPct, setEditorWidthPct] = useState(45);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const serialMonitorOpen = useSimulatorStore((s) => s.serialMonitorOpen);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [compileLogs, setCompileLogs] = useState<CompilationLog[]>([]);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(BOTTOM_PANEL_DEFAULT);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [loginPromptOpen, setLoginPromptOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT);
  const user = useAuthStore((s) => s.user);

  const handleSaveClick = useCallback(() => {
    if (!user) {
      setLoginPromptOpen(true);
    } else {
      setSaveModalOpen(true);
    }
  }, [user]);

  // Ctrl+S shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveClick();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSaveClick]);

  // Prevent body scroll on the editor page
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    window.scrollTo(0, 0);
    return () => {
      html.style.overflow = '';
      body.style.overflow = '';
    };
  }, []);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setEditorWidthPct(Math.max(20, Math.min(80, pct)));
    };

    const handleMouseUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleBottomPanelResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = bottomPanelHeight;

    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      setBottomPanelHeight(Math.max(BOTTOM_PANEL_MIN, Math.min(BOTTOM_PANEL_MAX, startHeight + delta)));
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [bottomPanelHeight]);

  const handleExplorerResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = explorerWidth;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      setExplorerWidth(Math.max(EXPLORER_MIN, Math.min(EXPLORER_MAX, startWidth + delta)));
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [explorerWidth]);

  return (
    <div className="app">
      <AppHeader />

      <div className="app-container" ref={containerRef}>
        {/* ── Editor side ── */}
        <div
          className="editor-panel"
          style={{ width: `${editorWidthPct}%`, display: 'flex', flexDirection: 'row' }}
        >
          {/* File explorer sidebar + resize handle */}
          {explorerOpen && (
            <>
              <div style={{ width: explorerWidth, flexShrink: 0, display: 'flex', overflow: 'hidden' }}>
                <FileExplorer onSaveClick={handleSaveClick} />
              </div>
              <div className="explorer-resize-handle" onMouseDown={handleExplorerResizeMouseDown} />
            </>
          )}

          {/* Editor main area */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
            {/* Explorer toggle + toolbar */}
            <div style={{ display: 'flex', alignItems: 'stretch', flexShrink: 0 }}>
              <button
                className="explorer-toggle-btn"
                onClick={() => setExplorerOpen((v) => !v)}
                title={explorerOpen ? 'Hide file explorer' : 'Show file explorer'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>
              <div style={{ flex: 1 }}>
                <EditorToolbar
                  consoleOpen={consoleOpen}
                  setConsoleOpen={setConsoleOpen}
                  compileLogs={compileLogs}
                  setCompileLogs={setCompileLogs}
                />
              </div>
            </div>

            {/* File tabs */}
            <FileTabs />

            {/* Monaco editor */}
            <div className="editor-wrapper" style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
              <CodeEditor />
            </div>

            {/* Console */}
            {consoleOpen && (
              <>
                <div
                  onMouseDown={handleBottomPanelResizeMouseDown}
                  style={resizeHandleStyle}
                  title="Drag to resize"
                />
                <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                  <CompilationConsole
                    isOpen={consoleOpen}
                    onClose={() => setConsoleOpen(false)}
                    logs={compileLogs}
                    onClear={() => setCompileLogs([])}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Resize handle */}
        <div className="resize-handle" onMouseDown={handleResizeMouseDown}>
          <div className="resize-handle-grip" />
        </div>

        {/* ── Simulator side ── */}
        <div
          className="simulator-panel"
          style={{ width: `${100 - editorWidthPct}%`, display: 'flex', flexDirection: 'column' }}
        >
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
            <SimulatorCanvas />
          </div>
          {serialMonitorOpen && (
            <>
              <div
                onMouseDown={handleBottomPanelResizeMouseDown}
                style={resizeHandleStyle}
                title="Drag to resize"
              />
              <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                <SerialMonitor />
              </div>
            </>
          )}
        </div>
      </div>

      {saveModalOpen && <SaveProjectModal onClose={() => setSaveModalOpen(false)} />}
      {loginPromptOpen && <LoginPromptModal onClose={() => setLoginPromptOpen(false)} />}
    </div>
  );
};
