// @vitest-environment jsdom
/**
 * BundleFetcher tests — inject `fetchImpl` so we can simulate CDN
 * outages, 4xx errors, dev-server hits, and timeouts without touching
 * the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BundleFetchError,
  fetchBundle,
} from '../plugins/loader/BundleFetcher';

afterEach(() => {
  vi.useRealTimers();
});

function ok(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, statusText: 'OK' });
}

function notFound(): Response {
  return new Response('not found', { status: 404, statusText: 'Not Found' });
}

function server500(): Response {
  return new Response('boom', { status: 500, statusText: 'Server Error' });
}

describe('BundleFetcher · happy path', () => {
  it('fetches from CDN when dev server is disabled', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi.fn().mockResolvedValue(ok(bytes));
    const result = await fetchBundle('my.plugin', '1.0.0', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      preferDevServer: false,
    });
    expect(result.source).toBe('cdn');
    expect(result.url).toBe('https://cdn.velxio.dev/plugins/my.plugin/1.0.0/bundle.mjs');
    expect(result.attempts).toBe(1);
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
  });

  it('hits dev server first when on localhost', async () => {
    const bytes = new Uint8Array([9, 9]);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('http://localhost:5180/')) return ok(bytes);
      throw new Error('should not have hit cdn');
    });
    const result = await fetchBundle('my.plugin', '1.0.0', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      devHost: 'localhost',
    });
    expect(result.source).toBe('dev');
    expect(result.url).toBe('http://localhost:5180/plugins/my.plugin/bundle.mjs');
  });

  it('falls back to CDN when dev server 404s', async () => {
    const bytes = new Uint8Array([7]);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('http://localhost:5180/')) return notFound();
      return ok(bytes);
    });
    const result = await fetchBundle('my.plugin', '1.0.0', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      devHost: 'localhost',
    });
    expect(result.source).toBe('cdn');
    expect(result.attempts).toBe(1);
  });
});

describe('BundleFetcher · retries and errors', () => {
  it('retries on 5xx with exponential backoff', async () => {
    const bytes = new Uint8Array([1]);
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) return server500();
      return ok(bytes);
    });
    const result = await fetchBundle('my.plugin', '1.0.0', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      preferDevServer: false,
      baseDelayMs: 1, // keep the test fast
    });
    expect(result.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it('does NOT retry on permanent 4xx (404)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(notFound());
    await expect(
      fetchBundle('my.plugin', '1.0.0', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        preferDevServer: false,
        baseDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(BundleFetchError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('DOES retry on 429 (rate limit)', async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) return new Response('slow down', { status: 429, statusText: 'Too Many Requests' });
      return ok(new Uint8Array([1]));
    });
    const result = await fetchBundle('my.plugin', '1.0.0', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      preferDevServer: false,
      baseDelayMs: 1,
    });
    expect(result.attempts).toBe(2);
  });

  it('throws BundleFetchError after exhausting retries on persistent 5xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(server500());
    await expect(
      fetchBundle('my.plugin', '1.0.0', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        preferDevServer: false,
        attempts: 2,
        baseDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(BundleFetchError);
  });

  it('aborts a single attempt that exceeds timeoutMs', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit | undefined) => {
      // Hang until aborted.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }
      });
    });
    await expect(
      fetchBundle('my.plugin', '1.0.0', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        preferDevServer: false,
        attempts: 1,
        timeoutMs: 30,
        baseDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(BundleFetchError);
  });
});
