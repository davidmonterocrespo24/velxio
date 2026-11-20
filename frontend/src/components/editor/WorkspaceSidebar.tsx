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
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { chipFileGroupId, useEditorStore, type WorkspaceFile } from '../../store/useEditorStore';
import type { EditorPreferences } from '../../store/useEditorPreferences';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { boardDisplayName } from '../../types/board';
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
}: {
  view: WorkspaceView | null;
  settingsOpen: boolean;
  openTools: Record<WorkspaceTool, boolean>;
  onSelect: (view: WorkspaceView) => void;
  onToggleTool: (tool: WorkspaceTool) => void;
  onSettings: () => void;
}) {
  const { t } = useTranslation();
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
  const [contents, setContents] = useState(false);
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
      <h2>{t('editor.activity.search', 'Search')}</h2>
      <input
        className="workspace-search-input"
        type="search"
        aria-label={t('editor.search.query', 'Search workspace')}
        placeholder={t('editor.search.query', 'Search workspace')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && matches[0]) open(matches[0]);
        }}
      />
      <label className="workspace-search-mode">
        <input
          type="checkbox"
          checked={contents}
          onChange={(event) => setContents(event.target.checked)}
        />
        {t('editor.search.contents', 'Search file contents')}
      </label>
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
  return (
    <section
      className="workspace-sidebar-view"
      aria-label={t('editor.activity.libraries', 'Libraries')}
    >
      <h2>{t('editor.activity.libraries', 'Libraries')}</h2>
      {board ? (
        <>
          <p>{boardDisplayName(board)}</p>
          {board.libraries?.length ? (
            <ul>
              {board.libraries.map((library) => (
                <li key={library}>{library}</li>
              ))}
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
