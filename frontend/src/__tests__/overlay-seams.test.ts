/**
 * @vitest-environment jsdom
 *
 * The client half of the overlay seams (project/gallery-libraries-2026-09,
 * P2.OSS-hooks): the manifest reaches the server in three states, a
 * refusal body is shaped for the editor whatever the server sent, a server
 * that is still starting is waited for rather than reported as a failed
 * compile, and the on-load library install steps aside only when the server
 * says it provides the gallery set itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  compileCode,
  compileResultFromErrorBody,
  isServerStarting,
  manifestFieldFor,
} from '../services/compilation';
import {
  resetGalleryLibrariesGateForTest,
  serverProvidesGalleryLibraries,
} from '../services/galleryLibrariesGate';

describe('manifest field, three-state', () => {
  it('omits an undeclared manifest, keeps a declared-empty one, passes a list through', () => {
    expect(manifestFieldFor(undefined)).toBeNull();
    expect(manifestFieldFor(null)).toBeNull();
    expect(manifestFieldFor([])).toEqual([]);
    expect(manifestFieldFor(['DHT sensor library@1.4.4'])).toEqual(['DHT sensor library@1.4.4']);
  });
});

describe('refusal bodies', () => {
  it('passes a CompileResult-shaped body through', () => {
    const body = { success: false, error: 'DHT.h twice', stderr: '', ambiguous_headers: { 'DHT.h': ['a', 'b'] } };
    expect(compileResultFromErrorBody(body)).toBe(body);
  });
  it('maps a FastAPI {detail} body to a failed result the editor can render', () => {
    expect(compileResultFromErrorBody({ detail: 'Sign in to compile.' })).toMatchObject({ success: false, error: 'Sign in to compile.' });
    expect(compileResultFromErrorBody({ detail: [{ loc: ['body', 'files'], msg: 'field required' }] }).error).toContain('field required');
    expect(compileResultFromErrorBody('nonsense')).toMatchObject({ success: false });
  });
  it('knows which statuses mean "starting"', () => {
    expect(isServerStarting(502)).toBe(true);
    expect(isServerStarting(503)).toBe(true);
    expect(isServerStarting(500)).toBe(false);
    expect(isServerStarting(undefined)).toBe(false);
  });
});

describe('a server that is still starting', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is waited for, then the job is taken', async () => {
    const starting = Object.assign(new Error('503'), {
      isAxiosError: true,
      response: { status: 503, data: { success: false, error: 'seeding' }, headers: { 'retry-after': '1' } },
    });
    const post = vi
      .spyOn(axios, 'post')
      .mockRejectedValueOnce(starting)
      .mockRejectedValueOnce(starting)
      .mockResolvedValueOnce({ data: { job_id: 'job-1' } } as never);
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    const get = vi.spyOn(axios, 'get').mockResolvedValue({
      data: { state: 'done', result: { success: true, stdout: '', stderr: '' } },
    } as never);
    const progress: string[] = [];
    const p = compileCode([{ name: 'a.ino', content: '' }], 'arduino:avr:uno', null, (i) => progress.push(i.stdout));
    // Two starting answers (1 s each), then the job, then the status poll.
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(1000);
    const result = await p;
    expect(result.success).toBe(true);
    expect(post).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalled();
    expect(progress.some((s) => /Server is starting/.test(s))).toBe(true);
  });

  it('is not confused with a real 4xx refusal', async () => {
    const refused = Object.assign(new Error('422'), {
      isAxiosError: true,
      response: { status: 422, data: { success: false, error: 'DHT.h twice', stderr: '' }, headers: {} },
    });
    vi.spyOn(axios, 'post').mockRejectedValueOnce(refused);
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    const result = await compileCode([{ name: 'a.ino', content: '' }], 'arduino:avr:uno');
    expect(result).toMatchObject({ success: false, error: 'DHT.h twice' });
  });
});

describe('the gallery libraries gate', () => {
  beforeEach(() => resetGalleryLibrariesGateForTest());
  afterEach(() => vi.unstubAllGlobals());

  const health = (body: unknown, ok = true) => {
    const f = vi.fn(async () => ({ ok, json: async () => body }));
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('is true only when /health says the library set is present', async () => {
    health({ status: 'healthy', overlay: 'pro', libraries: { ok: true, since: 1 } });
    expect(await serverProvidesGalleryLibraries()).toBe(true);
  });
  it('is false on the OSS one-word answer, on a degraded set, and on any failure', async () => {
    health({ status: 'healthy' });
    expect(await serverProvidesGalleryLibraries()).toBe(false);
    resetGalleryLibrariesGateForTest();
    health({ status: 'degraded', libraries: { ok: false } }, false);
    expect(await serverProvidesGalleryLibraries()).toBe(false);
    resetGalleryLibrariesGateForTest();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await serverProvidesGalleryLibraries()).toBe(false);
  });
  it('asks once per session', async () => {
    const f = health({ libraries: { ok: true } });
    await serverProvidesGalleryLibraries();
    await serverProvidesGalleryLibraries();
    expect(f).toHaveBeenCalledTimes(1);
  });
});
