// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveLocalWorkspace, useLocalWorkspace, watchLocalWorkspace } from '../lib/localWorkspace';
import { getDiskFileVersions, getLocalFileVersions, getLocalProject } from '../services/localProjects';
import { useEditorPreferences } from '../store/useEditorPreferences';
import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { BoardInstance } from '../types/board';

const { records } = vi.hoisted(() => ({ records: new Map<string, unknown>() }));

vi.mock('idb-keyval', () => ({
  createStore: (name: string) => name,
  get: async (id: string, store: string) => records.get(`${store}/${id}`),
  set: async (id: string, value: unknown, store: string) => records.set(`${store}/${id}`, value),
  update: async (id: string, change: (previous: unknown) => unknown, store: string) => {
    const key = `${store}/${id}`;
    records.set(key, change(records.get(key)));
  },
  entries: async () => [],
}));

let stopWatching: () => void;

beforeEach(() => {
  records.clear();
  useProjectStore.getState().clearCurrentProject();
  useEditorPreferences.getState().update({ autoSave: false });
  useEditorStore.setState(useEditorStore.getInitialState());
  const groupId = useEditorStore.getState().activeGroupId;
  const board = { id: 'uno', boardKind: 'arduino-uno', activeFileGroupId: groupId } as BoardInstance;
  useSimulatorStore.setState({ boards: [board], components: [], wires: [], activeBoardId: board.id });
  stopWatching = watchLocalWorkspace();
});

afterEach(() => {
  stopWatching();
  useEditorPreferences.getState().reset();
});

it('saves a rename to the current browser project when Auto Save is off', async () => {
  expect(await saveLocalWorkspace({ copyName: 'Workspace' })).toBe(true);
  const projectId = useLocalWorkspace.getState().browserId!;
  const editor = useEditorStore.getState();
  const original = editor.files[0];
  editor.setFileContent(original.id, 'Edited sketch');
  await vi.waitFor(() => expect(useLocalWorkspace.getState().status).toBe('dirty'));
  expect((await getLocalProject(projectId))?.revision).toBe(1);

  expect(editor.moveWorkspacePath(editor.activeGroupId, original.name, 'renamed.ino', false)).toBe(true);

  await vi.waitFor(async () => {
    const history = await getLocalFileVersions(projectId, editor.activeGroupId, 'renamed.ino', original.id);
    expect(history.map(({ rename, content }) => ({ rename, content }))).toEqual([
      { rename: { from: original.name, to: 'renamed.ino' }, content: 'Edited sketch' },
      { rename: undefined, content: 'Edited sketch' },
      { rename: undefined, content: original.content },
    ]);
    expect(useLocalWorkspace.getState().status).toBe('saved');
  });
});

it('saves the files in a renamed folder to the current disk project', async () => {
  let content = '';
  let modifiedAt = 100;
  const disk = {
    name: 'workspace.vlx',
    getFile: async () => new File([content], 'workspace.vlx', { lastModified: modifiedAt }),
    queryPermission: async () => 'granted' as const,
    createWritable: async () => ({
      write: async (value: string) => { content = value; },
      close: async () => { modifiedAt++; },
    }),
  } as unknown as NonNullable<NonNullable<Parameters<typeof saveLocalWorkspace>[0]>['disk']>;
  const editor = useEditorStore.getState();
  const id = editor.createFile('src/driver.h');
  expect(await saveLocalWorkspace({ disk })).toBe(true);
  const projectId = useLocalWorkspace.getState().diskHistoryId!;

  expect(editor.moveWorkspacePath(editor.activeGroupId, 'src', 'include', true)).toBe(true);

  await vi.waitFor(async () => {
    const versions = await getDiskFileVersions(projectId, editor.activeGroupId, 'include/driver.h', id);
    expect(versions[0]?.rename).toEqual({ from: 'src/driver.h', to: 'include/driver.h' });
    expect(versions).toHaveLength(2);
    expect(JSON.parse(content).fileGroups[editor.activeGroupId]).toContainEqual({
      id, name: 'include/driver.h', content: '',
    });
    expect(useLocalWorkspace.getState().status).toBe('saved');
  });
});

it('leaves the first save of an untitled project to the user', async () => {
  const editor = useEditorStore.getState();
  editor.renameFile(editor.files[0].id, 'new.ino');
  await Promise.resolve();

  expect(useLocalWorkspace.getState().browserId).toBeNull();
  expect(records.size).toBe(0);
});
