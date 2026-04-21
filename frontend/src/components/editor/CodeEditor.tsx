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
  const { files, activeFileId, setFileContent, theme, fontSize } = useEditorStore();
  const activeFile = files.find((f) => f.id === activeFileId);

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
