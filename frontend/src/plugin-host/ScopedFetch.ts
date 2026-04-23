/**
 * Scoped `fetch` for plugins.
 *
 * Plugins only see the host's network through this wrapper. The wrapper:
 *
 *   - Rejects any URL that is not a `https://` prefix-match of the manifest's
 *     `http.allowlist`. Throws `HttpAllowlistDeniedError` synchronously.
 *   - Strips credentials (`credentials: 'omit'`) so the user's session cookies
 *     never leak to a third-party host.
 *   - Tags every request with `X-Velxio-Plugin: <id>@<version>` and overrides
 *     `User-Agent` so the upstream knows which plugin is calling. Useful for
 *     rate-limit attribution and abuse triage.
 *   - Caps response body at 4 MB to prevent a malicious or sloppy plugin from
 *     pulling a giant payload into the editor's tab.
 *
 * The underlying `fetch` is injectable so tests can drive it without going
 * through real DNS / network. Production wires `globalThis.fetch`.
 */

import {
  HttpAllowlistDeniedError,
  HttpResponseTooLargeError,
  type ScopedFetch,
  type PluginManifest,
} from '@velxio/sdk';

/** 4 MB cap on response body. */
export const SCOPED_FETCH_MAX_BYTES = 4 * 1024 * 1024;

export interface ScopedFetchOptions {
  /** Underlying fetch. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Override the byte cap for tests. */
  readonly maxBytes?: number;
}

/**
 * Build a `ScopedFetch` for a specific plugin manifest. The returned function
 * has the same shape as the SDK type, but its closure carries the allowlist
 * + plugin id so the call site doesn't have to repeat them.
 */
export function createScopedFetch(
  manifest: PluginManifest,
  options: ScopedFetchOptions = {},
): ScopedFetch {
  const allowlist = manifest.http?.allowlist ?? [];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? SCOPED_FETCH_MAX_BYTES;

  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (!isUrlAllowed(url, allowlist)) {
      throw new HttpAllowlistDeniedError(url, allowlist);
    }

    const headers: Record<string, string> = {
      ...(init?.headers ?? {}),
      'X-Velxio-Plugin': `${manifest.id}@${manifest.version}`,
    };
    // We can't reliably override User-Agent in the browser (it's a forbidden
    // header), but on Node/test environments it goes through. Set it anyway.
    if (typeof process !== 'undefined') {
      headers['User-Agent'] = `Velxio-Plugin/${manifest.id}`;
    }

    const response = await fetchImpl(url, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
      credentials: 'omit',
    });

    return wrapWithSizeCap(url, response, maxBytes);
  };
}

/**
 * Allowlist match: every entry must be an `https://` URL prefix. A request
 * URL is allowed if `requestUrl.startsWith(entry)`. Plain `http://` is never
 * allowed even if explicitly listed (defense-in-depth).
 */
function isUrlAllowed(url: string, allowlist: ReadonlyArray<string>): boolean {
  if (!url.startsWith('https://')) return false;
  return allowlist.some((entry) => entry.startsWith('https://') && url.startsWith(entry));
}

/**
 * Wrap a Response so reading the body fails if it exceeds the cap.
 *
 * Two layers of enforcement:
 *
 *   1. **Upfront** — if `Content-Length` is set and over the cap, refuse
 *      before reading any bytes. Cheapest path; lets a misconfigured
 *      upstream fail fast.
 *   2. **Mid-stream** — wrap `response.body` in a counting `ReadableStream`
 *      that errors as soon as the running total crosses the cap. Handles
 *      the common cases where Content-Length is omitted (chunked transfer
 *      encoding, or a buggy server) or where the server lies about the
 *      length.
 *
 * Bodies without a stream (no `response.body`, or a 204/304) are passed
 * through unchanged — there is nothing to count.
 */
function wrapWithSizeCap(url: string, response: Response, maxBytes: number): Response {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpResponseTooLargeError(url, declared, maxBytes);
    }
  }

  // No body to count (e.g. 204 No Content, HEAD response). Pass through.
  if (response.body === null) return response;

  const limited = capByteStream(url, response.body, maxBytes);
  // `Response` constructor copies headers but does not preserve `url` or
  // `redirected` — but plugins can read them via the `url` property of the
  // outer fetch promise; we don't try to restore them here. The status,
  // statusText, and headers are what matters for `.json()`/`.text()` etc.
  return new Response(limited, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Counting transform: enqueues each chunk through and errors the stream
 * the first time the running total exceeds `maxBytes`. Cancels the source
 * reader on error so we don't keep pulling bytes we'll never use.
 */
function capByteStream(
  url: string,
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          total += value.byteLength;
          if (total > maxBytes) {
            controller.error(new HttpResponseTooLargeError(url, total, maxBytes));
            await reader.cancel().catch(() => {});
            return;
          }
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
        await reader.cancel().catch(() => {});
      }
    },
  });
}
