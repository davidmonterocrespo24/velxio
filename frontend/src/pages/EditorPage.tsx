/**
 * Editor Page — main editor + simulator with resizable panels
 */

import React, { useRef, useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { wireElectricalSolver } from '../simulation/spice/subscribeToStore';
import { useSEO } from '../utils/useSEO';
import { CodeEditor } from '../components/editor/CodeEditor';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { FileTabs } from '../components/editor/FileTabs';
import { FileExplorer } from '../components/editor/FileExplorer';

// Lazy-load Pi workspace so xterm.js isn't in the main bundle
const RaspberryPiWorkspace = lazy(() =>
  import('../components/raspberry-pi/RaspberryPiWorkspace').then((m) => ({
    default: m.RaspberryPiWorkspace,
  })),
);
import { CompilationConsole } from '../components/editor/CompilationConsole';
import { SimulatorCanvas } from '../components/simulator/SimulatorCanvas';
import { SerialMonitor } from '../components/simulator/SerialMonitor';
import { Oscilloscope } from '../components/simulator/Oscilloscope';
import { AppHeader } from '../components/layout/AppHeader';
import { SaveProjectModal } from '../components/layout/SaveProjectModal';
import { LoginPromptModal } from '../components/layout/LoginPromptModal';
import { GitHubStarBanner } from '../components/layout/GitHubStarBanner';
import { useSimulatorStore, DEFAULT_BOARD_POSITION } from '../store/useSimulatorStore';
import { useOscilloscopeStore } from '../store/useOscilloscopeStore';
import { useAuthStore } from '../store/useAuthStore';
import { useProjectStore } from '../store/useProjectStore';
import { useAutoSaveProject } from '../hooks/useAutoSaveProject';
import type { CompilationLog } from '../utils/compilationLogger';
import '../App.css';

const MOBILE_BREAKPOINT = 768;

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
  useSEO({
    title: 'Multi-Board Simulator Editor — Arduino, ESP32, RP2040, RISC-V | Velxio',
    description:
      'Write, compile and simulate Arduino, ESP32, Raspberry Pi Pico, ESP32-C3, and Raspberry Pi 3 code in your browser. 19 boards, 5 CPU architectures, 48+ components. Free and open-source.',
    url: 'https://velxio.dev/editor',
  });

  // Silent auto-save for the loaded project (only fires when authed AND
  // currentProject has a UUID — see useAutoSaveProject for the gating rules).
  const autoSave = useAutoSaveProject();

  const [editorWidthPct, setEditorWidthPct] = useState(45);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const serialMonitorOpen = useSimulatorStore((s) => s.serialMonitorOpen);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const activeBoardKind = useSimulatorStore(
    (s) => s.boards.find((b) => b.id === s.activeBoardId)?.boardKind,
  );
  const isRaspberryPi3 = activeBoardKind === 'raspberry-pi-3';
  const oscilloscopeOpen = useOscilloscopeStore((s) => s.open);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [compileLogs, setCompileLogs] = useState<CompilationLog[]>([]);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(BOTTOM_PANEL_DEFAULT);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [loginPromptOpen, setLoginPromptOpen] = useState(false);
  const [showStarBanner, setShowStarBanner] = useState(false);

  // ── Electrical simulation subscriber (one-time, idempotent) ───────────────
  useEffect(() => {
    const unsub = wireElectricalSolver();
    return unsub;
  }, []);

  // ── GitHub star prompt (show once: 2nd visit OR after 3 min) ──────────────
  useEffect(() => {
    const STAR_KEY = 'velxio_star_prompted';
    const VISITS_KEY = 'velxio_editor_visits';
    const FIRST_VISIT_KEY = 'velxio_editor_first_visit';
    const THREE_MIN = 3 * 60 * 1000;

    if (localStorage.getItem(STAR_KEY)) return;

    // Increment visit counter
    const visits = parseInt(localStorage.getItem(VISITS_KEY) ?? '0', 10) + 1;
    localStorage.setItem(VISITS_KEY, String(visits));

    // Record timestamp of first visit
    if (!localStorage.getItem(FIRST_VISIT_KEY)) {
      localStorage.setItem(FIRST_VISIT_KEY, String(Date.now()));
    }
    const firstVisit = parseInt(localStorage.getItem(FIRST_VISIT_KEY)!, 10);

    // Show immediately on second+ visit
    if (visits >= 2) {
      setShowStarBanner(true);
      return;
    }

    // Otherwise schedule after the 3-minute mark
    const elapsed = Date.now() - firstVisit;
    const delay = Math.max(0, THREE_MIN - elapsed);
    const timer = setTimeout(() => {
      if (!localStorage.getItem(STAR_KEY)) setShowStarBanner(true);
    }, delay);
    return () => clearTimeout(timer);
  }, []);

  const handleDismissStarBanner = () => {
    localStorage.setItem('velxio_star_prompted', '1');
    setShowStarBanner(false);
  };
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches,
  );
  // Slot element for SimulatorCanvas to portal its header into. When set, the
  // canvas board selector / Serial / Scope / zoom / Add buttons render here
  // instead of above the canvas — keeping the top bar a single full-width row
  // that doesn't reflow when the editor/canvas splitter is dragged.
  const [canvasHeaderSlot, setCanvasHeaderSlot] = useState<HTMLDivElement | null>(null);
  // Default to 'code' on mobile — show the editor so users can write/view code
  const [mobileView, setMobileView] = useState<'code' | 'circuit'>('code');
  const user = useAuthStore((s) => s.user);

  const handleSaveClick = useCallback(() => {
    if (!user) {
      setLoginPromptOpen(true);
    } else {
      setSaveModalOpen(true);
    }
  }, [user]);

  const handleNewClick = useCallback(() => {
    if (
      !window.confirm(
        'Start a new workspace? This clears every board, component, wire and file. This cannot be undone.',
      )
    ) {
      return;
    }
    const sim = useSimulatorStore.getState();
    sim.boards.forEach((b) => sim.stopBoard(b.id));
    const ids = sim.boards.map((b) => b.id);
    ids.forEach((id) => sim.removeBoard(id));
    sim.setComponents([]);
    sim.setWires([]);
    useProjectStore.getState().clearCurrentProject();
    const newId = useSimulatorStore
      .getState()
      .addBoard('arduino-uno', DEFAULT_BOARD_POSITION.x, DEFAULT_BOARD_POSITION.y);
    useSimulatorStore.getState().setActiveBoardId(newId);
  }, []);

  // Track mobile breakpoint
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const update = (e: MediaQueryListEvent | MediaQueryList) => {
      const mobile = e.matches;
      setIsMobile(mobile);
      if (mobile) setExplorerOpen(false);
    };
    update(mq);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

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

  const handleBottomPanelResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = bottomPanelHeight;

      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY;
        setBottomPanelHeight(
          Math.max(BOTTOM_PANEL_MIN, Math.min(BOTTOM_PANEL_MAX, startHeight + delta)),
        );
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
    },
    [bottomPanelHeight],
  );

  const handleExplorerResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
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
    },
    [explorerWidth],
  );

  return (
    <div className="app">
      <AppHeader autoSave={autoSave} />

      {/* ── Mobile tab bar (top, above panels) ── */}
      {isMobile && (
        <nav className="mobile-tab-bar">
          <button
            className={`mobile-tab-btn${mobileView === 'code' ? ' mobile-tab-btn--active' : ''}`}
            onClick={() => setMobileView('code')}
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
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
            <span>&lt;/&gt; Code</span>
          </button>
          <button
            className={`mobile-tab-btn${mobileView === 'circuit' ? ' mobile-tab-btn--active' : ''}`}
            onClick={() => setMobileView('circuit')}
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
              <rect x="2" y="7" width="20" height="14" rx="2" />
              <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
              <line x1="12" y1="12" x2="12" y2="16" />
              <line x1="10" y1="14" x2="14" y2="14" />
            </svg>
            <span>Circuit</span>
          </button>
        </nav>
      )}

      {/* ── Unified top toolbar (desktop only) ──
          Editor controls + canvas controls share a single full-width row so
          the bar doesn't reflow when the editor/canvas splitter is dragged.
          The canvas controls (board selector, Serial, Scope, zoom, Add) are
          portaled into `canvasHeaderSlot` from inside SimulatorCanvas. */}
      {!isMobile && (
        <div className="unified-toolbar">
          <button
            className="explorer-toggle-btn unified-toolbar-explorer-toggle"
            onClick={() => setExplorerOpen((v) => !v)}
            title={explorerOpen ? 'Hide file explorer' : 'Show file explorer'}
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
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <div className="unified-toolbar-editor">
            <EditorToolbar
              consoleOpen={consoleOpen}
              setConsoleOpen={setConsoleOpen}
              compileLogs={compileLogs}
              setCompileLogs={setCompileLogs}
              centerSlot={!isRaspberryPi3 ? <FileTabs /> : null}
            />
          </div>
          <div className="unified-toolbar-canvas" ref={setCanvasHeaderSlot} />
        </div>
      )}

      <div className="app-container" ref={containerRef}>
        {/* ── Editor side ── */}
        <div
          className="editor-panel"
          style={{
            width: isMobile ? '100%' : `${editorWidthPct}%`,
            display: isMobile && mobileView !== 'code' ? 'none' : 'flex',
            flexDirection: 'row',
          }}
        >
          {/* File explorer sidebar + resize handle */}
          {explorerOpen && (
            <>
              <div
                style={{ width: explorerWidth, flexShrink: 0, display: 'flex', overflow: 'hidden' }}
              >
                <FileExplorer onSaveClick={handleSaveClick} onNewClick={handleNewClick} />
              </div>
              {!isMobile && (
                <div
                  className="explorer-resize-handle"
                  onMouseDown={handleExplorerResizeMouseDown}
                />
              )}
            </>
          )}

          {/* Editor main area */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              minWidth: 0,
            }}
          >
            {/* Mobile-only: explorer toggle + editor toolbar inside the panel.
                On desktop these are hoisted into the unified top toolbar. */}
            {isMobile && (
              <div style={{ display: 'flex', alignItems: 'stretch', flexShrink: 0 }}>
                <button
                  className="explorer-toggle-btn"
                  onClick={() => setExplorerOpen((v) => !v)}
                  title={explorerOpen ? 'Hide file explorer' : 'Show file explorer'}
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
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <EditorToolbar
                    consoleOpen={consoleOpen}
                    setConsoleOpen={setConsoleOpen}
                    compileLogs={compileLogs}
                    setCompileLogs={setCompileLogs}
                    centerSlot={!isRaspberryPi3 ? <FileTabs /> : null}
                  />
                </div>
              </div>
            )}

            {/* Editor area: Pi workspace or Monaco editor */}
            <div className="editor-wrapper" style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
              {isRaspberryPi3 && activeBoardId ? (
                <Suspense
                  fallback={
                    <div style={{ color: '#666', padding: 16, fontSize: 12 }}>
                      Loading Pi workspace…
                    </div>
                  }
                >
                  <RaspberryPiWorkspace boardId={activeBoardId} />
                </Suspense>
              ) : (
                <CodeEditor />
              )}
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

        {/* Resize handle (desktop only) */}
        {!isMobile && (
          <div className="resize-handle" onMouseDown={handleResizeMouseDown}>
            <div className="resize-handle-grip" />
          </div>
        )}

        {/* ── Simulator side ── */}
        <div
          className="simulator-panel"
          style={{
            width: isMobile ? '100%' : `${100 - editorWidthPct}%`,
            display: isMobile && mobileView !== 'circuit' ? 'none' : 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
            <SimulatorCanvas headerSlot={!isMobile ? canvasHeaderSlot : null} />
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
          {oscilloscopeOpen && (
            <>
              <div
                onMouseDown={handleBottomPanelResizeMouseDown}
                style={resizeHandleStyle}
                title="Drag to resize"
              />
              <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                <Oscilloscope />
              </div>
            </>
          )}
        </div>
      </div>

      {saveModalOpen && <SaveProjectModal onClose={() => setSaveModalOpen(false)} />}
      {loginPromptOpen && <LoginPromptModal onClose={() => setLoginPromptOpen(false)} />}
      {showStarBanner && <GitHubStarBanner onClose={handleDismissStarBanner} />}
    </div>
  );
};
