/**
 * Editor Page — main editor + simulator with resizable panels
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { startSimulation } from '../simulation/spice/start';
import { useSEO } from '../utils/useSEO';
import { getLocaleFromPath, localizedPath } from '../i18n/path';
import { restoreStashedWorkspace } from '../utils/workspaceDraft';
import { CodeEditor } from '../components/editor/CodeEditor';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { FileExplorer } from '../components/editor/FileExplorer';

// Lazy-load Pi workspace so xterm.js isn't in the main bundle
import { CompilationConsole } from '../components/editor/CompilationConsole';
import { CompileProgressCard } from '../components/editor/CompileProgressCard';
import { SimulatorCanvas } from '../components/simulator/SimulatorCanvas';
import { SerialMonitor } from '../components/simulator/SerialMonitor';
import { Oscilloscope } from '../components/simulator/Oscilloscope';
import { AppHeader } from '../components/layout/AppHeader';
import { triggerSaveAction } from '../lib/proSaveAction';
import { GitHubStarBanner } from '../components/layout/GitHubStarBanner';
import { NewsAnnouncer } from '../components/layout/NewsAnnouncer';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { useCompileLogsStore } from '../store/useCompileLogsStore';
import { useOscilloscopeStore } from '../store/useOscilloscopeStore';
import { useProjectStore } from '../store/useProjectStore';
import {
  NewProjectDialog,
  clearWorkspaceForStarter,
} from '../components/editor/NewProjectDialog';
import { useAutoSaveProject } from '../hooks/useAutoSaveProject';
import { registerEditorCommand } from '../lib/editorCommands';
import { whenNewsClear } from '../lib/newsGate';
import { EditorMenuBar } from '../components/editor/EditorMenuBar';
import type { CompilationLog } from '../utils/compilationLogger';
import '../App.css';

const MOBILE_BREAKPOINT = 768;

const BOTTOM_PANEL_MIN = 80;
const BOTTOM_PANEL_MAX = 600;
const BOTTOM_PANEL_DEFAULT = 200;

const EXPLORER_MIN = 100;
const EXPLORER_MAX = 500;
// Narrow by default: the explorer rows are compact and both headers stack
// their actions ABOVE their label instead of beside it (see
// FileExplorer.css), so nothing has to share a line — 124px fits a board
// name and typical file names, and every px saved here goes to the code
// editor.
const EXPLORER_DEFAULT = 124;

// Once per full page load: the pristine-visit starter dialog must not pop
// again when the user closes it and later navigates away from and back to
// /editor within the same SPA session.
let starterDialogShownThisLoad = false;

function announceStarBanner(action: 'shown' | 'click' | 'dismiss', round: 1 | 2): void {
  window.dispatchEvent(new CustomEvent('velxio-star-banner', { detail: { action, round } }));
}

const resizeHandleStyle: React.CSSProperties = {
  height: 5,
  flexShrink: 0,
  cursor: 'row-resize',
  background: 'var(--wb-5)',
  borderTop: '1px solid var(--wb-7)',
  borderBottom: '1px solid var(--wb-7)',
};

export const EditorPage: React.FC = () => {
  const { t } = useTranslation();
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
  // Desktop-only 3-way layout switch (code-only / circuit-only / both).
  // Lets users hide a pane to give the right-docked chat more room.
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const explorerOpen = useEditorStore((s) => s.explorerOpen);
  const setExplorerOpen = useEditorStore((s) => s.setExplorerOpen);
  const toggleExplorer = useEditorStore((s) => s.toggleExplorer);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const serialMonitorOpen = useSimulatorStore((s) => s.serialMonitorOpen);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const oscilloscopeOpen = useOscilloscopeStore((s) => s.open);
  const [consoleOpen, setConsoleOpen] = useState(false);
  // compileLogs live in a Zustand store so the velxio-pro agent overlay
  // (mounted in a separate React tree via slotMounter) can subscribe and
  // build a "diagnose this failure" prompt without prop-drilling.
  const compileLogs = useCompileLogsStore((s) => s.logs);
  const setCompileLogs = useCompileLogsStore((s) => s.setLogs);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(BOTTOM_PANEL_DEFAULT);
  const [showStarBanner, setShowStarBanner] = useState(false);
  const [starRound, setStarRound] = useState<1 | 2>(1);

  // ── Electrical simulation (one-time mount) ────────────────────────────────
  // `startSimulation()` is the single entry point: it constructs the
  // CircuitSimulationService, mounts the ADC bridge, and subscribes
  // PinManager → service.handleMcuEdge.  No more legacy paths — the
  // WASM ngspice (via NgSpiceWorkerAdapter) is the only solver.
  useEffect(() => {
    return startSimulation();
  }, []);

  // Restore an in-progress workspace stashed before a login redirect, so a
  // user who was building something and signed in lands back on their circuit
  // (not the empty starter board). One-shot; see utils/workspaceDraft.
  useEffect(() => {
    restoreStashedWorkspace();
  }, []);

  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);

  // Pristine-visit starter dialog: a bare /editor landing still holds the
  // hardcoded Uno + LED starter (see useSimulatorStore INITIAL_BOARD /
  // builtin components). Clear it and offer the template picker over an
  // EMPTY canvas instead of silently dropping the user into the Arduino
  // blink (cancelling the dialog leaves a blank workspace). Guarded so it
  // never fires over a loaded project/example URL, a restored login draft
  // (both leave the stores non-pristine), or twice per page load. Declared
  // AFTER the restoreStashedWorkspace effect — mount order is what makes
  // the pristine check see the restored draft.
  //
  // Sequenced BEHIND the news announcement: the canvas is cleared right
  // away, but the dialog itself waits until NewsAnnouncer reports the
  // announcement flow is done (nothing to show, or its modal was closed).
  // The 2.5s bound applies only while the news decision is pending, so a
  // dead feed can't hold the dialog hostage — see lib/newsGate.ts.
  useEffect(() => {
    if (starterDialogShownThisLoad) return;
    const locale = getLocaleFromPath(window.location.pathname);
    // /editor is prerendered, so a fresh load arrives as /editor/ (nginx
    // adds the slash); client-side navigation lands on /editor. Both count.
    if (window.location.pathname.replace(/\/+$/, '') !== localizedPath('/editor', locale)) return;
    if (window.location.search) return;
    if (useProjectStore.getState().currentProject) return;
    const sim = useSimulatorStore.getState();
    const pristine =
      sim.boards.length === 1 &&
      sim.boards[0].id === 'arduino-uno' &&
      sim.components.length === 2 &&
      sim.components.every((c) => c.id === 'led_builtin' || c.id === 'r_builtin');
    if (!pristine) return;
    starterDialogShownThisLoad = true;
    clearWorkspaceForStarter();
    let cancelled = false;
    void whenNewsClear(2500).then(() => {
      if (!cancelled) setShowNewProjectDialog(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── GitHub star prompt (show twice at most, after 10 min in the editor) ────
  // Three localStorage flags drive this:
  //   velxio_star_prompted     → dismissed the first ask
  //   velxio_star_prompted_v2  → dismissed the follow-up ask (stop forever)
  //   velxio_star_clicked      → clicked through to the repo (stop forever)
  // Anyone who dismissed the first ask WITHOUT clicking through gets one
  // follow-up (round 2) with a stronger message; clicking the repo link at
  // any time opts them out permanently.
  //
  // The banner waits for 10 minutes of the current editor session: asking
  // before someone has built anything reads as noise. STAR_RESET_KEY clears
  // the dismiss flags once for everybody who never clicked through, so the
  // people who dismissed the old early prompt get asked again at the new time.
  //
  // Every transition is also announced as a `velxio-star-banner` window event
  // ({ action: 'shown' | 'click' | 'dismiss', round }) so a deployment can
  // count it; the OSS build has no listener.
  useEffect(() => {
    const STAR_KEY = 'velxio_star_prompted';
    const STAR_KEY_V2 = 'velxio_star_prompted_v2';
    const STAR_CLICKED_KEY = 'velxio_star_clicked';
    const STAR_RESET_KEY = 'velxio_star_reset_2026_10';
    const TEN_MIN = 10 * 60 * 1000;

    try {
      // Never bother people who already starred.
      if (localStorage.getItem(STAR_CLICKED_KEY)) return;

      if (!localStorage.getItem(STAR_RESET_KEY)) {
        localStorage.removeItem(STAR_KEY);
        localStorage.removeItem(STAR_KEY_V2);
        localStorage.removeItem('velxio_editor_visits');
        localStorage.removeItem('velxio_editor_first_visit');
        localStorage.setItem(STAR_RESET_KEY, '1');
      }

      // Stop for good once the follow-up was dismissed too.
      if (localStorage.getItem(STAR_KEY_V2)) return;
    } catch {
      return; // storage blocked: never nag someone we cannot remember
    }

    const timer = setTimeout(() => {
      try {
        if (localStorage.getItem(STAR_CLICKED_KEY) || localStorage.getItem(STAR_KEY_V2)) return;
        // Round 2 = they dismissed the first ask (without clicking through).
        const round = localStorage.getItem(STAR_KEY) ? 2 : 1;
        setStarRound(round);
        setShowStarBanner(true);
        announceStarBanner('shown', round);
      } catch {
        /* storage blocked */
      }
    }, TEN_MIN);
    return () => clearTimeout(timer);
  }, []);

  const handleDismissStarBanner = () => {
    // First dismiss → mark round 1; second dismiss → mark round 2 (stop forever).
    try {
      if (localStorage.getItem('velxio_star_prompted')) {
        localStorage.setItem('velxio_star_prompted_v2', '1');
      } else {
        localStorage.setItem('velxio_star_prompted', '1');
      }
    } catch {
      /* storage blocked */
    }
    announceStarBanner('dismiss', starRound);
    setShowStarBanner(false);
  };

  const handleStarClick = () => {
    // They went to the repo — opt them out of any further prompts.
    try {
      localStorage.setItem('velxio_star_clicked', '1');
    } catch {
      /* storage blocked */
    }
    announceStarBanner('click', starRound);
    setShowStarBanner(false);
  };
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

  // Mirrors the `display: none` on the simulator panel below. The compile
  // progress card renders over the canvas, so when that pane is hidden the
  // card has to move to the editor pane instead of disappearing with it.
  const simulatorHidden =
    (isMobile && mobileView !== 'circuit') || (!isMobile && viewMode === 'code');

  // Save is dispatched to the pro overlay, which inspects auth state and
  // shows the right modal (Save vs Login prompt). In OSS without the
  // overlay this is a no-op today and becomes the .vlx Export entry
  // point in Phase 4 of the OSS split.
  const handleSaveClick = useCallback(() => {
    triggerSaveAction();
  }, []);

  // "New workspace" opens the starter-template dialog. Destruction moved
  // from here into the dialog's selection handler — Cancel/ESC now leaves
  // the current workspace untouched, so the old confirm dialog is gone.
  const handleNewClick = useCallback(() => {
    setShowNewProjectDialog(true);
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
  }, [setExplorerOpen]);

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

  // File-menu commands owned by this page. Registered here (not in the
  // menu) so the menu never duplicates the confirm-dialog / autosave logic.
  useEffect(() => {
    const offSave = registerEditorCommand('project.save', handleSaveClick);
    const offNew = registerEditorCommand('project.new', () => {
      void handleNewClick();
    });
    const offExplorer = registerEditorCommand('view.toggleExplorer', () => toggleExplorer());
    return () => {
      offSave();
      offNew();
      offExplorer();
    };
  }, [handleSaveClick, handleNewClick, toggleExplorer]);

  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z — canvas undo/redo. Skipped when the
  // user is typing in any input/textarea/contenteditable so the Monaco
  // editor's per-file history (and the AI chat composer, etc.) keep
  // working untouched.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
          return;
        }
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const sim = useSimulatorStore.getState();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        sim.undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        sim.redo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
      const el = containerRef.current;
      const rect = el.getBoundingClientRect();
      // The panels' percentage widths resolve against the container's CONTENT
      // box, but getBoundingClientRect() returns the border box — and overlays
      // may reserve space by padding .app-container (e.g. a docked side panel).
      // Measuring against the padded box makes the handle jump away from the
      // cursor, so strip borders and padding first.
      const cs = getComputedStyle(el);
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const padRight = parseFloat(cs.paddingRight) || 0;
      const contentLeft = rect.left + el.clientLeft + padLeft;
      const contentWidth = el.clientWidth - padLeft - padRight;
      if (contentWidth <= 0) return;
      const pct = ((ev.clientX - contentLeft) / contentWidth) * 100;
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

  /* ── Unified toolbar (desktop) ──
     Editor controls + canvas controls in one strip; the canvas side is
     portaled into `canvasHeaderSlot` from SimulatorCanvas. Since the
     marketing nav left the editor header, the header's middle is empty
     space — so this strip now rides INSIDE the AppHeader row (via the
     editorToolbar prop) instead of being a second bar: one 44px row where
     there used to be 44+38. On narrow widths the strip wraps internally
     and the header grows; the docked AI chat is avoided by the same
     padding-right the strip always had. */
  /* Account block. Fused as the explorer panel's footer so a long file
     tree scrolls ABOVE it instead of disappearing underneath a floating
     box; when the explorer is collapsed it falls back to the small fixed
     corner box (avatar only there — no room for a name). */
  const accountBlock = !isMobile ? (
    // Just the account button. Language lives in the menubar's Language
    // menu (for everyone) and inside the account menu (for signed-in
    // users) — the standalone globe crowded the footer for no gain.
    <div data-velxio-slot="header-auth" style={{ display: 'contents' }} />
  ) : undefined;

  const unifiedToolbar = !isMobile ? (
        <div className="unified-toolbar">
          {/* View-mode toggle: explorer | Code / Both / Circuit — one
              segmented group so the four pane switches read as one control.
              Hidden on mobile — there's already a code/circuit toggle in
              the mobile bottom-nav. */}
          <div
            role="group"
            aria-label={t('editor.shell.viewMode')}
            className="view-mode-toggle"
            style={{
              // display comes from App.css (flex; none on a narrow bar or mobile).
              // Never squeezed below its buttons: flexbox used to crush
              // this block to a third of its width and clip two of them.
              flexShrink: 0,
              gap: 1,
              background: 'var(--wb-3)',
              border: '1px solid var(--wb-7)',
              borderRadius: 4,
              overflow: 'hidden',
              alignSelf: 'center',
              margin: '0 6px',
            }}
          >
            <button
              onClick={() => toggleExplorer()}
              aria-pressed={explorerOpen}
              title={explorerOpen ? t('editor.menu.hideExplorer', 'Hide file explorer') : t('editor.menu.showExplorer', 'Show file explorer')}
              style={{
                background: explorerOpen ? 'var(--color-action-primary)' : 'transparent',
                color: explorerOpen ? 'white' : 'var(--wb-11)',
                border: 'none',
                height: 28,
                padding: '0 10px',
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
              }}
            >
              <svg
                width="13"
                height="13"
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
            <div style={{ width: 1, background: 'var(--wb-7)', alignSelf: 'stretch' }} />
            {(
              [
                { key: 'code', label: t('editor.shell.code'), path: 'M16 18l6-6-6-6M8 6l-6 6 6 6' },
                { key: 'both', label: t('editor.shell.both'), path: 'M3 3h7v18H3zM14 3h7v18h-7z' },
                { key: 'circuit', label: t('editor.shell.circuit'), path: 'M5 12h14M12 5v14' },
              ] as const
            ).map((m) => (
              <button
                key={m.key}
                onClick={() => setViewMode(m.key)}
                aria-pressed={viewMode === m.key}
                style={{
                  background: viewMode === m.key ? 'var(--color-action-primary)' : 'transparent',
                  color: viewMode === m.key ? 'white' : 'var(--wb-11)',
                  border: 'none',
                  height: 28,
                  padding: '0 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontFamily: 'inherit',
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={m.path} />
                </svg>
                <span className="vm-label">{m.label}</span>
              </button>
            ))}
          </div>
          <div className="unified-toolbar-editor">
            <EditorToolbar
              consoleOpen={consoleOpen}
              setConsoleOpen={setConsoleOpen}
              compileLogs={compileLogs}
              setCompileLogs={setCompileLogs}
            />
          </div>
          <div className="unified-toolbar-canvas" ref={setCanvasHeaderSlot} />
        </div>
  ) : undefined;

  return (
    <div className="app">
      <AppHeader
        editorMenu={!isMobile ? <EditorMenuBar /> : undefined}
        editorToolbar={unifiedToolbar}
      />

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
            <span>&lt;/&gt; {t('editor.shell.code')}</span>
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
            <span>{t('editor.shell.circuit')}</span>
          </button>
        </nav>
      )}


      <div className="app-container" ref={containerRef}>
        {/* ── Editor side ── */}
        <div
          className="editor-panel"
          style={{
            width: isMobile
              ? '100%'
              : viewMode === 'code'
              ? '100%'
              : viewMode === 'circuit'
              ? '0%'
              : `${editorWidthPct}%`,
            display:
              (isMobile && mobileView !== 'code') || (!isMobile && viewMode === 'circuit')
                ? 'none'
                : 'flex',
            flexDirection: 'row',
          }}
        >
          {/* File explorer sidebar + resize handle */}
          {explorerOpen && (
            <>
              <div
                style={{
                  width: explorerWidth,
                  flexShrink: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
                  <FileExplorer onSaveClick={handleSaveClick} onNewClick={handleNewClick} autoSave={autoSave} />
                </div>
                {accountBlock && (
                  <div className="explorer-account-footer">{accountBlock}</div>
                )}
              </div>
              {!isMobile && (
                <div
                  className="explorer-resize-handle"
                  onMouseDown={handleExplorerResizeMouseDown}
                />
              )}
            </>
          )}

          {!explorerOpen && accountBlock && (
            <div className="editor-corner-box">{accountBlock}</div>
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
                  onClick={() => toggleExplorer()}
                  title={explorerOpen ? t('editor.menu.hideExplorer', 'Hide file explorer') : t('editor.menu.showExplorer', 'Show file explorer')}
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
                  />
                </div>
              </div>
            )}

            {/* Editor area — Monaco for every board, QEMU-Linux included.
                Pi boards edit script.py here like any other board edits its
                sketch; their interactive terminal lives in the bottom serial
                panel (SerialMonitor renders an xterm for Pi kinds). The old
                RaspberryPiWorkspace (own file tree + own editor + upload
                button) confused users with three competing file surfaces. */}
            <div
              className="editor-wrapper"
              style={{ flex: 1, overflow: 'hidden', minHeight: 0, position: 'relative' }}
            >
              <CodeEditor />
              {/* The compile card lives over the simulator canvas, which is
                  where the build's result appears. In code-only view (and on
                  a phone showing the editor) that pane is display:none, so it
                  falls back to here rather than leaving the user with the
                  toolbar spinner and no idea a queue exists. */}
              {simulatorHidden && (
                <CompileProgressCard inEditor onShowOutput={() => setConsoleOpen(true)} />
              )}
            </div>

            {/* Console */}
            {consoleOpen && (
              <>
                <div
                  onMouseDown={handleBottomPanelResizeMouseDown}
                  style={resizeHandleStyle}
                  title={t('editor.shell.dragResize')}
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

        {/* Resize handle (desktop only, and only when both panes are visible) */}
        {!isMobile && viewMode === 'both' && (
          <div className="resize-handle" onMouseDown={handleResizeMouseDown}>
            <div className="resize-handle-grip" />
          </div>
        )}

        {/* ── Simulator side ── */}
        <div
          className="simulator-panel"
          style={{
            width: isMobile
              ? '100%'
              : viewMode === 'circuit'
              ? '100%'
              : viewMode === 'code'
              ? '0%'
              : `${100 - editorWidthPct}%`,
            display: simulatorHidden ? 'none' : 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
            <SimulatorCanvas headerSlot={!isMobile ? canvasHeaderSlot : null} />
            {/* Guarded rather than left to `display: none` on the panel: a
                hidden copy still keeps its 100ms timer running and duplicates
                the aria-live region a screen reader reads out. */}
            {!simulatorHidden && <CompileProgressCard onShowOutput={() => setConsoleOpen(true)} />}
          </div>
          {serialMonitorOpen && (
            <>
              <div
                onMouseDown={handleBottomPanelResizeMouseDown}
                style={resizeHandleStyle}
                title={t('editor.shell.dragResize')}
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
                title={t('editor.shell.dragResize')}
              />
              <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                <Oscilloscope />
              </div>
            </>
          )}
        </div>
      </div>

      {showStarBanner && (
        <GitHubStarBanner
          onClose={handleDismissStarBanner}
          onStarClick={handleStarClick}
          round={starRound}
        />
      )}
      <NewsAnnouncer />
      <NewProjectDialog
        isOpen={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
      />
      {/* Slot reserved for the private pro overlay (e.g. agent chat panel).
          Self-hosted builds without an overlay see nothing here. */}
      <div data-velxio-slot="agent-chat" />
    </div>
  );
};
