import { create } from 'zustand';
import { createStore, entries, get, set } from 'idb-keyval';
import type { AutoSaveState } from '../hooks/useAutoSaveProject';
import { flushChipFileSync } from '../services/chipFiles';
import { resolveMissingLibraryVersions } from '../services/libraryService';
import {
  deleteLocalProject,
  getLocalProject,
  recordDiskFileVersions,
  renameLocalProject,
  writeLocalProject,
  type LocalProject,
} from '../services/localProjects';
import { useEditorPreferences } from '../store/useEditorPreferences';
import { useCompileLogsStore } from '../store/useCompileLogsStore';
import { useEditorStore } from '../store/useEditorStore';
import { showConfirmDialog, showMessageDialog } from '../store/useMessageDialogStore';
import { useProjectStore } from '../store/useProjectStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { generateUUID } from '../utils/uuid';
import { bareLibName, libraryVersionFromSpec } from '../utils/libraryManifest';
import { buildVlxPayload, loadVlxPayload, parseVlxFile, type VlxPayload } from '../utils/vlxFile';

interface DiskHandle extends FileSystemFileHandle {
  queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
}

type PickerWindow = Window & {
  showOpenFilePicker?: (options: object) => Promise<DiskHandle[]>;
  showSaveFilePicker?: (options: object) => Promise<DiskHandle>;
};

type SaveTarget =
  | { kind: 'browser'; id: string; name: string; revision: number }
  | { kind: 'disk'; id?: string; historyId: string; name: string; handle: DiskHandle; fileVersion: string };

const diskProjects = createStore('velxio-disk-projects', 'handles');

const idle: AutoSaveState = { status: 'idle', lastSavedAt: null, errorMessage: null };
const fileType = { description: 'Velxio project', accept: { 'application/json': ['.vlx'] } };

export const useLocalWorkspace = create<AutoSaveState & {
  name: string | null;
  browserId: string | null;
  diskId: string | null;
  diskHistoryId: string | null;
}>(() => ({
  ...idle,
  name: null,
  browserId: null,
  diskId: null,
  diskHistoryId: null,
}));

let target: SaveTarget | null = null;
let targetVersion = -1;
let savedContent = '';
let pending: Promise<void> | null = null;
let observedWorkspaceVersion = useProjectStore.getState().workspaceVersion;

function workspaceVersion(): number {
  return useProjectStore.getState().workspaceVersion;
}

function currentTarget(): SaveTarget | null {
  return targetVersion === workspaceVersion() ? target : null;
}

export function hasLocalWorkspace(): boolean {
  return currentTarget() !== null;
}

/** Carry an explicitly loaded workspace through an in-app navigation to /editor. */
export function keepWorkspaceLocationState() {
  return { keepWorkspaceVersion: workspaceVersion() };
}

function fingerprint(payload = buildVlxPayload()): string {
  const { exportedAt: _time, name: _name, ...content } = payload;
  return JSON.stringify(content);
}

function selectTarget(next: SaveTarget, content: string, updatedAt: number): void {
  target = next;
  targetVersion = workspaceVersion();
  savedContent = content;
  useLocalWorkspace.setState({
    name: next.name,
    browserId: next.kind === 'browser' ? next.id : null,
    diskId: next.kind === 'disk' ? next.id ?? null : null,
    diskHistoryId: next.kind === 'disk' ? next.historyId : null,
    status: 'saved',
    lastSavedAt: updatedAt,
    errorMessage: null,
  });
}

function clearTarget(status: 'idle' | 'dirty' = 'idle'): void {
  target = null;
  savedContent = '';
  useLocalWorkspace.setState({ ...idle, status, name: null, browserId: null, diskId: null, diskHistoryId: null });
}

function loadLocalProject(project: LocalProject): void {
  loadVlxPayload(project.payload);
  useSimulatorStore.getState().clearHistory();
  useCompileLogsStore.getState().clear();
  selectTarget(
    { kind: 'browser', id: project.id, name: project.name, revision: project.revision },
    fingerprint(),
    project.updatedAt,
  );
}

export function hasUnsavedLocalChanges(): boolean {
  if (hasLocalWorkspace()) return fingerprint() !== savedContent;
  return (
    useLocalWorkspace.getState().status === 'dirty' ||
    useSimulatorStore.getState().historyIndex >= 0 ||
    Object.values(useEditorStore.getState().fileGroups).some((files) =>
      files.some((f) => f.modified),
    )
  );
}

