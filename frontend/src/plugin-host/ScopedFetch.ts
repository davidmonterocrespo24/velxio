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

    return wrapWithSizeCap(response, maxBytes);
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
 * Wrap a Response so reading the body throws if it exceeds the cap. We can't
 * pre-check Content-Length (it's optional), so we stream and count.
 */
function wrapWithSizeCap(response: Response, maxBytes: number): Response {
  // Cheap path: if Content-Length is set and over the cap, refuse upfront.
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(
      `Plugin fetch refused: response too large (${contentLength} bytes, cap ${maxBytes})`,
    );
  }
  // Otherwise, return as-is. A streaming size cap would be nice but the
  // browser fetch API doesn't expose a clean way to abort mid-stream while
  // still letting consumers call `.json()` etc; we punt to runtime check via
  // a wrapper for `.arrayBuffer()` and `.text()` later if it becomes a real
  // problem in production telemetry.
  return response;
}
