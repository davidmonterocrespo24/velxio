/**
 * SDK-004 — `LibraryDefinition` schema + validator unit tests.
 *
 * Validation runs at register() time AND from the plugin CLI's lint
 * command, so it must produce identical errors in both contexts.
 */
import { describe, it, expect } from 'vitest';
import {
  defineLibrary,
  validateLibraryDefinition,
  LibraryDefinitionSchema,
  LIBRARY_MAX_TOTAL_BYTES,
  LIBRARY_MAX_FILE_BYTES,
  LIBRARY_PLATFORMS,
  type LibraryDefinition,
} from '../src/libraries';

const tinyLibrary = (): LibraryDefinition => ({
  id: 'Adafruit_GFX',
  version: '1.11.5',
  files: [
    { path: 'src/Adafruit_GFX.h', content: '#pragma once\nclass Adafruit_GFX {};\n' },
    { path: 'src/Adafruit_GFX.cpp', content: '#include "Adafruit_GFX.h"\n' },
    { path: 'library.properties', content: 'name=Adafruit GFX\nversion=1.11.5\n' },
  ],
  platforms: ['avr', 'rp2040'],
});

describe('defineLibrary', () => {
  it('is an identity function', () => {
    const lib = tinyLibrary();
    expect(defineLibrary(lib)).toBe(lib);
  });

  it('exposes the 3 supported platforms', () => {
    expect(LIBRARY_PLATFORMS).toEqual(['avr', 'rp2040', 'esp32']);
  });
});

