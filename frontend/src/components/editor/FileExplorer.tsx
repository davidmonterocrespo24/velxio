import React, { useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useEditorStore, chipFileGroupId } from '../../store/useEditorStore';
import type { AutoSaveState } from '../../hooks/useAutoSaveProject';
import type { WorkspaceFile } from '../../store/useEditorStore';
import { useSimulatorStore, keepWireShapes } from '../../store/useSimulatorStore';
import { installChipFileSync, ensureChipWasm, flushChipFileSync } from '../../services/chipFiles';
import { getChipActions, getChipActionsVersion, subscribeChipActions } from '../../lib/chipActions';
import type { BoardKind } from '../../types/board';
import { boardDisplayName, isKnownBoardKind, isPiBoardKind } from '../../types/board';
import { importProjectFile, PROJECT_FILE_ACCEPT } from '../../utils/importProject';
import { retargetBoardWires } from '../../utils/wokwiZip';
import { showMessageDialog, showConfirmDialog } from '../../store/useMessageDialogStore';
import { registerEditorCommand } from '../../lib/editorCommands';
import './FileExplorer.css';

/** Neutral chip glyph for overlay-registered boards without a bespoke icon. */
const PRO_FALLBACK_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="3" y="3" width="10" height="10" rx="2" fill="#8b5cf6" />
    <rect x="5.5" y="5.5" width="5" height="5" rx="1" fill="#1e1b2e" />
  </svg>
);


// SVG icons — same style as EditorToolbar (stroke-based, 16x16)
const IcoFile = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

const IcoHeader = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

const IcoNewFile = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="18" x2="12" y2="12" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </svg>
);

const IcoNewWorkspace = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <line x1="9" y1="14" x2="15" y2="14" />
  </svg>
);

/** Tooltip for the Save button: the plain action when no project is
 *  loaded, otherwise the auto-save status and the last save time. */
function saveButtonTitle(t: TFunction, autoSave?: AutoSaveState): string {
  const base = t('editor.fileExplorer.saveProject');
  if (!autoSave) return base;
  const when = autoSave.lastSavedAt
    ? ` — ${t('editor.fileExplorer.lastSaved', 'last saved')} ${new Date(autoSave.lastSavedAt).toLocaleTimeString()}`
    : '';
  switch (autoSave.status) {
    case 'dirty':
      return `${base} — ${t('editor.fileExplorer.unsavedChanges')}${when}`;
    case 'saving':
      return `${base} — ${t('editor.fileExplorer.saving', 'saving…')}`;
    case 'error':
      return `${base} — ${t('editor.fileExplorer.saveFailed', 'save failed')}${autoSave.errorMessage ? `: ${autoSave.errorMessage}` : ''}`;
    default:
      return `${base} — ${t('editor.fileExplorer.saved', 'saved')}${when}`;
  }
}

const IcoSave = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);

const IcoOpen = () => (
  // Folder with an "open / upload arrow" — matches Save visually (both
  // are project-IO actions) but points the opposite way to signal load.
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <polyline points="12 11 12 17" />
    <polyline points="9 14 12 11 15 14" />
  </svg>
);

const IcoFolder = ({ open }: { open: boolean }) => (
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
    {open ? (
      <path d="M6 14l1.5-5.5A2 2 0 0 1 9.44 7H20a2 2 0 0 1 1.94 2.5l-1.2 4.5A2 2 0 0 1 18.8 15.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2" />
    ) : (
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    )}
  </svg>
);

const IcoNewFolder = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <line x1="12" y1="10" x2="12" y2="16" />
    <line x1="9" y1="13" x2="15" y2="13" />
  </svg>
);

const IcoTrashSmall = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const IcoChevron = ({ open }: { open: boolean }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

// Pencil icon — the rename affordance on a board/chip section header.
const IcoPencil = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

// Integrated-circuit (chip) icon — a DIP package with pins. Marks a
// programmable custom-chip's program section, distinct from board sections.
/** Per-chip Compile button: hammer, spinner-ish while busy, red on error. */
/** Picture-in-frame: set or replace the chip's optional face image. */
const IcoChipImage = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </svg>
);

/** Picture-in-frame with a strike: remove the chip's face image. */
const IcoChipImageRemove = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-feedback-error)"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="m8 8 8 8" />
    <path d="m16 8-8 8" />
  </svg>
);

const IcoChipCompile = ({ state }: { state?: string }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke={state === 'busy' ? 'var(--wb-10)' : state && state !== 'ok' ? 'var(--color-feedback-error)' : 'currentColor'}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9" />
    <path d="m18 15 4-4" />
    <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 3l.92.92A6.18 6.18 0 0 1 11.72 8.3V9l2 2h1.172a2 2 0 0 1 1.414.586L18.5 13.5" />
  </svg>
);

const IcoChip = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="7" y="7" width="10" height="10" rx="1" />
    <line x1="10" y1="3" x2="10" y2="7" />
    <line x1="14" y1="3" x2="14" y2="7" />
    <line x1="10" y1="17" x2="10" y2="21" />
    <line x1="14" y1="17" x2="14" y2="21" />
    <line x1="3" y1="10" x2="7" y2="10" />
    <line x1="3" y1="14" x2="7" y2="14" />
    <line x1="17" y1="10" x2="21" y2="10" />
    <line x1="17" y1="14" x2="21" y2="14" />
  </svg>
);

