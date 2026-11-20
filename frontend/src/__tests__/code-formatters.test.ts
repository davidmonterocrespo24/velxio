/**
 * "Format document" for the code editor (components/editor/codeFormatters).
 *
 * Two halves:
 *   - the line diff that turns "old text -> formatted text" into Monaco
 *     edits, checked by applying the edits back onto the old text (including
 *     a randomised sweep, because the end-of-document cases are exactly the
 *     ones a hand-picked list forgets);
 *   - the real formatter engines (clang-format and ruff, wasm builds), driven
 *     through their Node entry points here since the browser entry loads the
 *     wasm over fetch.
 */
import { describe, it, expect, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';

vi.mock('@wasm-fmt/clang-format/vite', async () => {
  const m = await import('@wasm-fmt/clang-format/node');
  return { default: async () => undefined, format: m.format };
});
vi.mock('@wasm-fmt/ruff_fmt/vite', async () => {
  const m = await import('@wasm-fmt/ruff_fmt/node');
  return { default: async () => undefined, format: m.format };
});
// codeFormatters reports engine failures through the app's message dialog;
// keep the zustand store out of these tests.
vi.mock('../store/useMessageDialogStore', () => ({ showMessageDialog: vi.fn() }));

import {
  computeFormatEdits,
  describeFormatError,
  diffLines,
  formatSource,
  formatterFilename,
  hasDocumentFormatter,
  registerCodeFormatters,
} from '../components/editor/codeFormatters';

/** The slice of ITextModel the edit computation reads. */
function fakeModel(text: string, eol: '\n' | '\r\n' = '\n'): Monaco.editor.ITextModel {
  const lines = text.split(/\r\n|\r|\n/);
  return {
    getValue: () => text,
    getEOL: () => eol,
    getLineCount: () => lines.length,
    getLineMaxColumn: (n: number) => lines[n - 1].length + 1,
  } as unknown as Monaco.editor.ITextModel;
}

/** Apply Monaco text edits to a string the way the model would. */
function applyEdits(text: string, edits: Monaco.languages.TextEdit[]): string {
  const lines = text.split(/\r\n|\r|\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const offsetOf = (line: number, col: number): number => {
    let off = 0;
    for (let i = 0; i < line - 1; i++) off += lines[i].length + eol.length;
    return off + col - 1;
  };
  const sorted = [...edits].sort(
    (a, b) =>
      b.range.startLineNumber - a.range.startLineNumber ||
      b.range.startColumn - a.range.startColumn,
  );
  let out = text;
  for (const e of sorted) {
    const s = offsetOf(e.range.startLineNumber, e.range.startColumn);
    const t = offsetOf(e.range.endLineNumber, e.range.endColumn);
    out = out.slice(0, s) + e.text + out.slice(t);
  }
  return out;
}

describe('diffLines', () => {
  it('returns nothing for identical input', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('isolates a change in the middle', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
    ]);
  });

  it('produces separate hunks for separate changes', () => {
    const hunks = diffLines(['a', 'b', 'c', 'd', 'e'], ['A', 'b', 'c', 'd', 'E']);
    expect(hunks).toEqual([
      { aStart: 0, aEnd: 1, bStart: 0, bEnd: 1 },
      { aStart: 4, aEnd: 5, bStart: 4, bEnd: 5 },
    ]);
  });

  it('handles pure insertions and deletions', () => {
    expect(diffLines(['a', 'c'], ['a', 'b', 'c'])).toEqual([
      { aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 },
    ]);
    expect(diffLines(['a', 'b', 'c'], ['a', 'c'])).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 },
    ]);
  });
});

