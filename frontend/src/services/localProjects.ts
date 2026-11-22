import { createStore, entries, get, promisifyRequest, update } from 'idb-keyval';
import { savedWorkspaceFileId, type SavedWorkspaceFile } from '../utils/savedWorkspaceFile';
import type { VlxPayload } from '../utils/vlxFile';

export interface LocalProjectDetails {
  id: string;
  name: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface LocalProject extends LocalProjectDetails {
  payload: VlxPayload;
}

export interface LocalFileVersion {
  savedAt: number;
  content: string;
  rename?: { from: string; to: string };
}

type StoredFileVersion = number | (Omit<LocalFileVersion, 'content'> & { content?: string });
type StoredProject = Omit<LocalProject, 'createdAt'> & {
  createdAt?: number;
  fileSaveHistory?: Record<string, StoredFileVersion[]>;
};
type ProjectSave = Omit<LocalProject, 'createdAt'>;

const projects = createStore('velxio-projects', 'projects');
const diskHistory = createStore('velxio-disk-history', 'file-versions');

export class LocalProjectConflict extends Error {
  constructor() {
    super(
      'This project changed in another tab. Reopen it to load that version, or save a local copy to keep your edits.',
    );
  }
}

function withCreatedAt(project: StoredProject): LocalProject {
  return { ...project, createdAt: project.createdAt ?? project.updatedAt };
}

const fileKey = (groupId: string, path: string) => JSON.stringify([groupId, path]);
const FILE_HISTORY_LIMIT = 20;

let lastBrowserProject: StoredProject | undefined;
let lastDiskHistory: { id: string; history: DiskFileHistory } | undefined;

function readableVersions(value: unknown): LocalFileVersion[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is LocalFileVersion =>
    entry !== null && typeof entry === 'object' && Number.isFinite(entry.savedAt) &&
    Number.isFinite(new Date(entry.savedAt).getTime()) && typeof entry.content === 'string',
  );
}

function fileVersions(project: StoredProject, key: string, currentContent: string): LocalFileVersion[] {
  const stored = project.fileSaveHistory?.[key];
  const [latest, ...older] = Array.isArray(stored) ? stored : [];
  const time = typeof latest === 'number' ? latest : latest?.savedAt;
  const savedAt = typeof time === 'number' && Number.isFinite(new Date(time).getTime()) ? time : project.updatedAt;
  // The project payload can recover the latest save from the old timestamp-only format.
  return [
    { ...(typeof latest === 'object' ? latest : undefined), savedAt, content: currentContent },
    ...readableVersions(older),
  ];
}

function recordFileSave(
  older: LocalFileVersion[],
  { name, content }: SavedWorkspaceFile,
  savedAt: number,
  previousName?: string,
): LocalFileVersion[] {
  const entries: LocalFileVersion[] = [];
  if (previousName !== undefined && previousName !== name) {
    entries.push({ savedAt, content, rename: { from: previousName, to: name } });
  }
  if (older[0]?.content !== content) entries.push({ savedAt, content });
  return entries.length ? [...entries, ...older].slice(0, FILE_HISTORY_LIMIT) : older;
}

function collectFileSaves(project: ProjectSave, previous?: StoredProject): Record<string, LocalFileVersion[]> {
  const history: Record<string, LocalFileVersion[]> = {};
  for (const [groupId, files] of Object.entries(project.payload.fileGroups ?? {})) {
    const previousFiles = new Map(
      (previous?.payload.fileGroups?.[groupId] ?? []).map((file) => [savedWorkspaceFileId(file), file]),
    );
    for (const file of files) {
      const priorFile = previousFiles.get(savedWorkspaceFileId(file));
      const older = previous && priorFile
        ? fileVersions(previous, fileKey(groupId, priorFile.name), priorFile.content) : [];
      history[fileKey(groupId, file.name)] = recordFileSave(older, file, project.updatedAt, priorFile?.name);
    }
  }
  return history;
}

export async function getLocalProject(id: string): Promise<LocalProject | undefined> {
  const project = await get<StoredProject>(id, projects);
  if (project) lastBrowserProject = project;
  return project && withCreatedAt(project);
}

export async function getLocalFileVersions(
  id: string, groupId: string, path: string, fileId?: string,
): Promise<LocalFileVersion[]> {
  let project: StoredProject | undefined;
  try {
    project = await get<StoredProject>(id, projects);
  } catch (error) {
    if (lastBrowserProject?.id !== id) throw error;
    project = lastBrowserProject;
  }
  const files = project?.payload?.fileGroups?.[groupId];
  const file = Array.isArray(files) && files.find((candidate) =>
    candidate && (fileId === undefined ? candidate.name === path : savedWorkspaceFileId(candidate) === fileId),
  );
  return project && file ? fileVersions(project, fileKey(groupId, file.name), file.content) : [];
}

