/**
 * Tiny semver range checker — covers the subset Pro emits for plugin
 * licenses. Avoids pulling the full `semver` npm dep (which is large
 * and would bloat the editor bundle for one function).
 *
 * Supported range syntax:
 *   - exact:    "1.2.3"
 *   - caret:    "^1.2.3"   → >=1.2.3 <2.0.0   (special-cases 0.x as locked-minor)
 *   - tilde:    "~1.2.3"   → >=1.2.3 <1.3.0
 *   - wildcard: "1.2.x"  /  "1.x"  /  "*"
 *
 * Pre-release versions (`1.2.3-rc.1`) are intentionally rejected — the
 * marketplace does not sell pre-release plugins.
 */

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(input: string): ParsedVersion | null {
  const m = VERSION_RE.exec(input);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Returns true when `version` satisfies the `range`.
 *
 * Returns false on any malformed input — the verifier treats that as
 * `wrong-version` rather than a thrown exception, since malformed
 * version strings are an attestation problem (Pro emitted bad data).
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (v === null) return false;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return true;

  // Wildcard: "1.x", "1.2.x" — strip ".x" to derive a tilde-equivalent.
  if (/\.x$/i.test(trimmed)) {
    const base = trimmed.replace(/(?:\.x)+$/i, '');
    const parts = base.split('.');
    if (parts.length === 1) {
      const major = Number(parts[0]);
      return Number.isFinite(major) && v.major === major;
    }
    if (parts.length === 2) {
      const major = Number(parts[0]);
      const minor = Number(parts[1]);
      return Number.isFinite(major) && Number.isFinite(minor) && v.major === major && v.minor === minor;
    }
    return false;
  }

  if (trimmed.startsWith('^')) {
    const base = parseVersion(trimmed.slice(1).trim());
    if (base === null) return false;
    if (compareVersions(v, base) < 0) return false;
    // Caret semantics special-case 0.x and 0.0.y the way npm does:
    // ^0.2.3 ≡ >=0.2.3 <0.3.0; ^0.0.3 ≡ >=0.0.3 <0.0.4.
    if (base.major > 0) return v.major === base.major;
    if (base.minor > 0) return v.major === 0 && v.minor === base.minor;
    return v.major === 0 && v.minor === 0 && v.patch === base.patch;
  }

  if (trimmed.startsWith('~')) {
    const base = parseVersion(trimmed.slice(1).trim());
    if (base === null) return false;
    if (compareVersions(v, base) < 0) return false;
    return v.major === base.major && v.minor === base.minor;
  }

  // Exact match — also accept a leading `=`.
  const exact = parseVersion(trimmed.startsWith('=') ? trimmed.slice(1).trim() : trimmed);
  if (exact === null) return false;
  return compareVersions(v, exact) === 0;
}