export async function upgradeWorkspaceLibraryVersions(signal: AbortSignal): Promise<void> {
  const version = workspaceVersion();
  const openedTarget = currentTarget();
  const simulator = useSimulatorStore.getState();
  if (useProjectStore.getState().currentExampleId) return;
  const dependencies = simulator.boards.flatMap((board) => board.libraries ?? []);
  const catalog = await resolveMissingLibraryVersions(dependencies, signal);
  if (!catalog.size || signal.aborted || workspaceVersion() !== version) return;

  // Write a metadata-only migration even with auto-save disabled, provided the
  // loaded project is still clean and its existing destination can be written.
  const writable = openedTarget?.kind === 'browser' || (openedTarget?.kind === 'disk' &&
    await openedTarget.handle.queryPermission({ mode: 'readwrite' }).catch(() => 'denied') === 'granted');
  if (signal.aborted || workspaceVersion() !== version) return;
  const saveMigration = writable && currentTarget() === openedTarget && !pending && !hasUnsavedLocalChanges();
  let changed = false;
  useSimulatorStore.setState((state) => {
    const boards = state.boards.map((board) => {
      const libraries = board.libraries;
      if (!libraries?.length) return board;
      const next = libraries.map((spec) => {
        if (typeof spec !== 'string' || libraryVersionFromSpec(spec)) return spec;
        const name = bareLibName(spec).trim();
        const latest = catalog.get(name.toLowerCase());
        return latest ? `${name}@${latest}` : spec;
      });
      if (next.every((spec, index) => spec === libraries[index])) return board;
      changed = true;
      return { ...board, libraries: next };
    });
    return changed ? { boards } : state;
  });
  if (changed && saveMigration) await saveLocalWorkspace({ manual: false });
}

