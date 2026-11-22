import { describe, it, expect } from 'vitest';
import { fingerprintSources } from '../utils/sourceFingerprint';

const board = { languageMode: 'arduino' as const, boardOptions: undefined };

describe('fingerprintSources (stale-build detection for Flash)', () => {
  it('is stable for identical inputs regardless of file order', () => {
    const a = fingerprintSources(board, [
      { name: 'sketch.ino', content: 'void setup(){}' },
      { name: 'util.h', content: '#pragma once' },
    ]);
    const b = fingerprintSources(board, [
      { name: 'util.h', content: '#pragma once' },
      { name: 'sketch.ino', content: 'void setup(){}' },
    ]);
    expect(a).toBe(b);
  });

  it('changes when a file body, a file name, the language or the options change', () => {
    const base = fingerprintSources(board, [{ name: 'sketch.ino', content: 'a' }]);
    expect(fingerprintSources(board, [{ name: 'sketch.ino', content: 'b' }])).not.toBe(base);
    expect(fingerprintSources(board, [{ name: 'main.ino', content: 'a' }])).not.toBe(base);
    expect(
      fingerprintSources({ ...board, languageMode: 'espidf' }, [{ name: 'sketch.ino', content: 'a' }]),
    ).not.toBe(base);
    expect(
      fingerprintSources(
        { ...board, boardOptions: { flashSize: '8MB' } as never },
        [{ name: 'sketch.ino', content: 'a' }],
      ),
    ).not.toBe(base);
  });

  it('changes when a library is pinned to another version or SPIFFS bytes change', () => {
    const files = [{ name: 'sketch.ino', content: 'void setup(){}' }];
    const settings = {
      ...board,
      libraries: ['Servo@1.0.0'],
      spiffsFiles: [{ name: 'data.txt', contentB64: 'YQ==', size: 1 }],
    };
    const compiled = fingerprintSources(settings, files);
    expect(fingerprintSources({ ...settings, libraries: ['Servo@1.1.0'] }, files)).not.toBe(compiled);
    const spiffsFiles = [{ ...settings.spiffsFiles[0], contentB64: 'Yg==' }];
    expect(fingerprintSources({ ...settings, spiffsFiles }, files)).not.toBe(compiled);
    expect(fingerprintSources({ ...settings, spiffsFiles: [...settings.spiffsFiles] }, files)).toBe(compiled);
  });
});