interface DiskFileHistory {
  savedAt: number;
  files: Record<string, LocalFileVersion[]>;
  namesById?: Record<string, string>;
}

export async function recordDiskFileVersions(
  id: string, fileGroups: VlxPayload['fileGroups'], savedAt: number, persist = true,
): Promise<void> {
  const cached = () => lastDiskHistory?.id === id ? lastDiskHistory.history : undefined;
  const record = (previous?: DiskFileHistory) => {
    const memory = cached();
    if (memory && (!previous || memory.savedAt > previous.savedAt)) previous = memory;
    if (previous && previous.savedAt > savedAt) return previous;
    const files: DiskFileHistory['files'] = {};
    const namesById: NonNullable<DiskFileHistory['namesById']> = {};
    for (const [groupId, groupFiles] of Object.entries(fileGroups)) {
      for (const file of groupFiles) {
        const key = fileKey(groupId, savedWorkspaceFileId(file));
        const priorName = previous?.namesById?.[key];
        const priorPath = previous?.namesById ? priorName : file.name;
        const older = priorPath === undefined ? [] : readableVersions(previous?.files?.[fileKey(groupId, priorPath)]);
        namesById[key] = file.name;
        files[fileKey(groupId, file.name)] = recordFileSave(older, file, savedAt, priorName);
      }
    }
    return { savedAt, files, namesById };
  };
  let history: DiskFileHistory | undefined;
  if (persist) {
    try {
      await update<DiskFileHistory>(id, (previous) => (history = record(previous)), diskHistory);
    } catch {
      // The project file has already been read or written. Keep its history in this tab.
      history ??= record();
    }
  } else {
    history = record();
  }
  if (history) lastDiskHistory = { id, history };
}

export async function getDiskFileVersions(
  id: string, groupId: string, path: string, fileId?: string,
): Promise<LocalFileVersion[]> {
  const history = lastDiskHistory?.id === id
    ? lastDiskHistory.history
    : await get<DiskFileHistory>(id, diskHistory);
  const savedPath = fileId && history?.namesById ? history.namesById[fileKey(groupId, fileId)] : path;
  return savedPath === undefined ? [] : readableVersions(history?.files?.[fileKey(groupId, savedPath)]);
}

export async function listLocalProjects(): Promise<LocalProjectDetails[]> {
  const records = await entries<string, StoredProject>(projects);
  return records
    .map(([, project]) => {
      const { id, name, revision, createdAt, updatedAt } = withCreatedAt(project);
      return { id, name, revision, createdAt, updatedAt };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function writeLocalProject(project: ProjectSave): Promise<void> {
  let committed: StoredProject | undefined;
  // Read and compare inside the same transaction as the write, so two tabs
  // starting from the same revision cannot both report a successful save.
  await update<StoredProject>(
    project.id,
    (previous) => {
      if ((previous?.revision ?? 0) !== project.revision - 1) throw new LocalProjectConflict();
      committed = {
        ...project,
        createdAt: previous ? withCreatedAt(previous).createdAt : project.updatedAt,
        fileSaveHistory: collectFileSaves(project, previous),
      };
      return committed;
    },
    projects,
  );
  lastBrowserProject = committed;
}

export async function renameLocalProject(
  id: string,
  revision: number,
  name: string,
): Promise<LocalProject> {
  let renamed: StoredProject | undefined;
  await update<StoredProject>(
    id,
    (previous) => {
      if (!previous || previous.revision !== revision) throw new LocalProjectConflict();
      renamed = {
        ...withCreatedAt(previous),
        name,
        revision: revision + 1,
        updatedAt: Date.now(),
        payload: { ...previous.payload, name },
        fileSaveHistory: collectFileSaves(previous, previous),
      };
      return renamed;
    },
    projects,
  );
  lastBrowserProject = renamed;
  return withCreatedAt(renamed!);
}

export function deleteLocalProject(id: string, revision: number): Promise<void> {
  return projects('readwrite', (store) => new Promise<void>((resolve, reject) => {
    // Check the revision in the same transaction as the delete.
    const request = store.get(id);
    request.onsuccess = () => {
      const project: StoredProject | undefined = request.result;
      if (!project) return;
      if (project.revision !== revision) {
        reject(new LocalProjectConflict());
        return;
      }
      store.delete(id);
    };
    void promisifyRequest(store.transaction).then(() => {
      if (lastBrowserProject?.id === id) lastBrowserProject = undefined;
      resolve();
    }, reject);
  }));
}