export async function openLocalWorkspace(id: string, signal: AbortSignal): Promise<boolean> {
  if (currentTarget()?.id === id) return true;
  const version = workspaceVersion();
  const project = await getLocalProject(id);
  if (signal.aborted || version !== workspaceVersion()) return false;
  if (project) {
    loadLocalProject(project);
    return true;
  }

  const handle = await get<DiskHandle>(id, diskProjects);
  const isCurrent = () => !signal.aborted && version === workspaceVersion();
  if (!handle || !isCurrent() || !canOpenProjectFile()) return false;
  try {
    if (await handle.queryPermission({ mode: 'read' }) !== 'granted') {
      if (!isCurrent()) return false;
      const reconnect = await showConfirmDialog(`Allow Velxio to reopen “${handle.name}”.`, {
        title: 'Reconnect disk project',
        confirmLabel: 'Reconnect',
      });
      // Request permission from the confirmation click's user activation.
      if (!reconnect || !isCurrent() || await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') return false;
    }
    if (!isCurrent()) return false;
    const file = await handle.getFile();
    const payload = await parseVlxFile(file);
    if (!isCurrent()) return false;
    await cacheDiskTimeline(id, true, payload, file.lastModified);
    if (!isCurrent()) return false;
    loadDiskWorkspace(handle, file, payload, id, id);
    return true;
  } catch (error) {
    if (isCurrent()) showMessageDialog(String(error), { kind: 'error', title: 'Could not reopen disk project' });
    return false;
  }
}

async function rememberDiskHandle(handle: DiskHandle): Promise<string | undefined> {
  try {
    for (const [id, saved] of await entries<string, DiskHandle>(diskProjects)) {
      if (await handle.isSameEntry(saved).catch(() => false)) return id;
    }
    const id = generateUUID();
    await set(id, handle, diskProjects);
    return id;
  } catch {
    // Some browsers or storage policies prevent persisting file handles.
    return undefined;
  }
}

function loadDiskWorkspace(handle: DiskHandle, file: File, payload: VlxPayload, historyId: string, id?: string): void {
  loadVlxPayload(payload);
  selectTarget(
    {
      kind: 'disk',
      id,
      historyId,
      handle,
      name: payload.name || file.name.replace(/\.vlx$/i, ''),
      fileVersion: diskFileVersion(file),
    },
    fingerprint(),
    file.lastModified,
  );
}

async function cacheDiskTimeline(id: string, persist: boolean, payload: VlxPayload, savedAt: number): Promise<void> {
  // A history cache failure cannot undo a successful disk read or write.
  await recordDiskFileVersions(id, payload.fileGroups, savedAt, persist).catch(() => undefined);
}

export async function renameBrowserWorkspace(id: string, revision: number, name: string) {
  while (pending) await pending;
  const selected = currentTarget();
  const active = selected?.kind === 'browser' && selected.id === id ? selected : null;
  const write = renameLocalProject(id, active?.revision ?? revision, name);
  const lock = write.then(() => undefined, () => undefined);
  pending = lock;
  try {
    const project = await write;
    if (active && active === currentTarget()) {
      target = { ...active, name: project.name, revision: project.revision };
      useLocalWorkspace.setState({ name: project.name, lastSavedAt: project.updatedAt });
    }
    return project;
  } finally {
    if (pending === lock) pending = null;
  }
}

export async function deleteBrowserWorkspace(id: string, revision: number): Promise<void> {
  while (pending) await pending;
  const selected = currentTarget();
  const active = selected?.kind === 'browser' && selected.id === id ? selected : null;
  const deletion = deleteLocalProject(id, active?.revision ?? revision);
  const lock = deletion.then(() => undefined, () => undefined);
  pending = lock;
  try {
    await deletion;
    if (active && active === currentTarget()) clearTarget('dirty');
  } finally {
    if (pending === lock) pending = null;
  }
}

function reportSaveError(error: unknown, manual: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  useLocalWorkspace.setState({ status: 'error', errorMessage: message });
  if (manual) showMessageDialog(message, { kind: 'error', title: 'Could not save project' });
}

function diskFileVersion(file: File): string {
  return `${file.lastModified}:${file.size}`;
}

async function writeDisk(
  destination: Extract<SaveTarget, { kind: 'disk' }>,
  payload: VlxPayload,
  manual: boolean,
): Promise<{ target: typeof destination; savedAt: number }> {
  if (!manual && (await destination.handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    throw new Error('Choose Save to grant Velxio permission to write this file.');
  }
  if (
    destination.fileVersion &&
    destination.fileVersion !== diskFileVersion(await destination.handle.getFile())
  ) {
    throw new Error('The file changed on disk. Reopen it or use Save As to keep your edits.');
  }
  const writable = await destination.handle.createWritable();
  try {
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
  const file = await destination.handle.getFile();
  return {
    target: { ...destination, fileVersion: diskFileVersion(file) },
    savedAt: file.lastModified,
  };
}

export async function saveLocalWorkspace(
  options: {
    manual?: boolean;
    copyName?: string;
    disk?: DiskHandle;
  } = {},
): Promise<boolean> {
  const { manual = true, copyName, disk } = options;
  const version = workspaceVersion();
  if (pending) {
    await pending;
    if (version !== workspaceVersion()) return false;
    return saveLocalWorkspace(options);
  }

  const selected = currentTarget();
  if (!manual && !selected) return false;
  const sim = useSimulatorStore.getState();
  const example = useProjectStore.getState().currentExampleId;
  const name =
    copyName?.trim() ||
    selected?.name ||
    useProjectStore.getState().currentProject?.slug ||
    example ||
    sim.boards.find((board) => board.id === sim.activeBoardId)?.name ||
    'Untitled project';
  let destination = selected;
  if (disk)
    destination = {
      kind: 'disk',
      historyId: generateUUID(),
      handle: disk,
      name: disk.name.replace(/\.vlx$/i, ''),
      fileVersion: '',
    };
  else if (copyName !== undefined || !selected) {
    destination = { kind: 'browser', id: generateUUID(), name, revision: 0 };
  }
  if (!destination) return false;
  const saveTarget = destination;
  const write = async () => {
    try {
      flushChipFileSync();
      const files = useEditorStore.getState().fileGroups;
      const payload = buildVlxPayload({ name: saveTarget.name });
      const content = fingerprint(payload);
      if (
        saveTarget === selected &&
        content === savedContent &&
        useLocalWorkspace.getState().status !== 'error'
      )
        return true;
      const updatedAt = Date.now();
      useLocalWorkspace.setState({ status: 'saving', errorMessage: null });
      let next: SaveTarget;
      if (saveTarget.kind === 'disk') {
        const { target: written, savedAt } = await writeDisk(saveTarget, payload, manual);
        const id = disk ? await rememberDiskHandle(disk) : written.id;
        const historyId = id ?? written.historyId;
        next = { ...written, id, historyId };
        await cacheDiskTimeline(historyId, !!id, payload, savedAt);
      } else {
        next = { ...saveTarget, revision: saveTarget.revision + 1 };
        await writeLocalProject({ ...next, updatedAt, payload });
      }
      if (workspaceVersion() !== version) return false;
      if (useProjectStore.getState().currentProject && (disk || copyName !== undefined)) {
        useProjectStore.getState().clearCurrentProject();
      }
      selectTarget(next, content, updatedAt);
      useEditorStore.getState().markWorkspaceFilesSaved(files);
      if (fingerprint() !== content) useLocalWorkspace.setState({ status: 'dirty' });
      return true;
    } catch (error) {
      if (workspaceVersion() === version) reportSaveError(error, manual);
      return false;
    }
  };
  const result = write();
  const lock = result.then(() => undefined);
  pending = lock;
  try {
    return await result;
  } finally {
    if (pending === lock) pending = null;
  }
}

export function canOpenProjectFile(): boolean {
  return typeof (window as PickerWindow).showOpenFilePicker === 'function';
}

export function canSaveProjectFile(): boolean {
  return typeof (window as PickerWindow).showSaveFilePicker === 'function';
}

export async function openProjectFile(): Promise<void> {
  const version = workspaceVersion();
  try {
    const [handle] =
      (await (window as PickerWindow).showOpenFilePicker?.({
        types: [fileType],
        excludeAcceptAllOption: true,
      })) ?? [];
    if (!handle) return;
    const file = await handle.getFile();
    const payload = await parseVlxFile(file);
    if (
      hasUnsavedLocalChanges() &&
      !(await showConfirmDialog('Opening this project will replace your unsaved changes.', {
        title: 'Open project from disk',
        confirmLabel: 'Open project',
        danger: true,
      }))
    )
      return;
    if (version !== workspaceVersion()) return;
    const id = await rememberDiskHandle(handle);
    if (version !== workspaceVersion()) return;
    const historyId = id ?? generateUUID();
    await cacheDiskTimeline(historyId, !!id, payload, file.lastModified);
    if (version !== workspaceVersion()) return;
    loadDiskWorkspace(handle, file, payload, historyId, id);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      showMessageDialog(String(error), { kind: 'error', title: 'Could not open project' });
    }
  }
}

export async function saveProjectFileAs(): Promise<void> {
  const version = workspaceVersion();
  try {
    const handle = await (window as PickerWindow).showSaveFilePicker?.({
      suggestedName: `${currentTarget()?.name ?? 'velxio-project'}.vlx`,
      types: [fileType],
    });
    if (handle && version === workspaceVersion()) await saveLocalWorkspace({ disk: handle });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError'))
      reportSaveError(error, true);
  }
}

export function watchLocalWorkspace(): () => void {
  let disposed = false;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let dirtyContent = '';
  const scheduleCheck = () => {
    if (!hasLocalWorkspace() || checkTimer) return;
    checkTimer = setTimeout(() => {
      checkTimer = undefined;
      if (!hasLocalWorkspace()) return;
      const state = useLocalWorkspace.getState();
      if (state.status === 'saving' || state.status === 'error') return;
      const content = fingerprint();
      if (content === savedContent) {
        clearTimeout(saveTimer);
        dirtyContent = '';
        if (state.status === 'dirty') useLocalWorkspace.setState({ status: 'saved' });
        return;
      }
      if (state.status !== 'dirty') useLocalWorkspace.setState({ status: 'dirty' });
      if (content === dirtyContent) return;
      dirtyContent = content;
      clearTimeout(saveTimer);
      if (useEditorPreferences.getState().autoSave) {
        saveTimer = setTimeout(() => void saveLocalWorkspace({ manual: false }), 800);
      }
    }, 120);
  };
  const editor = useEditorStore.subscribe((state, previous) => {
    if (state.renameRevision !== previous.renameRevision && hasLocalWorkspace()) {
      const version = workspaceVersion();
      queueMicrotask(() => {
        if (!disposed && workspaceVersion() === version) void saveLocalWorkspace({ manual: false });
      });
      return;
    }
    if (state.fileGroups !== previous.fileGroups || state.folderGroups !== previous.folderGroups)
      scheduleCheck();
  });
  const sim = useSimulatorStore.subscribe((state, previous) => {
    if (
      state.boards !== previous.boards ||
      state.components !== previous.components ||
      state.wires !== previous.wires ||
      state.activeBoardId !== previous.activeBoardId
    )
      scheduleCheck();
  });
  const settings = useEditorPreferences.subscribe((state, previous) => {
    if (state.autoSave === previous.autoSave) return;
    dirtyContent = '';
    clearTimeout(saveTimer);
    scheduleCheck();
  });
  const resetTarget = () => {
    const version = workspaceVersion();
    if (version === observedWorkspaceVersion) return;
    observedWorkspaceVersion = version;
    dirtyContent = '';
    clearTimeout(saveTimer);
    clearTarget();
  };
  resetTarget();
  const project = useProjectStore.subscribe(resetTarget);
  const storage = useLocalWorkspace.subscribe((state, previous) => {
    if (state.status === 'saving' || (previous.browserId && !state.browserId)) {
      clearTimeout(saveTimer);
      dirtyContent = '';
    } else if (state.status === 'dirty' && previous.status === 'saved') {
      scheduleCheck();
    }
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasLocalWorkspace() && useLocalWorkspace.getState().status !== 'dirty') return;
    if (!hasUnsavedLocalChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  scheduleCheck();
  return () => {
    disposed = true;
    clearTimeout(checkTimer);
    clearTimeout(saveTimer);
    editor();
    sim();
    settings();
    project();
    storage();
    window.removeEventListener('beforeunload', beforeUnload);
  };
}
