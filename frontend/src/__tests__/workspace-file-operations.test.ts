import { afterEach, describe, expect, it } from 'vitest';
import { useEditorStore } from '../store/useEditorStore';

afterEach(() => useEditorStore.setState(useEditorStore.getInitialState()));

describe('workspace file operations', () => {
  it('moves a nested folder with its open files and its empty subfolders', () => {
    const editor = useEditorStore.getState();
    const groupId = editor.activeGroupId;
    editor.createFolder('src/nested/empty');
    const fileId = editor.createFile('src/screen.cpp');
    editor.setFileContent(fileId, 'int width = 160;');

    expect(editor.moveWorkspacePath(groupId, 'src', 'firmware/display', true)).toBe(true);
    const moved = useEditorStore.getState();
    expect(moved.files.find((file) => file.id === fileId)).toMatchObject({
      name: 'firmware/display/screen.cpp',
      content: 'int width = 160;',
      modified: true,
    });
    expect(moved.folderGroups[groupId]).toContain('firmware/display/nested/empty');
    expect(moved.activeFileId).toBe(fileId);
    expect(moved.openFileIds).toContain(fileId);
  });

  it('rejects conflicting moves in an inactive group without changing either group', () => {
    const editor = useEditorStore.getState();
    const originalGroup = editor.activeGroupId;
    editor.createFile('src/screen.cpp');
    editor.createFile('drivers/screen.cpp');
    editor.createFile('readme.md');
    editor.createFileGroup('another-board', 'arduino');
    editor.setActiveGroup('another-board');
    const before = useEditorStore.getState();

    expect(editor.moveWorkspacePath(originalGroup, 'src', 'drivers', true)).toBe(false);
    expect(editor.moveWorkspacePath(originalGroup, 'src', 'src/subfolder', true)).toBe(false);
    expect(
      editor.moveWorkspacePath(originalGroup, 'src/screen.cpp', 'readme.md/nested.cpp', false),
    ).toBe(false);
    expect(useEditorStore.getState().fileGroups).toBe(before.fileGroups);
    expect(useEditorStore.getState().activeGroupId).toBe('another-board');
  });

  it('keeps edits made after a save started marked dirty', () => {
    const editor = useEditorStore.getState();
    const first = editor.createFile('first.h');
    const second = editor.createFile('second.h');
    editor.setFileContent(first, 'first');
    editor.setFileContent(second, 'second');
    const snapshot = useEditorStore.getState().fileGroups;
    editor.setFileContent(second, 'newer');

    editor.markWorkspaceFilesSaved(snapshot);
    const files = useEditorStore.getState().files;
    expect(files.find((file) => file.id === first)?.modified).toBe(false);
    expect(files.find((file) => file.id === second)).toMatchObject({
      modified: true,
      content: 'newer',
    });
  });
});
