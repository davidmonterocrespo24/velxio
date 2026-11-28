import { describe, expect, it } from 'vitest';
import { compilerLocation } from '../lib/compileDiagnostics';
import { parseCompileResult } from '../utils/compilationLogger';

const files = [
  { id: 'sketch', name: 'Blink.ino', content: 'void setup() {}\nvoid loop() {}', modified: true },
  { id: 'nested', name: 'src/config.h', content: '#pragma once\nint xyz;\n', modified: true },
  { id: 'other', name: 'config.h', content: '// another header\n', modified: false },
];

describe('compiler diagnostics', () => {
  it('maps the Arduino scratch filename to the original sketch', () => {
    const location = compilerLocation(
      'C:\\build\\sketch\\sketch.ino:2:6: error: expected initializer',
      'uno',
      files,
    );
    expect(location).toMatchObject({
      fileId: 'sketch',
      groupId: 'uno',
      name: 'Blink.ino',
      severity: 'error',
      position: { lineNumber: 2, column: 6 },
      message: 'expected initializer',
    });
  });

  it('uses the most specific workspace path in the compiler output', () => {
    expect(
      compilerLocation('/tmp/sketch/src/config.h:2: warning: unused', 'nano', files),
    ).toMatchObject({ fileId: 'nested', groupId: 'nano', severity: 'warning' });
    expect(
      compilerLocation('/tmp/sketch/unknown.h:2:6: error: missing', 'uno', files),
    ).toBeUndefined();
  });

  it('shares the exact build location with the console and marker consumers', () => {
    const logs = parseCompileResult(
      { success: false, stdout: '', stderr: 'sketch.ino:2:1: error: expected initializer' },
      'Uno',
      { id: 'one', label: 'Uno', kind: 'board' },
      false,
      { groupId: 'uno', files },
    );
    expect(logs.find(({ location }) => location)?.location).toMatchObject({
      fileId: 'sketch',
      position: { lineNumber: 2, column: 1 },
      content: files[0].content,
    });
  });
});
