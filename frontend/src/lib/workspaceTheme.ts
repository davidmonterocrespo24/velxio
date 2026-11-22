import type { editor } from 'monaco-editor';

const uiTokens = {
  canvas: ['--wb-1', '--color-bg-canvas'],
  surface: ['--wb-2', '--color-bg-surface-1'],
  panel: ['--wb-3', '--color-bg-surface-2', '--color-bg-header'],
  input: ['--wb-4', '--color-bg-input'],
  popup: ['--wb-5', '--color-bg-surface-3'],
  border: ['--wb-6', '--wb-7', '--color-border-default', '--color-border-strong'],
  foreground: ['--wb-12', '--wb-13', '--color-fg-default'],
  muted: ['--wb-10', '--wb-11', '--color-fg-muted'],
  accent: ['--color-action-primary', '--color-accent-fg'],
  accentForeground: ['--color-action-primary-fg', '--color-fg-on-action'],
  selection: ['--color-accent-soft', '--color-wash-selected'],
  menuBackground: ['--workspace-menu-background'],
  menuForeground: ['--workspace-menu-foreground'],
  sidebarBackground: ['--workspace-sidebar-background'],
  sidebarForeground: ['--workspace-sidebar-foreground'],
  statusBackground: ['--workspace-status-background'],
  statusForeground: ['--workspace-status-foreground'],
  consoleBackground: ['--workspace-console-background'],
  consoleForeground: ['--workspace-console-foreground'],
  assistantBackground: ['--workspace-assistant-background'],
  assistantForeground: ['--workspace-assistant-foreground'],
  terminalBackground: ['--color-terminal-bg'],
  terminalForeground: ['--color-terminal-fg'],
} as const;

type UiColor = keyof typeof uiTokens;
type UiColors = Partial<Record<UiColor, string>>;
type MonacoRule = editor.ITokenThemeRule;

export interface WorkspaceTheme {
  format: 'velxio-theme';
  version: 1;
  name: string;
  base: 'dark' | 'light';
  ui: UiColors;
  monaco: { colors: Record<string, string>; rules: MonacoRule[] };
}

const vsCodeUi: Record<UiColor, readonly string[]> = {
  canvas: ['editor.background'],
  surface: ['editorWidget.background', 'editor.background'],
  panel: ['titleBar.activeBackground', 'activityBar.background', 'sideBar.background'],
  input: ['input.background'],
  popup: ['dropdown.background', 'quickInput.background', 'menu.background'],
  border: ['widget.border', 'panel.border', 'contrastBorder'],
  foreground: ['foreground', 'editor.foreground'],
  muted: ['descriptionForeground'],
  accent: ['button.background', 'focusBorder'],
  accentForeground: ['button.foreground'],
  selection: ['list.activeSelectionBackground'],
  menuBackground: ['menu.background'],
  menuForeground: ['menu.foreground'],
  sidebarBackground: ['sideBar.background'],
  sidebarForeground: ['sideBar.foreground'],
  statusBackground: ['statusBar.background', 'statusBar.noFolderBackground'],
  statusForeground: ['statusBar.foreground', 'statusBar.noFolderForeground'],
  consoleBackground: ['panel.background'],
  consoleForeground: ['terminal.foreground'],
  assistantBackground: ['chat.requestBackground', 'sideBar.background'],
  assistantForeground: ['sideBar.foreground'],
  terminalBackground: ['terminal.background'],
  terminalForeground: ['terminal.foreground'],
};

const vsCodeEditorColors = [
  'editor.background',
  'editor.foreground',
  'editorCursor.foreground',
  'editorGutter.background',
  'editorLineNumber.foreground',
  'editorLineNumber.activeForeground',
  'editorIndentGuide.background1',
  'editorIndentGuide.activeBackground1',
  'editor.lineHighlightBackground',
  'editor.selectionBackground',
  'editor.inactiveSelectionBackground',
  'editor.selectionHighlightBackground',
  'editor.findMatchBackground',
  'editor.findMatchHighlightBackground',
  'editorBracketMatch.background',
  'editorBracketMatch.border',
  'editorError.foreground',
  'editorWarning.foreground',
  'editorInfo.foreground',
  'editorWidget.background',
  'editorWidget.foreground',
  'editorWidget.border',
  'editorHoverWidget.background',
  'editorHoverWidget.foreground',
  'editorHoverWidget.border',
  'editorSuggestWidget.background',
  'editorSuggestWidget.foreground',
  'editorSuggestWidget.border',
  'editorSuggestWidget.selectedBackground',
  'editorSuggestWidget.highlightForeground',
  'input.background',
  'input.foreground',
  'input.border',
  'dropdown.background',
  'dropdown.foreground',
  'dropdown.border',
  'scrollbar.shadow',
  'scrollbarSlider.background',
  'scrollbarSlider.hoverBackground',
  'scrollbarSlider.activeBackground',
  'minimap.background',
] as const;

const simpleScopes = {
  comment: 'comment',
  string: 'string',
  keyword: 'keyword',
  'storage.type': 'type',
  'storage.modifier': 'keyword',
  'constant.numeric': 'number',
  'constant.language': 'constant',
  'entity.name.type': 'type',
  'entity.name.function': 'function',
  'variable.parameter': 'variable.parameter',
} as const;

