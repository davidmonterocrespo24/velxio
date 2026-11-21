import { DropdownSelect } from '../ui/DropdownSelect';
import { SearchBar } from '../ui/SearchBar';
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  searchLibraries,
  installLibrary,
  getInstalledLibraries,
  getCustomLibraries,
  deleteCustomLibrary,
} from '../../services/libraryService';
import type { ArduinoLibrary, InstalledLibrary } from '../../services/libraryService';
import { trackInstallLibrary } from '../../utils/analytics';
import {
  BUILTIN_MPY_MODULES,
  FEATURED_MPY_PACKAGES,
  fetchMpyPackage,
  packageFilesInGroup,
  searchMpyPackages,
  writeFilesIntoGroup,
} from '../../services/micropythonLibs';
import type { MpyPackage } from '../../services/micropythonLibs';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { boardDisplayName } from '../../types/board';
import './LibraryManagerModal.css';

interface LibraryManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Case/separator-insensitive name match, matching the backend's _norm_lib_name
 *  so the UI's "in project" state agrees with what the compiler scopes. */
const normLib = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** One row of the single unified list. A search result and an installed/custom
 *  library both normalise to this so they render identically. */
interface LibRow {
  name: string;
  version: string;
  author: string;
  desc: string;
  installed: boolean;
  custom: boolean;
  releases?: Record<string, unknown>;
}

/**
 * Library Manager — ONE list, no tabs. Each row is state-aware:
 *   + Add to project   (installs if needed, then declares it on this board)
 *   In project ✓       (click to remove from this board's libraries.json)
 *   Uninstall / Remove (free the cache / remove your custom upload)
 *
 * The per-board manifest (board.libraries) IS the compile scope and is what the
 * read-only `libraries.json` file in the explorer shows. This modal is the only
 * place that edits it.
 */
