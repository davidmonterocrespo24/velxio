/**
 * Editor Page — main editor + simulator with resizable panels
 */

import React, { useRef, useState, useSyncExternalStore, useCallback, useEffect, useLayoutEffect } from 'react';
import { ChevronDown, CircuitBoard, CodeXml, FolderOpen, Package, PanelsLeftRight, Plus, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { startSimulation } from '../simulation/spice/start';
import { useSEO } from '../utils/useSEO';
import { CodeEditor, type CodeEditorHandle } from '../components/editor/CodeEditor';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { FileExplorer } from '../components/editor/FileExplorer';
import { EditorSettings } from '../components/editor/EditorSettings';
import { EditorQuickPick } from '../components/editor/EditorQuickPick';
import { LocalProjectsDialog } from '../components/editor/LocalProjectsDialog';
import {
  WorkspaceActivityBar, WorkspaceLibraries, WorkspaceSearch, WorkspaceToolButton,
  type WorkspaceTool, type WorkspaceView,
} from '../components/editor/WorkspaceSidebar';

// Lazy-load Pi workspace so xterm.js isn't in the main bundle
import { CompilationConsole } from '../components/editor/CompilationConsole';
import { CompileProgressCard } from '../components/editor/CompileProgressCard';
import { SimulatorCanvas } from '../components/simulator/SimulatorCanvas';
import { SerialMonitor } from '../components/simulator/SerialMonitor';
import { Oscilloscope } from '../components/simulator/Oscilloscope';
import { AppHeader } from '../components/layout/AppHeader';
import { triggerSaveAction } from '../lib/proSaveAction';
import {
  canOpenProjectFile,
  canSaveProjectFile,
  openProjectFile,
  saveProjectFileAs,
  upgradeWorkspaceLibraryVersions,
  useLocalWorkspace,
  watchLocalWorkspace,
} from '../lib/localWorkspace';
import { useEditorPreferences } from '../store/useEditorPreferences';
import { GitHubStarBanner } from '../components/layout/GitHubStarBanner';
import { NewsAnnouncer } from '../components/layout/NewsAnnouncer';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import { useCompileLogsStore } from '../store/useCompileLogsStore';
import { useOscilloscopeStore } from '../store/useOscilloscopeStore';
import { boardDisplayName } from '../types/board';
import { trackToggleSerialMonitor } from '../utils/analytics';
import { clearWorkspaceForStarter } from '../components/editor/NewProjectDialog';
import { useAutoSaveProject } from '../hooks/useAutoSaveProject';
import { useEditorProjectRoute } from '../hooks/useEditorProjectRoute';
import { registerEditorCommand, runEditorCommand } from '../lib/editorCommands';
import { WorkspaceFlash } from '../components/editor/WorkspaceFlash';
import { getBrowserFlashSelection, subscribeBrowserFlashSelection } from '../lib/browserFlashSerial';
import { EditorMenuBar } from '../components/editor/EditorMenuBar';
import '../App.css';
import '../components/editor/Workspace.css';

const MOBILE_BREAKPOINT = 768;

const BOTTOM_PANEL_MIN = 80;
const BOTTOM_PANEL_MAX = 600;
const BOTTOM_PANEL_DEFAULT = 200;

const EXPLORER_MIN = 100;
const EXPLORER_MAX = 500;
const EXPLORER_COLLAPSE_WIDTH = 92;
const EXPLORER_OPEN_DRAG = 28;
const EDITOR_MIN_WIDTH = 160;
const EXPLORER_HANDLE_WIDTH = 4;
const ACTIVITY_BAR_WIDTH = 34;
const SPLIT_HANDLE_WIDTH = 5;
const DESKTOP_VIEWS = [
  { mode: 'code', Icon: CodeXml },
  { mode: 'both', Icon: PanelsLeftRight },
  { mode: 'circuit', Icon: CircuitBoard },
] as const;

type ProjectDialog = 'start' | 'templates' | 'saved' | 'saved-from-start' | 'save' | 'save-copy';
type BottomPanel = 'console' | 'serial' | 'scope';

function announceStarBanner(action: 'shown' | 'click' | 'dismiss', round: 1 | 2): void {
  window.dispatchEvent(new CustomEvent('velxio-star-banner', { detail: { action, round } }));
}

export const EditorPage: React.FC = () => {
  const { t } = useTranslation();
  useSEO({
    title: 'Multi-Board Simulator Editor — Arduino, ESP32, RP2040, RISC-V | Velxio',
    description:
      'Write, compile and simulate Arduino, ESP32, Raspberry Pi Pico, ESP32-C3, and Raspberry Pi 3 code in your browser. 19 boards, 5 CPU architectures, 48+ components. Free and open-source.',
    url: 'https://velxio.dev/editor',
  });

  useAutoSaveProject();
  const sidebarView = useEditorPreferences((state) => state.sidebarView);
  const savedExplorerWidth = useEditorPreferences((state) => state.sidebarWidth);
  const [draggedExplorerWidth, setDraggedExplorerWidth] = useState<number | null>(null);
  const explorerWidth = draggedExplorerWidth ?? savedExplorerWidth;
  const updatePreferences = useEditorPreferences((state) => state.update);
  const [projectDialog, setProjectDialog] = useState<ProjectDialog | null>(null);
  const [startupWorkspaceVersion, setStartupWorkspaceVersion] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const codeEditorRef = useRef<CodeEditorHandle>(null);
  const [showBoardPicker, setShowBoardPicker] = useState(false);
  const toggleBoardPicker = useCallback(() => setShowBoardPicker((open) => !open), []);
  const [statusBarHost, setStatusBarHost] = useState<HTMLDivElement | null>(null);
  const localProjectName = useLocalWorkspace((state) => state.name);
  const isBrowserProject = useLocalWorkspace((state) => state.browserId !== null);
  const localSaveStatus = useLocalWorkspace((state) => state.status);
  const hasLocalProject = localProjectName !== null;
  const hasCloudProject = useProjectStore((state) => state.currentProject !== null);
  const statusFile = useEditorStore((state) => state.manifestViewBoardId
    ? undefined
    : state.files.find(({ id }) => id === state.activeFileId));
  const workspaceVersion = useProjectStore((state) => state.workspaceVersion);
  const emptyCircuit = useSimulatorStore(
    (state) => !state.boards.length && !state.components.length && !state.wires.length,
  );
  const emptyFiles = useEditorStore(
    (state) => !Object.values(state.fileGroups).some((files) => files.length) &&
      !Object.values(state.folderGroups).some((folders) => folders.length),
  );
  const closeProjectDialog = useCallback(() => setProjectDialog(null), []);
  const dismissProjectStart = () => {
    setStartupWorkspaceVersion(null);
    closeProjectDialog();
  };
  const showProjectStart = useCallback(() => setProjectDialog('start'), []);
  const showStartup = useCallback(() => {
    setStartupWorkspaceVersion(useProjectStore.getState().workspaceVersion);
    setProjectDialog((dialog) => dialog ?? 'start');
  }, []);
  useLayoutEffect(() => watchLocalWorkspace(), []);
  useEffect(() => {
    const request = new AbortController();
    void upgradeWorkspaceLibraryVersions(request.signal);
    return () => request.abort();
  }, [workspaceVersion]);
  const projectRoute = useEditorProjectRoute({
    clearWorkspace: clearWorkspaceForStarter,
    showStartup,
    closeProjectDialog,
  });

  const [editorWidthPct, setEditorWidthPct] = useState(45);
  // Desktop-only 3-way layout switch (code-only / circuit-only / both).
  // Lets users hide a pane to give the right-docked chat more room.
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const explorerOpen = useEditorStore((s) => s.explorerOpen);
  const setExplorerOpen = useEditorStore((s) => s.setExplorerOpen);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorPanelRef = useRef<HTMLDivElement>(null);
  const explorerRef = useRef<HTMLElement>(null);
  const editorMainRef = useRef<HTMLDivElement>(null);
  const simulatorPanelRef = useRef<HTMLDivElement>(null);
  const workspaceStatusRef = useRef<HTMLElement>(null);
  const splitHandleRef = useRef<HTMLDivElement>(null);
  const viewToggleRef = useRef<HTMLDivElement>(null);
  const stopResize = useRef<(() => void) | null>(null);
  const serialMonitorOpen = useSimulatorStore((s) => s.serialMonitorOpen);
  const componentCount = useSimulatorStore((state) => state.components.length);
  const componentCountLabel = t('editor.canvas.componentCount', { count: componentCount });
  const boardChoices = useSimulatorStore((state) => showBoardPicker ? state.boards : undefined);
  const activeBoardId = useSimulatorStore((state) => state.activeBoardId);
  const activeBoardName = useSimulatorStore((state) => {
    const board = state.boards.find((item) => item.id === state.activeBoardId);
    return board ? boardDisplayName(board) : '';
  });
  const oscilloscopeOpen = useOscilloscopeStore((s) => s.open);
  const [consoleOpen, setConsoleOpen] = useState(false);
  // compileLogs live in a Zustand store so the velxio-pro agent overlay
  // (mounted in a separate React tree via slotMounter) can subscribe and
  // build a "diagnose this failure" prompt without prop-drilling.
  const compileLogs = useCompileLogsStore((s) => s.logs);
  const setCompileLogs = useCompileLogsStore((s) => s.setLogs);
  const [bottomPanelHeights, setBottomPanelHeights] = useState<Record<BottomPanel, number>>({
    console: BOTTOM_PANEL_DEFAULT,
    serial: BOTTOM_PANEL_DEFAULT,
    scope: BOTTOM_PANEL_DEFAULT,
  });
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
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches,
  );
  // The canvas portals its board selector and Add button into the desktop toolbar.
  const [canvasHeaderSlot, setCanvasHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [addComponentSlot, setAddComponentSlot] = useState<HTMLDivElement | null>(null);
  // Default to 'code' on mobile — show the editor so users can write/view code
  const [mobileView, setMobileView] = useState<'code' | 'circuit'>('code');

  // Mirrors the `display: none` on the simulator panel below. The compile
  // progress card renders over the canvas, so when that pane is hidden the
  // card has to move to the editor pane instead of disappearing with it.
  const simulatorHidden =
    (isMobile && mobileView !== 'circuit') || (!isMobile && viewMode === 'code');
  const codeVisible = isMobile ? mobileView === 'code' : viewMode !== 'circuit';
  useLayoutEffect(() => {
    const status = workspaceStatusRef.current;
    const editor = editorMainRef.current;
    const circuit = simulatorPanelRef.current;
    if (!status || !editor || !circuit) return;

    const alignDividers = () => {
      const footer = status.getBoundingClientRect();
      const rtl = getComputedStyle(status).direction === 'rtl';
      const paneStart = (pane: HTMLElement) => {
        const rect = pane.getBoundingClientRect();
        return Math.max(0, rtl ? footer.right - rect.right : rect.left - footer.left);
      };
      const editorStart = isMobile || !codeVisible ? 0 : paneStart(editor);
      const circuitStart = isMobile || simulatorHidden ? 0 : paneStart(circuit);
      const split = splitHandleRef.current;
      status.style.setProperty('--status-leading', `${codeVisible ? editorStart : circuitStart}px`);
      status.style.setProperty('--status-editor-width', codeVisible
        ? simulatorHidden ? 'minmax(0, 1fr)' : `${Math.max(0, circuitStart - editorStart)}px`
        : '0px');
      status.style.setProperty('--status-circuit-width', simulatorHidden ? '0px' : 'minmax(0, 1fr)');
      status.style.setProperty('--status-editor-line', `${Math.max(0, editorStart - 1)}px`);
      status.style.setProperty('--status-circuit-line', `${split ? paneStart(split) : circuitStart}px`);
    };

    alignDividers();
    const observer = new ResizeObserver(alignDividers);
    for (const element of [status, editor, circuit]) observer.observe(element);
    return () => observer.disconnect();
  }, [isMobile, codeVisible, simulatorHidden, t]);

  useLayoutEffect(() => {
    const toggle = viewToggleRef.current;
    if (!toggle) return;
    const positionPill = () => {
      const selected = toggle.querySelector('[aria-pressed="true"]');
      if (!selected) return;
      const rect = selected.getBoundingClientRect();
      toggle.style.setProperty('--view-pill-x', `${rect.left - toggle.getBoundingClientRect().left}px`);
      toggle.style.setProperty('--view-pill-width', `${rect.width}px`);
    };
    positionPill();
    const observer = new ResizeObserver(positionPill);
    observer.observe(toggle);
    toggle.querySelectorAll('button').forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [isMobile, viewMode, t]);

  const handleSaveClick = useCallback(() => {
    if (!projectRoute.openingProject) triggerSaveAction(() => setProjectDialog('save'));
  }, [projectRoute.openingProject]);

  const openWorkspaceView = useCallback((view: WorkspaceView) => {
    updatePreferences({ sidebarView: view });
    setExplorerOpen(true);
    if (isMobile) setMobileView('code');
    else if (useEditorStore.getState().viewMode === 'circuit') setViewMode('code');
  }, [isMobile, setExplorerOpen, setViewMode, updatePreferences]);
  const openFlash = useCallback(() => openWorkspaceView('flash'), [openWorkspaceView]);
  const openFlashOutput = useCallback(() => setConsoleOpen(true), []);
  const flashPort = useSyncExternalStore(subscribeBrowserFlashSelection, getBrowserFlashSelection, () => null);
  const flashBoardName = useSimulatorStore((s) => {
    if (!flashPort || flashPort.workspaceVersion !== workspaceVersion || flashPort.port.connected === false) return undefined;
    const board = s.boards.find((item) => item.id === flashPort.boardId);
    return board ? boardDisplayName(board) : undefined;
  });
  const openExplorer = useCallback(() => openWorkspaceView('explorer'), [openWorkspaceView]);

  const selectWorkspaceView = (view: WorkspaceView) => {
    if (view === sidebarView && explorerOpen && codeVisible) setExplorerOpen(false);
    else openWorkspaceView(view);
  };

  const toggleWorkspaceTool = (tool: WorkspaceTool) => {
    if (tool === 'terminal') {
      if (!consoleOpen && !codeVisible) {
        if (isMobile) setMobileView('code');
        else setViewMode('both');
      }
      setConsoleOpen(!consoleOpen);
      return;
    }
    const alreadyOpen = tool === 'serial' ? serialMonitorOpen : oscilloscopeOpen;
    if (!alreadyOpen && simulatorHidden) {
      if (isMobile) setMobileView('circuit');
      else setViewMode('both');
    }
    if (tool === 'serial') {
      useSimulatorStore.getState().toggleSerialMonitor();
      trackToggleSerialMonitor(!serialMonitorOpen);
    } else {
      useOscilloscopeStore.getState().toggleOscilloscope();
    }
  };

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'p') return;
      event.preventDefault();
      openWorkspaceView('search');
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.workspace-search input')?.focus());
    };
    window.addEventListener('keydown', openSearch);
    return () => window.removeEventListener('keydown', openSearch);
  }, [openWorkspaceView]);

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
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!e.repeat) runEditorCommand('project.save');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // File-menu commands owned by this page. Registered here (not in the
  // menu) so the menu never duplicates the confirm-dialog / autosave logic.
  useEffect(() => {
    const offSave = registerEditorCommand('project.save', handleSaveClick);
    const offNew = registerEditorCommand('project.new', showProjectStart);
    const offExplorer = registerEditorCommand('view.toggleExplorer', () => {
      const state = useEditorStore.getState();
      const codeVisible = isMobile ? mobileView === 'code' : state.viewMode !== 'circuit';
      if (state.explorerOpen && sidebarView === 'explorer' && codeVisible) setExplorerOpen(false);
      else openWorkspaceView('explorer');
    });
    const offSettings = registerEditorCommand('view.settings', () => setShowSettings(true));
    const offLocal = registerEditorCommand('project.openLocal', () => setProjectDialog('saved'));
    const offDisk = canOpenProjectFile()
      ? registerEditorCommand('project.openDisk', () => void openProjectFile())
      : undefined;
    const offSaveAs = canSaveProjectFile()
      ? registerEditorCommand('project.saveAs', () => void saveProjectFileAs())
      : undefined;
    return () => {
      offSave();
      offNew();
      offExplorer();
      offSettings();
      offLocal();
      offDisk?.();
      offSaveAs?.();
    };
  }, [handleSaveClick, showProjectStart, isMobile, mobileView, openWorkspaceView, setExplorerOpen, sidebarView]);

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

  useEffect(() => () => stopResize.current?.(), []);

  const beginResize = useCallback((
    event: React.MouseEvent<HTMLElement>,
    cursor: 'ew-resize' | 'ns-resize',
    onMove: (event: MouseEvent) => void,
    onFinish?: () => void,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopResize.current?.();

    const handle = event.currentTarget;
    const bodyStyle = document.body.style;
    const previousCursor = bodyStyle.cursor;
    const previousUserSelect = bodyStyle.userSelect;
    const finish = () => {
      stopResize.current = null;
      delete handle.dataset.resizing;
      bodyStyle.cursor = previousCursor;
      bodyStyle.userSelect = previousUserSelect;
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', finish, true);
      window.removeEventListener('blur', finish);
      onFinish?.();
    };
    stopResize.current = finish;
    handle.dataset.resizing = 'true';
    bodyStyle.cursor = cursor;
    bodyStyle.userSelect = 'none';
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', finish, true);
    window.addEventListener('blur', finish);
  }, []);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const grabOffset = e.clientX - e.currentTarget.getBoundingClientRect().left;
    beginResize(e, 'ew-resize', (ev) => {
      if (!containerRef.current) return;
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
      const panelsLeft = rect.left + el.clientLeft + padLeft + ACTIVITY_BAR_WIDTH;
      const panelsWidth = el.clientWidth - padLeft - padRight - ACTIVITY_BAR_WIDTH - SPLIT_HANDLE_WIDTH;
      if (panelsWidth <= 0) return;
      const sidebarWidth = explorerRef.current?.getBoundingClientRect().width ?? 0;
      const maxWidth = panelsWidth * 0.8;
      const minWidth = Math.min(
        maxWidth,
        Math.max(panelsWidth * 0.2, sidebarWidth + EXPLORER_HANDLE_WIDTH + EDITOR_MIN_WIDTH),
      );
      const width = Math.max(minWidth, Math.min(maxWidth, ev.clientX - panelsLeft - grabOffset));
      setEditorWidthPct((width / panelsWidth) * 100);
    });
  }, [beginResize]);

  const handleBottomPanelResizeMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, panel: BottomPanel) => {
      const startY = e.clientY;
      const startHeight = e.currentTarget.nextElementSibling?.getBoundingClientRect().height ??
        bottomPanelHeights[panel];

      beginResize(e, 'ns-resize', (ev) => {
        const delta = startY - ev.clientY;
        const height = Math.max(BOTTOM_PANEL_MIN, Math.min(BOTTOM_PANEL_MAX, startHeight + delta));
        setBottomPanelHeights((heights) => ({ ...heights, [panel]: height }));
      });
    },
    [beginResize, bottomPanelHeights],
  );

  const handleExplorerResizeMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const startX = e.clientX;
      const startWidth = explorerOpen ? explorerRef.current?.getBoundingClientRect().width ?? explorerWidth : 0;
      const openAt = explorerOpen ? EXPLORER_MIN : EXPLORER_OPEN_DRAG;
      const collapseAt = explorerOpen ? EXPLORER_COLLAPSE_WIDTH : EXPLORER_OPEN_DRAG - 8;
      let open = explorerOpen;
      let nextWidth = explorerWidth;

      beginResize(e, 'ew-resize', (ev) => {
        const width = startWidth + ev.clientX - startX;
        if (open && width < collapseAt) {
          open = false;
          setExplorerOpen(false);
        } else if (!open && width >= openAt) {
          open = true;
          setExplorerOpen(true);
        }
        if (!open) return;
        const panelWidth = editorPanelRef.current?.clientWidth ?? 0;
        const maxWidth = Math.max(
          EXPLORER_MIN,
          Math.min(EXPLORER_MAX, panelWidth - EDITOR_MIN_WIDTH - EXPLORER_HANDLE_WIDTH),
        );
        nextWidth = Math.round(Math.max(EXPLORER_MIN, Math.min(maxWidth, width)));
        setDraggedExplorerWidth(nextWidth);
      }, () => {
        if (open) updatePreferences({ sidebarWidth: nextWidth });
        setDraggedExplorerWidth(null);
      });
    },
    [beginResize, explorerOpen, explorerWidth, setExplorerOpen, updatePreferences],
  );

  /* ── Unified toolbar (desktop) ──
     SimulatorCanvas portals its board controls and Add button into
     separate slots so the execution controls sit between them. */
  const unifiedToolbar = !isMobile ? (
        <div className="unified-toolbar">
          <div className="unified-toolbar-spacer" aria-hidden />
          {/* The three desktop layouts share one segmented control. */}
          <div
            role="group"
            aria-label={t('editor.shell.viewMode')}
            className="view-mode-toggle"
            ref={viewToggleRef}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
              const index = buttons.findIndex((button) => button === event.target);
              if (index < 0) return;
              event.preventDefault();
              const step = event.key === 'ArrowRight' ? 1 : -1;
              const next = (index + step + DESKTOP_VIEWS.length) % DESKTOP_VIEWS.length;
              setViewMode(DESKTOP_VIEWS[next].mode);
              buttons[next]?.focus();
            }}
          >
            {DESKTOP_VIEWS.map(({ mode, Icon }) => {
              const label = t(`editor.shell.${mode}`);
              const selected = viewMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  className="view-mode-button"
                  onClick={() => setViewMode(mode)}
                  tabIndex={selected ? 0 : -1}
                  aria-pressed={selected}
                  aria-label={label}
                  title={label}
                >
                  <Icon size={14} aria-hidden />
                  <span className="vm-label">{label}</span>
                </button>
              );
            })}
          </div>
          <div className="unified-toolbar-tools">
            <div className="unified-toolbar-canvas" ref={setCanvasHeaderSlot} />
            <div className="unified-toolbar-editor">
              <EditorToolbar
                consoleOpen={consoleOpen}
                setConsoleOpen={setConsoleOpen}
                compileLogs={compileLogs}
                setCompileLogs={setCompileLogs}
              />
            </div>
            <div className="unified-toolbar-add" ref={setAddComponentSlot} />
          </div>
        </div>
  ) : undefined;

  const openingProject = projectRoute.openingProject && !projectDialog;
  const awaitingStarterProject = !hasLocalProject && workspaceVersion === startupWorkspaceVersion && emptyCircuit && emptyFiles;
  const showEmptyProjectActions = !projectDialog && !openingProject && awaitingStarterProject;
  const unsavedLocal = !hasCloudProject && (
    statusFile?.modified || localSaveStatus === 'dirty' || localSaveStatus === 'error'
  );
  const statusName = localProjectName ?? (unsavedLocal ? statusFile?.name : undefined);
  const unsavedLabel = t('editor.localProjects.unsavedStatus', 'Unsaved changes');
  const statusTitle = unsavedLocal ? `${unsavedLabel} · ${statusName}` : statusName;
  const statusContent = (
    <>
      {unsavedLocal && <TriangleAlert size={13} className="workspace-status-unsaved" aria-label={unsavedLabel} role="img" />}
      <span>{statusName}</span>
    </>
  );
  const projectStatus = statusName && (isBrowserProject ? (
    <button type="button" className="workspace-status-board workspace-status-project"
      title={statusTitle}
      aria-label={t('editor.localProjects.openList', 'Saved projects · {{name}}', { name: statusTitle })}
      onClick={() => setProjectDialog('saved')}>
      {statusContent}
    </button>
  ) : (
    <span className="workspace-status-board workspace-status-project" title={statusTitle}>
      {statusContent}
    </span>
  ));
  return (
    <>
    {openingProject && (
      <div className="workspace-project-loading" role="status">
        {t('editor.localProjects.opening', 'Opening saved project…')}
      </div>
    )}
    <div className="app editor-workspace" inert={openingProject}
      style={{ '--workspace-activity-width': `${ACTIVITY_BAR_WIDTH}px` } as React.CSSProperties}>
      <AppHeader
        editorMenu={<EditorMenuBar mobileView={isMobile ? mobileView : undefined} onSetMobileView={setMobileView} />}
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
        <WorkspaceActivityBar
          view={explorerOpen && codeVisible ? sidebarView : null}
          settingsOpen={showSettings}
          openTools={{ terminal: consoleOpen, scope: oscilloscopeOpen, serial: serialMonitorOpen }}
          onSelect={selectWorkspaceView}
          flashBoardName={flashBoardName}
          onToggleTool={toggleWorkspaceTool}
          onSettings={() => setShowSettings(true)}
        />
        {/* ── Editor side ── */}
        <div
          className="editor-panel"
          ref={editorPanelRef}
          style={{
            width: isMobile
              ? '100%'
              : viewMode === 'code'
              ? `calc(100% - ${ACTIVITY_BAR_WIDTH}px)`
              : viewMode === 'circuit'
              ? '0%'
              : `calc(${editorWidthPct}% - ${((ACTIVITY_BAR_WIDTH + SPLIT_HANDLE_WIDTH) * editorWidthPct) / 100}px)`,
            display:
              (isMobile && mobileView !== 'code') || (!isMobile && viewMode === 'circuit')
                ? 'none'
                : 'flex',
            maxWidth: 'none',
            minWidth: isMobile ? undefined : `min(${EDITOR_MIN_WIDTH +
              (explorerOpen ? EXPLORER_MIN : 0) + EXPLORER_HANDLE_WIDTH}px, 70%)`,
            flexDirection: 'row',
          }}
        >
          <aside
            ref={explorerRef}
            className="workspace-sidebar"
            style={{ width: isMobile ? explorerWidth :
              `min(${explorerWidth}px, max(0px, calc(100% - ${EDITOR_MIN_WIDTH + EXPLORER_HANDLE_WIDTH}px)))` }}
            hidden={!explorerOpen}
          >
            {/* Keep the explorer mounted so File > Import and New File can
                still use its picker and tree when another view is selected. */}
            <div className="workspace-explorer-view" hidden={sidebarView !== 'explorer'}>
              <FileExplorer onShowExplorer={openExplorer} />
            </div>
            {sidebarView === 'search' && <WorkspaceSearch onOpen={() => {
              if (isMobile) setExplorerOpen(false);
            }} />}
            {sidebarView === 'libraries' && <WorkspaceLibraries />}
            <WorkspaceFlash key={workspaceVersion} active={sidebarView === 'flash'} onOpen={openFlash} onShowOutput={openFlashOutput} />
          </aside>
          {!isMobile && (
            <div
              className={`explorer-resize-handle${explorerOpen ? '' : ' explorer-resize-handle--collapsed'}`}
              style={{ width: EXPLORER_HANDLE_WIDTH }}
              role="separator"
              tabIndex={0}
              aria-label={t('editor.workspace.resizeSidebar', 'Resize sidebar')}
              aria-orientation="vertical"
              title={explorerOpen
                ? t('editor.workspace.resizeSidebar', 'Resize sidebar')
                : t('editor.workspace.dragOpenSidebar', 'Drag to open sidebar')}
              aria-valuemin={0}
              aria-valuemax={EXPLORER_MAX}
              aria-valuenow={explorerOpen ? explorerWidth : 0}
              onMouseDown={handleExplorerResizeMouseDown}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                if (!explorerOpen) {
                  if (event.key === 'ArrowRight') setExplorerOpen(true);
                  return;
                }
                const currentWidth = explorerRef.current?.getBoundingClientRect().width ?? explorerWidth;
                const width = Math.round(currentWidth + (event.key === 'ArrowLeft' ? -10 : 10));
                if (width < EXPLORER_MIN) setExplorerOpen(false);
                else updatePreferences({ sidebarWidth: Math.min(EXPLORER_MAX, width) });
              }}
            />
          )}

          {/* Editor main area */}
          <div
            ref={editorMainRef}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              minWidth: 0,
            }}
          >
            {/* On desktop the editor controls share the top toolbar. */}
            {isMobile && (
              <div className="editor-mobile-toolbar">
                <EditorToolbar
                  consoleOpen={consoleOpen}
                  setConsoleOpen={setConsoleOpen}
                  compileLogs={compileLogs}
                  setCompileLogs={setCompileLogs}
                />
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
              <CodeEditor ref={codeEditorRef} statusBarHost={codeVisible ? statusBarHost : null} />
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
                  onMouseDown={(event) => handleBottomPanelResizeMouseDown(event, 'console')}
                  className="bottom-panel-resize-handle"
                  title={t('editor.shell.dragResize')}
                />
                <div style={{ height: bottomPanelHeights.console, maxHeight: 'calc(100% - 150px)', flexShrink: 0 }}>
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
          <div ref={splitHandleRef} className="resize-handle" style={{ width: SPLIT_HANDLE_WIDTH }}
            onMouseDown={handleResizeMouseDown} />
        )}

        {/* ── Simulator side ── */}
        <div
          className="simulator-panel"
          ref={simulatorPanelRef}
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
            <SimulatorCanvas
              headerSlot={!isMobile ? canvasHeaderSlot : null}
              addComponentSlot={!isMobile ? addComponentSlot : null}
              boardPickerOpen={showBoardPicker}
              onToggleBoardPicker={toggleBoardPicker}
            />
            {/* Guarded rather than left to `display: none` on the panel: a
                hidden copy still keeps its 100ms timer running and duplicates
                the aria-live region a screen reader reads out. */}
            {!simulatorHidden && <CompileProgressCard onShowOutput={() => setConsoleOpen(true)} />}
          </div>
          {serialMonitorOpen && (
            <>
              <div
                onMouseDown={(event) => handleBottomPanelResizeMouseDown(event, 'serial')}
                className="bottom-panel-resize-handle"
                title={t('editor.shell.dragResize')}
              />
              <div style={{ height: bottomPanelHeights.serial, flexShrink: 0 }}>
                <SerialMonitor onClose={() => toggleWorkspaceTool('serial')} />
              </div>
            </>
          )}
          {oscilloscopeOpen && (
            <>
              <div
                onMouseDown={(event) => handleBottomPanelResizeMouseDown(event, 'scope')}
                className="bottom-panel-resize-handle"
                title={t('editor.shell.dragResize')}
              />
              <div style={{ height: bottomPanelHeights.scope, flexShrink: 0 }}>
                <Oscilloscope onClose={() => toggleWorkspaceTool('scope')} />
              </div>
            </>
          )}
        </div>
        {showEmptyProjectActions && (
          <div className="workspace-project-start">
            <section aria-labelledby="workspace-project-start-title">
              <h2 id="workspace-project-start-title">
                {t('editor.localProjects.startTitle', 'Start a project')}
              </h2>
              <div className="workspace-project-start-actions">
                <button type="button" className="workspace-project-start-new"
                  onClick={() => setProjectDialog('templates')}>
                  <Plus size={16} aria-hidden />
                  {t('editor.localProjects.new', 'New project')}
                </button>
                <button type="button" onClick={() => setProjectDialog('saved-from-start')}>
                  <FolderOpen size={16} aria-hidden />
                  {t('editor.localProjects.title', 'Saved projects')}
                </button>
              </div>
            </section>
          </div>
        )}
      </div>

      <footer
        className="workspace-status-bar"
        ref={workspaceStatusRef}
        aria-label={t('editor.workspace.status', 'Workspace status')}
      >
        {!isMobile && codeVisible && explorerOpen && (
          <span className="workspace-status-divider workspace-status-divider--editor" aria-hidden />
        )}
        {!isMobile && codeVisible && !simulatorHidden && (
          <span className="workspace-status-divider workspace-status-divider--circuit" aria-hidden />
        )}
        {codeVisible && (
          <div className="workspace-status-pane workspace-status-pane--editor">
            <WorkspaceToolButton compact tool="terminal" pressed={consoleOpen} onToggle={toggleWorkspaceTool} />
            <div className="workspace-status-controls">
              {projectStatus}
              <div className="workspace-status-editor" ref={setStatusBarHost} />
            </div>
          </div>
        )}
        {!simulatorHidden && (
          <div className="workspace-status-pane workspace-status-pane--circuit">
            <div className="workspace-status-tools">
              <WorkspaceToolButton compact tool="serial" pressed={serialMonitorOpen} onToggle={toggleWorkspaceTool} />
              <WorkspaceToolButton compact tool="scope" pressed={oscilloscopeOpen} onToggle={toggleWorkspaceTool} />
            </div>
            <div className="workspace-status-controls">
              {!codeVisible && projectStatus}
              {activeBoardName && (
            <button
              type="button"
              className="workspace-status-board"
              title={t('editor.workspace.switchBoard', 'Switch board')}
              aria-haspopup="dialog"
              aria-expanded={showBoardPicker}
              onClick={toggleBoardPicker}
            >
              <span>{activeBoardName}</span>
              <ChevronDown size={11} aria-hidden />
            </button>
              )}
              <span className="workspace-component-count" role="img" aria-label={componentCountLabel} title={componentCountLabel}>
                <Package size={13} aria-hidden />
                {componentCount}
              </span>
            </div>
          </div>
        )}
      </footer>

      {showStarBanner && (
        <GitHubStarBanner
          onClose={handleDismissStarBanner}
          onStarClick={handleStarClick}
          round={starRound}
        />
      )}
      <NewsAnnouncer />
      {boardChoices && (
        <EditorQuickPick
          label={t('editor.workspace.selectBoard', 'Select board')}
          onClose={() => setShowBoardPicker(false)}
          groups={[{
            items: boardChoices.map((board) => ({
              id: board.id,
              label: boardDisplayName(board),
              detail: boardChoices.some((other) =>
                other.id !== board.id && boardDisplayName(other) === boardDisplayName(board),
              ) ? board.id : undefined,
              selected: board.id === activeBoardId,
              run: () => {
                useSimulatorStore.getState().setActiveBoardId(board.id);
                setShowBoardPicker(false);
              },
            })),
          }]}
        />
      )}
      {showSettings && (
        <EditorSettings
          onClose={() => setShowSettings(false)}
          onIndentationChange={(previous) => codeEditorRef.current?.applyIndentationPreferences(previous)}
        />
      )}
      {projectDialog === 'start' ? (
        <LocalProjectsDialog view="start" onClose={dismissProjectStart}
          onNew={() => setProjectDialog('templates')} onSaved={() => setProjectDialog('saved-from-start')} />
      ) : projectDialog === 'templates' ? (
        <LocalProjectsDialog view="templates" onClose={closeProjectDialog} onBack={showProjectStart}
          onSaveFailed={projectRoute.leaveProjectRoute} />
      ) : projectDialog === 'saved' || projectDialog === 'saved-from-start' ? (
        <LocalProjectsDialog view="saved" onClose={closeProjectDialog}
          onOpen={projectRoute.openProject}
          onBack={projectDialog === 'saved-from-start' ? showProjectStart : undefined}
          onSaveCopy={projectDialog === 'saved' ? () => setProjectDialog('save-copy') : undefined} />
      ) : projectDialog === 'save' || projectDialog === 'save-copy' ? (
        <LocalProjectsDialog view="save" copy={projectDialog === 'save-copy'}
          onClose={closeProjectDialog} />
      ) : null}
      {/* Slot reserved for the private pro overlay (e.g. agent chat panel).
          Self-hosted builds without an overlay see nothing here. */}
      <div data-velxio-slot="agent-chat" />
    </div>
    </>
  );
};
