import Editor from '@monaco-editor/react';
import { useEditorStore } from '../../store/useEditorStore';

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (['ino', 'cpp', 'c', 'cc', 'h', 'hpp'].includes(ext)) return 'cpp';
  if (ext === 'py') return 'python';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  return 'plaintext';
}

export const CodeEditor = () => {
  const { files, activeFileId, activeGroupId, fileGroups, setFileContent, theme, fontSize } = useEditorStore();

  // Ensure we always get the file from the current file group to avoid stale content
  const currentGroupFiles = fileGroups[activeGroupId] ?? files;
  const activeFile = currentGroupFiles.find((f) => f.id === activeFileId) ?? files.find((f) => f.id === activeFileId);

  // Debug: Log file being edited
  console.log('[CodeEditor] Editing file:', activeFileId, 'in group:', activeGroupId, 'content length:', activeFile?.content?.length ?? 0);

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <Editor
        // key forces a fresh editor instance per file (preserves undo/redo per file)
        key={activeFileId}
        height="100%"
        language={activeFile ? getLanguage(activeFile.name) : 'cpp'}
        theme={theme}
        value={activeFile?.content ?? ''}
        onChange={(value) => {
          if (activeFileId) setFileContent(activeFileId, value || '');
        }}
        options={{
          minimap: { enabled: true },
          fontSize,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
        }}
      />
    </div>
  );
};
