import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLocalProject,
  getLocalFileVersions,
  listLocalProjects,
  LocalProjectConflict,
  renameLocalProject,
  writeLocalProject,
} from '../services/localProjects';
import type { VlxPayload } from '../utils/vlxFile';

const { records } = vi.hoisted(() => ({ records: new Map<string, unknown>() }));

vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  entries: async () => [...records.entries()],
  get: async (id: string) => records.get(id),
  update: async (id: string, change: (value: unknown) => unknown) => {
    records.set(id, change(records.get(id)));
  },
}));

function project(id: string, name: string, revision: number, updatedAt: number) {
  return { id, name, revision, updatedAt, payload: { name, boards: [] } as unknown as VlxPayload };
}

beforeEach(() => records.clear());

describe('browser project metadata', () => {
  it('records only saves that changed the selected file and keeps the legacy save date', async () => {
    const original = project('id', 'Workspace', 1, 100);
    original.payload.fileGroups = {
      board: [{ name: 'src/main.ino', content: 'original' }, { name: 'config.h', content: 'unchanged' }],
    };
    records.set('id', original);
    await writeLocalProject({
      ...original,
      revision: 2,
      updatedAt: 200,
      payload: {
        ...original.payload,
        fileGroups: { board: [{ name: 'src/main.ino', content: 'edited' }, original.payload.fileGroups.board[1]] },
      },
    });
    const saved = await getLocalProject('id');
    expect(saved).toBeDefined();
    await writeLocalProject({ ...saved!, revision: 3, updatedAt: 300 });
    expect(await getLocalFileVersions('id', 'board', 'src/main.ino')).toEqual([
      { savedAt: 200, content: 'edited' }, { savedAt: 100, content: 'original' },
    ]);
    expect(await getLocalFileVersions('id', 'board', 'config.h')).toEqual([
      { savedAt: 100, content: 'unchanged' },
    ]);
    expect(await getLocalFileVersions('id', 'other', 'config.h')).toEqual([]);
  });

  it('keeps only recoverable legacy saves and stores the complete contents of new versions', async () => {
    const original = project('id', 'Workspace', 3, 300);
    original.payload.fileGroups = { board: [{ name: 'main.ino', content: '' }] };
    records.set('id', { ...original, fileSaveHistory: { '["board","main.ino"]': [200, 100] } });
    expect(await getLocalFileVersions('id', 'board', 'main.ino')).toEqual([
      { savedAt: 200, content: '' },
    ]);

    await writeLocalProject({
      ...original, revision: 4, updatedAt: 400,
      payload: { ...original.payload, fileGroups: { board: [{ name: 'main.ino', content: 'saved now' }] } },
    });
    const versions = [{ savedAt: 400, content: 'saved now' }, { savedAt: 200, content: '' }];
    expect(await getLocalFileVersions('id', 'board', 'main.ino')).toEqual(versions);
    expect(records.get('id')).toMatchObject({ fileSaveHistory: { '["board","main.ino"]': versions } });
  });

  it('lists older cached projects by their last save and keeps their IDs', async () => {
    records.set('older-id', project('older-id', 'Original workspace', 3, 100));
    await writeLocalProject(project('other-id', 'Another workspace', 1, 200));

    expect(await listLocalProjects()).toEqual([
      { id: 'other-id', name: 'Another workspace', revision: 1, createdAt: 200, updatedAt: 200 },
      { id: 'older-id', name: 'Original workspace', revision: 3, createdAt: 100, updatedAt: 100 },
    ]);
    expect(await getLocalProject('missing-id')).toBeUndefined();

    await writeLocalProject(project('older-id', 'Original workspace', 4, 300));
    expect(await getLocalProject('older-id')).toMatchObject({ createdAt: 100, updatedAt: 300 });
  });

  it('renames an existing record without replacing its saved contents or UID', async () => {
    await writeLocalProject(project('id', 'Before', 1, 100));
    const renamed = await renameLocalProject('id', 1, 'After');

    expect(renamed).toMatchObject({
      id: 'id',
      name: 'After',
      revision: 2,
      createdAt: 100,
      payload: { name: 'After', boards: [] },
    });
    await expect(writeLocalProject(project('id', 'Before', 2, 200))).rejects.toBeInstanceOf(
      LocalProjectConflict,
    );
    expect((await getLocalProject('id'))?.name).toBe('After');
    await expect(renameLocalProject('missing', 1, 'Unknown')).rejects.toBeInstanceOf(
      LocalProjectConflict,
    );
  });
});
