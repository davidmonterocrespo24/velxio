/**
 * compileCode() — library injection (SDK-004b).
 *
 * Verifies that the client reads from the host LibraryRegistry, filters
 * entries by board platform, and forwards the validated payload to the
 * backend. The backend itself is mocked via axios so we test the wiring,
 * not the network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getLibraryRegistry,
  resetLibraryRegistryForTests,
} from '../plugin-host/LibraryRegistry';
import type { LibraryDefinition } from '@velxio/sdk';

// ── axios mock (must be hoisted before importing the module under test) ──

vi.mock('axios', () => {
  const post = vi.fn();
  const defaultExport = { post, isAxiosError: () => false };
  return {
    default: defaultExport,
    isAxiosError: () => false,
  };
});

// Imported AFTER the mock above so compileCode picks up the stub.
import axios from 'axios';
import { compileCode } from '../services/compilation';

// ── Helpers ─────────────────────────────────────────────────────────────

function buildLibrary(overrides: Partial<LibraryDefinition>): LibraryDefinition {
  return {
    id: 'TestLib',
    version: '1.0.0',
    files: [{ path: 'TestLib.h', content: '#pragma once\nvoid noop();\n' }],
    platforms: ['avr'],
    ...overrides,
  };
}

const lastPostBody = (): any => {
  const calls = (axios.post as unknown as { mock: { calls: any[][] } }).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1];
};

beforeEach(() => {
  resetLibraryRegistryForTests();
  (axios.post as unknown as { mockClear: () => void }).mockClear();
  (axios.post as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
    status: 200,
    data: {
      success: true,
      hex_content: ':00000001FF\n',
      stdout: '',
      stderr: '',
    },
  });
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('compileCode — library injection', () => {
  it('omits libraries field when registry is empty', async () => {
    await compileCode([{ name: 'sketch.ino', content: 'void setup(){}' }], 'arduino:avr:uno');
    const body = lastPostBody();
    expect(body.libraries).toBeUndefined();
    expect(body.board_fqbn).toBe('arduino:avr:uno');
  });

  it('forwards libraries that match the active board platform', async () => {
    getLibraryRegistry().registerFromPlugin(
      buildLibrary({ id: 'AvrLib', platforms: ['avr'] }),
      'plugin-a',
    );
    getLibraryRegistry().registerFromPlugin(
      buildLibrary({ id: 'EspLib', platforms: ['esp32'] }),
      'plugin-b',
    );

    await compileCode(
      [{ name: 'sketch.ino', content: 'void setup(){}' }],
      'arduino:avr:uno',
    );

    const body = lastPostBody();
    expect(Array.isArray(body.libraries)).toBe(true);
    const ids = (body.libraries as Array<{ id: string }>).map((lib) => lib.id);
    expect(ids).toContain('AvrLib');
    expect(ids).not.toContain('EspLib');
  });

  it('strips entries that do not match the platform even when others do', async () => {
    getLibraryRegistry().registerFromPlugin(
      buildLibrary({ id: 'EspOnly', platforms: ['esp32'] }),
      'plugin-a',
    );
    await compileCode(
      [{ name: 'sketch.ino', content: 'void setup(){}' }],
      'arduino:avr:uno',
    );
    expect(lastPostBody().libraries).toBeUndefined();
  });

  it('reduces wire payload to {id, version, files}', async () => {
    getLibraryRegistry().registerFromPlugin(
      buildLibrary({
        id: 'WithExamples',
        platforms: ['avr'],
        examples: [{ name: 'demo', sketch: 'void setup(){}' }],
        dependsOn: ['SomeOther'],
      }),
      'plugin-a',
    );
    await compileCode(
      [{ name: 'sketch.ino', content: 'void setup(){}' }],
      'arduino:avr:uno',
    );
    const lib = (lastPostBody().libraries as Array<Record<string, unknown>>)[0];
    expect(Object.keys(lib).sort()).toEqual(['files', 'id', 'version']);
    const files = lib.files as Array<Record<string, unknown>>;
    expect(Object.keys(files[0]).sort()).toEqual(['content', 'path']);
  });

  it('resolves transitive dependencies via the registry topo sort', async () => {
    getLibraryRegistry().registerFromPlugin(
      buildLibrary({ id: 'Core', platforms: ['avr'], files: [{ path: 'Core.h', content: '#pragma once\n' }] }),
      'plugin-a',
    );
    getLibraryRegistry().registerFromPlugin(
      buildLibrary({
        id: 'Wrapper',
        platforms: ['avr'],
        dependsOn: ['Core'],
        files: [{ path: 'Wrapper.h', content: '#pragma once\n' }],
      }),
      'plugin-b',
    );

    await compileCode(
      [{ name: 'sketch.ino', content: 'void setup(){}' }],
      'arduino:avr:uno',
    );

    const ids = (lastPostBody().libraries as Array<{ id: string }>).map((lib) => lib.id);
    // Topological order: Core (dep) first, then Wrapper.
    expect(ids).toEqual(['Core', 'Wrapper']);
  });

  it('maps esp32 board FQBN to the esp32 platform filter', async () => {
    getLibraryRegistry().registerFromPlugin(
      buildLibrary({ id: 'EspLib', platforms: ['esp32'] }),
      'plugin-a',
    );
    getLibraryRegistry().registerFromPlugin(
      buildLibrary({ id: 'AvrLib', platforms: ['avr'] }),
      'plugin-b',
    );

    await compileCode(
      [{ name: 'sketch.ino', content: 'void setup(){}' }],
      'esp32:esp32:esp32',
    );

    const ids = (lastPostBody().libraries as Array<{ id: string }>).map((lib) => lib.id);
    expect(ids).toEqual(['EspLib']);
  });

  it('maps rp2040 board FQBN to the rp2040 platform filter', async () => {
    getLibraryRegistry().registerFromPlugin(
      buildLibrary({ id: 'RpLib', platforms: ['rp2040'] }),
      'plugin-a',
    );
    await compileCode(
      [{ name: 'sketch.ino', content: 'void setup(){}' }],
      'rp2040:rp2040:rpipico',
    );
    const ids = (lastPostBody().libraries as Array<{ id: string }>).map((lib) => lib.id);
    expect(ids).toEqual(['RpLib']);
  });

  it('emits no libraries field for an unknown board platform', async () => {
    getLibraryRegistry().registerFromPlugin(
      buildLibrary({ id: 'AvrLib', platforms: ['avr'] }),
      'plugin-a',
    );
    await compileCode(
      [{ name: 'sketch.ino', content: 'void setup(){}' }],
      'esoteric:unknown:weird',
    );
    expect(lastPostBody().libraries).toBeUndefined();
  });
});
