// @vitest-environment jsdom
/**
 * File icons an extension registers by file name (lib/fileIcons.ts), the
 * built-in HTML icon, and the editor naming the web languages Monaco ships
 * (an .html file used to open as plain text).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fileIconFor, getFileIconsVersion, registerFileIcon } from '../lib/fileIcons';
import {
  detectEditorLanguage,
  getEditorLanguage,
  renameForEditorLanguage,
} from '../lib/editorLanguages';

let removers: Array<() => void> = [];
afterEach(() => {
  removers.forEach((r) => r());
  removers = [];
});

describe('file icon registry', () => {
  it('matches by name, first rule wins, and the remover takes it back', () => {
    const v0 = getFileIconsVersion();
    const cube = {
      match: (n: string) => n.toLowerCase() === 'world.html',
      paths: ['M4 4h16'],
      color: 'red',
    };
    removers.push(registerFileIcon(cube));
    removers.push(
      registerFileIcon({ match: (n: string) => n.endsWith('.html'), paths: ['M1 1h1'] }),
    );
    expect(getFileIconsVersion()).toBeGreaterThan(v0);
    expect(fileIconFor('World.html')).toBe(cube);
    expect(fileIconFor('index.html')?.paths).toEqual(['M1 1h1']);
    expect(fileIconFor('sketch.ino')).toBeNull();
    removers.shift()!();
    expect(fileIconFor('world.html')?.paths).toEqual(['M1 1h1']);
  });

  it('skips a rule whose matcher throws', () => {
    removers.push(
      registerFileIcon({
        match: () => {
          throw new Error('boom');
        },
        paths: ['x'],
      }),
    );
    expect(fileIconFor('a.html')).toBeNull();
  });
});

describe('editor languages', () => {
  it.each([
    ['python', '# A greeting\nprint("Hello")'],
    ['python', '#!/usr/bin/env python3\nmessage = "Hello"'],
    ['cpp', '# include <Arduino.h>\nvoid setup() {}'],
    ['retro-asm', 'ORG_LABEL: MVI A, 0x42\nHLT'],
    ['html', '<!-- Greeting -->\n<h1>Hello</h1>'],
    ['css', 'body { color: red; }'],
    ['javascript', 'const message = "Hello";\nconsole.log(message);'],
    ['typescript', 'function greet(name: string) { return name; }'],
    ['json', '{"name":"Hello","enabled":true}'],
    ['yaml', 'name: Hello\nsteps:\n  - run: echo hello'],
    ['yaml', 'steps:\n  - run: |\n      print("Hello")'],
    ['markdown', '# Example\n\n```python\nprint("Hello")\n```'],
  ])('detects %s from the file contents', (language, source) => {
    expect(detectEditorLanguage('scratch.txt', source)).toBe(language);
  });

  it('uses the extension for ambiguous code and reports an unknown language for prose', () => {
    expect(detectEditorLanguage('scratch.PYI', 'answer = 42')).toBe('python');
    expect(detectEditorLanguage('script.ts', 'const answer = 42;')).toBe('typescript');
    expect(detectEditorLanguage('chart.yml', '{"value":42}')).toBe('yaml');
    expect(detectEditorLanguage('notes', 'Note: This is plain prose.')).toBeUndefined();
    expect(detectEditorLanguage('untitled', '')).toBeUndefined();
  });

  it('opens .html, .css and .js files with their Monaco language', () => {
    expect(getEditorLanguage('index.html')).toBe('html');
    expect(getEditorLanguage('index.htm')).toBe('html');
    expect(getEditorLanguage('styles.css')).toBe('css');
    expect(getEditorLanguage('script.js')).toBe('javascript');
  });

  it('changes the extension without changing the folder or other dots in the name', () => {
    expect(renameForEditorLanguage('src/assets.v2/sketch.test.ino', 'python')).toBe(
      'src/assets.v2/sketch.test.py',
    );
    expect(renameForEditorLanguage('src/.example', 'yaml')).toBe('src/.example.yaml');
    expect(renameForEditorLanguage('src/helper', 'cpp')).toBe('src/helper.cpp');
  });

  it('preserves existing extensions that already match the selected language', () => {
    expect(renameForEditorLanguage('sketch.ino', 'cpp')).toBe('sketch.ino');
    expect(renameForEditorLanguage('PAGE.HTM', 'html')).toBe('PAGE.HTM');
  });
});
