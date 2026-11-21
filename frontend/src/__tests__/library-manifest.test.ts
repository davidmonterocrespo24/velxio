/**
 * Library-manifest helpers (utils/libraryManifest.ts).
 *
 * These pure functions drive the 2026-08 manifest migration:
 *  - mergeSuggestedLibraries folds the backend's post-build report
 *    (`manifest_suggested_libraries`) into a board's declared manifest —
 *    conservatively: single-candidate entries only, normalized dedup,
 *    null when nothing changes (so callers skip the store write).
 *  - add/removeLibraryToManifest back the install-declares flow (agent
 *    install tool, Wokwi InstallLibrariesModal).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeLibName,
  bareLibName,
  mergeSuggestedLibraries,
  addLibraryToManifest,
  removeLibraryFromManifest,
} from '../utils/libraryManifest';

describe('normalizeLibName', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(normalizeLibName('Adafruit GFX Library')).toBe('adafruitgfxlibrary');
    expect(normalizeLibName('Adafruit_GFX_Library')).toBe('adafruitgfxlibrary');
    expect(normalizeLibName('ESP Async WebServer')).toBe('espasyncwebserver');
  });

  it('handles empty / falsy input', () => {
    expect(normalizeLibName('')).toBe('');
  });
});

describe('bareLibName', () => {
  it('strips a trailing @version', () => {
    expect(bareLibName('DHT sensor library@1.4.6')).toBe('DHT sensor library');
    expect(bareLibName('ESP32Servo@3.2.1')).toBe('ESP32Servo');
  });

  it('leaves version-less specs untouched', () => {
    expect(bareLibName('ESP32Servo')).toBe('ESP32Servo');
  });

  it('does not treat a leading @ as a version separator', () => {
    expect(bareLibName('@scoped-thing')).toBe('@scoped-thing');
  });
});

describe('mergeSuggestedLibraries', () => {
  it('adds single-candidate suggestions to an empty manifest', () => {
    const merged = mergeSuggestedLibraries(undefined, {
      'ESPAsyncWebServer.h': ['ESP Async WebServer'],
      'ESP32Servo.h': ['ESP32Servo'],
    });
    expect(merged).toEqual(['ESP Async WebServer', 'ESP32Servo']);
  });

  it('skips ambiguous (multi-candidate) suggestions', () => {
    const merged = mergeSuggestedLibraries([], {
      'Servo.h': ['Servo', 'ESP32Servo'], // ambiguous — never guess
      'AsyncTCP.h': ['AsyncTCP'],
    });
    expect(merged).toEqual(['AsyncTCP']);
  });

  it('dedups against the current manifest with normalized comparison', () => {
    const merged = mergeSuggestedLibraries(['esp async webserver'], {
      'ESPAsyncWebServer.h': ['ESP Async WebServer'],
      'AsyncTCP.h': ['AsyncTCP'],
    });
    expect(merged).toEqual(['esp async webserver', 'AsyncTCP']);
  });

  it('dedups repeated suggestions across headers', () => {
    const merged = mergeSuggestedLibraries([], {
      'FooA.h': ['FooLib'],
      'FooB.h': ['Foo_Lib'], // same library, different spelling
    });
    expect(merged).toEqual(['FooLib']);
  });

  it('returns null when there is nothing new (no store churn)', () => {
    expect(mergeSuggestedLibraries(['AsyncTCP'], { 'AsyncTCP.h': ['AsyncTCP'] })).toBeNull();
    expect(mergeSuggestedLibraries(['A'], null)).toBeNull();
    expect(mergeSuggestedLibraries(['A'], undefined)).toBeNull();
    expect(mergeSuggestedLibraries(['A'], {})).toBeNull();
  });

  it('ignores empty or malformed candidate entries', () => {
    const merged = mergeSuggestedLibraries([], {
      'A.h': [''],
      'B.h': [],
      'C.h': ['RealLib'],
    });
    expect(merged).toEqual(['RealLib']);
  });

  it('preserves the existing manifest order and appends', () => {
    const merged = mergeSuggestedLibraries(['First', 'Second'], { 'X.h': ['Third'] });
    expect(merged).toEqual(['First', 'Second', 'Third']);
  });
});

describe('addLibraryToManifest', () => {
  it('keeps an explicit version or Wokwi reference in the declaration', () => {
    expect(addLibraryToManifest(undefined, 'ESP32Servo@3.2.1')).toEqual(['ESP32Servo@3.2.1']);
    expect(addLibraryToManifest(undefined, 'Display@wokwi:hash')).toEqual(['Display@wokwi:hash']);
  });

  it('fills a missing version but keeps an existing pin', () => {
    expect(addLibraryToManifest(['esp32servo'], 'ESP32Servo@3.2.1')).toEqual(['ESP32Servo@3.2.1']);
    expect(addLibraryToManifest(['esp32servo@3.0.0'], 'ESP32Servo@3.2.1')).toBeNull();
    expect(addLibraryToManifest(['ESP Async WebServer'], 'esp_async_webserver')).toBeNull();
  });

  it('appends to an existing manifest', () => {
    expect(addLibraryToManifest(['A'], 'B')).toEqual(['A', 'B']);
  });

  it('rejects empty specs', () => {
    expect(addLibraryToManifest(['A'], '')).toBeNull();
    expect(addLibraryToManifest(['A'], '  ')).toBeNull();
  });
});

describe('removeLibraryFromManifest', () => {
  it('removes by normalized name regardless of version suffix', () => {
    expect(removeLibraryFromManifest(['ESP32Servo@3.0.0', 'AsyncTCP'], 'esp32servo@3.2.1')).toEqual([
      'AsyncTCP',
    ]);
  });

  it('returns null when the library is not declared', () => {
    expect(removeLibraryFromManifest(['A'], 'B')).toBeNull();
    expect(removeLibraryFromManifest([], 'B')).toBeNull();
    expect(removeLibraryFromManifest(undefined, 'B')).toBeNull();
  });

  it('can empty the manifest (explicit [] is a valid manifest)', () => {
    expect(removeLibraryFromManifest(['OnlyOne'], 'OnlyOne')).toEqual([]);
  });
});
