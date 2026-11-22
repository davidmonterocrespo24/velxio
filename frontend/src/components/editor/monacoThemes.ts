/* Monaco themes wired to the app's workbench ramp.
 *
 * Monaco paints into a canvas-backed DOM of its own and cannot read CSS
 * custom properties, so the two themes below restate the ramp as literals.
 * They are the ONLY place in the app allowed to do that; if
 * tokens/colors.css moves a --wb-* value, move it here too or the editor
 * will sit a shade off the panel around it.
 *
 * `velxio-dark` is built on vs-dark and keeps its token colors — the dark
 * editor is unchanged from before the theme switch existed. `velxio-light`
 * is built on vs (Light+) for the same reason: readers know those syntax
 * colors from VS Code and the Arduino IDE.
 */
import type { Monaco } from '@monaco-editor/react';
import { useActiveWorkspaceTheme, useResolvedTheme } from '../../hooks/useTheme';
import { getActiveWorkspaceTheme, subscribeTheme } from '../../lib/theme';
import { readableEditorColors, type WorkspaceTheme } from '../../lib/workspaceTheme';

export const MONACO_DARK = 'velxio-dark';
export const MONACO_LIGHT = 'velxio-light';
const MONACO_CUSTOM = 'velxio-custom';

/** Editor chrome per theme. Mirrors --wb-* in tokens/colors.css. */
const DARK = {
  bg: '#1e1e1e', // --wb-2
  gutter: '#1e1e1e',
  lineNumber: '#6e6e6e', // --wb-9
  lineNumberActive: '#cccccc', // --wb-12
  indentGuide: '#3d3d3d', // --wb-7
  currentLine: '#282828',
  selection: '#264f78',
  widgetBg: '#252526', // --wb-3
  widgetBorder: '#454545',
  widgetSelection: '#34475e',
  scrollShadow: '#000000',
};

const LIGHT = {
  bg: '#ffffff', // --wb-2 (light)
  gutter: '#ffffff',
  lineNumber: '#8c949e', // --wb-9 (light)
  lineNumberActive: '#24292f', // --wb-12 (light)
  indentGuide: '#d0d0d6', // --wb-7 (light)
  currentLine: '#f3f6fa',
  selection: '#add6ff',
  widgetBg: '#f3f3f4', // --wb-3 (light)
  widgetBorder: '#d0d0d6',
  widgetSelection: '#dceafa',
  scrollShadow: '#dddddd',
};

function colors(c: typeof DARK): Record<string, string> {
  return {
    'editor.background': c.bg,
    'editorGutter.background': c.gutter,
    'editorLineNumber.foreground': c.lineNumber,
    'editorLineNumber.activeForeground': c.lineNumberActive,
    'editorIndentGuide.background1': c.indentGuide,
    'editor.lineHighlightBackground': c.currentLine,
    'editor.selectionBackground': c.selection,
    // The hover, suggestion, and signature popups use the editor's chrome.
    'editorWidget.background': c.widgetBg,
    'editorWidget.border': c.widgetBorder,
    'editorSuggestWidget.background': c.widgetBg,
    'editorSuggestWidget.border': c.widgetBorder,
    'editorSuggestWidget.selectedBackground': c.widgetSelection,
    'editorHoverWidget.background': c.widgetBg,
    'editorHoverWidget.border': c.widgetBorder,
    'input.background': c.bg,
    'dropdown.background': c.widgetBg,
    'scrollbar.shadow': c.scrollShadow,
    'minimap.background': c.bg,
  };
}

/** Register both themes on a monaco instance. Idempotent per instance —
 *  CodeEditor remounts per file (the `key` prop) and would otherwise
 *  redefine these on every tab switch. */
export function defineVelxioThemes(monaco: Monaco): void {
  const g = monaco as unknown as { __velxioThemes?: boolean };
  if (g.__velxioThemes) return;
  g.__velxioThemes = true;

  monaco.editor.defineTheme(MONACO_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: colors(DARK),
  });

  monaco.editor.defineTheme(MONACO_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: colors(LIGHT),
  });

  let registered: WorkspaceTheme | null = null;
  const registerCustom = () => {
    const theme = getActiveWorkspaceTheme();
    if (!theme || theme === registered) return;
    registered = theme;
    const palette = theme.base === 'light' ? LIGHT : DARK;
    monaco.editor.defineTheme(MONACO_CUSTOM, {
      base: theme.base === 'light' ? 'vs' : 'vs-dark',
      inherit: true,
      rules: theme.monaco.rules,
      colors: { ...colors(palette), ...readableEditorColors(theme, palette.bg) },
    });
  };
  registerCustom();
  subscribeTheme(registerCustom);
}

export function monacoThemeFor(resolved: 'dark' | 'light'): string {
  return resolved === 'light' ? MONACO_LIGHT : MONACO_DARK;
}

export function useMonacoTheme(): string {
  const resolved = useResolvedTheme();
  return useActiveWorkspaceTheme() ? MONACO_CUSTOM : monacoThemeFor(resolved);
}
