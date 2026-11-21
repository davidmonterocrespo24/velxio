/**
 * Library-manifest helpers — pure functions, no store imports.
 *
 * Why this exists (2026-08 library-contamination investigation): 79% of
 * projects compile with an EMPTY manifest, which forces the backend into
 * scan-all resolution over ~1000 shared libraries — the mode where an
 * unrelated library can be dragged into the build. Rather than ever
 * breaking those projects, the backend now reports the libraries a
 * successful scan-all build actually used (`manifest_suggested_libraries`,
 * shape { header: [candidateNames] }), and the frontend folds them into the
 * board's declared manifest here. One green build = one migrated project.
 */

/** Library-name normalization, mirroring the backend's `_norm_lib_name`:
 * lowercase, alphanumerics only, so "Adafruit GFX Library",
 * "Adafruit_GFX_Library" and "adafruitgfxlibrary" all compare equal. */
export function normalizeLibName(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Strip a trailing "@version" from a spec ("DHT sensor library@1.4.6"). */
export function bareLibName(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

export function libraryVersionFromSpec(spec: string): string | undefined {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(at + 1).trim() || undefined : undefined;
}

/**
 * Merge the backend's suggested libraries into the current manifest.
 *
 * Conservative by design:
 *  - only entries with EXACTLY ONE candidate are taken (an ambiguous
 *    suggestion must never guess its way into the manifest);
 *  - names already present (normalized comparison) are skipped;
 *  - returns `null` when there is nothing new, so callers can cheaply
 *    detect "no change" and avoid a store write / autosave churn.
 */
export function mergeSuggestedLibraries(
  current: string[] | undefined,
  suggested: Record<string, string[]> | null | undefined,
): string[] | null {
  if (!suggested) return null;
  const have = new Set((current ?? []).map((spec) => normalizeLibName(bareLibName(spec))));
  const additions: string[] = [];
  for (const candidates of Object.values(suggested)) {
    if (!Array.isArray(candidates) || candidates.length !== 1) continue;
    const name = String(candidates[0] ?? '').trim();
    if (!name) continue;
    const norm = normalizeLibName(bareLibName(name));
    if (!norm || have.has(norm)) continue;
    have.add(norm);
    additions.push(name);
  }
  if (!additions.length) return null;
  return [...(current ?? []), ...additions];
}

/**
 * Add one just-installed library to a manifest (install-declares flow).
 * Returns `null` when it is already declared.
 */
export function addLibraryToManifest(
  current: string[] | undefined,
  spec: string,
): string[] | null {
  const name = bareLibName(spec).trim();
  if (!name) return null;
  const norm = normalizeLibName(name);
  const entries = current ?? [];
  const version = libraryVersionFromSpec(spec);
  const existing = entries.findIndex((entry) => normalizeLibName(bareLibName(entry)) === norm);
  if (existing === -1) return [...entries, version ? spec.trim() : name];
  if (!version || libraryVersionFromSpec(entries[existing])) return null;
  return entries.map((entry, index) => index === existing ? spec.trim() : entry);
}

/** Remove a library from a manifest (uninstall flow). Null = no change. */
export function removeLibraryFromManifest(
  current: string[] | undefined,
  spec: string,
): string[] | null {
  if (!current?.length) return null;
  const norm = normalizeLibName(bareLibName(spec));
  const next = current.filter((n) => normalizeLibName(bareLibName(n)) !== norm);
  return next.length === current.length ? null : next;
}
