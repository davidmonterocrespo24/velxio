// @vitest-environment jsdom
/**
 * File icons an extension registers by file name (lib/fileIcons.ts), the
 * built-in HTML icon, and the editor naming the web languages Monaco ships
 * (an .html file used to open as plain text).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fileIconFor, getFileIconsVersion, registerFileIcon } from '../lib/fileIcons';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let removers: Array<() => void> = [];
afterEach(() => {
  removers.forEach((r) => r());
  removers = [];
});

describe('file icon registry', () => {
  it('matches by name, first rule wins, and the remover takes it back', () => {
    const v0 = getFileIconsVersion();
    const cube = { match: (n: string) => n.toLowerCase() === 'world.html', paths: ['M4 4h16'], color: 'red' };
    removers.push(registerFileIcon(cube));
    removers.push(registerFileIcon({ match: (n: string) => n.endsWith('.html'), paths: ['M1 1h1'] }));
    expect(getFileIconsVersion()).toBeGreaterThan(v0);
    expect(fileIconFor('World.html')).toBe(cube);
    expect(fileIconFor('index.html')?.paths).toEqual(['M1 1h1']);
    expect(fileIconFor('sketch.ino')).toBeNull();
    removers.shift()!();
    expect(fileIconFor('world.html')?.paths).toEqual(['M1 1h1']);
  });

  it('skips a rule whose matcher throws', () => {
    removers.push(registerFileIcon({ match: () => { throw new Error('boom'); }, paths: ['x'] }));
    expect(fileIconFor('a.html')).toBeNull();
  });
});

describe('editor languages', () => {
  it('opens .html, .css and .js files with their Monaco language', () => {
    const src = readFileSync(join(__dirname, '../components/editor/CodeEditor.tsx'), 'utf8');
    expect(src).toMatch(/ext === 'html' \|\| ext === 'htm'\) return 'html'/);
    expect(src).toMatch(/ext === 'css'\) return 'css'/);
    expect(src).toMatch(/return 'javascript'/);
  });
});
