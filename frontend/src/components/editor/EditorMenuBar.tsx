/**
 * EditorMenuBar — File / Edit menus for the editor header.
 *
 * The editor grew a single toolbar row where every action, frequent or
 * rare, competed for the same pixels; on small screens the buttons
 * measurably overlapped. The classic fix is the classic desktop split:
 * things you do every minute stay as buttons (Run, Stop, board, Add),
 * things you do a few times per session move into menus. This is those
 * menus.
 *
 * Actions are invoked through the editorCommands registry — their real
 * owners (EditorPage, FileExplorer, EditorToolbar, SimulatorCanvas)
 * register handlers on mount, so nothing here duplicates logic and an
 * item whose owner is not mounted renders disabled. Undo and redo follow
 * the last focused editing pane and use its history.
 *
 * Menubar behaviour follows the desktop convention: click opens, click
 * again closes, hovering a sibling while open switches menus, Escape and
 * outside clicks close.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useOscilloscopeStore } from '../../store/useOscilloscopeStore';
import { useEditorStore, type EditorViewMode } from '../../store/useEditorStore';
import { useEditorPreferences } from '../../store/useEditorPreferences';
import {
  getEditingPane,
  hasEditorCommand,
  runEditorCommand,
  subscribeEditorCommands,
  getEditorCommandsVersion,
  type EditorCommandId,
} from '../../lib/editorCommands';
import './EditorMenuBar.css';

type Item =
  | {
      kind: 'command';
      id: EditorCommandId;
      label: string;
      shortcut?: string;
      pro?: boolean;
      /** Hide the row entirely when no handler is registered, instead of
       *  the default "render disabled". For account-scoped items the
       *  absence of a handler is not "temporarily unavailable" but "does
       *  not apply here": OSS has no accounts at all, and in pro exactly
       *  one of Sign in / My projects is meaningful at a time. A greyed-out
       *  "My projects" would read as a broken feature in both. */
      optional?: boolean;
    }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'separator' };

// Same links the desktop app's Help menu opens (pro/desktop menu.rs) — the
// web editor mirrors that structure so both feel like one product. They
// replace the marketing nav this header no longer shows, opening in a new
// tab so the editor (and any unsaved work) stays put.
const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';
const DISCORD_URL = 'https://discord.gg/3mARjJrh4E';
// In the OSS build the marketing pages live on velxio.dev, not in this app
// (the overlay registers them only in pro builds) — link absolute, exactly
// like the desktop app's Help menu does.
const SITE = import.meta.env.VITE_PRO_BUILD ? '' : 'https://velxio.dev';

