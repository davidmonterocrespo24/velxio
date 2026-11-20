import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CaseSensitive,
  Check,
  FolderOpen,
  IndentIncrease,
  LayoutList,
  Palette,
  RotateCcw,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useActiveWorkspaceTheme, useThemeMode } from '../../hooks/useTheme';
import { isLocale, LOCALES, LOCALE_META } from '../../i18n/config';
import { getLocaleFromPath, switchLocale } from '../../i18n/path';
import { useEditorPreferences, type EditorPreferences, type Indentation } from '../../store/useEditorPreferences';
import { WorkspaceThemeSettings } from './WorkspaceThemeSettings';
import './EditorSettings.css';

type SettingsSection = 'appearance' | 'editor' | 'indentation' | 'files';

interface Setting {
  id: string;
  label: string;
  description?: string;
  field: ReactNode;
}

export function EditorSettings({ onClose, onIndentationChange }: {
  onClose: () => void;
  onIndentationChange?: (previous: EditorPreferences) => void;
}) {
  const { t } = useTranslation();
  const settings = useEditorPreferences();
  const [theme, setTheme] = useThemeMode();
  const customTheme = useActiveWorkspaceTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const locale = getLocaleFromPath(location.pathname);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SettingsSection | 'all'>('all');
  const [language, setLanguage] = useState<'default' | 'cpp' | 'python'>('default');
  const [fontSizeInput, setFontSizeInput] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const settingsBody = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    searchInput.current?.focus();
    return () => element?.close();
  }, []);

  const indent =
    language === 'default'
      ? settings.indentation
      : (settings.languageIndentation[language] ?? settings.indentation);

  const setIndent = (value: Indentation) => {
    const previous = useEditorPreferences.getState();
    if (language === 'default') settings.update({ indentation: value });
    else
      settings.update({
        languageIndentation: { ...settings.languageIndentation, [language]: value },
      });
    onIndentationChange?.(previous);
  };

  const themeChoices = [
    { value: 'dark', label: t('editor.menu.themeDark', 'Dark') },
    { value: 'light', label: t('editor.menu.themeLight', 'Light') },
    { value: 'system', label: t('editor.menu.themeSystem', 'Match system') },
  ] as const;

  const sections: { id: SettingsSection; label: string; icon: typeof Palette; rows: Setting[] }[] =
    [
      {
        id: 'appearance',
        label: t('editor.settings.appearanceSection', 'Appearance'),
        icon: Palette,
        rows: [
          {
            id: 'theme',
            label: t('editor.settings.theme', 'Theme'),
            description: t(
              'editor.settings.themeHelp',
              'Choose the colors used across the workspace.',
            ),
            field: (
              <div
                className="editor-settings-themes"
                role="radiogroup"
                aria-labelledby="setting-theme-label"
              >
                {themeChoices.map(({ value, label }) => (
                  <label className="editor-settings-theme" key={value}>
                    <input
                      type="radio"
                      name="editor-theme"
                      checked={!customTheme && theme === value}
                      onChange={() => setTheme(value)}
                    />
                    <span
                      className={`editor-settings-theme-preview editor-settings-theme-preview--${value}`}
                      aria-hidden
                    >
                      <span />
                    </span>
                    <span className="editor-settings-theme-label">
                      {label}
                      {!customTheme && theme === value && <Check size={13} aria-hidden />}
                    </span>
                  </label>
                ))}
              </div>
            ),
          },
          {
            id: 'custom-theme',
            label: t('editor.settings.customTheme', 'Custom theme'),
            description: t(
              'editor.settings.customThemeHelp',
              'Import a Velxio or VS Code color theme. Missing colors use the corresponding built-in light or dark theme.',
            ),
            field: <WorkspaceThemeSettings />,
          },
          {
            id: 'interface-language',
            label: t('editor.settings.interfaceLanguage', 'Interface language'),
            field: (
              <select
                id="setting-interface-language"
                value={locale}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!isLocale(next) || next === locale) return;
                  navigate(switchLocale(location.pathname, next) + location.search + location.hash);
                }}
              >
                {LOCALES.map((option) => (
                  <option key={option} value={option}>
                    {LOCALE_META[option].nativeName}
                  </option>
                ))}
              </select>
            ),
          },
        ],
      },
      {
        id: 'editor',
        label: t('editor.settings.editorSection', 'Code editor'),
        icon: CaseSensitive,
        rows: [
          {
            id: 'font-size',
            label: t('editor.settings.fontSize', 'Font size'),
            description: t(
              'editor.settings.fontSizeHelp',
              'Set the code editor text size in pixels (10–30).',
            ),
            field: (
              <input
                id="setting-font-size"
                type="number"
                min={10}
                max={30}
                value={fontSizeInput ?? settings.fontSize}
                onBlur={() => setFontSizeInput(null)}
                onChange={(event) => {
                  setFontSizeInput(event.target.value);
                  const size = event.target.valueAsNumber;
                  if (Number.isInteger(size) && size >= 10 && size <= 30)
                    settings.update({ fontSize: size });
                }}
              />
            ),
          },
          {
            id: 'word-wrap',
            label: t('editor.settings.wordWrap', 'Word wrap'),
            description: t(
              'editor.settings.wordWrapHelp',
              'Wrap long lines to fit the editor width.',
            ),
            field: (
              <input
                id="setting-word-wrap"
                type="checkbox"
                role="switch"
                checked={settings.wordWrap}
                onChange={(event) => settings.update({ wordWrap: event.target.checked })}
              />
            ),
          },
          {
            id: 'minimap',
            label: t('editor.settings.minimap', 'Minimap'),
            description: t(
              'editor.settings.minimapHelp',
              'Show a small overview of the file beside the code.',
            ),
            field: (
              <input
                id="setting-minimap"
                type="checkbox"
                role="switch"
                checked={settings.minimap}
                onChange={(event) => settings.update({ minimap: event.target.checked })}
              />
            ),
          },
        ],
      },
      {
        id: 'indentation',
        label: t('editor.settings.indentation', 'Indentation'),
        icon: IndentIncrease,
        rows: [
          {
            id: 'detect-indentation',
            label: t('editor.settings.detectIndentation', 'Detect indentation'),
            description: t(
              'editor.settings.detectIndentationHelp',
              'Use the indentation found in the file when possible.',
            ),
            field: (
              <input
                id="setting-detect-indentation"
                type="checkbox"
                role="switch"
                checked={settings.detectIndentation}
                onChange={(event) => settings.update({ detectIndentation: event.target.checked })}
              />
            ),
          },
          {
            id: 'indent-language',
            label: t('editor.settings.language', 'Language'),
            description: t(
              'editor.settings.indentLanguageHelp',
              'Edit the defaults or set an override for a language.',
            ),
            field: (
              <select
                id="setting-indent-language"
                value={language}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'default' || value === 'cpp' || value === 'python')
                    setLanguage(value);
                }}
              >
                <option value="default">
                  {t('editor.settings.allLanguages', 'All languages')}
                </option>
                <option value="cpp">C/C++</option>
                <option value="python">Python</option>
              </select>
            ),
          },
          {
            id: 'indent-style',
            label: t('editor.settings.indentStyle', 'Indent style'),
            description: t('editor.settings.indentStyleHelp', 'Applies to existing indentation in the active file when this setting matches its language.'),
            field: (
              <select
                id="setting-indent-style"
                value={indent.insertSpaces ? 'spaces' : 'tabs'}
                onChange={(event) =>
                  setIndent({ ...indent, insertSpaces: event.target.value === 'spaces' })
                }
              >
                <option value="spaces">{t('editor.settings.spaces', 'Spaces')}</option>
                <option value="tabs">{t('editor.settings.tabs', 'Tabs')}</option>
              </select>
            ),
          },
          {
            id: 'tab-width',
            label: t('editor.settings.tabWidth', 'Tab width'),
            field: (
              <select
                id="setting-tab-width"
                value={indent.tabSize}
                onChange={(event) => setIndent({ ...indent, tabSize: Number(event.target.value) })}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8].map((size) => (
                  <option key={size}>{size}</option>
                ))}
              </select>
            ),
          },
        ],
      },
      {
        id: 'files',
        label: t('editor.settings.filesSection', 'Files'),
        icon: FolderOpen,
        rows: [
          {
            id: 'autosave',
            label: t('editor.settings.autoSave', 'Local autosave'),
            description: t(
              'editor.settings.autoSaveHelp',
              'Save changes to the local project automatically.',
            ),
            field: (
              <input
                id="setting-autosave"
                type="checkbox"
                role="switch"
                checked={settings.autoSave}
                onChange={(event) => settings.update({ autoSave: event.target.checked })}
              />
            ),
          },
        ],
      },
    ];

  const searchLabel = t('editor.settings.search', 'Search settings');
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const visibleSections = sections
    .filter(({ id }) => category === 'all' || id === category)
    .map((section) => ({
      ...section,
      rows: section.rows.filter(({ label, description }) => {
        const keywords = `${section.label} ${label} ${description ?? ''}`.toLocaleLowerCase();
        return terms.every((term) => keywords.includes(term));
      }),
    }))
    .filter(({ rows }) => rows.length > 0);

  const selectCategory = (next: SettingsSection | 'all') => {
    setCategory(next);
    if (settingsBody.current) settingsBody.current.scrollTop = 0;
  };

  const clearSearch = () => {
    setQuery('');
    searchInput.current?.focus();
  };

  const closeSettings = () => {
    dialog.current?.close();
    onClose();
  };

  return (
    <dialog
      className="editor-settings-dialog"
      ref={dialog}
      aria-labelledby="editor-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        closeSettings();
      }}
      onClick={(event) => {
        if (event.currentTarget === event.target) closeSettings();
      }}
    >
      <div className="editor-settings-content">
        <header className="editor-settings-header">
          <div className="editor-settings-heading">
            <Settings size={18} aria-hidden />
            <h2 id="editor-settings-title">{t('editor.settings.title', 'Settings')}</h2>
            <button
              type="button"
              className="editor-settings-icon-button"
              onClick={closeSettings}
              aria-label={t('editor.settings.close', 'Close settings')}
            >
              <X size={17} aria-hidden />
            </button>
          </div>
          <div className="editor-settings-search">
            <Search size={16} aria-hidden />
            <input
              ref={searchInput}
              type="search"
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={query}
              onChange={(event) => {
                const next = event.target.value;
                if (!query.trim() && next.trim()) selectCategory('all');
                setQuery(next);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                closeSettings();
              }}
            />
            {query && (
              <button
                type="button"
                className="editor-settings-icon-button"
                onClick={clearSearch}
                aria-label={t('editor.settings.clearSearch', 'Clear settings search')}
              >
                <X size={14} aria-hidden />
              </button>
            )}
          </div>
        </header>
        <div className="editor-settings-layout">
          <nav
            className="editor-settings-nav"
            aria-label={t('editor.settings.categories', 'Settings categories')}
          >
            <button
              type="button"
              aria-pressed={category === 'all'}
              onClick={() => selectCategory('all')}
            >
              <LayoutList size={15} aria-hidden />
              {t('editor.settings.allSettings', 'All settings')}
            </button>
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                aria-pressed={category === id}
                onClick={() => selectCategory(id)}
              >
                <Icon size={15} aria-hidden />
                {label}
              </button>
            ))}
          </nav>
          <div className="editor-settings-body" ref={settingsBody}>
            {visibleSections.map(({ id, label, rows }) => (
              <section
                className="editor-settings-section"
                key={id}
                aria-labelledby={`settings-heading-${id}`}
              >
                <h3 id={`settings-heading-${id}`}>{label}</h3>
                <div className="editor-settings-card">
                  {rows.map((row) => (
                    <div
                      className={`editor-settings-row${['theme', 'custom-theme'].includes(row.id) ? ' editor-settings-row--stacked' : ''}`}
                      key={row.id}
                    >
                      <div className="editor-settings-row-copy">
                        {row.id === 'theme' ? (
                          <span id="setting-theme-label">{row.label}</span>
                        ) : (
                          <label htmlFor={`setting-${row.id}`}>{row.label}</label>
                        )}
                        {row.description && <p>{row.description}</p>}
                      </div>
                      {row.field}
                    </div>
                  ))}
                  {id === 'indentation' &&
                    language !== 'default' &&
                    settings.languageIndentation[language] && (
                      <div className="editor-settings-card-action">
                        <button
                          type="button"
                          className="editor-settings-button"
                          onClick={() => {
                            const overrides = { ...settings.languageIndentation };
                            delete overrides[language];
                            settings.update({ languageIndentation: overrides });
                          }}
                        >
                          {t('editor.settings.useDefaults', 'Use editor defaults')}
                        </button>
                      </div>
                    )}
                </div>
              </section>
            ))}
            {visibleSections.length === 0 && (
              <div className="editor-settings-empty" role="status">
                <Search size={22} aria-hidden />
                <p>{t('editor.settings.noResults', 'No matching settings.')}</p>
              </div>
            )}
          </div>
        </div>
        <footer className="editor-settings-footer">
          <button
            type="button"
            className="editor-settings-button"
            onClick={() => {
              settings.reset();
              setTheme('dark');
            }}
          >
            <RotateCcw size={13} aria-hidden />
            {t('editor.settings.reset', 'Reset settings')}
          </button>
          <button
            type="button"
            className="editor-settings-button editor-settings-done"
            onClick={closeSettings}
          >
            {t('editor.settings.done', 'Done')}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
