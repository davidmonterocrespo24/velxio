// @vitest-environment jsdom
/**
 * install-libraries.test.ts
 *
 * Tests for the automatic library installation feature introduced when
 * importing Wokwi ZIP projects:
 *
 * UNIT — parseLibrariesTxt()
 *   Parses a libraries.txt string into an array of installable names.
 *   Verifies filtering of comments, blank lines, and @wokwi: entries.
 *
 * INTEGRATION — importFromWokwiZip() :: libraries field
 *   Creates real in-memory ZIP files with JSZip, runs the full import
 *   function, and verifies that result.libraries contains the correct names.
 *
 * SERVICE — installLibrary() / getInstalledLibraries()
 *   Stubs global fetch and verifies the correct HTTP requests and response
 *   handling of the library service functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';

import { parseLibrariesTxt, importFromWokwiZip } from '../utils/wokwiZip';
import { installLibrary, getInstalledLibraries } from '../services/libraryService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal diagram.json so importFromWokwiZip doesn't throw */
const MINIMAL_DIAGRAM = JSON.stringify({
  version: 1,
  author: 'test',
  editor: 'wokwi',
  parts: [{ type: 'wokwi-arduino-uno', id: 'uno', top: 0, left: 0, attrs: {} }],
  connections: [],
});

/** Build an in-memory ZIP File with the given files */
async function makeZip(entries: Record<string, string>): Promise<File> {
  const zip = new JSZip();
  zip.file('diagram.json', MINIMAL_DIAGRAM);
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'test.zip', { type: 'application/zip' });
}

// ─── Real libraries.txt content (from example_zip/extracted/) ─────────────────

const PONG_LIBRARIES_TXT = `# Wokwi Library List
# See https://docs.wokwi.com/guides/libraries

# Automatically added based on includes:
Adafruit GFX Library

Adafruit SSD1306
`;

const CALCULATOR_LIBRARIES_TXT = `Adafruit GFX Library
Adafruit FT6206 Library
Adafruit ILI9341
LC_Adafruit_1947@wokwi:b065451f35dab6e1021d78f0f79b6eda6910455d
LC_baseTools@wokwi:95340986110645c1b45e55597a7caf4d023d4b4a
LC_GUIbase@wokwi:cad247b5fc057dce02f20f7dd8902e0ab3464bb0
LC_GUIItems@wokwi:0dabc07df1078c562ee693693d51c280c68131ce
LC_GUITextTools@wokwi:0ea40c37c3578be382f9a915362413565a13779f
LC_keyboard@wokwi:2f79075f1332b48f679c2ab9f8199344458b2643
LC_RPNCalculator@wokwi:c670627d569e21d822d4bc5e3a04c299191e9dce
LC_scrollingList@wokwi:57d9e60a3fbfb0aee4291d3ad9b9bb4ff1ad0650
LCP_breakout@wokwi:93b61107ec6046ae81014971bbab8821411b066f
LCP_rpnCalc@wokwi:e87783abb639c397a4c3aa4c4410cd4912407d2c
SD
Adafruit SSD1351 library
`;

const SERVO_LIBRARIES_TXT = `Servo
`;

// ─── 1. parseLibrariesTxt — unit tests ────────────────────────────────────────

describe('parseLibrariesTxt — unit', () => {
  it('returns empty array for empty content', () => {
    expect(parseLibrariesTxt('')).toEqual([]);
  });

  it('returns empty array when content is only blank lines', () => {
    expect(parseLibrariesTxt('\n\n\n')).toEqual([]);
  });

  it('strips comment lines starting with #', () => {
    const result = parseLibrariesTxt('# comment\n# another\nMyLib\n');
    expect(result).toEqual(['MyLib']);
  });

  it('strips blank lines between entries', () => {
    const result = parseLibrariesTxt('LibA\n\nLibB\n\n\nLibC');
    expect(result).toEqual(['LibA', 'LibB', 'LibC']);
  });

  it('includes @wokwi: hash entries (backend handles them)', () => {
    const result = parseLibrariesTxt('GoodLib\nWokwiLib@wokwi:abc123deadbeef\nAnotherGood\n');
    expect(result).toEqual(['GoodLib', 'WokwiLib@wokwi:abc123deadbeef', 'AnotherGood']);
  });

  it('handles inline whitespace (leading/trailing spaces on a line)', () => {
    const result = parseLibrariesTxt('  Adafruit GFX Library  \n  \n  Servo  \n');
    expect(result).toEqual(['Adafruit GFX Library', 'Servo']);
  });

  it('parses pong libraries.txt → 2 standard libs', () => {
    const result = parseLibrariesTxt(PONG_LIBRARIES_TXT);
    expect(result).toEqual(['Adafruit GFX Library', 'Adafruit SSD1306']);
  });

  it('parses calculator-breakout-icon libraries.txt → standard libs AND @wokwi: entries', () => {
    const result = parseLibrariesTxt(CALCULATOR_LIBRARIES_TXT);
    expect(result).toContain('Adafruit GFX Library');
    expect(result).toContain('Adafruit FT6206 Library');
    expect(result).toContain('Adafruit ILI9341');
    expect(result).toContain('SD');
    expect(result).toContain('Adafruit SSD1351 library');
    // Wokwi-hosted entries must also be present
    expect(result).toContain('LC_Adafruit_1947@wokwi:b065451f35dab6e1021d78f0f79b6eda6910455d');
    expect(result).toContain('LC_baseTools@wokwi:95340986110645c1b45e55597a7caf4d023d4b4a');
    // 5 standard + 10 @wokwi: entries visible in CALCULATOR_LIBRARIES_TXT snippet
    expect(result.length).toBeGreaterThan(5);
  });

  it('parses ServoOverdone libraries.txt → [Servo]', () => {
    const result = parseLibrariesTxt(SERVO_LIBRARIES_TXT);
    expect(result).toEqual(['Servo']);
  });
});

