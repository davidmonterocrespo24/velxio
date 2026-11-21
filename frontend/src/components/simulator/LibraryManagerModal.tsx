import { LibraryPackageIcon } from '../ui/CustomIcons';
import { DropdownSelect } from '../ui/DropdownSelect';
import { SearchBar } from '../ui/SearchBar';
import React, { useState, useEffect, useCallback, useId, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Download, LoaderCircle, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import {
  searchLibraries,
  findArduinoLibrary,
  getCatalogLibraryVersion,
  installLibrary,
  getInstalledLibraries,
  getCustomLibraries,
  deleteCustomLibrary,
  findInstalledArduinoLibrary,
  normalizeArduinoLibraryName as normLib,
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
import { useEditorStore } from '../../store/useEditorStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { boardDisplayName } from '../../types/board';
import { addLibraryToManifest, bareLibName, libraryVersionFromSpec } from '../../utils/libraryManifest';
import './LibraryManagerModal.css';

interface LibraryManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** One row of the single unified list. A search result and an installed/custom
 *  library both normalise to this so they render identically. */
interface LibRow {
  name: string;
  version: string;
  author: string;
  desc: string;
  paragraph?: string;
  website?: string;
  category?: string;
  catalogVersion?: string;
  installed: boolean;
  pin?: string;
  custom: boolean;
  catalog?: ArduinoLibrary;
}

interface LibrarySearchResponse {
  query: string;
  isMpy: boolean;
  arduino?: ArduinoLibrary[];
  mpy?: MpyPackage[];
  error?: string;
}

interface MpyRow {
  name: string;
  version: string;
  desc: string;
  author: string;
  license?: string;
  builtin: boolean;
  inProject: boolean;
}

const libraryTabs = ['installed', 'browse'] as const;
type LibraryTab = (typeof libraryTabs)[number];

// Libraries used by boards and components in the example gallery.
const featuredArduinoLibraries: readonly ArduinoLibrary[] = [
  { name: 'Servo', sentence: 'Control hobby servo motors.' },
  { name: 'Adafruit GFX Library', sentence: 'Draw text and graphics on displays.' },
  { name: 'Adafruit SSD1306', sentence: 'Drive SSD1306 OLED displays over I²C or SPI.' },
  { name: 'Adafruit NeoPixel', sentence: 'Control addressable RGB LEDs and strips.' },
  { name: 'DHT sensor library', sentence: 'Read temperature and humidity from DHT sensors.' },
];

function catalogMetadata(library: ArduinoLibrary | undefined, version?: string) {
  const release = version ? library?.releases?.[version] : undefined;
  const latest = library?.latest;
  return {
    author: release?.author || latest?.author || library?.author || '',
    desc: release?.sentence || latest?.sentence || library?.sentence || '',
    paragraph: release?.paragraph || latest?.paragraph || library?.paragraph,
    website: release?.website || latest?.website || library?.website,
    category: release?.category || latest?.category || library?.category,
  };
}

function LibraryItemInfo({
  row, children, onExpand, loading, missing,
}: {
  row: Pick<LibRow, 'name' | 'version' | 'author' | 'desc' | 'paragraph' | 'website' | 'category' | 'catalogVersion'>
    & { license?: string };
  children?: React.ReactNode;
  onExpand?: () => void;
  loading?: boolean;
  missing?: boolean;
}) {
  const { t } = useTranslation();
  const website = /^https?:\/\//i.test(row.website ?? '') ? row.website : undefined;
  const description = [row.desc, row.paragraph].filter(Boolean).join('\n\n');
  return (
    <details className="lib-item-info" onToggle={(event) => {
      if (event.currentTarget.open) onExpand?.();
    }}>
      <summary className="lib-item-summary">
        <span className="lib-item-header">
          <ChevronRight className="lib-item-chevron" size={14} aria-hidden />
          {missing && (
            <span className="lib-missing-icon" role="img"
              aria-label={t('editor.libraryManager.libraryMissing', 'Required by this board and not installed')}
              title={t('editor.libraryManager.libraryMissing', 'Required by this board and not installed')}>
              <TriangleAlert size={14} aria-hidden />
            </span>
          )}
          <span className="lib-item-name">{row.name}</span>
          {children}
          {row.author && (
            <span className="lib-item-author">
              {t('editor.libraryManager.byAuthor', { author: row.author })}
            </span>
          )}
        </span>
        {row.desc && <span className="lib-item-desc lib-item-preview">{row.desc}</span>}
      </summary>
      <div className="lib-item-details">
        {description && <p>{description}</p>}
        {(row.version || row.catalogVersion || row.category || row.license) && (
          <dl>
            {row.version && <><dt>{t('editor.libraryManager.version', 'Version')}</dt><dd>{row.version}</dd></>}
            {row.catalogVersion && <><dt>{t('editor.libraryManager.catalogVersion', 'Latest release')}</dt><dd>{row.catalogVersion}</dd></>}
            {row.category && <><dt>{t('editor.libraryManager.category', 'Category')}</dt><dd>{row.category}</dd></>}
            {row.license && <><dt>{t('editor.libraryManager.license', 'License')}</dt><dd>{row.license}</dd></>}
          </dl>
        )}
        {website && (
          <a href={website} target="_blank" rel="noopener noreferrer">
            {t('editor.libraryManager.website', 'Library website')}
          </a>
        )}
        {loading && <p role="status">{t('editor.libraryManager.loadingDetails', 'Loading library details…')}</p>}
        {!loading && !description && !row.version && !row.catalogVersion && !row.category && !row.license && !website && (
          <p>{t('editor.libraryManager.noDetails', 'No additional details are available.')}</p>
        )}
      </div>
    </details>
  );
}

/**
 * Library Manager — installed dependencies and the library catalog.
 *   Add to project     (installs if needed, then declares it on this board)
 *   Remove from board  (remove the declaration from this board's libraries.json)
 *   Remove upload      (delete your custom upload)
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
  const boardId = activeBoard?.id;
  const manifestLibs = activeBoard?.libraries ?? null;
  const declared = useMemo(() => manifestLibs ?? [], [manifestLibs]);

  // ── MicroPython mode (issue #214) ─────────────────────────────────────────
  // Same modal, different backing: a MicroPython library is a .py file in
  // the project, so search hits the micropython-lib index (backend proxy)
  // and "Add to project" writes the package's files into this board's file
  // group — no libraries.json, no arduino-cli.
  const isMpy = activeBoard?.languageMode === 'micropython';
  const mpyGroupId = isMpy ? activeBoard?.activeFileGroupId : undefined;
  const mpyFiles = useEditorStore((state) => mpyGroupId ? state.fileGroups[mpyGroupId] : undefined);
  const tabId = useId();
  const [tab, setTab] = useState<LibraryTab>('installed');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResponse, setSearchResponse] = useState<LibrarySearchResponse | null>(null);
  const [installedLibraries, setInstalledLibraries] = useState<InstalledLibrary[] | null>(null);
  const [inventoryUnavailable, setInventoryUnavailable] = useState(false);
  const [inventoryChecking, setInventoryChecking] = useState(false);
  const [inventoryRevision, setInventoryRevision] = useState(0);
  const [customLibraries, setCustomLibraries] = useState<InstalledLibrary[]>([]);
  const [libraryDetails, setLibraryDetails] = useState<Record<string, ArduinoLibrary | null>>({});
  const [mpyDetails, setMpyDetails] = useState<Record<string, MpyRow>>({});
  const loadingDetails = useRef(new Set<string>());
  const [detailRequests, setDetailRequests] = useState<ReadonlySet<string>>(() => new Set());
  const customRequest = useRef(0);
  const pendingLibraryActions = useRef(new Set<string>());
  const [busyLibraries, setBusyLibraries] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );
  const query = searchQuery.trim();
  const installedTab = tab === 'installed';
  const needsInventory = !installedTab || declared.length > 0;
  const checkingInstalled = installedTab && !isMpy && needsInventory
    && (inventoryChecking || (installedLibraries === null && !inventoryUnavailable));
  const catalogQuery = installedTab ? '' : query;
  const currentSearch = catalogQuery && searchResponse?.query === catalogQuery && searchResponse.isMpy === isMpy
    ? searchResponse
    : null;
  const loadingSearch = !!catalogQuery && !currentSearch;
  const queryText = query.toLowerCase();
  const matchesQuery = useCallback(
    (name: string, description: string) =>
      !queryText || name.toLowerCase().includes(queryText) || description.toLowerCase().includes(queryText),
    [queryText],
  );
  const chooseTab = (nextTab: LibraryTab) => {
    if (nextTab === tab) return;
    setSearchResponse(null);
    setStatusMsg(null);
    setTab(nextTab);
  };

  const inManifest = useCallback(
    (name: string): boolean => declared.some((l) => normLib(l) === normLib(name)),
    [declared],
  );
  const addToManifest = useCallback(
    (name: string) => {
      const board = useSimulatorStore.getState().boards.find((entry) => entry.id === boardId);
      if (!board) return;
      const libraries = addLibraryToManifest(board.libraries, name);
      if (libraries) updateBoard(board.id, { libraries });
    },
    [boardId, updateBoard],
  );
  const removeFromManifest = useCallback(
    (name: string) => {
      const board = useSimulatorStore.getState().boards.find((entry) => entry.id === boardId);
      if (!board?.libraries) return;
      const next = board.libraries.filter((l) => normLib(l) !== normLib(name));
      updateBoard(board.id, { libraries: next });
    },
    [boardId, updateBoard],
  );

  const isInstalled = useCallback(
    (name: string): boolean =>
      [customLibraries, installedLibraries ?? []].some((libraries) =>
        libraries.some((lib) => normLib(lib.library?.name || lib.name || '') === normLib(name)),
      ),
    [customLibraries, installedLibraries],
  );

  const fetchCustom = useCallback(async () => {
    const request = ++customRequest.current;
    const custom = await getCustomLibraries();
    if (request === customRequest.current) setCustomLibraries(custom);
  }, []);

  const loadLibraryDetails = async (name: string) => {
    const key = normLib(name);
    if (libraryDetails[key] !== undefined || loadingDetails.current.has(key)) return;
    loadingDetails.current.add(key);
    setDetailRequests(new Set(loadingDetails.current));
    try {
      const match = await findArduinoLibrary(name);
      setLibraryDetails((previous) => ({ ...previous, [key]: match }));
    } catch {
      // Existing metadata remains available. Opening the details again retries the lookup.
    } finally {
      loadingDetails.current.delete(key);
      setDetailRequests(new Set(loadingDetails.current));
    }
  };

  // Reset transient state when the modal closes.
  useEffect(() => {
    if (!isOpen) {
      setTab('installed');
      setSearchQuery('');
      setSearchResponse(null);
      setStatusMsg(null);
      setInstalledLibraries(null);
      setInventoryUnavailable(false);
      setInventoryChecking(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && !isMpy) void fetchCustom();
  }, [isOpen, isMpy, fetchCustom]);

  // Render the manifest immediately and verify availability in the background.
  useEffect(() => {
    if (!isOpen || isMpy || !needsInventory) return;
    let active = true;
    setInventoryChecking(true);
    void getInstalledLibraries().then((libraries) => {
      if (active) {
        setInstalledLibraries(libraries);
        setInventoryUnavailable(false);
      }
    }).catch(() => {
      if (active) setInventoryUnavailable(true);
    }).finally(() => {
      if (active) setInventoryChecking(false);
    });
    return () => { active = false; };
  }, [isOpen, isMpy, needsInventory, inventoryRevision]);

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

  // Ignore results and errors from searches superseded by typing, clearing, or closing.
  useEffect(() => {
    if (!isOpen || !catalogQuery) return;
    let active = true;
    const debounce = setTimeout(async () => {
      try {
        const results = isMpy
          ? { mpy: await searchMpyPackages(catalogQuery) }
          : { arduino: await searchLibraries(catalogQuery) };
        if (active) setSearchResponse({ query: catalogQuery, isMpy, ...results });
      } catch (e: unknown) {
        if (active) {
          const error = e instanceof Error ? e.message : 'Search failed';
          setSearchResponse({ query: catalogQuery, isMpy, error });
        }
      }
    }, 400);
    return () => {
      active = false;
      clearTimeout(debounce);
    };
  }, [catalogQuery, isOpen, isMpy]);

  // A custom .zip upload (pro) lands in the user's per-user store; auto-declare
  // it on the active board and refresh the list. The upload BUTTON is injected
  // into .lib-modal-header by the pro overlay (libraryUploadInjector).
  useEffect(() => {
    const onUploaded = (e: Event) => {
      const name = (e as CustomEvent).detail?.library;
      if (name) addToManifest(name);
      void fetchCustom();
    };
    window.addEventListener('velxio-custom-library-installed', onUploaded);
    return () => window.removeEventListener('velxio-custom-library-installed', onUploaded);
  }, [addToManifest, fetchCustom]);

  // ── actions ────────────────────────────────────────────────────────────────
  const startLibraryAction = useCallback((key: string) => {
    if (pendingLibraryActions.current.has(key)) return false;
    pendingLibraryActions.current.add(key);
    setBusyLibraries(new Set(pendingLibraryActions.current));
    return true;
  }, []);

  const finishLibraryAction = useCallback((key: string) => {
    pendingLibraryActions.current.delete(key);
    setBusyLibraries(new Set(pendingLibraryActions.current));
  }, []);

  const install = useCallback(
    async (name: string, version?: string): Promise<boolean> => {
      const key = `arduino:${normLib(name)}`;
      if (!startLibraryAction(key)) return false;
      setStatusMsg(null);
      try {
        const result = await installLibrary(name, version);
        if (result.success) {
          trackInstallLibrary(name);
          setInventoryRevision((revision) => revision + 1);
          if (version && result.fallback) {
            setStatusMsg({ type: 'error', text: t('editor.libraryManager.versionInstallUnavailable', 'Could not install {{name}} {{version}}. The board’s library declaration was kept as it was.', { version, name }) });
            return false;
          }
          if (!result.fallback) {
            setInstalledLibraries((previous) => previous && [
              ...previous.filter((library) => !findInstalledArduinoLibrary([library], name)),
              { name, version },
            ]);
          }
          return true;
        }
        setStatusMsg({ type: 'error', text: result.error || `Failed to install "${name}"` });
        return false;
      } catch (e: unknown) {
        setStatusMsg({ type: 'error', text: e instanceof Error ? e.message : 'Installation failed' });
        return false;
      } finally {
        finishLibraryAction(key);
      }
    },
    [t, startLibraryAction, finishLibraryAction],
  );

  // Primary action: install if needed, then declare on THIS board.
  const addToProject = useCallback(
    async (row: LibRow) => {
      const workspace = useProjectStore.getState().workspaceVersion;
      const isCurrent = () => useProjectStore.getState().workspaceVersion === workspace;
      const inventory = [...customLibraries, ...(installedLibraries ?? [])];
      const installed = findInstalledArduinoLibrary(inventory, row.name);
      const version = selectedVersions[row.name] || row.version ||
        installed?.library?.version || installed?.version || await getCatalogLibraryVersion(row.name);
      if (!isCurrent()) return;
      const spec = version ? `${row.name}@${version}` : row.name;
      if (!row.custom && !findInstalledArduinoLibrary(inventory, spec)) {
        const ok = await install(row.name, version);
        if (!ok) return;
      }
      if (!isCurrent()) return;
      if (row.catalog) {
        const catalog = row.catalog;
        setLibraryDetails((previous) => ({ ...previous, [normLib(row.name)]: catalog }));
      }
      addToManifest(spec);
      setStatusMsg({ type: 'success', text: `"${row.name}" added to ${activeBoard ? boardDisplayName(activeBoard) : 'this board'}.` });
    },
    [install, addToManifest, activeBoard, customLibraries, installedLibraries, selectedVersions],
  );

  // A CUSTOM lib lives in the user's per-user store, so removing it hits the
  // per-user delete endpoint and also drops it from the manifest.
  const removeCustom = useCallback(
    async (name: string) => {
      const key = `arduino:${normLib(name)}`;
      if (!startLibraryAction(key)) return;
      setStatusMsg(null);
      try {
        const result = await deleteCustomLibrary(name);
        if (result.success) {
          setStatusMsg({ type: 'success', text: `Removed your custom "${name}".` });
          removeFromManifest(name);
          void fetchCustom();
        } else {
          setStatusMsg({ type: 'error', text: result.error || `Failed to remove "${name}"` });
        }
      } finally {
        finishLibraryAction(key);
      }
    },
    [removeFromManifest, fetchCustom, startLibraryAction, finishLibraryAction],
  );

  // The Installed tab includes this board's manifest and personal uploads.
  const rows: LibRow[] = useMemo(() => {
    if (!installedTab) {
      const libraries = catalogQuery ? currentSearch?.arduino ?? [] : featuredArduinoLibraries;
      return libraries.filter((lib) => !inManifest(lib.name)).map((lib) => {
        const catalog = catalogQuery ? lib : libraryDetails[normLib(lib.name)] ?? undefined;
        return {
          name: lib.name,
          version: catalog?.latest?.version || catalog?.version || '',
          ...catalogMetadata(catalog ?? lib),
          installed: isInstalled(lib.name),
          custom: false,
          catalog,
        };
      });
    }
    const installed: LibRow[] = customLibraries.map((lib) => ({
      name: lib.library?.name || lib.name || 'Unknown',
      version: lib.library?.version || lib.version || '',
      author: lib.library?.author || lib.author || '',
      desc: lib.library?.sentence || lib.sentence || '',
      installed: true,
      custom: true,
    }));
    const listed = new Set(installed.map((lib) => normLib(lib.name)));
    for (const spec of declared) {
      const name = bareLibName(spec);
      const pin = libraryVersionFromSpec(spec);
      const key = normLib(name);
      if (listed.has(key)) continue;
      const info = installedLibraries && findInstalledArduinoLibrary(installedLibraries, spec);
      const version = pin || info?.library?.version || info?.version || '';
      const catalog = libraryDetails[key];
      const metadata = catalogMetadata(catalog ?? undefined, version);
      installed.push({
        name,
        pin,
        version,
        catalogVersion: version ? undefined : catalog?.latest?.version || catalog?.version,
        ...metadata,
        author: metadata.author || info?.library?.author || info?.author || '',
        desc: metadata.desc || info?.library?.sentence || info?.sentence || '',
        installed: !!info,
        custom: false,
      });
      listed.add(key);
    }
    return installed.filter((lib) => matchesQuery(lib.name, lib.desc));
  }, [installedTab, catalogQuery, currentSearch, installedLibraries, customLibraries, isInstalled, inManifest, declared, matchesQuery, libraryDetails]);

  // ── MicroPython actions ───────────────────────────────────────────────────
  const addMpyPackage = useCallback(
    async (row: MpyRow) => {
      if (!mpyGroupId) return;
      const { name } = row;
      const key = `mpy:${name}`;
      if (!startLibraryAction(key)) return;
      setStatusMsg(null);
      try {
        const files = await fetchMpyPackage(name);
        const written = writeFilesIntoGroup(mpyGroupId, files);
        setMpyDetails((previous) => ({ ...previous, [name.replaceAll('/', '.')]: row }));
        trackInstallLibrary(`mpy:${name}`);
        setStatusMsg({
          type: 'success',
          text: `"${name}" added to the workspace: ${written.join(', ')}. main.py can import it now.`,
        });
      } catch (e: unknown) {
        const detail =
          (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        setStatusMsg({
          type: 'error',
          text: detail || (e instanceof Error ? e.message : `Failed to add "${name}"`),
        });
      } finally {
        finishLibraryAction(key);
      }
    },
    [mpyGroupId, startLibraryAction, finishLibraryAction],
  );

  const mpyRows: MpyRow[] = useMemo(() => {
    if (!isMpy || !mpyGroupId) return [];
    const inProj = (name: string) => packageFilesInGroup(mpyGroupId, name);
    if (installedTab) {
      const moduleNames = new Set(
        (mpyFiles ?? [])
          .map((file) => file.name)
          .filter((name) => name.endsWith('.py') && name !== 'main.py' && name !== 'boot.py')
          .map((name) => name.replace(/(?:\/__init__)?\.py$/, '').replaceAll('/', '.')),
      );
      return [...moduleNames].filter((name) => matchesQuery(name, mpyDetails[name]?.desc ?? '')).map((name) => ({
        version: mpyDetails[name]?.version ?? '',
        desc: mpyDetails[name]?.desc ?? '',
        author: mpyDetails[name]?.author ?? '',
        license: mpyDetails[name]?.license,
        name,
        builtin: false,
        inProject: true,
      }));
    }
    const available = catalogQuery
      ? (currentSearch?.mpy ?? []).map((p) => ({
        name: p.name, version: p.version, desc: p.description, author: p.author, license: p.license,
      }))
      : FEATURED_MPY_PACKAGES.map((p) => ({ name: p.name, version: '', desc: p.blurb, author: '' }));
    return available.filter((p) => !inProj(p.name)).map((p) => ({
      ...p,
      builtin: false,
      inProject: false,
    })).concat(
      BUILTIN_MPY_MODULES.filter((b) => matchesQuery(b.name, b.blurb)).map((b) => ({
        name: b.name,
        version: '',
        desc: b.blurb,
        author: '',
        builtin: true,
        inProject: false,
      })),
    );
  }, [isMpy, mpyGroupId, mpyFiles, mpyDetails, installedTab, catalogQuery, currentSearch, matchesQuery]);

  if (!isOpen) return null;
  const status = currentSearch?.error ? { type: 'error', text: currentSearch.error } : statusMsg;

  // Portaled to <body>: the toolbar ancestor has container-type
  // (container queries), which turns it into the containing block for
  // position:fixed and shrank the overlay to the toolbar's box.
  return createPortal(
    <div className="lib-modal-overlay" onClick={onClose}>
      <div className="lib-modal" role="dialog" aria-modal="true" aria-labelledby={`${tabId}-title`} onClick={(e) => e.stopPropagation()}>
        {/* Header — the pro custom-upload button injects into .lib-modal-header */}
        <div className="lib-modal-header">
          <div className="lib-modal-title">
            <LibraryPackageIcon className="lib-icon" />
            <h2 id={`${tabId}-title`}>{t('editor.libraryManager.title')}</h2>
            {activeBoard && (
              <span
                title={
                  isMpy
                    ? 'MicroPython: a library is a .py file in this board\'s workspace'
                    : 'Libraries apply to this board (its libraries.json = compile scope)'
                }
                className="lib-modal-board"
              >
                {boardDisplayName(activeBoard)}
                {isMpy ? ' · MicroPython' : ` · ${declared.length}`}
              </span>
            )}
          </div>
          <button
            type="button"
            className="lib-close-btn"
            onClick={onClose}
            aria-label={t('editor.componentPicker.close')}
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <div
          className="lib-tabs"
          role="tablist"
          aria-label={t('editor.libraryManager.title')}
          onKeyDown={(event) => {
            const next = event.key === 'Home' ? 'installed' : event.key === 'End' ? 'browse'
              : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
                ? (installedTab ? 'browse' : 'installed') : null;
            if (!next) return;
            event.preventDefault();
            chooseTab(next);
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-library-tab="${next}"]`)?.focus();
          }}
        >
          {libraryTabs.map((libraryTab) => (
            <button
              key={libraryTab}
              id={`${tabId}-${libraryTab}`}
              type="button"
              className="lib-tab"
              role="tab"
              data-library-tab={libraryTab}
              aria-selected={tab === libraryTab}
              aria-controls={`${tabId}-panel`}
              tabIndex={tab === libraryTab ? 0 : -1}
              onClick={() => chooseTab(libraryTab)}
            >
              {libraryTab === 'installed'
                ? t('editor.libraryManager.installedTab')
                : t('editor.libraryManager.browseTab', 'Browse Libraries')}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="lib-search-bar">
          <SearchBar
            placeholder={installedTab
              ? t('editor.libraryManager.filterInstalled', 'Filter installed libraries…')
              : t('editor.libraryManager.searchCatalog', 'Search the library catalog…')}
            value={searchQuery}
            onValueChange={(value) => {
              if (value.trim() !== query) {
                setSearchResponse(null);
                setStatusMsg(null);
              }
              setSearchQuery(value);
            }}
            autoFocus
            trailing={loadingSearch && (
              <LoaderCircle size={16} strokeWidth={2.5} className="lib-spinner" aria-hidden />
            )}
          />
        </div>

        {/* Status */}
        {status && <div className={`lib-status ${status.type}`}>{status.text}</div>}

        <div className="lib-content" id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}`}>
          <div className="lib-list">
            {checkingInstalled && (
              <p className="lib-checking-inventory" role="status">
                {t('editor.libraryManager.checkingInventory', 'Checking installed libraries…')}
              </p>
            )}
            {!isMpy && !installedTab && !query && rows.length > 0 && (
              <h3 className="lib-featured-heading">{t('editor.libraryManager.featured', 'Featured libraries')}</h3>
            )}
            {isMpy &&
              mpyRows.map((row) => {
                const busy = busyLibraries.has(`mpy:${row.name}`);
                return (
                  <div key={`mpy-${row.name}`} className="lib-item">
                    <LibraryItemInfo row={row}>
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
                    </LibraryItemInfo>
                    <div className="lib-item-actions">
                      {row.version && <span className="lib-item-version">{row.version}</span>}
                      {row.builtin ? (
                        <span className="lib-item-version" title="No install needed — just import it">
                          import {row.name}
                        </span>
                      ) : row.inProject ? (
                        <span
                          className="lib-item-version lib-installed-badge"
                          title="Its .py file is in the workspace — edit or delete it from the file explorer"
                        >
                          {t('editor.libraryManager.inWorkspace', 'In workspace')}
                        </span>
                      ) : (
                        <button
                          className="lib-install-btn"
                          onClick={() => addMpyPackage(row)}
                          disabled={busy}
                          title="Write this package's .py files into the board's workspace"
                        >
                          {!busy && <Download size={14} aria-hidden />}
                          {busy ? '…' : t('editor.libraryManager.installDependencyButton', 'Install')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            {!loadingSearch && !currentSearch?.error && (isMpy ? mpyRows : rows).length === 0 && (
              <div className="lib-empty">
                <p>
                  {query
                    ? t('editor.libraryManager.noResultsFor', { query })
                    : installedTab
                      ? t('editor.libraryManager.noneInProject', 'No libraries added to this board yet.')
                      : t('editor.libraryManager.catalogPrompt', 'Search by library name or topic to find a library to add.')}
                </p>
                {installedTab && (
                  <button
                    className="lib-install-btn"
                    type="button"
                    onClick={() => {
                      chooseTab('browse');
                      document.getElementById(`${tabId}-browse`)?.focus();
                    }}
                  >
                    {t('editor.libraryManager.browseTab', 'Browse Libraries')}
                  </button>
                )}
              </div>
            )}
            {!isMpy && rows.map((row, i) => {
              const inProj = inManifest(row.name);
              const busy = busyLibraries.has(`arduino:${normLib(row.name)}`);
              const missing = inProj && !row.installed && installedLibraries !== null && !inventoryUnavailable;
              const availabilityUnknown = inProj && !row.installed && inventoryUnavailable;
              const releases = Object.keys(row.catalog?.releases ?? {});
              return (
                <div key={`${tab}-${row.name}-${i}`} className="lib-item">
                  <LibraryItemInfo
                    row={row.custom ? { ...row, author: 'you' } : row}
                    onExpand={!row.custom && !row.catalog ? () => void loadLibraryDetails(row.name) : undefined}
                    loading={detailRequests.has(normLib(row.name))}
                    missing={missing}
                  >
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
                  </LibraryItemInfo>
                  <div className="lib-item-actions">
                    {row.version && <span className="lib-item-version">{row.version}</span>}
                    {!row.pin && releases.length > 1 && (
                      <DropdownSelect
                        className="lib-version-select"
                        value={selectedVersions[row.name] ?? row.version}
                        onValueChange={(value) => setSelectedVersions((p) => ({ ...p, [row.name]: value }))}
                      >
                        {releases.map((ver) => (
                          <option key={ver} value={ver}>
                            {ver}
                          </option>
                        ))}
                      </DropdownSelect>
                    )}
                    {inProj ? (
                      <div className="lib-dependency-actions">
                        {(missing || availabilityUnknown) && (
                          <button
                            type="button"
                            className="lib-install-btn"
                            onClick={() => {
                              const version = row.pin || selectedVersions[row.name] || row.catalogVersion;
                              const workspace = useProjectStore.getState().workspaceVersion;
                              void install(row.name, version).then((ok) => {
                                if (ok && version && !row.pin && useProjectStore.getState().workspaceVersion === workspace) {
                                  addToManifest(`${row.name}@${version}`);
                                }
                              });
                            }}
                            disabled={busy}
                            aria-label={t('editor.libraryManager.installDependency', 'Install {{name}} for this board', { name: row.name })}
                            title={availabilityUnknown ? t('editor.libraryManager.inventoryUnavailable', 'Could not check whether this library is installed') : undefined}
                          >
                            {!busy && <Download size={14} aria-hidden />}
                            {busy ? '…' : t('editor.libraryManager.installDependencyButton', 'Install')}
                          </button>
                        )}
                        <button
                          type="button"
                          className="lib-remove-btn"
                          onClick={() => removeFromManifest(row.name)}
                          disabled={busy}
                          aria-label={t('editor.libraryManager.removeDependency', 'Remove {{name}} from this board', { name: row.name })}
                          title={t('editor.libraryManager.removeFromBoard', 'Remove from this board')}
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      </div>
                    ) : (
                      <button
                        className="lib-install-btn"
                        onClick={() => addToProject(row)}
                        disabled={busy}
                        title="Install if needed and add to this board"
                      >
                        {!busy && (installedTab ? <Plus size={14} aria-hidden /> : <Download size={14} aria-hidden />)}
                        {busy ? '…' : installedTab
                          ? t('editor.libraryManager.addToProject', 'Add to project')
                          : t('editor.libraryManager.installDependencyButton', 'Install')}
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
