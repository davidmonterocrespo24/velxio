import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useActiveWorkspaceTheme, useWorkspaceThemes } from '../../hooks/useTheme';
import { applyWorkspaceTheme, previewWorkspaceTheme, resetWorkspaceTheme } from '../../lib/theme';
import {
  importWorkspaceTheme,
  readableEditorColors,
  type WorkspaceTheme,
} from '../../lib/workspaceTheme';
import { DropdownSelect } from '../ui/DropdownSelect';

function downloadTheme(theme: WorkspaceTheme): void {
  const json = new Blob([JSON.stringify(theme, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(json);
  const link = document.createElement('a');
  link.href = url;
  link.download =
    (theme.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '') || 'velxio') +
    '.velxio-theme.json';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WorkspaceThemeSettings() {
  const { t } = useTranslation();
  const { themes, active } = useWorkspaceThemes();
  const live = useActiveWorkspaceTheme();
  const [draft, setDraft] = useState<WorkspaceTheme | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);

  useEffect(
    () => () => {
      importRequest.current += 1;
      previewWorkspaceTheme(null);
    },
    [],
  );

  const current = choice ?? (active ? 'saved:' + active : '');
  const selected =
    current === 'draft' ? draft : themes.find((theme) => 'saved:' + theme.name === current);
  const applied = themes.find((theme) => theme.name === active);
  const isPreviewing = Boolean(live && live === selected && live !== applied);

  const importFile = async (file: File) => {
    const request = ++importRequest.current;
    setError('');
    try {
      const theme =
        file.size <= 2_000_000 ? importWorkspaceTheme(await file.text(), file.name) : null;
      if (request !== importRequest.current) return;
      if (theme) {
        previewWorkspaceTheme(null);
        setDraft(theme);
        setChoice('draft');
        return;
      }
    } catch {
      if (request !== importRequest.current) return;
    }
    setError(
      t(
        'editor.settings.themeImportError',
        'Choose a Velxio theme or a VS Code color-theme JSON file with supported colors.',
      ),
    );
  };

  const baseBackground = selected?.base === 'light' ? '#ffffff' : '#1e1e1e';
  const sample = selected ? readableEditorColors(selected, baseBackground) : {};
  const sampleText =
    sample['editor.foreground'] ?? (selected?.base === 'light' ? '#000000' : '#d4d4d4');

  return (
    <div className="editor-settings-custom-theme">
      <div className="editor-settings-theme-actions">
        <DropdownSelect
          id="setting-custom-theme"
          value={selected ? current : ''}
          onValueChange={(value) => {
            previewWorkspaceTheme(null);
            setChoice(value);
          }}
        >
          <option value="">{t('editor.settings.chooseCustomTheme', 'Choose a custom theme')}</option>
          {draft && <option value="draft">{t('editor.settings.importedTheme', '{{name}} (imported)', { name: draft.name })}</option>}
          {themes.map((theme) => <option key={theme.name} value={'saved:' + theme.name}>{theme.name}</option>)}
        </DropdownSelect>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.jsonc,.code-theme"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importFile(file);
          }}
        />
        <button
          type="button"
          className="editor-settings-button"
          onClick={() => fileInput.current?.click()}
        >
          {t('editor.settings.importTheme', 'Import theme')}
        </button>
      </div>
      <p className="editor-settings-theme-import-help">
        <Trans
          t={t}
          i18nKey="editor.settings.vscodeThemeLocation"
          defaults="On Windows, open <path>{{extensions}}</path> in File Explorer. Open the theme’s extension folder and import its theme JSON file, such as <path>{{themeFile}}</path>."
          components={{ path: <code dir="ltr" /> }}
          values={{
            extensions: '%USERPROFILE%\\.vscode\\extensions',
            themeFile: 'themes\\my-theme-color-theme.json',
          }}
        />
      </p>
      {selected && (
        <pre
          className="editor-settings-theme-sample"
          dir="ltr"
          style={{ background: sample['editor.background'] ?? baseBackground, color: sampleText }}
          aria-label={t('editor.settings.themeSample', 'Editor color sample')}
        >
          <span style={{ color: syntaxColor(selected, 'keyword') }}>void</span>
          {' setup() {\n  Serial.println('}
          <span style={{ color: syntaxColor(selected, 'string') }}>"Hello"</span>
          {');\n}'}
        </pre>
      )}
      <div className="editor-settings-theme-actions">
        <button
          type="button"
          className="editor-settings-button"
          disabled={!selected || selected === applied}
          onClick={() => previewWorkspaceTheme(isPreviewing ? null : (selected ?? null))}
        >
          {isPreviewing
            ? t('editor.settings.cancelThemePreview', 'Cancel preview')
            : t('editor.settings.previewTheme', 'Preview')}
        </button>
        <button
          type="button"
          className="editor-settings-button"
          disabled={!selected || selected === applied}
          onClick={() => {
            if (!selected) return;
            applyWorkspaceTheme(selected);
            setDraft(null);
            setChoice(null);
          }}
        >
          {t('editor.settings.applyTheme', 'Apply')}
        </button>
        <button
          type="button"
          className="editor-settings-button"
          disabled={!selected}
          onClick={() => selected && downloadTheme(selected)}
        >
          {t('editor.settings.exportTheme', 'Export theme')}
        </button>
        <button
          type="button"
          className="editor-settings-button"
          disabled={!live}
          onClick={() => {
            resetWorkspaceTheme();
            setChoice(null);
          }}
        >
          {t('editor.settings.resetTheme', 'Reset theme')}
        </button>
      </div>
      {error && (
        <p className="editor-settings-theme-error" role="alert">
          {error}
        </p>
      )}
      {isPreviewing && (
        <span role="status">
          {t('editor.settings.themePreviewActive', 'Theme preview is active.')}
        </span>
      )}
    </div>
  );
}

function syntaxColor(theme: WorkspaceTheme, token: string): string | undefined {
  const foreground = theme.monaco.rules.find((rule) => rule.token === token)?.foreground;
  return foreground ? '#' + foreground : undefined;
}
