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

  it('cuts a file into a folder with its original ID and copies it with a new ID', () => {
    const editor = useEditorStore.getState();
    const groupId = editor.activeGroupId;
    const fileId = editor.createFile('driver.h');
    editor.setFileContent(fileId, '#pragma once');
    editor.createFolder('include');
    const source = { groupId, path: 'driver.h', folder: false, fileId };

    expect(editor.pasteWorkspacePath(source, groupId, 'include', false)).toBe(true);
    expect(editor.pasteWorkspacePath(source, groupId, 'include', true)).toBe(true);
    const files = useEditorStore.getState().files;
    expect(files.find((file) => file.id === fileId)?.name).toBe('include/driver.h');
    const copy = files.find((file) => file.name === 'include/driver copy.h');
    expect(copy).toMatchObject({ content: '#pragma once', modified: true });
    expect(copy?.id).not.toBe(fileId);
  });

  it('moves a folder across boards atomically and keeps its empty subfolders', () => {
    const editor = useEditorStore.getState();
    const groupId = editor.activeGroupId;
    const target = 'another-board';
    editor.createFileGroup(target, 'arduino');
    editor.createFolder('src/empty');
    const fileId = editor.createFile('src/driver.h');
    editor.setFileContent(fileId, '#pragma once');
    const source = { groupId, path: 'src', folder: true };

    expect(editor.pasteWorkspacePath(source, groupId, 'src/empty', false)).toBe(false);
    expect(editor.pasteWorkspacePath(source, target, '', false)).toBe(true);
    const state = useEditorStore.getState();
    expect(state.fileGroups[target]).toContainEqual({
      id: fileId, name: 'src/driver.h', content: '#pragma once', modified: true,
    });
    expect(state.folderGroups[target]).toContain('src/empty');
    expect(state.openFileIds).not.toContain(fileId);
    expect(state.files).toBe(state.fileGroups[groupId]);
    expect(state.activeFileId).not.toBe(fileId);
  });

  it('keeps the source intact when a cut would overwrite a file or empty its board', () => {
    const editor = useEditorStore.getState();
    const groupId = editor.activeGroupId;
    const target = 'another-board';
    editor.createFileGroup(target, [{ name: 'driver.h', content: 'target content' }]);
    const [main] = editor.getGroupFiles(groupId);
    const beforeLastFile = useEditorStore.getState().fileGroups;
    expect(editor.pasteWorkspacePath({ groupId, path: main.name, folder: false, fileId: main.id }, target, '', false)).toBe(false);
    expect(useEditorStore.getState().fileGroups).toBe(beforeLastFile);

    const fileId = editor.createFile('driver.h');
    const beforeConflict = useEditorStore.getState().fileGroups;
    expect(editor.pasteWorkspacePath({ groupId, path: 'driver.h', folder: false, fileId }, target, '', false)).toBe(false);
    expect(useEditorStore.getState().fileGroups).toBe(beforeConflict);
  });
});