export const LibraryManagerModal: React.FC<LibraryManagerModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();

  // Per-board manifest: the libraries.json edited here belongs to the ACTIVE
  // board, so two boards in one project can scope to different libraries.
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const updateBoard = useSimulatorStore((s) => s.updateBoard);
  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? boards[0];
  const manifestLibs = activeBoard?.libraries ?? null;
  const declared = manifestLibs ?? [];

  // ── MicroPython mode (issue #214) ─────────────────────────────────────────
  // Same modal, different backing: a MicroPython library is a .py file in
  // the project, so search hits the micropython-lib index (backend proxy)
  // and "Add to project" writes the package's files into this board's file
  // group — no libraries.json, no arduino-cli.
  const isMpy = activeBoard?.languageMode === 'micropython';
  const [mpyResults, setMpyResults] = useState<MpyPackage[]>([]);
  // Bumped after add/remove so the "In project" pills re-derive from the
  // file group (which lives outside React state).
  const [mpyTick, setMpyTick] = useState(0);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ArduinoLibrary[]>([]);
  const [installedLibraries, setInstalledLibraries] = useState<InstalledLibrary[]>([]);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [loadingInstalled, setLoadingInstalled] = useState(false);
  const [busyLib, setBusyLib] = useState<string | null>(null); // install/uninstall in flight
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setLibraries = useCallback(
    (libs: string[] | null) => {
      if (!activeBoard) return;
      updateBoard(activeBoard.id, { libraries: libs && libs.length ? libs : undefined });
    },
    [activeBoard, updateBoard],
  );

  const inManifest = useCallback(
    (name: string): boolean => declared.some((l) => normLib(l) === normLib(name)),
    [declared],
  );
  const addToManifest = useCallback(
    (name: string) => {
      const clean = name.trim();
      if (!clean) return;
      const cur = manifestLibs ?? [];
      if (cur.some((l) => normLib(l) === normLib(clean))) return;
      setLibraries([...cur, clean]);
    },
    [manifestLibs, setLibraries],
  );
  const removeFromManifest = useCallback(
    (name: string) => {
      const cur = manifestLibs ?? [];
      const next = cur.filter((l) => normLib(l) !== normLib(name));
      setLibraries(next.length ? next : null);
    },
    [manifestLibs, setLibraries],
  );

  const isInstalled = useCallback(
    (name: string): boolean =>
      installedLibraries.some((il) => normLib(il.library?.name || il.name || '') === normLib(name)),
    [installedLibraries],
  );

  const fetchInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      // The shared index libs PLUS the user's per-user custom uploads (which
      // live in their per-user store). Custom first; de-duped by name.
      const [libs, custom] = await Promise.all([getInstalledLibraries(), getCustomLibraries()]);
      const customNames = new Set(custom.map((c) => (c.name || '').toLowerCase()));
      setInstalledLibraries([
        ...custom,
        ...libs.filter((l) => !customNames.has((l.library?.name || l.name || '').toLowerCase())),
      ]);
    } catch (e: unknown) {
      setStatusMsg({
        type: 'error',
        text: e instanceof Error ? e.message : 'Failed to load installed libraries',
      });
    } finally {
      setLoadingInstalled(false);
    }
  }, []);

  // Reset transient state when the modal closes.
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSearchResults([]);
      setStatusMsg(null);
    }
  }, [isOpen]);

  // Load the installed/custom list whenever the modal opens.
  useEffect(() => {
    if (isOpen) fetchInstalled();
  }, [isOpen, fetchInstalled]);

  // Escape closes it, like any dialog. The overlay already closes on a
  // backdrop click, but the toolbar button that OPENED this sits underneath
  // the overlay — so someone who installs a library and reaches for it to get
  // back to their sketch clicks a button that cannot be hit, and the editor
  // reads as frozen. Escape is the exit everyone tries next.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Search the index (debounced). With an empty query we BROWSE the installed
  // list instead, so don't fire a search.
  useEffect(() => {
    if (!isOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setLoadingSearch(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoadingSearch(true);
      setStatusMsg(null);
      try {
        if (isMpy) setMpyResults(await searchMpyPackages(searchQuery));
        else setSearchResults(await searchLibraries(searchQuery));
      } catch (e: unknown) {
        setStatusMsg({ type: 'error', text: e instanceof Error ? e.message : 'Search failed' });
        if (isMpy) setMpyResults([]);
        else setSearchResults([]);
      } finally {
        setLoadingSearch(false);
      }
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, isOpen, isMpy]);

  // A custom .zip upload (pro) lands in the user's per-user store; auto-declare
  // it on the active board and refresh the list. The upload BUTTON is injected
  // into .lib-modal-header by the pro overlay (libraryUploadInjector).
  useEffect(() => {
    const onUploaded = (e: Event) => {
      const name = (e as CustomEvent).detail?.library;
      if (name) addToManifest(name);
      fetchInstalled();
    };
    window.addEventListener('velxio-custom-library-installed', onUploaded);
    return () => window.removeEventListener('velxio-custom-library-installed', onUploaded);
  }, [addToManifest, fetchInstalled]);

  // ── actions ────────────────────────────────────────────────────────────────
  const install = useCallback(
    async (name: string): Promise<boolean> => {
      setBusyLib(name);
      setStatusMsg(null);
      try {
        const result = await installLibrary(name, selectedVersions[name]);
        if (result.success) {
          trackInstallLibrary(name);
          fetchInstalled();
          return true;
        }
        setStatusMsg({ type: 'error', text: result.error || `Failed to install "${name}"` });
        return false;
      } catch (e: unknown) {
        setStatusMsg({ type: 'error', text: e instanceof Error ? e.message : 'Installation failed' });
        return false;
      } finally {
        setBusyLib(null);
      }
    },
    [selectedVersions, fetchInstalled],
  );

  // Primary action: install if needed, then declare on THIS board.
  const addToProject = useCallback(
    async (row: LibRow) => {
      if (!row.installed) {
        const ok = await install(row.name);
        if (!ok) return;
      }
      addToManifest(row.name);
      setStatusMsg({ type: 'success', text: `"${row.name}" added to ${activeBoard ? boardDisplayName(activeBoard) : 'this board'}.` });
    },
    [install, addToManifest, activeBoard],
  );

  // A CUSTOM lib lives in the user's per-user store, so removing it hits the
  // per-user delete endpoint and also drops it from the manifest.
  const removeCustom = useCallback(
    async (name: string) => {
      setBusyLib(name);
      setStatusMsg(null);
      try {
        const result = await deleteCustomLibrary(name);
        if (result.success) {
          setStatusMsg({ type: 'success', text: `Removed your custom "${name}".` });
          removeFromManifest(name);
          fetchInstalled();
        } else {
          setStatusMsg({ type: 'error', text: result.error || `Failed to remove "${name}"` });
        }
      } finally {
        setBusyLib(null);
      }
    },
    [removeFromManifest, fetchInstalled],
  );

  // ── unified rows: search results when typing, else the installed/custom list ─
  const rows: LibRow[] = useMemo(() => {
    if (searchQuery.trim()) {
      return searchResults.map((lib) => ({
        name: lib.name || 'Unknown',
        version: lib.latest?.version || lib.version || '',
        author: lib.latest?.author || lib.author || '',
        desc: lib.latest?.sentence || lib.sentence || '',
        installed: isInstalled(lib.name || ''),
        custom: false,
        releases: lib.releases,
      }));
    }
    return installedLibraries.map((lib) => ({
      name: lib.library?.name || lib.name || 'Unknown',
      version: lib.library?.version || lib.version || '',
      author: lib.library?.author || lib.author || '',
      desc: lib.library?.sentence || lib.sentence || '',
      installed: true,
      custom: !!lib.custom,
    }));
  }, [searchQuery, searchResults, installedLibraries, isInstalled]);

  // ── MicroPython actions ───────────────────────────────────────────────────
  const mpyGroupId = activeBoard?.activeFileGroupId ?? null;
  const addMpyPackage = useCallback(
    async (name: string) => {
      if (!mpyGroupId) return;
      setBusyLib(name);
      setStatusMsg(null);
      try {
        const files = await fetchMpyPackage(name);
        const written = writeFilesIntoGroup(mpyGroupId, files);
        trackInstallLibrary(`mpy:${name}`);
        setStatusMsg({
          type: 'success',
          text: `"${name}" added to the workspace: ${written.join(', ')}. main.py can import it now.`,
        });
        setMpyTick((n) => n + 1);
      } catch (e: unknown) {
        const detail =
          (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        setStatusMsg({
          type: 'error',
          text: detail || (e instanceof Error ? e.message : `Failed to add "${name}"`),
        });
      } finally {
        setBusyLib(null);
      }
    },
    [mpyGroupId],
  );

  interface MpyRow {
    name: string;
    version: string;
    desc: string;
    builtin: boolean;
    inProject: boolean;
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mpyTick re-derives from the file group
  const mpyRows: MpyRow[] = useMemo(() => {
    if (!isMpy || !mpyGroupId) return [];
    const inProj = (name: string) => packageFilesInGroup(mpyGroupId, name);
    if (searchQuery.trim()) {
      const needle = searchQuery.trim().toLowerCase();
      const builtins = BUILTIN_MPY_MODULES.filter((b) => b.name.includes(needle)).map((b) => ({
        name: b.name,
        version: '',
        desc: b.blurb,
        builtin: true,
        inProject: false,
      }));
      return builtins.concat(
        mpyResults.map((p) => ({
          name: p.name,
          version: p.version,
          desc: p.description,
          builtin: false,
          inProject: inProj(p.name),
        })),
      );
    }
    return FEATURED_MPY_PACKAGES.map((f) => ({
      name: f.name,
      version: '',
      desc: f.blurb,
      builtin: false,
      inProject: inProj(f.name),
    })).concat(
      BUILTIN_MPY_MODULES.map((b) => ({
        name: b.name,
        version: '',
        desc: b.blurb,
        builtin: true,
        inProject: false,
      })),
    );
  }, [isMpy, mpyGroupId, searchQuery, mpyResults, mpyTick]);

  if (!isOpen) return null;
  const browsing = !searchQuery.trim();

  // Portaled to <body>: the toolbar ancestor has container-type
  // (container queries), which turns it into the containing block for
  // position:fixed and shrank the overlay to the toolbar's box.
  return createPortal(
    <div className="lib-modal-overlay" onClick={onClose}>
      <div className="lib-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header — the pro custom-upload button injects into .lib-modal-header */}
        <div className="lib-modal-header">
          <div className="lib-modal-title">
            <svg
              className="lib-icon"
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
            <span>{t('editor.libraryManager.title')}</span>
            {activeBoard && (
              <span
                title={
                  isMpy
                    ? 'MicroPython: a library is a .py file in this board\'s workspace'
                    : 'Libraries apply to this board (its libraries.json = compile scope)'
                }
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  color: 'var(--color-feedback-success)',
                  background: 'var(--color-feedback-success-soft)',
                  border: '1px solid #2e7d32',
                  borderRadius: 10,
                  padding: '1px 8px',
                }}
              >
                {boardDisplayName(activeBoard)}
                {isMpy ? ' · MicroPython' : ` · ${declared.length}`}
              </span>
            )}
          </div>
          <button className="lib-close-btn" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="lib-search-bar">
          <SearchBar
            placeholder={t('editor.libraryManager.filterPlaceholder')}
            value={searchQuery}
            onValueChange={setSearchQuery}
            autoFocus
            trailing={loadingSearch && (
              <svg className="lib-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            )}
          />
        </div>

        {/* Status */}
        {statusMsg && <div className={`lib-status ${statusMsg.type}`}>{statusMsg.text}</div>}

        {/* Single unified list */}
        <div className="lib-content">
          <div className="lib-list">
            {isMpy && browsing && (
              <div className="lib-empty" style={{ padding: '10px 14px 4px' }}>
                <p className="lib-empty-sub" style={{ margin: 0 }}>
                  A MicroPython library is a .py file in the project — adding one
                  writes it into this board's workspace, next to main.py. Search
                  the official micropython-lib index above.
                </p>
              </div>
            )}
            {isMpy &&
              mpyRows.map((row) => {
                const busy = busyLib === row.name;
                return (
                  <div key={`mpy-${row.name}`} className="lib-item">
                    <div className="lib-item-info">
                      <div className="lib-item-header">
                        <span className="lib-item-name">{row.name}</span>
                        {row.builtin && (
                          <span
                            style={{
                              fontSize: 10,
                              color: 'var(--color-accent-fg)',
                              background: 'var(--color-accent-soft)',
                              borderRadius: 6,
                              padding: '0 6px',
                            }}
                          >
                            built into the firmware
                          </span>
                        )}
                      </div>
                      {row.desc && <p className="lib-item-desc">{row.desc}</p>}
                    </div>
                    <div className="lib-item-actions">
                      {row.version && <span className="lib-item-version">{row.version}</span>}
                      {row.builtin ? (
                        <span className="lib-item-version" title="No install needed — just import it">
                          import {row.name}
                        </span>
                      ) : row.inProject ? (
                        <span
                          className="lib-uninstall-btn"
                          style={{ color: 'var(--color-feedback-success)', borderColor: '#2e7d32', cursor: 'default' }}
                          title="Its .py file is in the workspace — edit or delete it from the file explorer"
                        >
                          In project ✓
                        </span>
                      ) : (
                        <button
                          className="lib-install-btn"
                          onClick={() => addMpyPackage(row.name)}
                          disabled={busy}
                          title="Write this package's .py files into the board's workspace"
                        >
                          {busy ? '…' : '+ Add to project'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            {isMpy && !browsing && !loadingSearch && mpyRows.length === 0 && (
              <div className="lib-empty">
                <p>{t('editor.libraryManager.noResultsFor', { query: searchQuery })}</p>
                <p className="lib-empty-sub">
                  Not in micropython-lib? Paste the driver as a .py file in the
                  workspace — that is all an install does.
                </p>
              </div>
            )}
            {!isMpy && browsing && loadingInstalled && (
              <div className="lib-empty">
                <p>{t('editor.libraryManager.loadingInstalled')}</p>
              </div>
            )}
            {!isMpy && !loadingSearch && rows.length === 0 && !(browsing && loadingInstalled) && (
              <div className="lib-empty">
                <p>
                  {browsing
                    ? t('editor.libraryManager.noneInstalled')
                    : searchQuery
                      ? t('editor.libraryManager.noResultsFor', { query: searchQuery })
                      : t('editor.libraryManager.noResults')}
                </p>
                {browsing && <p className="lib-empty-sub">Search above to find and add a library.</p>}
              </div>
            )}
            {!isMpy && rows.map((row, i) => {
              const inProj = inManifest(row.name);
              const busy = busyLib === row.name;
              return (
                <div key={`${row.name}-${i}`} className="lib-item">
                  <div className="lib-item-info">
                    <div className="lib-item-header">
                      <span className="lib-item-name">{row.name}</span>
                      {row.custom && (
                        <span
                          style={{
                            fontSize: 10,
                            color: '#ffd60a',
                            background: 'var(--color-feedback-warning-soft)',
                            borderRadius: 6,
                            padding: '0 6px',
                          }}
                        >
                          custom
                        </span>
                      )}
                      {row.author && (
                        <span className="lib-item-author">
                          {t('editor.libraryManager.byAuthor', { author: row.custom ? 'you' : row.author })}
                        </span>
                      )}
                    </div>
                    {row.desc && <p className="lib-item-desc">{row.desc}</p>}
                  </div>
                  <div className="lib-item-actions">
                    {row.version && <span className="lib-item-version">{row.version}</span>}
                    {!row.installed && row.releases && Object.keys(row.releases).length > 1 && (
                      <DropdownSelect
                        className="lib-version-select"
                        value={selectedVersions[row.name] ?? row.version}
                        onValueChange={(value) => setSelectedVersions((p) => ({ ...p, [row.name]: value }))}
                      >
                        {Object.keys(row.releases).map((ver) => (
                          <option key={ver} value={ver}>
                            {ver}
                          </option>
                        ))}
                      </DropdownSelect>
                    )}
                    {inProj ? (
                      <button
                        className="lib-uninstall-btn"
                        style={{ color: 'var(--color-feedback-success)', borderColor: '#2e7d32' }}
                        onClick={() => removeFromManifest(row.name)}
                        title="Remove from this board (libraries.json)"
                      >
                        In project ✓
                      </button>
                    ) : (
                      <button
                        className="lib-install-btn"
                        onClick={() => addToProject(row)}
                        disabled={busy}
                        title="Install if needed and add to this board"
                      >
                        {busy ? '…' : '+ Add to project'}
                      </button>
                    )}
                    {/* Only CUSTOM uploads can be removed (per-user store). Index
                        libraries live in the shared content-addressed cache — you
                        add/remove them from THIS project, but never "uninstall" a
                        copy everyone shares, so no Uninstall button for them. */}
                    {row.custom && (
                      <button
                        className="lib-uninstall-btn"
                        onClick={() => removeCustom(row.name)}
                        disabled={busy}
                        title="Remove your custom upload"
                      >
                        {busy ? '…' : 'Remove'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