describe('computeFormatEdits', () => {
  const cases: Array<[string, string, string]> = [
    ['indents one line', 'void f(){\nint x;\n}\n', 'void f(){\n  int x;\n}\n'],
    ['adds a trailing newline', 'int x;', 'int x;\n'],
    ['drops the trailing newline', 'int x;\n', 'int x;'],
    ['deletes the last line', 'a\nb\n', 'a\n'],
    ['deletes the last line without newline', 'a\nb', 'a'],
    ['appends lines', 'a', 'a\nb\nc'],
    ['replaces everything', 'x\ny', 'p\nq\nr\n'],
    ['empties the document', 'x\ny\n', ''],
    ['fills an empty document', '', 'x\n'],
    ['deletes the first line', 'x\na\n', 'a\n'],
    ['inserts at the top', 'a\n', 'x\na\n'],
    ['two separate hunks', 'a\n  b\nc\nd\n  e\nf\n', 'a\nb\nc\nd\ne\nf\n'],
    ['insert before an empty line, then delete to the end', 'b\n  a\n\n\nb\n  a', 'b\n  a\n\nb\n'],
    ['change a line, keep an empty one, delete the tail', 'x\n\ny\nz', 'X\n'],
    ['change a line, keep an empty one, append after it', 'x\n', 'X\n\ny'],
    ['grow an empty document', '', '\n\nb'],
  ];
  for (const [name, before, after] of cases) {
    it(name, () => {
      const edits = computeFormatEdits(fakeModel(before), after);
      expect(applyEdits(before, edits)).toBe(after);
    });
  }

  it('keeps CRLF documents CRLF', () => {
    const before = 'void f(){\r\nint x;\r\n}\r\n';
    const after = 'void f(){\r\n  int x;\r\n}\r\n';
    const edits = computeFormatEdits(fakeModel(before, '\r\n'), after);
    expect(applyEdits(before, edits)).toBe(after);
    expect(edits.every((e) => !/(^|[^\r])\n/.test(e.text))).toBe(true);
  });

  it('touches only the changed lines', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\n';
    const after = 'a\nb\nC\nd\ne\nF\ng\n';
    const edits = computeFormatEdits(fakeModel(before), after);
    expect(edits).toHaveLength(2);
    expect(edits[0].range.startLineNumber).toBe(3);
    expect(edits[1].range.startLineNumber).toBe(6);
  });

  it('round-trips random line edits', () => {
    // Deterministic LCG so a failure reproduces.
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ['', 'a', 'b', 'c', '  a', 'x'];
    for (let round = 0; round < 500; round++) {
      const eol = rnd(2) ? '\n' : '\r\n';
      const oldLines = Array.from({ length: rnd(7) }, () => alphabet[rnd(alphabet.length)]);
      const newLines = Array.from({ length: rnd(7) }, () => alphabet[rnd(alphabet.length)]);
      const before = oldLines.join(eol);
      const after = newLines.join(eol);
      const edits = computeFormatEdits(fakeModel(before, eol), after);
      expect(applyEdits(before, edits), JSON.stringify({ before, after })).toBe(after);
    }
  });
});

describe('formatterFilename', () => {
  it('formats sketches and headers as C++, keeps .c as C', () => {
    expect(formatterFilename('cpp', 'sketch.ino')).toBe('sketch.cpp');
    expect(formatterFilename('cpp', '1')).toBe('sketch.cpp');
    expect(formatterFilename('cpp', 'util.h')).toBe('util.h');
    expect(formatterFilename('cpp', 'main.c')).toBe('main.c');
    expect(formatterFilename('python', 'main.py')).toBe('main.py');
    expect(formatterFilename('python', '1')).toBe('main.py');
  });
});

describe('hasDocumentFormatter', () => {
  it('enables the menu row for C/C++, Python and JSON only', () => {
    expect(hasDocumentFormatter('cpp')).toBe(true);
    expect(hasDocumentFormatter('python')).toBe(true);
    expect(hasDocumentFormatter('json')).toBe(true);
    expect(hasDocumentFormatter('plaintext')).toBe(false);
    expect(hasDocumentFormatter('markdown')).toBe(false);
  });
});

