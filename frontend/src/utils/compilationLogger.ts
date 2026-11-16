/**
 * Parse a CompileResult into CompilationLog entries for display in the console.
 */

import type { CompileResult } from '../services/compilation';

/** Which run target a log line belongs to — lets the console group output by
 *  board / chip, the way multiple Arduinos already stream. Optional: lines with
 *  no target (e.g. "Compiling all targets...", "Done") render as plain
 *  narration. */
export interface CompileTarget {
  id: string;
  label: string;
  kind: 'board' | 'chip';
}

export interface CompilationLog {
  timestamp: Date;
  type: 'info' | 'success' | 'error' | 'warning' | 'core-install';
  message: string;
  target?: CompileTarget;
}

/** The target of the console's "Circuit check" group: the pre-run findings
 *  and the runtime faults (EditorToolbar). They share the compile log and its
 *  'error' type, and they are not the compiler's. */
export const CIRCUIT_CHECK_TARGET_ID = 'circuit-check';

/** The error lines a compile wrote: every error line but the Circuit check's
 *  (velxio/velxio-prod#222). A short or a burnt LED on a build that compiled
 *  is not a compile to diagnose. */
export function compileErrorCount(logs: CompilationLog[]): number {
  return logs.filter((l) => l.type === 'error' && l.target?.id !== CIRCUIT_CHECK_TARGET_ID).length;
}

/** Build-system chatter with no signal for the user: CMake configure status,
 *  git-metadata probes inside the build container (the tree is a synthesized
 *  project, never a git repo — those "fatal:" lines are expected), IDF
 *  component-manager dependency solving, Python env checks. The full log is
 *  still available server-side; the console only drops these lines. */
const NOISE_LINE_PATTERNS: RegExp[] = [
  /^-- /, // CMake configure status lines
  /^fatal: not a git repository/,
  /^Stopping at filesystem boundary/,
  /^\.*NOTE: /, // IDF component manager (incl. leading progress dots)
  /^warning: unknown kconfig symbol/,
  /^Loading defaults file /,
  /^Constraint file: /,
  /^Requirement files:/,
  /^- \/.*requirements[^ ]*\.txt$/,
  /^Python being checked: /,
  /^Python requirements are satisfied\.?$/,
  /Project commit: HEAD-HASH-NOTFOUND/,
];

export function isNoiseBuildLine(line: string): boolean {
  const stripped = line.trim();
  return NOISE_LINE_PATTERNS.some((re) => re.test(stripped));
}

export function parseCompileResult(
  result: CompileResult,
  board: string,
  target?: CompileTarget,
  /** True when the caller already streamed the live cmake+ninja output into
   *  the console while the build ran. Skips re-printing result.stdout on
   *  success, and on failure re-emits only the error/warning lines (for the
   *  red/yellow highlighting the plain live stream lacked). */
  streamedLive = false,
): CompilationLog[] {
  const logs: CompilationLog[] = [];
  const now = new Date();

  logs.push({ timestamp: now, type: 'info', message: `Compiling for ${board}...` });

  // Core install log
  if (result.core_install_log) {
    for (const line of result.core_install_log.split('\n')) {
      if (line.trim()) {
        logs.push({ timestamp: now, type: 'core-install', message: line });
      }
    }
  }

  // stdout — for ESP-IDF/ninja builds, compiler errors appear here.
  // When the live stream already showed it, a successful build has nothing
  // left to say here (re-printing would duplicate the whole log).
  if (result.stdout && !(streamedLive && result.success)) {
    let inFailedBlock = false;
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      const stripped = line.trim();
      // Ninja FAILED block start
      if (
        stripped.startsWith('FAILED:') ||
        stripped === 'ninja: build stopped: subcommand failed.'
      ) {
        inFailedBlock = true;
        logs.push({ timestamp: now, type: 'error', message: line });
        continue;
      }
      // Progress line [N/M] ends a FAILED block
      if (inFailedBlock && /^\[\d+\/\d+\]/.test(stripped)) {
        inFailedBlock = false;
      }
      // Classify the line
      let type: CompilationLog['type'];
      if (inFailedBlock) {
        // Lines inside a FAILED block: compiler output — detect subcategory
        type = /:\s*(fatal )?error:/i.test(line) ? 'error' : 'warning';
      } else if (/:\s*(fatal )?error:/i.test(line) && !/^\[/.test(stripped)) {
        type = 'error';
      } else if (/:\s*warning:/i.test(line) || line.toLowerCase().includes('warning')) {
        type = 'warning';
      } else {
        type = 'info';
      }
      if (type === 'info' && (streamedLive || isNoiseBuildLine(stripped))) continue;
      if (type === 'warning' && isNoiseBuildLine(stripped)) continue;
      logs.push({ timestamp: now, type, message: line });
    }
  }

  // stderr — classify lines as warnings or errors
  if (result.stderr) {
    for (const line of result.stderr.split('\n')) {
      if (!line.trim()) continue;
      if (isNoiseBuildLine(line)) continue;
      let type: CompilationLog['type'] = 'error';
      const lower = line.toLowerCase();
      if (lower.includes('warning:') || lower.includes('warn ')) {
        type = 'warning';
      } else if (
        lower.includes('note:') ||
        lower.includes('in file included') ||
        lower.startsWith('using ') ||
        lower.startsWith('libraries ') ||
        // IDF's CMake banners for esp-insights/esp-rainmaker print
        // "... Project commit: HEAD-HASH-NOTFOUND" to stderr when the
        // component tree has no git metadata — build chatter, not an error,
        // but the red error marker made users read it as one.
        lower.includes('project commit:')
      ) {
        type = 'info';
      }
      // Live-streamed builds already showed the chatter; only re-emit lines
      // that gain something from re-classification (red/yellow markers).
      if (type === 'info' && streamedLive) continue;
      logs.push({ timestamp: now, type, message: line });
    }
  }

  // Final status
  if (result.success) {
    logs.push({ timestamp: now, type: 'success', message: '✓ Compilation successful' });
  } else {
    const errorMsg = result.error || 'Compilation failed';
    logs.push({ timestamp: now, type: 'error', message: `✕ ${errorMsg}` });
  }

  return target ? logs.map((l) => ({ ...l, target })) : logs;
}
