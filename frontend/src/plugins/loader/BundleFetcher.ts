/**
 * Network fetch for a plugin bundle, with retries and a dev-mode
 * shortcut.
 *
 * In production the loader only ever fetches `https://cdn.velxio.dev/
 * plugins/<id>/<version>/bundle.mjs`. In dev, plugin authors run
 * `velxio-plugin dev` (SDK-009) which serves their bundle at
 * `http://localhost:5180/plugins/<id>/bundle.mjs`. This fetcher
 * tries the dev URL first when the editor is on `localhost`, and
 * falls back to CDN on any error (404, network, etc).
 *
 * Retry policy: 3 attempts total, exponential backoff with jitter
 * (250ms, 750ms, 2250ms baseline). Aborts on 4xx that aren't 408 or
 * 429 — there is no point retrying a permanent 404 or 410.
 */

export interface BundleFetchOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  /**
   * Override `fetch` for tests. The signature mirrors the global —
   * we wrap it in `withTimeout` ourselves.
   */
  readonly fetchImpl?: typeof fetch;
  /** ms before a single attempt is treated as a network failure. */
  readonly timeoutMs?: number;
  /**
   * If true and `window.location.hostname === 'localhost'`, try the
   * dev URL first. Defaults to `true`.
   */
  readonly preferDevServer?: boolean;
  /** Override host name detection for tests. */
  readonly devHost?: string;
}

export interface BundleFetchResult {
  readonly bytes: Uint8Array;
  readonly source: 'cdn' | 'dev';
  readonly url: string;
  readonly attempts: number;
  readonly elapsedMs: number;
}

export class BundleFetchError extends Error {
  override readonly name = 'BundleFetchError';
  constructor(
    readonly url: string,
    readonly cause: unknown,
    readonly attempts: number,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Bundle fetch failed for ${url} after ${attempts} attempt(s): ${reason}`);
  }
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 15_000;

const CDN_BASE = 'https://cdn.velxio.dev/plugins';
const DEV_BASE = 'http://localhost:5180/plugins';

function cdnUrl(id: string, version: string): string {
  return `${CDN_BASE}/${encodeURIComponent(id)}/${encodeURIComponent(version)}/bundle.mjs`;
}

function devUrl(id: string): string {
  return `${DEV_BASE}/${encodeURIComponent(id)}/bundle.mjs`;
}

export async function fetchBundle(
  id: string,
  version: string,
  opts: BundleFetchOptions = {},
): Promise<BundleFetchResult> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const tryDev =
    opts.preferDevServer !== false &&
    isLocalhost(opts.devHost ?? hostname());
  if (tryDev) {
    try {
      const result = await fetchOnce(devUrl(id), fetchImpl, timeoutMs);
      return { bytes: result, source: 'dev', url: devUrl(id), attempts: 1, elapsedMs: Date.now() - startedAt };
    } catch {
      // Fall through to CDN. Dev server may not be running for this
      // plugin id; that is the common case for non-author users.
    }
  }

  const url = cdnUrl(id, version);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const bytes = await fetchOnce(url, fetchImpl, timeoutMs);
      return { bytes, source: 'cdn', url, attempts: i + 1, elapsedMs: Date.now() - startedAt };
    } catch (err) {
      lastErr = err;
      if (isFatalHttp(err)) break;
      if (i < attempts - 1) {
        await sleep(jitter(baseDelayMs * Math.pow(3, i)));
      }
    }
  }
  throw new BundleFetchError(url, lastErr, attempts);
}

async function fetchOnce(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Uint8Array> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { credentials: 'omit', signal: ctl.signal });
    if (!res.ok) {
      throw new HttpStatusError(url, res.status, res.statusText);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } finally {
    clearTimeout(timer);
  }
}

class HttpStatusError extends Error {
  override readonly name = 'HttpStatusError';
  constructor(readonly url: string, readonly status: number, readonly statusText: string) {
    super(`${status} ${statusText} for ${url}`);
  }
}

function isFatalHttp(err: unknown): boolean {
  if (!(err instanceof HttpStatusError)) return false;
  // Retry: 408 (request timeout) and 429 (too many requests). Everything
  // else in 4xx is permanent — retrying doesn't help.
  if (err.status === 408 || err.status === 429) return false;
  return err.status >= 400 && err.status < 500;
}

function jitter(ms: number): number {
  // Full jitter — drawn from [0, ms]. Smooths thundering herd on
  // simultaneous CDN failures.
  return Math.floor(Math.random() * ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hostname(): string {
  if (typeof window === 'undefined') return '';
  return window.location.hostname;
}

function isLocalhost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