describe('formatSource (real engines)', () => {
  it('formats an Arduino sketch the way the Arduino IDE does', async () => {
    const src = [
      '#include <Servo.h>',
      'Servo s;',
      'int   x=0;',
      'void setup(){pinMode(13,OUTPUT);',
      'Serial.begin(9600);  // hi',
      '   s.attach(9);}',
      'void loop() {',
      'if(x>3){digitalWrite(13,HIGH);}else{ digitalWrite(13,LOW); }',
      'for(int i=0;i<10;i++){x+=i;}',
      'switch(x){case 1: x=2; break;',
      'default: break;}',
      'delay(1000);',
      '}',
      '',
    ].join('\n');
    const out = await formatSource('cpp', 'sketch.ino', src);
    expect(out).toBe(
      [
        '#include <Servo.h>',
        'Servo s;',
        'int x = 0;',
        'void setup() {',
        '  pinMode(13, OUTPUT);',
        '  Serial.begin(9600);  // hi',
        '  s.attach(9);',
        '}',
        'void loop() {',
        '  if (x > 3) {',
        '    digitalWrite(13, HIGH);',
        '  } else {',
        '    digitalWrite(13, LOW);',
        '  }',
        '  for (int i = 0; i < 10; i++) { x += i; }',
        '  switch (x) {',
        '    case 1: x = 2; break;',
        '    default: break;',
        '  }',
        '  delay(1000);',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('leaves long lines and blank runs alone (no column limit, no reflow)', async () => {
    const long = 'const char *msg = "' + 'x'.repeat(150) + '";\n\n\n\nint y;\n';
    expect(await formatSource('cpp', 'sketch.ino', long)).toBe(long);
  });

  it('keeps CRLF line endings in C++', async () => {
    const out = await formatSource('cpp', 'sketch.ino', 'void f(){\r\nint x;\r\n}\r\n', '\r\n');
    expect(out).toBe('void f() {\r\n  int x;\r\n}\r\n');
  });

  it('is a fixed point: formatting formatted code changes nothing', async () => {
    const once = await formatSource('cpp', 'sketch.ino', 'void loop(){if(a){b();}}');
    expect(await formatSource('cpp', 'sketch.ino', once)).toBe(once);
  });

  it('formats MicroPython with 4-space indent and keeps quote style', async () => {
    const src = [
      'import machine,time',
      "led=machine.Pin(2,machine.Pin.OUT)",
      'def blink( n ):',
      '  for i in range( n ):',
      '      led.value( 1 )',
      "      print('on'); time.sleep(0.5)",
      'while True:',
      '  blink(3)',
      '',
    ].join('\n');
    const out = await formatSource('python', 'main.py', src);
    expect(out).toBe(
      [
        'import machine, time',
        '',
        'led = machine.Pin(2, machine.Pin.OUT)',
        '',
        '',
        'def blink(n):',
        '    for i in range(n):',
        '        led.value(1)',
        "        print('on')",
        '        time.sleep(0.5)',
        '',
        '',
        'while True:',
        '    blink(3)',
        '',
      ].join('\n'),
    );
  });

  it('keeps CRLF line endings in Python', async () => {
    const out = await formatSource('python', 'main.py', 'x=1\r\ny=2\r\n', '\r\n');
    expect(out).toBe('x = 1\r\ny = 2\r\n');
  });

  it('rejects Python it cannot parse, and the error names the line', async () => {
    const src = 'x = 1\ny = "ñandú"\ndef f(:\n  pass\n';
    let caught: unknown = null;
    try {
      await formatSource('python', 'main.py', src);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(describeFormatError(caught, src)).toMatch(/^Line 3: Expected a parameter/);
  });
});

describe('describeFormatError', () => {
  it('passes messages without a byte range through unchanged', () => {
    expect(describeFormatError(new Error('boom'), 'x')).toBe('boom');
    expect(describeFormatError('plain', 'x')).toBe('plain');
  });

  it('maps a byte offset to a 1-based line, counting UTF-8 bytes', () => {
    // "é" is two bytes, so line 1 ("aé" + newline) spans bytes 0..3 and
    // "b" sits at byte 4, not 3 as a character count would say.
    expect(describeFormatError(new Error('bad at byte range 3..4'), 'aé\nb\n')).toBe('Line 1: bad');
    expect(describeFormatError(new Error('bad at byte range 4..5'), 'aé\nb\n')).toBe('Line 2: bad');
  });
});

/** The slice of the monaco namespace registerCodeFormatters touches. */
function fakeMonaco(
  registered: string[],
  rules: Monaco.editor.IKeybindingRule[],
  providers: Record<string, Monaco.languages.DocumentFormattingEditProvider> = {},
): typeof Monaco {
  return {
    KeyMod: { Shift: 1024, Alt: 512 },
    KeyCode: { KeyF: 36 },
    editor: {
      addKeybindingRule: (rule: Monaco.editor.IKeybindingRule) => {
        rules.push(rule);
        return { dispose: () => undefined };
      },
    },
    languages: {
      registerDocumentFormattingEditProvider: (
        id: string,
        p: Monaco.languages.DocumentFormattingEditProvider,
      ) => {
        registered.push(id);
        providers[id] = p;
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
}

describe('registerCodeFormatters', () => {
  it('registers one provider per language and the shortcut, once per monaco instance', () => {
    const registered: string[] = [];
    const rules: Monaco.editor.IKeybindingRule[] = [];
    const monaco = fakeMonaco(registered, rules);
    registerCodeFormatters(monaco);
    registerCodeFormatters(monaco);
    expect(registered).toEqual(['cpp', 'python']);
    expect(rules).toHaveLength(1);
    expect(rules[0].command).toBe('editor.action.formatDocument');
    // Shift+Alt+F, the chord the Edit menu prints.
    expect(rules[0].keybinding).toBe(1024 | 512 | 36);
  });

  it('the cpp provider returns edits that produce the formatted text', async () => {
    const providers: Record<string, Monaco.languages.DocumentFormattingEditProvider> = {};
    registerCodeFormatters(fakeMonaco([], [], providers));
    const provider = providers.cpp;
    const before = 'void loop(){\nint x=1;\n}\n';
    const model = {
      ...fakeModel(before),
      uri: { path: '/1' },
      isDisposed: () => false,
      getOptions: () => ({ insertSpaces: true, tabSize: 4, indentSize: 4 }),
    } as unknown as Monaco.editor.ITextModel;
    const edits = await provider.provideDocumentFormattingEdits(
      model,
      { tabSize: 2, insertSpaces: true },
      {} as Monaco.CancellationToken,
    );
    expect(applyEdits(before, edits ?? [])).toBe('void loop() {\n    int x = 1;\n}\n');
  });
});
