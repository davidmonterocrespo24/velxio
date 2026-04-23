/**
 * Build-time configuration for the marketplace client.
 *
 * The discovery URL is `${VITE_VELXIO_MARKETPLACE_BASE_URL}/.well-known/velxio-marketplace.json`.
 * Setting the env var to an empty string at build time fully disables
 * the marketplace UI — useful for self-hosted installs that don't want
 * to ping velxio.dev at all.
 */

const DEFAULT_BASE_URL = 'https://api.velxio.dev';

interface ImportMetaEnvLike {
  readonly VITE_VELXIO_MARKETPLACE_BASE_URL?: string;
}

/**
 * Returns the configured base URL, or `null` when the marketplace is
 * disabled (env var explicitly set to empty string).
 *
 * Falls back to {@link DEFAULT_BASE_URL} when the env var is missing
 * (i.e. the dev forgot to set it — the public hosted Core uses the
 * default). Returns `null` only on explicit empty-string opt-out so
 * that a typo doesn't silently disable the marketplace.
 */
export function getMarketplaceBaseUrl(env?: ImportMetaEnvLike): string | null {
  const raw = (env ?? readImportMetaEnv())?.VITE_VELXIO_MARKETPLACE_BASE_URL;
  if (raw === undefined || raw === null) {
    return DEFAULT_BASE_URL;
  }
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  return trimmed.replace(/\/+$/, '');
}

function readImportMetaEnv(): ImportMetaEnvLike | undefined {
  // Wrapped so test files can call this without depending on Vite's
  // `import.meta.env` injection. In production Vite replaces this at
  // build time; in vitest it's polyfilled.
  try {
    return (import.meta as unknown as { env?: ImportMetaEnvLike }).env;
  } catch {
    return undefined;
  }
}

/** Resolves the discovery URL the Core should probe, or `null` when disabled. */
export function getDiscoveryUrl(env?: ImportMetaEnvLike): string | null {
  const base = getMarketplaceBaseUrl(env);
  if (base === null) return null;
  return `${base}/.well-known/velxio-marketplace.json`;
}
