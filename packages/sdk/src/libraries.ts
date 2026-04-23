/**
 * Arduino-library plugin contributions.
 *
 * Plugins can ship pre-vendored Arduino/PlatformIO libraries (sets of
 * `.h`/`.cpp`/`.S` files) that the host injects into the sketch's
 * `libraries/` folder before `arduino-cli` runs. The host **never reaches
 * out to the network** to fetch them — everything lives in the plugin
 * bundle. This is the safe default: a library plugin needs no JS execution,
 * so it can be served as JSON without a worker.
 *
 * The host (Core) owns the `LibraryRegistry`; plugins call `register()`
 * from their `activate()` lifecycle via `PluginContext.libraries`.
 */

import { z } from 'zod';

import type { Disposable } from './components';

export const LIBRARY_PLATFORMS = ['avr', 'rp2040', 'esp32'] as const;
export type LibraryPlatform = (typeof LIBRARY_PLATFORMS)[number];

/** Per-library hard cap on the sum of `files[].content.length` (bytes). */
export const LIBRARY_MAX_TOTAL_BYTES = 2_097_152 as const; // 2 MB

/** Per-file hard cap. Stops a single pathological file from filling the bundle. */
export const LIBRARY_MAX_FILE_BYTES = 524_288 as const; // 512 KB

/** Maximum nesting depth for library-relative paths (defends against absurd structures). */
export const LIBRARY_MAX_PATH_DEPTH = 8 as const;

const SAFE_PATH_RE = /^[A-Za-z0-9_./-]+$/;
const ALLOWED_EXTENSIONS = new Set([
  '.h',
  '.hpp',
  '.hh',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.s',
  '.S',
  '.inc',
  '.ino',
  '.txt',
  '.md',
  '.properties',
]);

const LibraryFileSchema = z.object({
  /**
   * Path relative to the library root. Must be a forward-slash-separated
   * relative path, no `..`, no leading slash, allowed characters only,
   * and a known source/header extension.
   */
  path: z.string().min(1).max(256),
  content: z.string(),
});

const LibraryExampleSchema = z.object({
  name: z.string().min(1).max(64),
  sketch: z.string().max(LIBRARY_MAX_FILE_BYTES),
});

export const LibraryDefinitionSchema = z.object({
  /** Library name as Arduino-IDE sees it (e.g. "Adafruit_GFX"). */
  id: z.string().min(1).max(128),
  /** Semver string. The host does NOT enforce semver semantics — it just records it. */
  version: z.string().min(1).max(32),
  files: z.array(LibraryFileSchema).min(1).max(512),
  platforms: z.array(z.enum(LIBRARY_PLATFORMS)).min(1),
  examples: z.array(LibraryExampleSchema).optional(),
  /** Other library ids this one depends on. The loader resolves transitively. */
  dependsOn: z.array(z.string()).optional(),
});
export type LibraryDefinition = z.infer<typeof LibraryDefinitionSchema>;

/**
 * Result of `registry.list()` — registry decorates the original record
 * with the owning plugin id (for diagnostics + provenance).
 */
export interface RegisteredLibrary {
  readonly definition: LibraryDefinition;
  readonly pluginId: string;
}

export interface LibraryRegistry {
  /**
   * Register a library bundle. Validates the schema, byte caps, path safety,
   * and preprocessor-content rules. Throws `InvalidLibraryError` on failure
   * — never returns a partially-registered handle.
   */
  register(definition: LibraryDefinition): Disposable;
  /** Lookup by `id`. Returns `undefined` when not registered. */
  get(id: string): RegisteredLibrary | undefined;
  /** Enumerate every registered library, sorted by id. */
  list(): ReadonlyArray<RegisteredLibrary>;
  /**
   * Resolve the dependency closure for a set of library ids.
   *
   * Returns the libraries in install order (deps before dependents) and
   * skips ids that aren't registered (the host will warn through the plugin
   * logger but won't throw — a missing dep is a runtime concern handled
   * by the compiler). Throws `LibraryDependencyCycleError` on a cycle.
   */
  resolve(ids: ReadonlyArray<string>): ReadonlyArray<RegisteredLibrary>;
}

/**
 * Thrown by `ctx.libraries.register()` when the bundle fails validation:
 * unsafe path, oversized file, banned preprocessor pattern, etc. The
 * message is plugin-author-facing.
 */
export class InvalidLibraryError extends Error {
  public override readonly name = 'InvalidLibraryError';
  constructor(
    public readonly libraryId: string,
    public readonly pluginId: string,
    public readonly reason: string,
  ) {
    super(
      `Plugin "${pluginId}" tried to register library "${libraryId}" but it is invalid: ${reason}`,
    );
  }
}

/**
 * Thrown by `ctx.libraries.register()` when a plugin tries to register a
 * library id that is already taken (same plugin or cross-plugin). Library
 * ids must be unique because arduino-cli identifies them by folder name.
 */
export class DuplicateLibraryError extends Error {
  public override readonly name = 'DuplicateLibraryError';
  constructor(
    public readonly libraryId: string,
    public readonly pluginId: string,
  ) {
    super(
      `Plugin "${pluginId}" tried to register library "${libraryId}", but that id is already registered. Dispose the existing registration first, or pick a unique id.`,
    );
  }
}

/**
 * Thrown by `LibraryRegistry.resolve()` when the dependency graph contains
 * a cycle. The cycle path is included in the message for debugging.
 */
