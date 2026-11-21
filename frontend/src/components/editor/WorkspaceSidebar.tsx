import { useDeferredValue, useEffect, useId, useRef, useState } from 'react';
import {
  Activity,
  CircleUser,
  Files,
  Library,
  Monitor,
  Search,
  Settings,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import { SearchBar } from '../ui/SearchBar';
import { useTranslation } from 'react-i18next';
import { chipFileGroupId, useEditorStore, type WorkspaceFile } from '../../store/useEditorStore';
import type { EditorPreferences } from '../../store/useEditorPreferences';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { boardDisplayName } from '../../types/board';
import {
  ARDUINO_LIBRARIES_CHANGED,
  findInstalledArduinoLibrary,
  getCustomLibraries,
  getInstalledLibraries,
  type InstalledLibrary,
} from '../../services/libraryService';
import { EditorAccountMenuItems } from './EditorAccountMenuItems';

export type WorkspaceView = EditorPreferences['sidebarView'];

const activities = [
  { id: 'explorer', label: 'Explorer', Icon: Files },
  { id: 'search', label: 'Search', Icon: Search },
  { id: 'libraries', label: 'Libraries', Icon: Library },
] as const;

const tools = [
  { id: 'terminal', label: 'Terminal', Icon: Terminal },
  { id: 'scope', label: 'Scope', Icon: Activity },
  { id: 'serial', label: 'Serial Monitor', Icon: Monitor },
] as const;

export type WorkspaceTool = (typeof tools)[number]['id'];

export function WorkspaceToolButton({ tool, pressed, onToggle, compact = false }: {
  tool: WorkspaceTool;
  pressed: boolean;
  onToggle: (tool: WorkspaceTool) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { label, Icon } = tools.find(({ id }) => id === tool)!;
  const name = t(`editor.activity.${tool}`, label);
  return (
    <button type="button" className={compact ? 'workspace-status-tool' : 'workspace-activity-button'}
      title={name} aria-label={name} aria-pressed={pressed} onClick={() => onToggle(tool)}>
      <Icon size={compact ? 14 : 18} aria-hidden />
    </button>
  );
}

function WorkspaceAccount() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const account = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const label = t('editor.menu.account', 'Account');

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !account.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const closeAccount = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div
      className="workspace-activity-account"
      ref={account}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === 'Escape') {
          event.stopPropagation();
          closeAccount();
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            '.workspace-account-menu button:not(:disabled), .workspace-account-menu a[href]',
          ),
        );
        if (items.length === 0) return;
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next =
          event.key === 'ArrowDown' ? index + 1 : index < 0 ? items.length - 1 : index - 1;
        event.preventDefault();
        items[(next + items.length) % items.length]?.focus();
      }}
    >
      <button
        type="button"
        className="workspace-activity-button"
        ref={trigger}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
      >
        <CircleUser size={18} aria-hidden />
      </button>
      {open && (
        <div className="emb-menu workspace-account-menu dropdown-panel" id={menuId} role="menu" aria-label={label}>
          <EditorAccountMenuItems onClose={closeAccount} />
        </div>
      )}
    </div>
  );
}

