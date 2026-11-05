/**
 * @vitest-environment jsdom
 *
 * Project-only files (utils/projectOnlyFiles): a file an overlay marks as
 * belonging to the project and not to the device stays out of everything that
 * reaches the board. The open-source build marks none, so nothing changes for
 * it; a predicate that throws marks none either, so a broken overlay can never
 * hide a sketch from the compiler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { deviceFiles, isProjectOnlyFile } from '../utils/projectOnlyFiles';
import { buildProjectSdImage } from '../utils/sdCardFiles';
import { readFat16Image } from '../utils/fatImage';
import { fingerprintSources } from '../utils/sourceFingerprint';
import { compileCode } from '../services/compilation';

type Seam = { __velxio_project_only_file__?: (name: string) => boolean };
const seam = globalThis as Seam;

const PROJECT = [
  { name: 'sketch.ino', content: 'void setup(){} void loop(){}' },
  { name: 'data.csv', content: 't,v\n0,1\n' },
  { name: 'world.html', content: '<canvas></canvas>' },
];

afterEach(() => {
  delete seam.__velxio_project_only_file__;
  vi.restoreAllMocks();
});

describe('project-only files', () => {
  it('are none in the open-source build', () => {
    expect(isProjectOnlyFile('world.html')).toBe(false);
    expect(deviceFiles(PROJECT).map((f) => f.name)).toEqual(['sketch.ino', 'data.csv', 'world.html']);
  });

  it('are what the overlay predicate says, by name', () => {
    seam.__velxio_project_only_file__ = (name) => name === 'world.html';
    expect(isProjectOnlyFile('world.html')).toBe(true);
    expect(isProjectOnlyFile('index.html')).toBe(false);
    expect(deviceFiles(PROJECT).map((f) => f.name)).toEqual(['sketch.ino', 'data.csv']);
  });

  it('are none when the predicate throws', () => {
    seam.__velxio_project_only_file__ = () => {
      throw new Error('broken overlay');
    };
    expect(deviceFiles(PROJECT)).toHaveLength(3);
  });

  it('stay off the microSD image', () => {
    const names = (img: Uint8Array) => readFat16Image(img).map((f) => f.name.toLowerCase());
    expect(names(buildProjectSdImage(PROJECT))).toContain('world.html');
    seam.__velxio_project_only_file__ = (name) => name === 'world.html';
    const after = names(buildProjectSdImage(PROJECT));
    expect(after).not.toContain('world.html');
    expect(after).toContain('data.csv');
  });

  it('do not make the last build stale when edited', () => {
    seam.__velxio_project_only_file__ = (name) => name === 'world.html';
    const board = { languageMode: undefined, boardOptions: undefined } as never;
    const before = fingerprintSources(board, PROJECT);
    const edited = PROJECT.map((f) => (f.name === 'world.html' ? { ...f, content: '<p>moved</p>' } : f));
    expect(fingerprintSources(board, edited)).toBe(before);
    const sketchEdited = PROJECT.map((f) => (f.name === 'sketch.ino' ? { ...f, content: '// x' } : f));
    expect(fingerprintSources(board, sketchEdited)).not.toBe(before);
  });

  it('are not sent to the compiler', async () => {
    seam.__velxio_project_only_file__ = (name) => name === 'world.html';
    const post = vi.spyOn(axios, 'post').mockRejectedValueOnce(new Error('stop here'));
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(false);
    await compileCode(PROJECT, 'arduino:avr:uno').catch(() => undefined);
    const body = post.mock.calls[0]?.[1] as { files: Array<{ name: string }> };
    expect(body.files.map((f) => f.name)).toEqual(['sketch.ino', 'data.csv']);
  });
});
