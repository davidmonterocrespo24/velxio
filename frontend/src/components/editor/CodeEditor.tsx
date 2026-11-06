import Editor, { type Monaco } from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { registerRetroAsm, LANGUAGE_ID as RETRO_ASM_ID } from './retroAsmLanguage';
import { attachIntellisenseMonaco } from '../../lib/intellisenseRegistry';
import { CHIP_JSON_SCHEMA, CHIP_JSON_SCHEMA_URI } from './chipJsonSchema';
import { defineVelxioThemes, monacoThemeFor } from './monacoThemes';
import { useResolvedTheme } from '../../hooks/useTheme';
import { registerEditorCommand } from '../../lib/editorCommands';
import {
  hasDocumentFormatter,
  registerCodeFormatters,
  setFormatterMessages,
} from './codeFormatters';

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 's' || ext === 'asm') return RETRO_ASM_ID;
  if (['ino', 'cpp', 'c', 'cc', 'h', 'hpp'].includes(ext)) return 'cpp';
  if (ext === 'py') return 'python';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  // Web files (a page served by an ESP32 sketch, an extension's scene page):
  // Monaco ships these languages, they only needed naming.
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs') return 'javascript';
  if (ext === 'hex') return 'plaintext';
  return 'plaintext';
}

export const CodeEditor = () => {
  const { files, activeFileId, setFileContent, fontSize, manifestViewBoardId } =
    useEditorStore();
  const boards = useSimulatorStore((s) => s.boards);
  // App-wide light/dark, not an editor-only setting: the editor sits flush
  // against the canvas and the panels, so it follows the same switch.
  const theme = monacoThemeFor(useResolvedTheme());
  const activeFile = files.find((f) => f.id === activeFileId);
  const language = activeFile ? getLanguage(activeFile.name) : 'cpp';
  const { t } = useTranslation();

  // The live editor instance, so the Edit menu's "Format document" can drive
  // Monaco's own format action (the same one the right-click menu and
  // Shift+Alt+F run). Re-set on every file switch: the editor is keyed by
  // file id, so each file is a fresh instance and the old one is disposed.
  const [instance, setInstance] = useState<MonacoEditor.IStandaloneCodeEditor | null>(null);
  useEffect(() => {
    // The read-only libraries.json view swaps the editor out without going
    // through onMount, so the last file's instance would otherwise linger.
    if (!instance || manifestViewBoardId || !hasDocumentFormatter(language)) return;
    return registerEditorCommand('edit.formatDocument', () => {
      if (!instance.getModel()) return; // disposed mid-switch
      instance.focus();
      void instance.getAction('editor.action.formatDocument')?.run();
    });
  }, [instance, language, manifestViewBoardId]);
  useEffect(() => {
    setFormatterMessages({
      failedTitle: () => t('editor.format.failed', 'Could not format the file'),
    });
  }, [t]);

  // READ-ONLY libraries.json view (the file explorer's libraries.json entry).
  // Shows the active board's declared library manifest as plain-text JSON, live.
  // It is read-only on purpose: adding/removing libraries is done from the
  // Library Manager modal, which edits board.libraries (this just reflects it).
  if (manifestViewBoardId) {
    const b = boards.find((x) => x.id === manifestViewBoardId);
    const content = JSON.stringify({ libraries: b?.libraries ?? [] }, null, 2);
    return (
      <div style={{ height: '100%', width: '100%' }}>
        <Editor
          key="__libraries_json__"
          height="100%"
          language="json"
          theme={theme}
          beforeMount={defineVelxioThemes}
          value={content}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            fontSize,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <Editor
        // key forces a fresh editor instance per file (preserves undo/redo per file)
        key={activeFileId}
        height="100%"
        language={language}
        theme={theme}
        value={activeFile?.content ?? ''}
        // A model path (unique per group+file) lets Monaco's JSON language
        // service match chip.json against the schema registered below. Only
        // set for chip manifests — other files keep the default in-memory
        // model so nothing else changes behaviour.
        {...(activeFile && activeFile.name.endsWith('chip.json')
          ? { path: `velxio-ws/${useEditorStore.getState().activeGroupId}/${activeFile.name}` }
          : {})}
        beforeMount={(monaco: Monaco) => {
          // Both velxio themes have to exist before Monaco is asked to use
          // one, or it silently falls back to stock vs-dark.
          defineVelxioThemes(monaco);
          // Register the 8080/Z80 assembly language once so Monaco knows how
          // to tokenize .s / .asm files when they're opened.
          registerRetroAsm(monaco);
          // "Format Document" for C/C++ and Python (idempotent per monaco
          // instance). Monaco adds the context-menu row and Shift+Alt+F by
          // itself once a provider exists.
          registerCodeFormatters(monaco);
          // Hand the monaco instance to the intellisense seam. Inert in OSS;
          // with the pro overlay loaded it registers the completion engine
          // (idempotent per monaco instance, so per-file remounts are fine).
          attachIntellisenseMonaco(monaco);
          // Validate chip.json manifests against the schema (idempotent per
          // monaco instance).
          const g = monaco as unknown as { __velxioChipJsonSchema?: boolean };
          if (!g.__velxioChipJsonSchema && monaco.languages.json?.jsonDefaults) {
            g.__velxioChipJsonSchema = true;
            monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
              validate: true,
              schemas: [
                {
                  uri: CHIP_JSON_SCHEMA_URI,
                  fileMatch: ['*chip.json'],
                  schema: CHIP_JSON_SCHEMA,
                },
              ],
            });
          }
        }}
        onMount={(ed) => setInstance(ed)}
        onChange={(value) => {
          if (activeFileId) setFileContent(activeFileId, value || '');
        }}
        options={{
          minimap: { enabled: true },
          fontSize,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          // Hover/suggest/signature widgets escape the editor's box as
          // position:fixed overlays. Without this, a marker hover wider
          // than the editor pane slides UNDER the simulator canvas next
          // to it (sibling stacking context) and can't be read.
          fixedOverflowWidgets: true,
          // Keep quick suggestions alive inside snippet placeholders:
          // completing `#include <|>` or an if-condition placeholder must
          // still offer suggestions while the snippet session is active.
          suggest: { snippetsPreventQuickSuggestions: false },
        }}
      />
    </div>
  );
};