// ─── 2. importFromWokwiZip — libraries field ───────────────────────────────────

describe('importFromWokwiZip — libraries field', () => {
  it('returns empty array when no libraries.txt is present', async () => {
    const file = await makeZip({ 'sketch.ino': 'void setup(){}void loop(){}' });
    const result = await importFromWokwiZip(file);
    expect(result.libraries).toEqual([]);
  });

  it('returns standard libs from a minimal libraries.txt', async () => {
    const file = await makeZip({
      'sketch.ino': 'void setup(){}void loop(){}',
      'libraries.txt': 'Adafruit GFX Library\nAdafruit SSD1306\n',
    });
    const result = await importFromWokwiZip(file);
    expect(result.libraries).toEqual(['Adafruit GFX Library', 'Adafruit SSD1306']);
  });

  it('includes @wokwi: entries in the returned array (backend installs them)', async () => {
    const file = await makeZip({
      'sketch.ino': 'void setup(){}void loop(){}',
      'libraries.txt': 'GoodLib\nWokwiLib@wokwi:deadbeef12345\n',
    });
    const result = await importFromWokwiZip(file);
    expect(result.libraries).toEqual(['GoodLib', 'WokwiLib@wokwi:deadbeef12345']);
  });

  it('returns empty array when libraries.txt is only comments', async () => {
    const file = await makeZip({
      'sketch.ino': 'void setup(){}void loop(){}',
      'libraries.txt': '# Wokwi Library List\n# no real libs here\n\n',
    });
    const result = await importFromWokwiZip(file);
    expect(result.libraries).toEqual([]);
  });

  it('pong ZIP — extracts 2 standard libs', async () => {
    const file = await makeZip({
      'sketch.ino': 'void setup(){}void loop(){}',
      'libraries.txt': PONG_LIBRARIES_TXT,
    });
    const result = await importFromWokwiZip(file);
    expect(result.libraries).toEqual(['Adafruit GFX Library', 'Adafruit SSD1306']);
  });

  it('calculator ZIP — includes both standard libs AND @wokwi: entries', async () => {
    const file = await makeZip({
      'sketch.ino': 'void setup(){}void loop(){}',
      'libraries.txt': CALCULATOR_LIBRARIES_TXT,
    });
    const result = await importFromWokwiZip(file);
    // 5 standard Arduino Library Manager libs
    expect(result.libraries).toContain('Adafruit GFX Library');
    expect(result.libraries).toContain('SD');
    // Wokwi-hosted libs must also be present
    expect(result.libraries).toContain(
      'LC_Adafruit_1947@wokwi:b065451f35dab6e1021d78f0f79b6eda6910455d',
    );
    expect(result.libraries.length).toBeGreaterThan(5);
  });

  it('libraries field does not interfere with files[], components[], wires[]', async () => {
    const file = await makeZip({
      'sketch.ino': '#include <Servo.h>\nvoid setup(){}void loop(){}',
      'libraries.txt': 'Servo\n',
    });
    const result = await importFromWokwiZip(file);
    // Board detected
    expect(result.boardType).toBe('arduino-uno');
    // Files parsed
    expect(result.files.some((f) => f.name === 'sketch.ino')).toBe(true);
    // Libraries parsed
    expect(result.libraries).toEqual(['Servo']);
  });
});

// ─── 3. installLibrary service — HTTP stubs ────────────────────────────────────

describe('installLibrary service', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to /api/libraries/install with the library name in the body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await installLibrary('Adafruit GFX Library');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/libraries/install');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ name: 'Adafruit GFX Library' });
  });

  it('returns { success: true } when the backend responds 200 ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      }),
    );

    const result = await installLibrary('Servo');
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns { success: false, error } when the backend reports failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: false, error: 'Library not found' }),
      }),
    );

    const result = await installLibrary('NonExistentLib99999');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Library not found');
  });

  it('installs multiple libraries sequentially without interference', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        calls.push(JSON.parse(opts.body as string).name);
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }),
    );

    const libs = ['Adafruit GFX Library', 'Adafruit SSD1306', 'Servo'];
    for (const lib of libs) await installLibrary(lib);

    expect(calls).toEqual(libs);
  });
});

// ─── 4. getInstalledLibraries service ─────────────────────────────────────────

describe('getInstalledLibraries service', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GETs /api/libraries/list and returns the libraries array', async () => {
    const mockLibs = [
      { library: { name: 'Servo', version: '1.2.1', author: 'Arduino' } },
      { library: { name: 'Adafruit GFX Library', version: '1.11.9', author: 'Adafruit' } },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, libraries: mockLibs }),
      }),
    );

    const result = await getInstalledLibraries();
    expect(result).toHaveLength(2);
    expect(result[0].library?.name).toBe('Servo');
    expect(result[1].library?.name).toBe('Adafruit GFX Library');
  });

  it('returns empty array when no libraries are installed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, libraries: [] }),
      }),
    );

    const result = await getInstalledLibraries();
    expect(result).toEqual([]);
  });

  it('throws when the request fails (non-ok response)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ detail: 'Internal server error' }),
      }),
    );

    await expect(getInstalledLibraries()).rejects.toThrow('Internal server error');
  });
});