const uiKeys = Object.keys(uiTokens) as UiColor[];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hex(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) {
    return undefined;
  }
  const digits = value.slice(1).toLowerCase();
  return '#' + (digits.length <= 4 ? digits.replace(/./g, '$&$&') : digits);
}

function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = parseInt(color.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function opaque(value: string | undefined): string | undefined {
  if (value?.length === 7) return value;
  if (value?.endsWith('ff')) return value.slice(0, 7);
  return undefined;
}

function readable(text: string, background: string): boolean {
  const first = luminance(text);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05) >= 4.5;
}

function syntaxRule(token: unknown, settings: Record<string, unknown>): MonacoRule | undefined {
  if (typeof token !== 'string' || !/^[\w.-]{1,120}$/.test(token)) return undefined;
  const foreground = opaque(hex(settings.foreground));
  const background = opaque(hex(settings.background));
  const style = typeof settings.fontStyle === 'string' ? settings.fontStyle.trim() : undefined;
  const fontStyle =
    style === '' ||
    style
      ?.split(/\s+/)
      .every((flag) => ['italic', 'bold', 'underline', 'strikethrough'].includes(flag))
      ? style
      : undefined;
  if (!foreground && !background && fontStyle === undefined) return undefined;
  return {
    token,
    ...(foreground && { foreground: foreground.slice(1) }),
    ...(background && { background: background.slice(1) }),
    ...(fontStyle !== undefined && { fontStyle }),
  };
}

function vsCodeRules(source: unknown): MonacoRule[] {
  const rules = new Map<string, MonacoRule>();
  if (!Array.isArray(source)) return [];
  for (const entry of source) {
    const { scope, settings } = record(entry);
    const scopes = Array.isArray(scope) ? scope : [scope];
    for (const group of scopes) {
      if (typeof group !== 'string') continue;
      for (const selector of group.split(',')) {
        const token = simpleScopes[selector.trim() as keyof typeof simpleScopes];
        const rule = syntaxRule(token, record(settings));
        if (rule) rules.set(rule.token, { ...rules.get(rule.token), ...rule });
      }
    }
  }
  return [...rules.values()];
}

function readColors(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const key of keys) {
    const color = hex(source[key]);
    if (color) colors[key] = color;
  }
  return colors;
}

function readNativeTheme(source: Record<string, unknown>): WorkspaceTheme | null {
  if (source.format !== 'velxio-theme' || source.version !== 1) return null;
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name || name.length > 100 || (source.base !== 'light' && source.base !== 'dark'))
    return null;
  const monaco = record(source.monaco);
  const rules = Array.isArray(monaco.rules)
    ? monaco.rules.slice(0, 2000).flatMap((value) => {
        const { token, foreground, background, fontStyle } = record(value);
        const rule = syntaxRule(token, {
          foreground:
            typeof foreground === 'string' ? '#' + foreground.replace(/^#/, '') : undefined,
          background:
            typeof background === 'string' ? '#' + background.replace(/^#/, '') : undefined,
          fontStyle,
        });
        return rule ? [rule] : [];
      })
    : [];
  return {
    format: 'velxio-theme',
    version: 1,
    name,
    base: source.base,
    ui: readColors(record(source.ui), uiKeys),
    monaco: { colors: readColors(record(monaco.colors), vsCodeEditorColors), rules },
  };
}

export function decodeWorkspaceTheme(source: unknown): WorkspaceTheme | null {
  return readNativeTheme(record(source));
}

export function importWorkspaceTheme(text: string, filename: string): WorkspaceTheme | null {
  // VS Code theme files may use JSON comments and trailing commas.
  const json = text
    .replace(/^\uFEFF/, '')
    .replace(/"(?:[^"\\]|\\[\s\S])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (token) =>
      token.startsWith('"') ? token : ' ',
    )
    .replace(/"(?:[^"\\]|\\[\s\S])*"|,(?=\s*[}\]])/g, (token) => (token === ',' ? '' : token));

  let source: Record<string, unknown>;
  try {
    source = record(JSON.parse(json));
  } catch {
    return null;
  }
  if ('format' in source) return readNativeTheme(source);

  const name =
    (typeof source.name === 'string' ? source.name.trim() : '') ||
    filename.replace(/(?:-color-theme)?\.(?:jsonc?|code-theme)$/i, '').trim() ||
    'Imported theme';
  const colors = record(source.colors);
  const ui: UiColors = {};
  for (const key of uiKeys) {
    for (const vsCodeKey of vsCodeUi[key]) {
      const color = hex(colors[vsCodeKey]);
      if (!color) continue;
      ui[key] = color;
      break;
    }
  }
  const monaco = {
    colors: readColors(colors, vsCodeEditorColors),
    rules: vsCodeRules(source.tokenColors),
  };
  if (!Object.keys(ui).length && !Object.keys(monaco.colors).length && !monaco.rules.length)
    return null;

  const background = monaco.colors['editor.background'] ?? ui.surface ?? ui.panel;
  const base =
    source.type === 'light' ||
    source.type === 'hcLight' ||
    (source.type !== 'dark' &&
      source.type !== 'hcDark' &&
      background &&
      luminance(background) > 0.179)
      ? 'light'
      : 'dark';
  return { format: 'velxio-theme', version: 1, name: name.slice(0, 100), base, ui, monaco };
}