// Board emoji icons — mirrors BoardPickerModal
const BOARD_ICON: Record<BoardKind, string> = {
  'arduino-uno': '⬤',
  'arduino-nano': '▪',
  'arduino-mega': '▬',
  'raspberry-pi-pico': '◆',
  'raspberry-pi-3': '⬛',
  esp32: '⬡',
  'esp32-s3': '⬡',
  'esp32-c3': '⬡',
  'stm32-bluepill': '◈',
  'stm32-blackpill': '◈',
  'stm32-bluepill-f103cb': '◈',
  'stm32-blackpill-f401': '◈',
  'stm32-f4-discovery': '◈',
  'stm32-olimex-h405': '◈',
  'stm32-netduino-plus2': '◈',
  'stm32-netduino2': '◈',
};

// Color accent per board family
const BOARD_COLOR: Record<BoardKind, string> = {
  'arduino-uno': '#4fc3f7',
  'arduino-nano': '#4fc3f7',
  'arduino-mega': '#4fc3f7',
  'raspberry-pi-pico': '#ce93d8',
  'raspberry-pi-3': 'var(--color-feedback-error)',
  esp32: 'var(--color-feedback-success)',
  'esp32-s3': 'var(--color-feedback-success)',
  'esp32-c3': 'var(--color-feedback-success)',
  'stm32-bluepill': 'var(--color-accent-fg)',
  'stm32-blackpill': 'var(--wb-12)',
  'stm32-bluepill-f103cb': 'var(--color-accent-fg)',
  'stm32-blackpill-f401': 'var(--wb-12)',
  'stm32-f4-discovery': 'var(--color-accent-fg)',
  'stm32-olimex-h405': 'var(--color-feedback-success)',
  'stm32-netduino-plus2': '#ce93d8',
  'stm32-netduino2': '#ce93d8',
};

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['h', 'hpp'].includes(ext)) return <IcoHeader />;
  return <IcoFile />;
}

/**
 * One row of a board group's file tree, flattened for rendering. Folders come
 * from file-name '/' prefixes plus the group's tracked EMPTY folders; a
 * collapsed folder hides everything beneath it.
 */
type TreeRow =
  | { kind: 'folder'; path: string; name: string; depth: number; open: boolean }
  | { kind: 'file'; file: WorkspaceFile; depth: number };

function buildTreeRows(
  files: WorkspaceFile[],
  emptyFolders: string[],
  isFolderCollapsed: (path: string) => boolean,
): TreeRow[] {
  const folderSet = new Set<string>();
  const addWithAncestors = (path: string) => {
    const segs = path.split('/');
    for (let i = 1; i <= segs.length; i++) folderSet.add(segs.slice(0, i).join('/'));
  };
  for (const f of files) {
    const idx = f.name.lastIndexOf('/');
    if (idx > 0) addWithAncestors(f.name.slice(0, idx));
  }
  for (const p of emptyFolders) if (p) addWithAncestors(p);

  const parentOf = (p: string) => {
    const idx = p.lastIndexOf('/');
    return idx === -1 ? '' : p.slice(0, idx);
  };
  const rows: TreeRow[] = [];
  const walk = (parent: string, depth: number) => {
    const childFolders = [...folderSet].filter((p) => parentOf(p) === parent).sort();
    for (const p of childFolders) {
      const open = !isFolderCollapsed(p);
      rows.push({ kind: 'folder', path: p, name: p.slice(p.lastIndexOf('/') + 1), depth, open });
      if (open) walk(p, depth + 1);
    }
    // Files keep their group order (the first file is the main sketch).
    for (const f of files) {
      if (parentOf(f.name) === parent) rows.push({ kind: 'file', file: f, depth });
    }
  };
  walk('', 0);
  return rows;
}

/** Display name of a possibly-nested file: its basename. */
const fileBasename = (name: string) => name.slice(name.lastIndexOf('/') + 1);

interface ContextMenu {
  fileId: string;
  boardGroupId: string;
  x: number;
  y: number;
}

interface FileExplorerProps {
  onSaveClick: () => void;
  onNewClick: () => void;
  /** Auto-save state of the loaded project. When present, the Save button
   *  is the save indicator: green = saved, orange = unsaved changes,
   *  pulsing = saving, red = save failed. Replaces the text pill the header
   *  used to render ("Unsaved changes"), which ate toolbar width. */
  autoSave?: AutoSaveState;
}

const SAVE_STATUS_CLASS: Record<AutoSaveState['status'], string> = {
  idle: 'is-saved',
  saved: 'is-saved',
  dirty: 'is-dirty',
  saving: 'is-saving',
  error: 'is-error',
};