describe('LibraryDefinitionSchema', () => {
  it('accepts a minimal valid library', () => {
    expect(LibraryDefinitionSchema.safeParse(tinyLibrary()).success).toBe(true);
  });

  it('rejects empty files[]', () => {
    const bad: LibraryDefinition = { ...tinyLibrary(), files: [] };
    expect(LibraryDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects empty platforms[]', () => {
    const bad = { ...tinyLibrary(), platforms: [] };
    expect(LibraryDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown platform', () => {
    const bad = { ...tinyLibrary(), platforms: ['avr', 'wasm'] };
    expect(LibraryDefinitionSchema.safeParse(bad).success).toBe(false);
  });
});

describe('validateLibraryDefinition — size caps', () => {
  it('returns the validated definition on success', () => {
    const out = validateLibraryDefinition(tinyLibrary(), 'plug');
    expect(out.id).toBe('Adafruit_GFX');
  });

  it('rejects a file > 512 KB per-file cap', () => {
    const huge = 'x'.repeat(LIBRARY_MAX_FILE_BYTES + 1);
    const bad: LibraryDefinition = {
      ...tinyLibrary(),
      files: [{ path: 'src/big.cpp', content: huge }],
    };
    expect(() => validateLibraryDefinition(bad, 'plug')).toThrowError(
      /exceeds the 524288-byte per-file cap/,
    );
  });

  it('rejects a library whose total bytes exceed 2 MB', () => {
    // 5 files of ~500 KB each = ~2.5 MB. Each within per-file cap, total over.
    const chunk = 'a'.repeat(500_000);
    const bad: LibraryDefinition = {
      ...tinyLibrary(),
      files: [
        { path: 'src/a.cpp', content: chunk },
        { path: 'src/b.cpp', content: chunk },
        { path: 'src/c.cpp', content: chunk },
        { path: 'src/d.cpp', content: chunk },
        { path: 'src/e.cpp', content: chunk },
      ],
    };
    expect(() => validateLibraryDefinition(bad, 'plug')).toThrowError(
      new RegExp(`exceed the ${LIBRARY_MAX_TOTAL_BYTES}-byte cap`),
    );
  });
});

describe('validateLibraryDefinition — path safety', () => {
  it('rejects an absolute path', () => {
    const bad: LibraryDefinition = {
      ...tinyLibrary(),
      files: [{ path: '/etc/passwd', content: '' }],
    };
    expect(() => validateLibraryDefinition(bad, 'plug')).toThrowError(/safe relative path/);
  });

  it('rejects a path with .. segments', () => {
    const bad: LibraryDefinition = {
      ...tinyLibrary(),
      files: [{ path: '../escape.h', content: '#pragma once\n' }],
    };
    expect(() => validateLibraryDefinition(bad, 'plug')).toThrowError(/safe relative path/);
  });

  it('rejects a path with bad characters (shell metacharacters)', () => {
    const bad: LibraryDefinition = {
      ...tinyLibrary(),
      files: [{ path: 'src/`oops`.h', content: '' }],
    };
    expect(() => validateLibraryDefinition(bad, 'plug')).toThrowError(/safe relative path/);
  });

  it('rejects an extension that is not Arduino-source', () => {
    const bad: LibraryDefinition = {
      ...tinyLibrary(),
      files: [{ path: 'src/oops.exe', content: '' }],
    };
    expect(() => validateLibraryDefinition(bad, 'plug')).toThrowError(/extension that is not allowed/);
  });

  it('rejects duplicate file paths', () => {
    const bad: LibraryDefinition = {
      ...tinyLibrary(),
      files: [
        { path: 'src/a.h', content: '#pragma once\n' },
        { path: 'src/a.h', content: '#pragma once\n' },
      ],
    };
    expect(() => validateLibraryDefinition(bad, 'plug')).toThrowError(/duplicate file path/);
  });
});

describe('validateLibraryDefinition — preprocessor scan', () => {
  it('accepts #pragma once and #pragma pack', () => {
    const ok: LibraryDefinition = {
      ...tinyLibrary(),
      files: [
        {
          path: 'src/ok.h',
          content: '#pragma once\n#pragma pack(push,1)\nstruct A {};\n#pragma pack(pop)\n',
        },
      ],
    };
    expect(() => validateLibraryDefinition(ok, 'plug')).not.toThrow();
  });

  it('accepts a normal #include of a system header', () => {
    const ok: LibraryDefinition = {
      ...tinyLibrary(),
      files: [{ path: 'src/ok.cpp', content: '#include <Arduino.h>\nvoid f(){}\n' }],
    };
    expect(() => validateLibraryDefinition(ok, 'plug')).not.toThrow();
  });

  it('rejects a relative-include with .. (dir traversal via #include)', () => {
    const bad: LibraryDefinition = {
      ...tinyLibrary(),
      files: [{ path: 'src/bad.cpp', content: '#include "../../../etc/passwd"\n' }],
    };
    expect(() => validateLibraryDefinition(bad, 'plug')).toThrowError(/unsafe preprocessor/);
  });

  it('rejects a system #include with .. (dir traversal via system include)', () => {
    const bad: LibraryDefinition = {
      ...tinyLibrary(),
      files: [{ path: 'src/bad.cpp', content: '#include <../../etc/passwd>\n' }],
    };
    expect(() => validateLibraryDefinition(bad, 'plug')).toThrowError(/unsafe preprocessor/);
  });

  it('rejects an unknown #pragma directive', () => {
    const bad: LibraryDefinition = {
      ...tinyLibrary(),
      files: [{ path: 'src/bad.cpp', content: '#pragma exec("rm -rf /")\n' }],
    };
    expect(() => validateLibraryDefinition(bad, 'plug')).toThrowError(/unsafe preprocessor/);
  });

  it('accepts #define macros (does NOT block legitimate library code)', () => {
    const ok: LibraryDefinition = {
      ...tinyLibrary(),
      files: [
        {
          path: 'src/ok.h',
          content: '#pragma once\n#define ADAFRUIT_GFX_VERSION 1\n#ifdef ADAFRUIT_GFX_VERSION\n#endif\n',
        },
      ],
    };
    expect(() => validateLibraryDefinition(ok, 'plug')).not.toThrow();
  });
});