const defaults = {
  dark: {
    surface: '#1e1e1e',
    panel: '#252526',
    foreground: '#cccccc',
    terminal: '#0a0a0a',
    terminalText: '#00ff41',
  },
  light: {
    surface: '#ffffff',
    panel: '#eceef1',
    foreground: '#24292f',
    terminal: '#ffffff',
    terminalText: '#0a7d33',
  },
};

function surfacePair(
  background: string | undefined,
  foreground: string | undefined,
  fallbackBackground: string,
  fallbackForeground: string,
): [string | undefined, string | undefined] {
  const text = opaque(foreground);
  const surface = opaque(background);
  const safeSurface =
    surface && (readable(fallbackForeground, surface) || (text && readable(text, surface)))
      ? surface
      : undefined;
  const safeText = text && readable(text, safeSurface ?? fallbackBackground) ? text : undefined;
  return [safeSurface, safeText];
}

export function workspaceThemeVariables(theme: WorkspaceTheme): Record<string, string> {
  const base = defaults[theme.base];
  const ui = { ...theme.ui };
  const sharedBackgrounds = ['canvas', 'surface', 'panel', 'input', 'popup'] as const;
  const text = opaque(ui.foreground);
  // Shared foreground and background tokens are reused in menus, hover states and dialogs.
  // Keep them readable on the built-in surfaces that a partial theme leaves in place.
  ui.foreground =
    text && readable(text, base.surface) && readable(text, base.panel) ? text : undefined;
  for (const key of sharedBackgrounds) {
    [ui[key]] = surfacePair(ui[key], undefined, base.surface, ui.foreground ?? base.foreground);
  }
  const muted = opaque(ui.muted);
  ui.muted =
    muted &&
    [base.surface, base.panel, ...sharedBackgrounds.map((key) => ui[key])].every(
      (background) => !background || readable(muted, background),
    )
      ? muted
      : undefined;

  for (const prefix of ['menu', 'sidebar', 'status', 'console', 'assistant'] as const) {
    const background = `${prefix}Background` as const;
    const foreground = `${prefix}Foreground` as const;
    [ui[background], ui[foreground]] = surfacePair(
      ui[background],
      ui[foreground],
      prefix === 'console' || prefix === 'assistant'
        ? (ui.surface ?? base.surface)
        : (ui.panel ?? base.panel),
      ui.foreground ?? base.foreground,
    );
  }
  [ui.terminalBackground, ui.terminalForeground] = surfacePair(
    ui.terminalBackground,
    ui.terminalForeground,
    base.terminal,
    base.terminalText,
  );

  const accent = opaque(ui.accent);
  ui.accent = accent;
  if (accent || ui.accentForeground) {
    const action = accent ?? '#0071e3';
    const requested = opaque(ui.accentForeground) ?? '#ffffff';
    ui.accentForeground = readable(requested, action)
      ? requested
      : readable('#000000', action)
        ? '#000000'
        : '#ffffff';
  }

  const variables: Record<string, string> = {};
  for (const key of uiKeys) {
    const color = ui[key];
    if (color) for (const token of uiTokens[key]) variables[token] = color;
  }
  if (accent) {
    variables['--color-action-primary-hover'] =
      `color-mix(in srgb, ${accent} 85%, ${ui.accentForeground})`;
    variables['--color-accent-fg'] = `color-mix(in srgb, ${accent} 55%, var(--wb-13))`;
    variables['--color-accent-border'] = `color-mix(in srgb, ${accent} 40%, transparent)`;
    variables['--color-accent-soft-strong'] = `color-mix(in srgb, ${accent} 26%, transparent)`;
    variables['--color-accent-soft'] ??= `color-mix(in srgb, ${accent} 14%, transparent)`;
  }
  return variables;
}

export function readableEditorColors(
  theme: WorkspaceTheme,
  background: string,
): Record<string, string> {
  const colors = { ...theme.monaco.colors };
  const defaultText = theme.base === 'light' ? '#000000' : '#d4d4d4';
  const widget = theme.base === 'light' ? '#f3f3f4' : '#252526';
  for (const key of [
    'editor',
    'editorWidget',
    'editorHoverWidget',
    'editorSuggestWidget',
    'input',
    'dropdown',
  ]) {
    const bg = key + '.background';
    const fg = key + '.foreground';
    const [surface, text] = surfacePair(
      colors[bg],
      colors[fg],
      key === 'editor' || key === 'input' ? background : widget,
      defaultText,
    );
    delete colors[bg];
    delete colors[fg];
    if (surface) colors[bg] = surface;
    if (text) colors[fg] = text;
  }
  if (colors['editor.background']) {
    colors['editorGutter.background'] ??= colors['editor.background'];
    colors['minimap.background'] ??= colors['editor.background'];
  }
  return colors;
}