export function WorkspaceActivityBar({
  view,
  settingsOpen,
  openTools,
  onSelect,
  onToggleTool,
  onSettings,
  flashBoardName,
}: {
  view: WorkspaceView | null;
  settingsOpen: boolean;
  openTools: Record<WorkspaceTool, boolean>;
  onSelect: (view: WorkspaceView) => void;
  onToggleTool: (tool: WorkspaceTool) => void;
  onSettings: () => void;
  flashBoardName?: string;
}) {
  const { t } = useTranslation();
  const flashLabel = flashBoardName
    ? t('editor.flash.selectedBoard', 'Flash · {{board}}', { board: flashBoardName })
    : t('editor.toolbar.flash.label', 'Flash');
  return (
    <nav
      className="workspace-activity-bar"
      aria-label={t('editor.activity.label', 'Workspace views')}
    >
      {activities.map(({ id, label, Icon }) => (
        <button
          type="button"
          className="workspace-activity-button"
          key={id}
          title={t(`editor.activity.${id}`, label)}
          aria-label={t(`editor.activity.${id}`, label)}
          aria-pressed={view === id}
          onClick={() => onSelect(id)}
        >
          <Icon size={18} aria-hidden />
        </button>
      ))}
      <div
        className="workspace-activity-panel-tools"
        role="group"
        aria-label={t('editor.activity.tools', 'Workspace tools')}
      >
        {tools.map(({ id }) => (
          <WorkspaceToolButton key={id} tool={id} pressed={openTools[id]} onToggle={onToggleTool} />
        ))}
      </div>
      <div className="workspace-activity-panel-tools">
        <button type="button" className="workspace-activity-button workspace-activity-flash"
          title={flashLabel} aria-label={flashLabel} aria-pressed={view === 'flash'}
          onClick={() => onSelect('flash')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M12 8v7" />
            <path d="m9 12 3 3 3-3" />
            <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
          </svg>
          {flashBoardName && <span className="workspace-activity-flash-dot" aria-hidden />}
        </button>
      </div>
      <div
        className="workspace-activity-account-tools"
        role="group"
        aria-label={t('editor.activity.accountTools', 'Account and settings')}
      >
        <WorkspaceAccount />
        <button
          type="button"
          className="workspace-activity-button workspace-activity-settings"
          title={t('editor.activity.settings', 'Settings')}
          aria-label={t('editor.activity.settings', 'Settings')}
          aria-pressed={settingsOpen}
          aria-haspopup="dialog"
          onClick={onSettings}
        >
          <Settings size={18} aria-hidden />
        </button>
      </div>
    </nav>
  );
}

interface SearchMatch {
  groupId: string;
  file: WorkspaceFile;
  line?: { lineNumber: number; column: number; text: string };
}

function findMatches(
  groups: Record<string, WorkspaceFile[]>,
  query: string,
  contents: boolean,
): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  for (const [groupId, files] of Object.entries(groups)) {
    for (const file of files) {
      if (!contents) {
        if (file.name.toLocaleLowerCase().includes(query)) matches.push({ groupId, file });
      } else {
        const lines = file.content.split(/\r?\n/);
        for (const [index, text] of lines.entries()) {
          const column = text.toLocaleLowerCase().indexOf(query) + 1;
          if (column)
            matches.push({ groupId, file, line: { lineNumber: index + 1, column, text } });
          if (matches.length >= 100) return { matches, truncated: true };
        }
      }
      if (matches.length >= 100) return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

export function WorkspaceSearch({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [contents, setContents] = useState(true);
  const searchMode = useId();
  const deferred = useDeferredValue(query.trim().toLocaleLowerCase());
  const groups = useEditorStore((state) => state.fileGroups);
  const boards = useSimulatorStore((state) => state.boards);
  const chips = useSimulatorStore((state) => state.components);
  const { matches, truncated } = deferred
    ? findMatches(groups, deferred, contents)
    : { matches: [], truncated: false };

  const open = ({ groupId, file, line }: SearchMatch) => {
    const board = useSimulatorStore
      .getState()
      .boards.find((item) => item.activeFileGroupId === groupId);
    if (board) useSimulatorStore.getState().setActiveBoardId(board.id);
    const editor = useEditorStore.getState();
    editor.setActiveGroup(groupId);
    editor.openFile(file.id);
    editor.setRevealLocation({
      groupId,
      fileId: file.id,
      position: line ?? { lineNumber: 1, column: 1 },
    });
    onOpen();
  };

  return (
    <section className="workspace-sidebar-view" aria-label={t('editor.activity.search', 'Search')}>
      <header className="workspace-sidebar-header">
        <h2 className="workspace-sidebar-title">{t('editor.activity.search', 'Search')}</h2>
      </header>
      <SearchBar
        className="workspace-search"
        placeholder={t('editor.search.query', 'Search workspace')}
        value={query}
        onValueChange={setQuery}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && matches[0]) open(matches[0]);
        }}
      />
      <div className="workspace-search-modes" role="radiogroup" aria-label={t('editor.search.mode', 'Search mode')}>
        <label>
          <input type="radio" name={searchMode} checked={contents} onChange={() => setContents(true)} />
          {t('editor.search.fileContents', 'File contents')}
        </label>
        <label>
          <input type="radio" name={searchMode} checked={!contents} onChange={() => setContents(false)} />
          {t('editor.search.fileNames', 'File names')}
        </label>
      </div>
      {deferred && matches.length === 0 && (
        <p role="status">{t('editor.search.noResults', 'No matches.')}</p>
      )}
      {matches.map((match) => {
        const { groupId, file, line } = match;
        const board = boards.find((item) => item.activeFileGroupId === groupId);
        const chip = chips.find(
          (item) => item.metadataId === 'custom-chip' && groupId === chipFileGroupId(item.id),
        );
        const group = board
          ? boardDisplayName(board)
          : String(chip?.properties.name || t('editor.activity.explorer', 'Explorer'));
        return (
          <button
            type="button"
            className="workspace-search-result"
            key={`${groupId}/${file.id}/${line?.lineNumber ?? 0}`}
            title={`${group} / ${file.name}`}
            onClick={() => open(match)}
          >
            <strong>
              {file.name}
              {line && `:${line.lineNumber}`}
            </strong>
            <span>{line ? line.text.trim() : group}</span>
          </button>
        );
      })}
      {truncated && <p>{t('editor.search.truncated', 'Showing the first 100 matches.')}</p>}
    </section>
  );
}

export function WorkspaceLibraries() {
  const { t } = useTranslation();
  const board = useSimulatorStore((state) =>
    state.boards.find((item) => item.id === state.activeBoardId),
  );
  const hasArduinoLibraries = !!board?.libraries?.length && board.languageMode !== 'micropython';
  const [inventory, setInventory] = useState<{ installed: InstalledLibrary[]; custom: InstalledLibrary[] } | null>(null);
  useEffect(() => {
    if (!hasArduinoLibraries) return;
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      try {
        const [installed, custom] = await Promise.all([getInstalledLibraries(), getCustomLibraries()]);
        if (current === request) setInventory({ installed, custom });
      } catch {
        if (current === request) setInventory(null);
      }
    };
    void refresh();
    window.addEventListener(ARDUINO_LIBRARIES_CHANGED, refresh);
    window.addEventListener('velxio-custom-library-installed', refresh);
    return () => {
      request++;
      window.removeEventListener(ARDUINO_LIBRARIES_CHANGED, refresh);
      window.removeEventListener('velxio-custom-library-installed', refresh);
    };
  }, [hasArduinoLibraries]);
  const missingLabel = t('editor.libraryManager.libraryMissing', 'Required by this board and not installed');

  return (
    <section
      className="workspace-sidebar-view"
      aria-label={t('editor.activity.libraries', 'Libraries')}
    >
      <header className="workspace-sidebar-header">
        <h2 className="workspace-sidebar-title">{t('editor.activity.libraries', 'Libraries')}</h2>
      </header>
      {board ? (
        <>
          <p>{boardDisplayName(board)}</p>
          {board.libraries?.length ? (
            <ul>
              {board.libraries.map((library) => {
                const missing = hasArduinoLibraries && inventory
                  && !findInstalledArduinoLibrary(inventory.custom, library.split('@')[0])
                  && !findInstalledArduinoLibrary(inventory.installed, library);
                return (
                  <li key={library} className={missing ? 'workspace-library-missing' : undefined}>
                    {missing && <TriangleAlert size={13} role="img" aria-label={missingLabel} />}
                    {library}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>{t('editor.workspace.noLibraries', 'This board has no declared libraries.')}</p>
          )}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('velxio-open-library-manager'))}
          >
            {t('editor.workspace.manageLibraries', 'Manage libraries')}
          </button>
        </>
      ) : (
        <p>{t('editor.workspace.noBoard', 'Select a board to see its libraries.')}</p>
      )}
    </section>
  );
}
