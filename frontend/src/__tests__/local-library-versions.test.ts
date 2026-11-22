import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveLocalWorkspace, upgradeWorkspaceLibraryVersions, useLocalWorkspace } from '../lib/localWorkspace';
import { getLocalProject } from '../services/localProjects';
import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { BoardInstance } from '../types/board';

const { records } = vi.hoisted(() => ({ records: new Map<string, unknown>() }));

vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: async (id: string) => records.get(id),
  update: async (id: string, change: (previous: unknown) => unknown) => {
    records.set(id, change(records.get(id)));
  },
  set: vi.fn(),
  entries: async () => [],
}));

const libraries = ['Servo', 'Wire@1.0.0', 'Custom Display@wokwi:hash', 'Unknown'];

beforeEach(() => {
  records.clear();
  useProjectStore.getState().clearCurrentProject();
  useEditorStore.setState(useEditorStore.getInitialState());
  const groupId = useEditorStore.getState().activeGroupId;
  const board = {
    id: 'uno', boardKind: 'arduino-uno', activeFileGroupId: groupId, libraries,
  } as BoardInstance;
  useSimulatorStore.setState({ boards: [board], components: [], wires: [], activeBoardId: board.id });
});

afterEach(() => vi.unstubAllGlobals());

function catalogResponse(name: string) {
  return Response.json({ libraries: name.includes('Servo')
    ? [{ name: 'Servo', latest: { version: '1.3.0' } }]
    : [{ name: 'Unknown Similar', latest: { version: '9.0.0' } }] });
}

it('persists metadata for an older project using only catalog reads', async () => {
  const fetchCatalog = vi.fn(async (input: string) => catalogResponse(decodeURIComponent(input)));
  vi.stubGlobal('fetch', fetchCatalog);
  expect(await saveLocalWorkspace({ copyName: 'Old workspace' })).toBe(true);
  const projectId = useLocalWorkspace.getState().browserId!;

  await upgradeWorkspaceLibraryVersions(new AbortController().signal);

  const expected = ['Servo@1.3.0', 'Wire@1.0.0', 'Custom Display@wokwi:hash', 'Unknown'];
  expect(useSimulatorStore.getState().boards[0].libraries).toEqual(expected);
  expect((await getLocalProject(projectId))?.payload.boards[0].libraries).toEqual(expected);
  expect(fetchCatalog.mock.calls.map(([url]) => decodeURIComponent(url).split('?q=')[1]))
    .toEqual(['name="Servo"', 'name="Unknown"']);
});

it('updates metadata in memory without saving edits made while the catalog was loading', async () => {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => { finish = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    await ready;
    return catalogResponse(decodeURIComponent(url));
  }));
  expect(await saveLocalWorkspace({ copyName: 'Old workspace' })).toBe(true);
  const projectId = useLocalWorkspace.getState().browserId!;
  const migration = upgradeWorkspaceLibraryVersions(new AbortController().signal);
  const editor = useEditorStore.getState();
  editor.setFileContent(editor.activeFileId, 'Unsaved sketch');
  finish();
  await migration;

  expect(useSimulatorStore.getState().boards[0].libraries?.[0]).toBe('Servo@1.3.0');
  const stored = await getLocalProject(projectId);
  expect(stored?.payload.boards[0].libraries).toEqual(libraries);
  expect(stored?.payload.fileGroups[editor.activeGroupId][0].content).not.toBe('Unsaved sketch');
});
