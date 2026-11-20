import { describe, expect, it } from 'vitest';
import {
  importWorkspaceTheme,
  readableEditorColors,
  workspaceThemeVariables,
} from '../lib/workspaceTheme';

describe('workspace theme import', () => {
  it('maps supported VS Code JSONC colors and basic syntax rules, then round-trips', () => {
    const theme = importWorkspaceTheme(
      `{
      // Keep comment-like text inside the name.
      "name": "Circuit // Night",
      "colors": {
        "editor.background": "#182231",
        "sideBar.background": "#253",
        "statusBar.background": "#37445a",
        "unrecognised.background": "#ff0000",
      },
      "tokenColors": [
        { "scope": "keyword, comment", "settings": { "foreground": "#ec9" } },
        { "scope": "comment", "settings": { "fontStyle": "italic" } },
        { "scope": "meta.function string", "settings": { "foreground": "#111" } },
      ],
    }`,
      'night-color-theme.json',
    );
    expect(theme).toMatchObject({
      name: 'Circuit // Night',
      base: 'dark',
      ui: { sidebarBackground: '#225533', statusBackground: '#37445a' },
      monaco: {
        colors: { 'editor.background': '#182231' },
        rules: [
          { token: 'keyword', foreground: 'eecc99' },
          { token: 'comment', foreground: 'eecc99', fontStyle: 'italic' },
        ],
      },
    });
    expect(theme?.monaco.colors).not.toHaveProperty('unrecognised.background');
    expect(importWorkspaceTheme(JSON.stringify(theme), 'night.velxio-theme.json')).toEqual(theme);
  });

  it('uses readable base colors wherever a partial import lacks a usable override', () => {
    const theme = importWorkspaceTheme(
      JSON.stringify({
        type: 'dark',
        colors: {
          'editor.background': '#182231',
          'editor.foreground': '#171e2a',
          'editorSuggestWidget.background': '#fff',
          'sideBar.background': '#fff',
          'statusBar.background': '#37445a',
        },
      }),
      'Partial-color-theme.json',
    );
    expect(theme).not.toBeNull();
    const variables = workspaceThemeVariables(theme!);
    const editor = readableEditorColors(theme!, '#1e1e1e');
    expect(variables['--workspace-sidebar-background']).toBeUndefined();
    expect(variables['--workspace-status-background']).toBe('#37445a');
    expect(editor['editor.foreground']).toBeUndefined();
    expect(editor['editorSuggestWidget.background']).toBeUndefined();
    expect(editor['editor.background']).toBe('#182231');
  });

  it('rejects unsupported files and native format versions', () => {
    expect(importWorkspaceTheme('{"include":"file.json"}', 'theme.json')).toBeNull();
    expect(importWorkspaceTheme('{"format":"velxio-theme","version":2}', 'theme.json')).toBeNull();
    expect(importWorkspaceTheme('{ broken }', 'theme.json')).toBeNull();
  });
});