export const EditorMenuBar: React.FC<{
  mobileView?: 'code' | 'circuit';
  onSetMobileView: (mode: 'code' | 'circuit') => void;
}> = ({ mobileView, onSetMobileView }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState<'file' | 'edit' | 'view' | 'run' | 'help' | null>(null);
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 1280px)').matches);
  const rootRef = useRef<HTMLDivElement>(null);

  // Re-render when owners (un)register their commands.
  useSyncExternalStore(subscribeEditorCommands, getEditorCommandsVersion);

  const serialOpen = useSimulatorStore((s) => s.serialMonitorOpen);
  const toggleSerialMonitor = useSimulatorStore((s) => s.toggleSerialMonitor);
  const scopeOpen = useOscilloscopeStore((s) => s.open);
  const toggleOscilloscope = useOscilloscopeStore((s) => s.toggleOscilloscope);
  // Layout rows: the same switches as the toolbar's explorer / Code / Both /
  // Circuit toggle, which hides on a narrow bar (App.css) — the menu is then
  // the only way to reach them, so they carry live checkmarks.
  const explorerOpen = useEditorStore((s) => s.explorerOpen);
  const sidebarView = useEditorPreferences((s) => s.sidebarView);
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const undo = useSimulatorStore((s) => s.undo);
  const redo = useSimulatorStore((s) => s.redo);
  const history = useSimulatorStore((s) => s.history);
  const historyIndex = useSimulatorStore((s) => s.historyIndex);
  const codeHistory = (mobileView ?? viewMode) === 'code' ||
    ((mobileView ?? viewMode) === 'both' && getEditingPane() === 'code');

  useEffect(() => {
    const query = matchMedia('(max-width: 1280px)');
    const onChange = () => {
      setCompact(query.matches);
      setOpen(null);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const trigger = rootRef.current?.querySelector<HTMLButtonElement>('.emb-trigger-open');
      setOpen(null);
      if (rootRef.current?.contains(document.activeElement)) trigger?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const fileItems: Item[] = [
    { kind: 'command', id: 'project.new', label: t('editor.menu.newProject', 'New workspace') },
    { kind: 'command', id: 'file.new', label: t('editor.menu.newFile', 'New file') },
    { kind: 'separator' },
    // Third item, and deliberately at the head of the project group rather
    // than tacked onto the "new …" pair above: it opens the user's saved
    // work, which is what Open/Save below are about.
    {
      kind: 'command',
      id: 'account.myProjects',
      label: t('header.auth.myProjects', 'My projects'),
      optional: true,
    },
    { kind: 'command', id: 'project.openLocal', label: t('editor.menu.openLocal', 'Open local project…') },
    { kind: 'command', id: 'project.openDisk', label: t('editor.menu.openDisk', 'Open .vlx from disk…'), optional: true },
    { kind: 'command', id: 'project.open', label: t('editor.menu.importFromDisk', 'Import from disk…') },
    {
      kind: 'command',
      id: 'project.save',
      label: t('editor.menu.save', 'Save project'),
      shortcut: 'Ctrl+S',
    },
    { kind: 'command', id: 'project.saveAs', label: t('editor.menu.saveAs', 'Save As…'), optional: true },
    { kind: 'separator' },
    { kind: 'command', id: 'project.import', label: t('editor.toolbar.importLabel', 'Import project') },
    { kind: 'command', id: 'project.exportVlx', label: t('editor.toolbar.exportVlxLabel', 'Export project (.vlx)') },
    { kind: 'command', id: 'project.export', label: t('editor.toolbar.exportLabel', 'Export project (.zip)') },
    { kind: 'command', id: 'project.exportBom', label: t('editor.toolbar.exportBomLabel', 'Bill of Materials (CSV)'), pro: true },
    {
      kind: 'command',
      id: 'project.exportScreenshot',
      label: t('editor.toolbar.exportScreenshotLabel', 'Schematic image (PNG)'),
      pro: true,
    },
    { kind: 'separator' },
    // The toolbar's "..." menu folded in here — same actions, same PRO
    // pills, one button fewer in the strip.
    { kind: 'command', id: 'project.share', label: t('editor.toolbar.shareLabel', 'Share / Embed') },
    { kind: 'command', id: 'project.githubSync', label: t('editor.toolbar.githubSyncLabel', 'Sync to GitHub'), pro: true },
    {
      kind: 'command',
      id: 'project.connectAgent',
      label: t('editor.toolbar.connectAgentLabel', 'Connect AI agent (Claude/Codex)'),
      pro: true,
      // Only the pro overlay registers a handler; hide (not grey out) the
      // row in builds where connecting an external agent cannot exist.
      optional: true,
    },
    { kind: 'command', id: 'firmware.upload', label: t('editor.toolbar.uploadFirmwareLabel', 'Upload firmware') },
    { kind: 'command', id: 'sim.record', label: t('editor.toolbar.recordLabel', 'Record simulation'), pro: true },
  ];

  const helpItems: Item[] = [
    // Only present once a post has been delivered — the announcement is a
    // toast now, and this is how it stays reachable after it retires.
    {
      kind: 'command',
      id: 'help.whatsNew',
      label: t('news.kicker', "What's new"),
      optional: true,
    },
    { kind: 'link', href: `${SITE}/docs`, label: t('header.nav.documentation', 'Documentation') },
    { kind: 'link', href: '/examples', label: t('header.nav.examples', 'Examples') },
    { kind: 'link', href: `${SITE}/pricing`, label: t('header.nav.pricing', 'Pricing') },
    { kind: 'separator' },
    { kind: 'link', href: SITE || '/', label: t('editor.menu.home', 'Velxio Home') },
    { kind: 'link', href: `${SITE}/blog/`, label: t('header.nav.blog', 'Blog') },
    { kind: 'link', href: `${SITE}/about`, label: t('editor.menu.about', 'About Velxio') },
    { kind: 'separator' },
    { kind: 'link', href: DISCORD_URL, label: t('editor.menu.discord', 'Discord Community') },
    { kind: 'link', href: GITHUB_URL, label: t('editor.menu.github', 'GitHub Repository') },
  ];

  // Undo and redo use the history of the current editing pane.
  const editItems: Item[] = [
    { kind: 'separator' },
    { kind: 'command', id: 'edit.cut', label: t('editor.menu.cut', 'Cut'), shortcut: 'Ctrl+X' },
    { kind: 'command', id: 'edit.copy', label: t('editor.menu.copy', 'Copy'), shortcut: 'Ctrl+C' },
    { kind: 'command', id: 'edit.paste', label: t('editor.menu.paste', 'Paste'), shortcut: 'Ctrl+V' },
    { kind: 'separator' },
    { kind: 'command', id: 'edit.find', label: t('editor.menu.find', 'Find'), shortcut: 'Ctrl+F' },
    { kind: 'command', id: 'edit.replace', label: t('editor.menu.replace', 'Replace'), shortcut: 'Ctrl+H' },
    { kind: 'separator' },
    {
      kind: 'command',
      id: 'edit.triggerSuggestions',
      label: t('editor.menu.triggerSuggestions', 'Trigger Suggestions'),
      shortcut: 'Ctrl+Space',
    },
    {
      kind: 'command',
      id: 'edit.formatDocument',
      label: t('editor.menu.formatDocument', 'Format document'),
      shortcut: 'Shift+Alt+F',
    },
  ];

  const runItems: Item[] = [
    { kind: 'command', id: 'sim.compile', label: t('editor.menu.compile', 'Compile'), shortcut: 'Ctrl+B' },
    { kind: 'command', id: 'sim.run', label: t('editor.menu.run', 'Run') },
    { kind: 'command', id: 'sim.stop', label: t('editor.toolbar.stop', 'Stop') },
    { kind: 'command', id: 'sim.resetBoard', label: t('editor.toolbar.reset', 'Reset') },
  ];

  // File Explorer is rendered as a checkmarked row in the View block below.
  const viewItems: Item[] = [
    { kind: 'command', id: 'view.toggleConsole', label: t('editor.menu.toggleConsole', 'Output Console') },
    { kind: 'command', id: 'view.settings', label: t('editor.settings.title', 'Settings') },
    { kind: 'separator' },
    { kind: 'command', id: 'view.reset', label: t('editor.menu.centerView', 'Center canvas view') },
    { kind: 'command', id: 'view.zoomIn', label: t('editor.canvas.zoomIn', 'Zoom in') },
    { kind: 'command', id: 'view.zoomOut', label: t('editor.canvas.zoomOut', 'Zoom out') },
  ];

  const layoutModes: { key: EditorViewMode; label: string }[] = [
    { key: 'code', label: t('editor.shell.code', 'Code') },
    { key: 'both', label: t('editor.shell.both', 'Both') },
    { key: 'circuit', label: t('editor.shell.circuit', 'Circuit') },
  ];

  const renderLink = (item: Extract<Item, { kind: 'link' }>): React.ReactNode => (
    <a
      key={item.href}
      role="menuitem"
      className="emb-item"
      href={item.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => setOpen(null)}
    >
      <span>{item.label}</span>
    </a>
  );

  const renderCommand = (item: Extract<Item, { kind: 'command' }>): React.ReactNode => (
    <button
      key={item.id}
      role="menuitem"
      className="emb-item"
      disabled={!hasEditorCommand(item.id)}
      onClick={() => {
        setOpen(null);
        runEditorCommand(item.id);
      }}
    >
      <span>
        {item.label}
        {item.pro && <span className="emb-pro">PRO</span>}
      </span>
      {item.shortcut && <span className="emb-shortcut">{item.shortcut}</span>}
    </button>
  );

  const menus = [
    { key: 'file', label: t('editor.menu.file', 'File'), items: fileItems },
    { key: 'edit', label: t('editor.menu.edit', 'Edit'), items: editItems },
    { key: 'view', label: t('editor.menu.view', 'View'), items: viewItems },
    { key: 'run', label: t('editor.menu.run', 'Run'), items: runItems },
    { key: 'help', label: t('editor.menu.help', 'Help'), items: helpItems },
  ] as const;

  const menu = ({ key: which, label, items }: typeof menus[number]): React.ReactNode => (
    <div className="emb-root" key={compact ? 'compact' : which}>
      <button
        className={`emb-trigger${open === which ? ' emb-trigger-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open === which}
        onClick={() => setOpen((cur) => (cur === which ? null : which))}
        onMouseEnter={() => {
          if (!compact) setOpen((cur) => (cur && cur !== which ? which : cur));
        }}
      >
        {compact ? t('editor.menu.mainMenu', 'Menu') : label}
      </button>
      {open === which && (
        <div className="emb-menu dropdown-panel" role="menu" onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href]',
          )).filter((item) => item.getClientRects().length > 0);
          if (!items.length) return;
          event.preventDefault();
          const index = items.findIndex((item) => item === document.activeElement);
          const step = event.key === 'ArrowDown' ? 1 : -1;
          items[(index + step + items.length) % items.length]?.focus();
        }}>
          {compact && (
            <div className="emb-categories">
              {menus.map((entry) => (
                <button type="button" key={entry.key} aria-pressed={open === entry.key}
                  onClick={() => setOpen(entry.key)}>
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          {which === 'view' && (
            <>
              <button
                role="menuitemcheckbox"
                aria-checked={serialOpen}
                className="emb-item"
                onClick={() => {
                  setOpen(null);
                  toggleSerialMonitor();
                }}
              >
                <span>{t('editor.canvas.toggleSerialMonitor', 'Serial Monitor')}</span>
                <span className="emb-shortcut">{serialOpen ? '✓' : ''}</span>
              </button>
              <button
                role="menuitemcheckbox"
                aria-checked={scopeOpen}
                className="emb-item"
                onClick={() => {
                  setOpen(null);
                  toggleOscilloscope();
                }}
              >
                <span>{t('editor.menu.toggleScope', 'Oscilloscope / Logic Analyzer')}</span>
                <span className="emb-shortcut">{scopeOpen ? '✓' : ''}</span>
              </button>
              <div className="emb-separator" />
              {/* Layout: explorer pane + Code / Both / Circuit. Mirrors the
                  toolbar's segmented toggle, which App.css hides once the
                  shared bar gets narrow (small window + docked AI chat). */}
              <div className="emb-section-label">{t('editor.shell.viewMode', 'View mode')}</div>
              <button
                role="menuitemcheckbox"
                aria-checked={explorerOpen && sidebarView === 'explorer'}
                className="emb-item"
                onClick={() => {
                  setOpen(null);
                  runEditorCommand('view.toggleExplorer');
                }}
              >
                <span>{t('editor.menu.toggleExplorer', 'File Explorer')}</span>
                <span className="emb-shortcut">{explorerOpen && sidebarView === 'explorer' ? '✓' : ''}</span>
              </button>
              {layoutModes.filter((m) => !mobileView || m.key !== 'both').map((m) => (
                <button
                  key={m.key}
                  role="menuitemradio"
                  aria-checked={(mobileView ?? viewMode) === m.key}
                  className="emb-item"
                  onClick={() => {
                    setOpen(null);
                    if (mobileView && m.key !== 'both') onSetMobileView(m.key);
                    else setViewMode(m.key);
                  }}
                >
                  <span>{m.label}</span>
                  <span className="emb-shortcut">{(mobileView ?? viewMode) === m.key ? '✓' : ''}</span>
                </button>
              ))}
              <div className="emb-separator" />
            </>
          )}
          {which === 'edit' && (
            <>
              <button
                role="menuitem"
                className="emb-item"
                disabled={codeHistory ? !hasEditorCommand('edit.undo') : historyIndex < 0}
                onClick={() => {
                  setOpen(null);
                  if (codeHistory) runEditorCommand('edit.undo');
                  else undo();
                }}
              >
                <span>{t('editor.menu.undo', 'Undo')}</span>
                <span className="emb-shortcut">Ctrl+Z</span>
              </button>
              <button
                role="menuitem"
                className="emb-item"
                disabled={codeHistory ? !hasEditorCommand('edit.redo') : historyIndex >= history.length - 1}
                onClick={() => {
                  setOpen(null);
                  if (codeHistory) runEditorCommand('edit.redo');
                  else redo();
                }}
              >
                <span>{t('editor.menu.redo', 'Redo')}</span>
                <span className="emb-shortcut">Ctrl+Y</span>
              </button>
            </>
          )}
          {items
            .filter(
              (item) =>
                item.kind !== 'command' || !item.optional || hasEditorCommand(item.id),
            )
            .map((item, i) =>
              item.kind === 'separator' ? (
                <div key={`sep-${i}`} className="emb-separator" />
              ) : item.kind === 'link' ? (
                renderLink(item)
              ) : (
                renderCommand(item)
              ),
            )}
        </div>
      )}
    </div>
  );

  return (
    <div className="editor-menubar" ref={rootRef}>
      {compact ? menu(menus.find((entry) => entry.key === open) ?? menus[0]) : menus.map(menu)}
    </div>
  );
};