export const FileExplorer: React.FC<FileExplorerProps> = ({ onSaveClick, onNewClick, autoSave }) => {
  const { t } = useTranslation();
  // Hidden <input type="file"> we trigger via ref when the user clicks
  // the Open project button.  Accepts both .vlx (Velxio native) and .zip
  // (Wokwi bundle); the dispatcher in utils/importProject.ts decides which
  // loader to run based on the file extension.  Kept outside React state so
  // the change event still fires when the user picks the same file twice.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleOpenProjectClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const handleProjectFilePicked = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the SAME file again later still fires onchange.
    e.target.value = '';
    if (!file) return;
    const friendlyName = file.name.toLowerCase().endsWith('.zip') ? 'Wokwi .zip' : '.vlx';
    const confirmed = await showConfirmDialog(
      t('editor.fileExplorer.confirmLoad.message', { type: friendlyName }),
      {
        kind: 'error',
        title: t('editor.fileExplorer.confirmLoad.title'),
        confirmLabel: t('editor.fileExplorer.confirmLoad.confirm'),
        cancelLabel: t('editor.fileTabs.cancel'),
        danger: true,
      },
    );
    if (!confirmed) return;
    try {
      const result = await importProjectFile(file);
      // .zip needs the caller to apply the payload to the stores (we keep
      // that asymmetry so the toolbar's import flow can also pop the
      // install-libraries modal afterwards). Here in the file explorer we
      // don't have that modal, so we apply the payload silently and just
      // warn in the console if the project references uninstalled libs.
      if (result.kind === 'zip') {
        const { loadFiles } = useEditorStore.getState();
        const { setComponents, setWires, setBoardType, setBoardPosition, stopSimulation } =
          useSimulatorStore.getState();
        stopSimulation();
        // Same rule as the toolbar's importer: an unknown board kind is left
        // alone, not coerced into an Uno (#268).
        // Same as the toolbar's importer: put the board on the canvas (an
        // empty one had nothing for setBoardType to re-kind, so the project
        // arrived without its chip — #268) and never coerce an unknown kind.
        let boardId: string | null = null;
        if (result.boardType && isKnownBoardKind(result.boardType)) {
          const sim = useSimulatorStore.getState();
          const current =
            sim.boards.find((b) => b.id === sim.activeBoardId) ?? sim.boards[0] ?? null;
          if (current) {
            setBoardType(result.boardType);
            boardId = current.id;
          } else {
            boardId = sim.addBoard(
              result.boardType,
              result.boardPosition.x,
              result.boardPosition.y,
            );
            // addBoard promotes the first board to active but does not sync the
            // flat legacy fields; setActiveBoardId is where that happens, and
            // whatever still reads `boardType` would otherwise see the board
            // this import just replaced.
            useSimulatorStore.getState().setActiveBoardId(boardId);
          }
        } else if (result.boardType) {
          console.warn(
            `[FileExplorer] Project is for a "${result.boardType}" board, which this build does not have — kept the current board.`,
          );
        }
        for (const w of result.warnings) console.warn(`[FileExplorer] ${w}`);
        setBoardPosition(result.boardPosition);
        setComponents(result.components);
        setWires(
          boardId && result.boardType
            ? retargetBoardWires(result.wires, result.boardType, boardId)
            : result.wires,
        );
        keepWireShapes(useSimulatorStore.getState().wires);
        if (result.files.length > 0) loadFiles(result.files);
        if (result.libraries.length > 0) {
          console.warn(
            '[FileExplorer] Imported Wokwi zip references libraries you may need to install:',
            result.libraries,
          );
        }
      }
    } catch (err) {
      showMessageDialog((err as Error).message, { kind: 'error' });
    }
  }, [t]);

  const {
    fileGroups,
    folderGroups,
    activeFileId,
    activeGroupId,
    openFile,
    createFile,
    deleteFile,
    renameFile,
    createFolder,
    deleteFolder,
    setActiveGroup,
    manifestViewBoardId,
    setManifestView,
  } = useEditorStore();
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const setActiveBoardId = useSimulatorStore((s) => s.setActiveBoardId);
  const updateBoard = useSimulatorStore((s) => s.updateBoard);
  const updateComponent = useSimulatorStore((s) => s.updateComponent);
  const components = useSimulatorStore((s) => s.components);

  // EVERY custom chip owns an editor section: its chip.c + chip.json are
  // ordinary files in its own group (plus the program file for programmable
  // CPU chips). Seeding and the two-way file<->properties sync live in
  // services/chipFiles.ts — this component just renders the groups.
  const customChipComponents = components.filter((c) => c.metadataId === 'custom-chip');

  useEffect(() => installChipFileSync(), []);

  // Overlay-registered per-chip actions (e.g. pro "Save to my chips") —
  // subscribe so a registration landing after the dynamic overlay import
  // still renders.
  useSyncExternalStore(subscribeChipActions, getChipActionsVersion);
  const chipActions = getChipActions();

  // Per-chip Compile button state: chipId -> 'busy' | 'ok' | error string.
  const [chipCompileState, setChipCompileState] = useState<Record<string, string>>({});
  /** The optional chip face image rides properties.image as a data URL and
   *  is projected into the file section as chip.png/.jpg/.svg by
   *  chipFiles.ts. One hidden input serves every chip section; the ref
   *  remembers which chip asked. */
  const chipImageInputRef = useRef<HTMLInputElement>(null);
  const chipImageTargetRef = useRef<string | null>(null);

  const pickChipImage = useCallback((chipId: string) => {
    chipImageTargetRef.current = chipId;
    chipImageInputRef.current?.click();
  }, []);

  const CHIP_IMAGE_MAX_BYTES = 256 * 1024;

  const onChipImageChosen = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      const chipId = chipImageTargetRef.current;
      chipImageTargetRef.current = null;
      if (!file || !chipId) return;
      if (!/^image\/(png|jpeg|svg\+xml)$/.test(file.type)) {
        window.alert('Chip images must be PNG, JPEG or SVG.');
        return;
      }
      if (file.size > CHIP_IMAGE_MAX_BYTES) {
        // The image travels inside the project JSON (and to GitHub on every
        // sync for linked projects), so it stays deliberately small.
        window.alert('Chip images must be 256 KB or smaller.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '');
        const comp = useSimulatorStore.getState().components.find((c) => c.id === chipId);
        if (!comp || !dataUrl.startsWith('data:image/')) return;
        updateComponent(chipId, {
          properties: { ...comp.properties, image: dataUrl },
        });
        flushChipFileSync();
      };
      reader.readAsDataURL(file);
    },
    [updateComponent],
  );

  const removeChipImage = useCallback(
    (chipId: string) => {
      const comp = useSimulatorStore.getState().components.find((c) => c.id === chipId);
      if (!comp) return;
      updateComponent(chipId, { properties: { ...comp.properties, image: '' } });
      flushChipFileSync();
    },
    [updateComponent],
  );

  const compileChipNow = useCallback(async (chipId: string) => {
    setChipCompileState((s) => ({ ...s, [chipId]: 'busy' }));
    const r = await ensureChipWasm(chipId, (type, message) => {
      if (type === 'error') console.warn(`[custom-chip] ${message}`);
    });
    setChipCompileState((s) => ({ ...s, [chipId]: r.ok ? 'ok' : (r.error ?? 'error') }));
  }, []);

  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Inline rename of a SECTION header (a board or a chip). Kept separate from
  // file rename (renamingId) so the two never collide.
  const [renamingSection, setRenamingSection] = useState<{
    id: string;
    kind: 'board' | 'chip';
  } | null>(null);
  const [sectionRenameValue, setSectionRenameValue] = useState('');
  // Track which board group is creating a file: boardGroupId or null.
  // creatingParentPath prefixes the new file into a folder ('' = group root).
  const [creatingInGroup, setCreatingInGroup] = useState<string | null>(null);
  const [creatingParentPath, setCreatingParentPath] = useState('');
  const [newFileName, setNewFileName] = useState('');
  // Inline new-folder input: which group + parent folder ('' = root).
  const [creatingFolderInGroup, setCreatingFolderInGroup] = useState<string | null>(null);
  const [creatingFolderParent, setCreatingFolderParent] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  // Collapsed state per board ID
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Collapsed folders, keyed `${groupId}:${folderPath}`
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  const renameInputRef = useRef<HTMLInputElement>(null);
  const sectionRenameInputRef = useRef<HTMLInputElement>(null);
  // Set true by Escape so the input's onBlur (which fires when Escape unmounts
  // the input) discards instead of committing the typed value.
  const sectionRenameCancelledRef = useRef(false);
  const newFileInputRef = useRef<HTMLInputElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creatingFolderInGroup && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [creatingFolderInGroup]);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (renamingSection && sectionRenameInputRef.current) {
      sectionRenameInputRef.current.focus();
      sectionRenameInputRef.current.select();
    }
  }, [renamingSection]);

  const startBoardRename = useCallback((board: { id: string; name?: string; boardKind: BoardKind }) => {
    sectionRenameCancelledRef.current = false;
    setRenamingSection({ id: board.id, kind: 'board' });
    setSectionRenameValue(boardDisplayName(board));
  }, []);

  const startChipRename = useCallback((chipId: string, currentName: string) => {
    sectionRenameCancelledRef.current = false;
    setRenamingSection({ id: chipId, kind: 'chip' });
    setSectionRenameValue(currentName);
  }, []);

  const cancelSectionRename = useCallback(() => {
    sectionRenameCancelledRef.current = true;
    setRenamingSection(null);
  }, []);

  const commitSectionRename = useCallback(() => {
    // Escape cancelled this edit (it unmounts the input, firing onBlur) — discard.
    if (sectionRenameCancelledRef.current) {
      sectionRenameCancelledRef.current = false;
      return;
    }
    const target = renamingSection;
    if (target) {
      const value = sectionRenameValue.trim();
      if (target.kind === 'board') {
        // Empty clears the custom name -> boardDisplayName falls back to kind.
        updateBoard(target.id, { name: value });
      } else {
        const comp = useSimulatorStore.getState().components.find((c) => c.id === target.id);
        if (comp) {
          updateComponent(target.id, {
            properties: { ...comp.properties, chipName: value || 'Custom Chip' },
          });
        }
      }
    }
    setRenamingSection(null);
  }, [renamingSection, sectionRenameValue, updateBoard, updateComponent]);

  useEffect(() => {
    if (creatingInGroup && newFileInputRef.current) {
      newFileInputRef.current.focus();
    }
  }, [creatingInGroup]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  const switchToBoard = useCallback(
    (boardId: string, groupId: string) => {
      setActiveBoardId(boardId);
      // setActiveBoardId already calls setActiveGroup internally via the store
      // but we make sure the editor group is also in sync
      setActiveGroup(groupId);
    },
    [setActiveBoardId, setActiveGroup],
  );

  const handleFileClick = useCallback(
    (fileId: string, boardId: string, groupId: string) => {
      if (boardId !== activeBoardId) {
        switchToBoard(boardId, groupId);
      }
      openFile(fileId);
    },
    [activeBoardId, switchToBoard, openFile],
  );

  // Chip program groups aren't tied to a board — switching to one just makes
  // the chip's group active in the editor (no activeBoardId change).
  const switchToChip = useCallback(
    (groupId: string) => {
      setActiveGroup(groupId);
    },
    [setActiveGroup],
  );

  const handleChipFileClick = useCallback(
    (fileId: string, groupId: string) => {
      if (groupId !== activeGroupId) switchToChip(groupId);
      openFile(fileId);
    },
    [activeGroupId, switchToChip, openFile],
  );

  const handleContextMenu = (e: React.MouseEvent, fileId: string, boardGroupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ fileId, boardGroupId, x: e.clientX, y: e.clientY });
  };

  const startRename = (fileId: string, groupId: string) => {
    const files = fileGroups[groupId] ?? [];
    const file = files.find((f) => f.id === fileId);
    if (!file) return;
    setRenamingId(fileId);
    setRenameValue(file.name);
    setContextMenu(null);
  };

  const commitRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameFile(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  }, [renamingId, renameValue, renameFile]);

  const handleDelete = async (fileId: string, groupId: string) => {
    setContextMenu(null);
    const files = fileGroups[groupId] ?? [];
    if (files.length <= 1) return;
    const confirmed = await showConfirmDialog(t('editor.fileExplorer.confirmDelete'), {
      kind: 'error',
      title: t('editor.fileExplorer.contextMenu.delete'),
      confirmLabel: t('editor.fileExplorer.contextMenu.delete'),
      cancelLabel: t('editor.fileTabs.cancel'),
      danger: true,
    });
    if (!confirmed) return;
    deleteFile(fileId);
  };

  // File-menu commands owned by the explorer: Open project… and New file
  // (which targets the ACTIVE board's file group, same as its + button).
  useEffect(() => {
    const offOpen = registerEditorCommand('project.open', handleOpenProjectClick);
    const offNewFile = registerEditorCommand('file.new', () => {
      const st = useSimulatorStore.getState();
      const board = st.boards.find((b) => b.id === st.activeBoardId) ?? st.boards[0];
      if (!board) return;
      switchToBoard(board.id, board.activeFileGroupId);
      setCreatingInGroup(board.activeFileGroupId);
      setNewFileName('');
    });
    return () => {
      offOpen();
      offNewFile();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleOpenProjectClick]);

  const startCreateFile = (boardId: string, groupId: string, parentPath = '') => {
    // Switch to this board first so createFile targets the right group
    switchToBoard(boardId, groupId);
    setCreatingInGroup(groupId);
    setCreatingParentPath(parentPath);
    setNewFileName('');
    setCreatingFolderInGroup(null);
    setContextMenu(null);
  };

  const startCreateFolder = (boardId: string, groupId: string, parentPath = '') => {
    switchToBoard(boardId, groupId);
    setCreatingFolderInGroup(groupId);
    setCreatingFolderParent(parentPath);
    setNewFolderName('');
    setCreatingInGroup(null);
    setContextMenu(null);
  };

  const commitCreateFolder = useCallback(() => {
    const name = newFolderName.trim().replace(/^\/+|\/+$/g, '');
    if (name) createFolder(creatingFolderParent ? `${creatingFolderParent}/${name}` : name);
    setCreatingFolderInGroup(null);
    setNewFolderName('');
  }, [newFolderName, creatingFolderParent, createFolder]);

  const toggleFolder = (groupId: string, path: string) => {
    const key = `${groupId}:${path}`;
    setCollapsedFolders((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleDeleteFolder = (boardId: string, groupId: string, path: string) => {
    switchToBoard(boardId, groupId);
    const inside = (fileGroups[groupId] ?? []).filter((f) => f.name.startsWith(path + '/'));
    // Never allow a folder delete to empty the group completely — the group
    // must keep at least one file (same invariant as single-file delete).
    if (inside.length >= (fileGroups[groupId] ?? []).length) {
      showMessageDialog(t('editor.fileExplorer.folderHoldsEverything', 'The folder holds every file of this board — a board needs at least one file.'), { kind: 'info' });
      return;
    }
    if (inside.length === 0) {
      deleteFolder(path);
      return;
    }
    void showConfirmDialog(
      t(
        'editor.fileExplorer.confirmDeleteFolder',
        `Delete the folder "${path}" and the ${inside.length} file(s) inside it?`,
      ),
    ).then((ok) => {
      if (ok) deleteFolder(path);
    });
  };

  const commitCreateFile = useCallback(() => {
    const name = newFileName.trim().replace(/^\/+/, '');
    if (name) createFile(creatingParentPath ? `${creatingParentPath}/${name}` : name);
    setCreatingInGroup(null);
    setCreatingParentPath('');
    setNewFileName('');
  }, [newFileName, creatingParentPath, createFile]);

  const toggleCollapse = (boardId: string) => {
    setCollapsed((prev) => ({ ...prev, [boardId]: !prev[boardId] }));
  };

  return (
    <div className="file-explorer">
      {/* Stacked, not side by side: the title owns the first line and the
          actions the second. Side by side, the three buttons and the word
          set the pane's minimum width between them — and every px the
          explorer does not need goes to the code editor. Vertical room is
          what this panel has to spare. */}
      <div className="file-explorer-header">
        <span className="file-explorer-title">{t('editor.fileExplorer.workspace')}</span>
        <div className="file-explorer-header-actions">
          <button
            className="file-explorer-new-btn"
            title={t('editor.fileExplorer.newWorkspace')}
            onClick={onNewClick}
          >
            <IcoNewWorkspace />
          </button>
          <button
            className="file-explorer-save-btn"
            title="Open project (.vlx Velxio or .zip Wokwi)"
            onClick={handleOpenProjectClick}
          >
            <IcoOpen />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={PROJECT_FILE_ACCEPT}
            onChange={handleProjectFilePicked}
            style={{ display: 'none' }}
          />
          <input
            ref={chipImageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml"
            style={{ display: 'none' }}
            onChange={onChipImageChosen}
          />
          <button
            className={`file-explorer-save-btn${autoSave ? ` ${SAVE_STATUS_CLASS[autoSave.status]}` : ''}`}
            title={saveButtonTitle(t, autoSave)}
            aria-label={saveButtonTitle(t, autoSave)}
            onClick={onSaveClick}
          >
            <IcoSave />
          </button>
        </div>
      </div>

      <div className="file-explorer-list">
        {boards.map((board) => {
          const groupId = board.activeFileGroupId;
          const groupFiles = fileGroups[groupId] ?? [];
          const isActiveBoard = board.id === activeBoardId;
          const isOpen = !collapsed[board.id];
          const color = BOARD_COLOR[board.boardKind] ?? '#8b5cf6';

          // Status dot color
          const statusColor = board.running
            ? 'var(--color-feedback-success)'
            : board.compiledProgram
              ? 'var(--color-feedback-warning)'
              : 'var(--wb-9)';

          return (
            <div key={board.id} className="fe-board-section">
              {/* Board section header */}
              <div
                className={`fe-board-header${isActiveBoard ? ' fe-board-header-active' : ''}`}
                onClick={() => {
                  switchToBoard(board.id, groupId);
                  if (!isOpen) toggleCollapse(board.id);
                }}
                title={`${boardDisplayName(board)} — ${t('editor.fileExplorer.clickToEdit')}`}
              >
                {/* Actions ride ABOVE the name, not beside it: sharing the
                    line, three buttons plus the status dot left a board name
                    like "M5 Cardputer ADV" a stub of the row and set a floor
                    under the pane's width. */}
                <div className="fe-board-actions-row">
                  {/* The run/compile dot rides here too: on the name row it
                      cost the name another 11px, and it is not hover-gated,
                      so this row is never empty. */}
                  <span
                    className="fe-status-dot"
                    style={{ background: statusColor }}
                    title={
                      board.running
                        ? t('editor.fileExplorer.status.running')
                        : board.compiledProgram
                          ? t('editor.fileExplorer.status.compiled')
                          : t('editor.fileExplorer.status.idle')
                    }
                  />
                  <span className="fe-board-actions-spacer" />
                  <button
                    className="fe-board-new-btn"
                    title="Rename board (or double-click the name)"
                    onClick={(e) => {
                      e.stopPropagation();
                      startBoardRename(board);
                    }}
                  >
                    <IcoPencil />
                  </button>
                  <button
                    className="fe-board-new-btn"
                    title={t('editor.fileExplorer.newFileInBoard')}
                    onClick={(e) => {
                      e.stopPropagation();
                      startCreateFile(board.id, groupId);
                    }}
                  >
                    <IcoNewFile />
                  </button>
                  <button
                    className="fe-board-new-btn"
                    title={t('editor.fileExplorer.newFolderInBoard', 'New folder')}
                    onClick={(e) => {
                      e.stopPropagation();
                      startCreateFolder(board.id, groupId);
                    }}
                  >
                    <IcoNewFolder />
                  </button>
                </div>

                <div className="fe-board-name-row">
                  <button
                    className="fe-collapse-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(board.id);
                    }}
                    title={isOpen ? t('editor.fileExplorer.collapse') : t('editor.fileExplorer.expand')}
                  >
                    <IcoChevron open={isOpen} />
                  </button>

                  <span className="fe-board-icon" style={{ color }}>
                    {BOARD_ICON[board.boardKind] ?? PRO_FALLBACK_ICON}
                  </span>

                  {renamingSection?.id === board.id && renamingSection.kind === 'board' ? (
                    <input
                      ref={sectionRenameInputRef}
                      className="file-explorer-rename-input fe-section-rename-input"
                      value={sectionRenameValue}
                      onChange={(e) => setSectionRenameValue(e.target.value)}
                      onBlur={commitSectionRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitSectionRename();
                        if (e.key === 'Escape') cancelSectionRename();
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="fe-board-label"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startBoardRename(board);
                      }}
                      title="Double-click to rename"
                    >
                      {boardDisplayName(board)}
                    </span>
                  )}

                </div>
              </div>

              {/* Files under this board, as a folder tree */}
              {isOpen && (
                <div className="fe-board-files">
                  {buildTreeRows(
                    groupFiles,
                    folderGroups[groupId] ?? [],
                    (p) => !!collapsedFolders[`${groupId}:${p}`],
                  ).map((row) => {
                    if (row.kind === 'folder') {
                      return (
                        <div
                          key={`folder:${row.path}`}
                          className="file-explorer-item fe-file-item fe-folder-item"
                          style={{ '--fe-depth': row.depth } as React.CSSProperties}
                          onClick={() => toggleFolder(groupId, row.path)}
                          title={row.path}
                        >
                          <span className="fe-folder-chevron">
                            <IcoChevron open={row.open} />
                          </span>
                          <span className="file-explorer-icon fe-folder-icon">
                            <IcoFolder open={row.open} />
                          </span>
                          <span className="file-explorer-name">{row.name}</span>
                          <span className="fe-folder-actions">
                            <button
                              title={t('editor.fileExplorer.newFileInFolder', 'New file here')}
                              onClick={(e) => {
                                e.stopPropagation();
                                startCreateFile(board.id, groupId, row.path);
                              }}
                            >
                              <IcoNewFile />
                            </button>
                            <button
                              title={t('editor.fileExplorer.newSubfolder', 'New subfolder')}
                              onClick={(e) => {
                                e.stopPropagation();
                                startCreateFolder(board.id, groupId, row.path);
                              }}
                            >
                              <IcoNewFolder />
                            </button>
                            <button
                              className="fe-folder-delete"
                              title={t('editor.fileExplorer.deleteFolder', 'Delete folder')}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteFolder(board.id, groupId, row.path);
                              }}
                            >
                              <IcoTrashSmall />
                            </button>
                          </span>
                        </div>
                      );
                    }
                    const file = row.file;
                    const isActiveFile = isActiveBoard && file.id === activeFileId;
                    return (
                      <div
                        key={file.id}
                        className={`file-explorer-item fe-file-item${isActiveFile ? ' file-explorer-item-active' : ''}`}
                        style={{ '--fe-depth': row.depth } as React.CSSProperties}
                        onClick={() => handleFileClick(file.id, board.id, groupId)}
                        onContextMenu={(e) => handleContextMenu(e, file.id, groupId)}
                        onDoubleClick={() => {
                          switchToBoard(board.id, groupId);
                          startRename(file.id, groupId);
                        }}
                        title={`${file.name}${file.modified ? ` (${t('editor.fileExplorer.unsavedSuffix')})` : ''}`}
                      >
                        <span className="file-explorer-icon">
                          <FileIcon name={file.name} />
                        </span>

                        {renamingId === file.id ? (
                          <input
                            ref={renameInputRef}
                            className="file-explorer-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename();
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span className="file-explorer-name">{fileBasename(file.name)}</span>
                        )}

                        {file.modified && (
                          <span className="file-explorer-dot" title={t('editor.fileExplorer.unsavedChanges')} />
                        )}
                      </div>
                    );
                  })}

                  {/* Inline new-file input for this group */}
                  {creatingInGroup === groupId && (
                    <div
                      className="file-explorer-item file-explorer-item-new fe-file-item"
                      style={
                        creatingParentPath
                          ? ({ '--fe-depth': creatingParentPath.split('/').length } as React.CSSProperties)
                          : undefined
                      }
                    >
                      <span className="file-explorer-icon">
                        <IcoFile />
                      </span>
                      <input
                        ref={newFileInputRef}
                        className="file-explorer-rename-input"
                        value={newFileName}
                        placeholder={
                          creatingParentPath ? `${creatingParentPath}/…` : 'filename.ino'
                        }
                        onChange={(e) => setNewFileName(e.target.value)}
                        onBlur={commitCreateFile}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitCreateFile();
                          if (e.key === 'Escape') {
                            setCreatingInGroup(null);
                            setCreatingParentPath('');
                            setNewFileName('');
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  )}

                  {/* Inline new-folder input for this group */}
                  {creatingFolderInGroup === groupId && (
                    <div
                      className="file-explorer-item file-explorer-item-new fe-file-item"
                      style={
                        creatingFolderParent
                          ? ({ '--fe-depth': creatingFolderParent.split('/').length } as React.CSSProperties)
                          : undefined
                      }
                    >
                      <span className="file-explorer-icon fe-folder-icon">
                        <IcoFolder open={true} />
                      </span>
                      <input
                        ref={newFolderInputRef}
                        className="file-explorer-rename-input"
                        value={newFolderName}
                        placeholder={t('editor.fileExplorer.folderNamePlaceholder', 'folder name')}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onBlur={commitCreateFolder}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitCreateFolder();
                          if (e.key === 'Escape') {
                            setCreatingFolderInGroup(null);
                            setNewFolderName('');
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  )}

                  {/* velxio.json — THIS board's declared library manifest
                      (compile scope), grouped with the board's code so it is
                      clear which board it belongs to. There is one per board.
                      Clicking switches to the board and opens the Library
                      Manager on its list. QEMU-Linux boards run Python in a
                      guest OS — no arduino-cli manifest, so no row. */}
                  {!isPiBoardKind(board.boardKind) && (
                  <div
                    className={`file-explorer-item fe-file-item${
                      manifestViewBoardId === board.id ? ' file-explorer-item-active' : ''
                    }`}
                    onClick={() => {
                      switchToBoard(board.id, groupId);
                      // Open the READ-ONLY libraries.json view (not the modal).
                      // Library actions happen in the Library Manager modal.
                      setManifestView(board.id);
                    }}
                    title={`libraries.json — ${boardDisplayName(board)}'s declared libraries (read-only; manage from the Library Manager)`}
                  >
                    <span className="file-explorer-icon" style={{ color: '#ffd60a' }}>
                      <FileIcon name="libraries.json" />
                    </span>
                    <span className="file-explorer-name">libraries.json</span>
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: 9,
                        lineHeight: '14px',
                        color: 'var(--wb-11)',
                        background: 'var(--wb-5)',
                        borderRadius: 7,
                        padding: '0 5px',
                      }}
                      title={
                        board.libraries && board.libraries.length
                          ? `${board.libraries.length} declared: ${board.libraries.join(', ')}`
                          : 'No libraries declared for this board'
                      }
                    >
                      {board.libraries?.length ?? 0}
                    </span>
                  </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Custom-chip sections — one per chip, each its own collapsible
            group holding chip.c + chip.json (and the ROM program for
            programmable CPU chips), separate from the board sketch above. */}
        {customChipComponents.map((chip) => {
          const groupId = chipFileGroupId(chip.id);
          const groupFiles = fileGroups[groupId] ?? [];
          if (groupFiles.length === 0) return null;
          const isActiveGroup = activeGroupId === groupId;
          const isOpen = !collapsed[chip.id];
          const chipName =
            String((chip.properties as Record<string, unknown>)?.chipName ?? '').trim() ||
            'Custom Chip';

          return (
            <div key={chip.id} className="fe-board-section">
              <div
                className={`fe-board-header${isActiveGroup ? ' fe-board-header-active' : ''}`}
                onClick={() => {
                  switchToChip(groupId);
                  if (!isOpen) toggleCollapse(chip.id);
                }}
                title={`${chipName} — ${t('editor.fileExplorer.clickToEdit')}`}
              >
                {/* Same two-row shape as a board section: the rename button
                    sits above, the chip's name gets the full row. */}
                <div className="fe-board-actions-row">
                  {!(renamingSection?.id === chip.id && renamingSection.kind === 'chip') && (
                    <>
                      <button
                        className="fe-board-new-btn"
                        title={
                          chipCompileState[chip.id] === 'busy'
                            ? 'Compiling...'
                            : chipCompileState[chip.id] && chipCompileState[chip.id] !== 'ok'
                              ? `Compile failed: ${chipCompileState[chip.id]}`
                              : 'Compile chip.c to WASM'
                        }
                        disabled={chipCompileState[chip.id] === 'busy'}
                        onClick={(e) => {
                          e.stopPropagation();
                          void compileChipNow(chip.id);
                        }}
                      >
                        <IcoChipCompile state={chipCompileState[chip.id]} />
                      </button>
                      <button
                        className="fe-board-new-btn"
                        title={
                          String((chip.properties as Record<string, unknown>)?.image ?? '')
                            ? 'Replace the chip image (PNG, JPEG or SVG)'
                            : 'Add a chip image (PNG, JPEG or SVG)'
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          pickChipImage(chip.id);
                        }}
                      >
                        <IcoChipImage />
                      </button>
                      {String((chip.properties as Record<string, unknown>)?.image ?? '') !== '' && (
                        <button
                          className="fe-board-new-btn"
                          title="Remove the chip image"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeChipImage(chip.id);
                          }}
                        >
                          <IcoChipImageRemove />
                        </button>
                      )}
                      {chipActions.map((a) => (
                        <button
                          key={a.id}
                          className="fe-board-new-btn"
                          title={a.title}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Commit any pending chip.c edit before the
                            // action reads properties (e.g. save-to-library).
                            flushChipFileSync();
                            a.run(chip.id);
                          }}
                        >
                          <span style={{ fontSize: 11, lineHeight: 1 }}>{a.glyph}</span>
                        </button>
                      ))}
                      <button
                        className="fe-board-new-btn"
                        title="Rename chip (or double-click the name)"
                        onClick={(e) => {
                          e.stopPropagation();
                          startChipRename(chip.id, chipName);
                        }}
                      >
                        <IcoPencil />
                      </button>
                    </>
                  )}
                </div>

                <div className="fe-board-name-row">
                  <button
                    className="fe-collapse-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(chip.id);
                    }}
                    title={isOpen ? t('editor.fileExplorer.collapse') : t('editor.fileExplorer.expand')}
                  >
                    <IcoChevron open={isOpen} />
                  </button>

                  <span className="fe-board-icon" style={{ color: 'var(--color-accent-fg)' }}>
                    <IcoChip />
                  </span>

                  {renamingSection?.id === chip.id && renamingSection.kind === 'chip' ? (
                    <input
                      ref={sectionRenameInputRef}
                      className="file-explorer-rename-input fe-section-rename-input"
                      value={sectionRenameValue}
                      onChange={(e) => setSectionRenameValue(e.target.value)}
                      onBlur={commitSectionRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitSectionRename();
                        if (e.key === 'Escape') cancelSectionRename();
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="fe-board-label"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startChipRename(chip.id, chipName);
                      }}
                      title="Double-click to rename"
                    >
                      {chipName}
                    </span>
                  )}
                </div>
              </div>

              {isOpen && (
                <div className="fe-board-files">
                  {groupFiles.map((file) => {
                    const isActiveFile = isActiveGroup && file.id === activeFileId;
                    return (
                      <div
                        key={file.id}
                        className={`file-explorer-item fe-file-item${isActiveFile ? ' file-explorer-item-active' : ''}`}
                        onClick={() => handleChipFileClick(file.id, groupId)}
                        title={`${file.name}${file.modified ? ` (${t('editor.fileExplorer.unsavedSuffix')})` : ''}`}
                      >
                        <span className="file-explorer-icon">
                          <FileIcon name={file.name} />
                        </span>
                        <span className="file-explorer-name">{file.name}</span>
                        {file.modified && (
                          <span className="file-explorer-dot" title={t('editor.fileExplorer.unsavedChanges')} />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Fallback: nothing on the canvas yet */}
        {boards.length === 0 && customChipComponents.length === 0 && (
          <div style={{ color: 'var(--wb-9)', fontSize: 11, padding: '12px 12px', lineHeight: 1.5 }}>
            {t('editor.fileExplorer.emptyState')}
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          className="file-explorer-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => startRename(contextMenu.fileId, contextMenu.boardGroupId)}>
            {t('editor.fileExplorer.contextMenu.rename')}
          </button>
          <button
            className="ctx-delete"
            onClick={() => handleDelete(contextMenu.fileId, contextMenu.boardGroupId)}
            disabled={(fileGroups[contextMenu.boardGroupId] ?? []).length <= 1}
          >
            {t('editor.fileExplorer.contextMenu.delete')}
          </button>
        </div>
      )}
    </div>
  );
};
