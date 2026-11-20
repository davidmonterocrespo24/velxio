import { createStore, entries, get, update } from 'idb-keyval';
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
}

type StoredFileVersion = number | { savedAt: number; content?: string };
type StoredProject = Omit<LocalProject, 'createdAt'> & {
  createdAt?: number;
  fileSaveHistory?: Record<string, StoredFileVersion[]>;
};
type ProjectSave = Omit<LocalProject, 'createdAt'>;

const projects = createStore('velxio-projects', 'projects');

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

function fileVersions(project: StoredProject, key: string, currentContent: string): LocalFileVersion[] {
  const [latest, ...older] = project.fileSaveHistory?.[key] ?? [];
  const savedAt = typeof latest === 'number' ? latest : latest?.savedAt ?? project.updatedAt;
  // The project payload can recover the latest save from the old timestamp-only format.
  return [
    { savedAt, content: currentContent },
    ...older.filter((entry): entry is LocalFileVersion => typeof entry !== 'number' && typeof entry.content === 'string'),
  ];
}

function collectFileSaves(project: ProjectSave, previous?: StoredProject): Record<string, LocalFileVersion[]> {
  const history: Record<string, LocalFileVersion[]> = {};
  for (const [groupId, files] of Object.entries(project.payload.fileGroups ?? {})) {
    const previousFiles = new Map(
      (previous?.payload.fileGroups?.[groupId] ?? []).map((file) => [file.name, file.content]),
    );
    for (const file of files) {
      const key = fileKey(groupId, file.name);
      const previousContent = previousFiles.get(file.name);
      const older = previous && previousContent !== undefined
        ? fileVersions(previous, key, previousContent) : [];
      history[key] = previousContent === file.content
        ? older
        : [{ savedAt: project.updatedAt, content: file.content }, ...older].slice(0, FILE_HISTORY_LIMIT);
    }
  }
  return history;
}

export async function getLocalProject(id: string): Promise<LocalProject | undefined> {
  const project = await get<StoredProject>(id, projects);
  return project && withCreatedAt(project);
}

export async function getLocalFileVersions(id: string, groupId: string, path: string): Promise<LocalFileVersion[]> {
  const project = await get<StoredProject>(id, projects);
  const file = project?.payload.fileGroups?.[groupId]?.find(({ name }) => name === path);
  return project && file ? fileVersions(project, fileKey(groupId, path), file.content) : [];
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

export function writeLocalProject(project: ProjectSave): Promise<void> {
  // Read and compare inside the same transaction as the write, so two tabs
  // starting from the same revision cannot both report a successful save.
  return update<StoredProject>(
    project.id,
    (previous) => {
      if ((previous?.revision ?? 0) !== project.revision - 1) throw new LocalProjectConflict();
      return {
        ...project,
        createdAt: previous ? withCreatedAt(previous).createdAt : project.updatedAt,
        fileSaveHistory: collectFileSaves(project, previous),
      };
    },
    projects,
  );
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
  return withCreatedAt(renamed!);
}