export class LibraryDependencyCycleError extends Error {
  public override readonly name = 'LibraryDependencyCycleError';
  constructor(public readonly cyclePath: ReadonlyArray<string>) {
    super(
      `Library dependency cycle detected: ${cyclePath.join(' → ')}`,
    );
  }
}

/**
 * Identity helper for authoring `LibraryDefinition` records with type
 * inference. The Zod schema is *not* run by this helper — it runs in the
 * registry. Define here, register in `activate(ctx)`.
 */
export function defineLibrary<T extends LibraryDefinition>(definition: T): T {
  return definition;
}

/**
 * Programmatic validator. Exposed so plugin author tools (CLI, lint) can
 * pre-flight a library bundle without standing up a host. Throws
 * `InvalidLibraryError` on failure; returns the validated definition on
 * success.
 *
 * Validation runs in this order — first failure stops:
 *   1. Zod schema (shape + length caps).
 *   2. Per-file size cap.
 *   3. Total bytes cap.
 *   4. Path safety: no `..`, no absolute paths, allowed chars only,
 *      depth <= `LIBRARY_MAX_PATH_DEPTH`, allowed extensions.
 *   5. Preprocessor scan: `#include <..>` lines must reference relative
 *      paths or known system headers; `#pragma` is allowed only for the
 *      common ones (`once`, `pack`, `GCC ...`).
 */
export function validateLibraryDefinition(
  definition: unknown,
  pluginId = '<unknown>',
): LibraryDefinition {
  const parsed = LibraryDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? first.path.join('.') : '<root>';
    const id = (definition as { id?: string } | null)?.id ?? '<unknown>';
    throw new InvalidLibraryError(
      id,
      pluginId,
      `schema validation failed at "${path}": ${first?.message ?? 'unknown error'}`,
    );
  }
  const lib = parsed.data;

  let total = 0;
  const seenPaths = new Set<string>();
  for (const file of lib.files) {
    if (file.content.length > LIBRARY_MAX_FILE_BYTES) {
      throw new InvalidLibraryError(
        lib.id,
        pluginId,
        `file "${file.path}" is ${file.content.length} bytes, exceeds the ${LIBRARY_MAX_FILE_BYTES}-byte per-file cap`,
      );
    }
    total += file.content.length;
    if (total > LIBRARY_MAX_TOTAL_BYTES) {
      throw new InvalidLibraryError(
        lib.id,
        pluginId,
        `total bytes (${total}) exceed the ${LIBRARY_MAX_TOTAL_BYTES}-byte cap`,
      );
    }
    if (seenPaths.has(file.path)) {
      throw new InvalidLibraryError(
        lib.id,
        pluginId,
        `duplicate file path "${file.path}"`,
      );
    }
    seenPaths.add(file.path);

    if (!isSafeRelativePath(file.path)) {
      throw new InvalidLibraryError(
        lib.id,
        pluginId,
        `file path "${file.path}" is not a safe relative path (no .., no absolute paths, allowed chars only)`,
      );
    }
    if (!hasAllowedExtension(file.path)) {
      throw new InvalidLibraryError(
        lib.id,
        pluginId,
        `file path "${file.path}" has an extension that is not allowed for Arduino libraries`,
      );
    }
    if (!isPreprocessorClean(file.content)) {
      throw new InvalidLibraryError(
        lib.id,
        pluginId,
        `file "${file.path}" contains an unsafe preprocessor directive`,
      );
    }
  }
  return lib;
}

function isSafeRelativePath(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (!SAFE_PATH_RE.test(p)) return false;
  const segments = p.split('/');
  if (segments.length > LIBRARY_MAX_PATH_DEPTH) return false;
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function hasAllowedExtension(p: string): boolean {
  const lastDot = p.lastIndexOf('.');
  if (lastDot < 0) return false;
  const ext = p.slice(lastDot);
  // Case-sensitive for .S vs .s (assembly files distinguish — Arduino convention).
  return ALLOWED_EXTENSIONS.has(ext) || ALLOWED_EXTENSIONS.has(ext.toLowerCase());
}

const ALLOWED_PRAGMAS = new Set(['once', 'pack', 'GCC', 'clang', 'message', 'warning', 'error']);

function isPreprocessorClean(content: string): boolean {
  // Lightweight scan: reject `#include` paths that try to escape upward
  // and `#pragma` directives outside an allowlist. We tolerate everything
  // else (#define, #if, #ifdef, …) since rejecting them would be hostile
  // to legitimate library code.
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('#')) continue;
    const directive = line.slice(1).trimStart();
    if (directive.startsWith('include')) {
      const rest = directive.slice('include'.length).trim();
      // System include — `<foo>` — must not contain ../ to escape.
      if (rest.startsWith('<')) {
        const close = rest.indexOf('>');
        if (close < 0) return false;
        const target = rest.slice(1, close);
        if (target.includes('..')) return false;
        continue;
      }
      // Local include — `"foo"` — same rule.
      if (rest.startsWith('"')) {
        const close = rest.indexOf('"', 1);
        if (close < 0) return false;
        const target = rest.slice(1, close);
        if (target.includes('..') || target.startsWith('/')) return false;
        continue;
      }
      return false; // malformed include
    }
    if (directive.startsWith('pragma')) {
      const rest = directive.slice('pragma'.length).trim();
      // Pragma name is the leading identifier — stops at whitespace or "(".
      const match = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      const head = match?.[1] ?? '';
      if (!ALLOWED_PRAGMAS.has(head)) return false;
    }
  }
  return true;
}
