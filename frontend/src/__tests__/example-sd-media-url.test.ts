// @vitest-environment jsdom
/**
 * Example SD files named by URL.
 *
 * A gallery example can pre-load a board's built-in microSD. Inline base64
 * is fine for a text file, but a music player's MP3s would ride in the main
 * bundle of every visitor; so an entry may name a `url` instead, and the
 * loader fetches it when the example opens, storing the bytes on the board in
 * the same shape an inline file (or the SD Card panel) produces.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  resolveExamplePartSdFiles,
  resolveExampleSdFiles,
  b64ToBytes,
} from '../utils/sdCardFiles';
import { loadExample } from '../utils/loadExample';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { ExampleProject } from '../data/examples';

const respond = (bytes: number[], status = 200) =>
  Promise.resolve(new Response(new Uint8Array(bytes), { status }));

describe('resolveExampleSdFiles', () => {
  it('passes inline files through untouched', async () => {
    const fetcher = vi.fn();
    const out = await resolveExampleSdFiles([{ name: 'a.txt', contentB64: 'aGk=' }], fetcher);
    expect(out).toEqual([{ name: 'a.txt', contentB64: 'aGk=' }]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches a url entry and stores its bytes as base64', async () => {
    const fetcher = vi.fn(() => respond([0x49, 0x44, 0x33, 0x00, 0xff]));
    const out = await resolveExampleSdFiles([{ name: 'SONG.MP3', url: '/examples-media/x/SONG.MP3' }], fetcher);
    expect(fetcher).toHaveBeenCalledWith('/examples-media/x/SONG.MP3');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('SONG.MP3');
    expect(Array.from(b64ToBytes(out[0].contentB64))).toEqual([0x49, 0x44, 0x33, 0x00, 0xff]);
  });

  it('keeps the order of the entries', async () => {
    const fetcher = vi.fn((url: string) => respond(url.endsWith('1') ? [1] : [2]));
    const out = await resolveExampleSdFiles(
      [
        { name: 'one', url: '/m/1' },
        { name: 'inline', contentB64: 'AA==' },
        { name: 'two', url: '/m/2' },
      ],
      fetcher,
    );
    expect(out.map((f) => f.name)).toEqual(['one', 'inline', 'two']);
  });

  it('leaves a file that cannot be fetched off the card instead of failing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = vi.fn((url: string) => (url.includes('gone') ? respond([], 404) : respond([7])));
    const out = await resolveExampleSdFiles(
      [
        { name: 'gone.mp3', url: '/m/gone.mp3' },
        { name: 'ok.mp3', url: '/m/ok.mp3' },
      ],
      fetcher,
    );
    expect(out.map((f) => f.name)).toEqual(['ok.mp3']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is empty for a board with no SD files', async () => {
    expect(await resolveExampleSdFiles(undefined)).toEqual([]);
  });
});

describe('a part that carries its own microSD', () => {
  it('fetches the url files of a part and leaves the other parts as they are', async () => {
    const fetcher = vi.fn(() => respond([0x49, 0x44, 0x33]));
    const plain = { id: 'led1', properties: { color: 'red' } };
    const inline = { id: 'sd1', properties: { sdFiles: [{ name: 'a.txt', contentB64: 'aGk=' }] } };
    const out = await resolveExamplePartSdFiles(
      [
        plain,
        inline,
        {
          id: 'disp',
          properties: { tilt: 1, sdFiles: [{ name: 'A.MP3', url: '/examples-media/x/A.MP3' }] },
        },
      ],
      fetcher,
    );
    expect(out[0]).toBe(plain);
    expect(out[1]).toBe(inline);
    expect(out[2]).toEqual({
      id: 'disp',
      properties: { tilt: 1, sdFiles: [{ name: 'A.MP3', contentB64: 'SUQz' }] },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('loadExample puts the fetched bytes on the part', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = vi.fn((input: RequestInfo | URL) =>
      String(input).includes('/examples-media/') ? respond([0x49, 0x44, 0x33]) : respond([], 404),
    ) as never;
    try {
      const example = (boards: boolean) =>
        ({
          id: 'sd-part',
          title: 't',
          description: '',
          category: 'basics',
          difficulty: 'beginner',
          code: 'void setup(){}\nvoid loop(){}',
          ...(boards ? { boards: [{ boardKind: 'arduino-uno', x: 0, y: 0, code: 'void setup(){}' }] } : {}),
          components: [
            {
              type: 'microsd-card',
              id: 'card',
              x: 300,
              y: 60,
              properties: { sdFiles: [{ name: 'A.MP3', url: '/examples-media/x/A.MP3' }] },
            },
          ],
          wires: [],
        }) as unknown as ExampleProject;
      for (const boards of [true, false]) {
        await loadExample(example(boards));
        const part = useSimulatorStore.getState().components.find((c) => c.id === 'card');
        expect(part?.properties.sdFiles).toEqual([{ name: 'A.MP3', contentB64: 'SUQz' }]);
      }
    } finally {
      globalThis.fetch = real;
    }
  });
});
