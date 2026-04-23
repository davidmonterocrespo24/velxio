import axios from 'axios';
import type { LibraryPlatform } from '@velxio/sdk';
import { getEventBus } from '../simulation/EventBus';
import { getCompileMiddlewareChain } from '../simulation/CompileMiddleware';
import { getLibraryRegistry } from '../plugin-host/LibraryRegistry';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

let runIdCounter = 0;
const nextRunId = (): string => `compile-${++runIdCounter}-${Date.now().toString(36)}`;

export interface SketchFile {
  name: string;
  content: string;
}

/** Wire shape for `CompileRequest.libraries[]` on the backend. */
interface CompileLibraryPayload {
  id: string;
  version: string;
  files: Array<{ path: string; content: string }>;
}

/**
 * Map an arduino-cli FQBN to a `LibraryPlatform` so we can filter plugin
 * libraries to only the ones declaring support for the active board.
 *
 * Returns `null` for boards we don't recognise — in that case the caller
 * skips library injection rather than ship a payload that is guaranteed
 * not to compile.
 */
function platformForFqbn(fqbn: string): LibraryPlatform | null {
  if (fqbn.startsWith('arduino:avr:')) return 'avr';
  if (fqbn.startsWith('esp32:')) return 'esp32';
  if (
    fqbn.startsWith('rp2040:') ||
    fqbn.startsWith('arduino:mbed_rp2040:') ||
    fqbn.includes('rp2040') ||
    fqbn.includes('rp2350')
  ) {
    return 'rp2040';
  }
  return null;
}

/**
 * Read the host library registry, keep only entries whose `platforms`
 * cover the active board, then strip down to the wire shape the backend
 * expects. The dependency closure is resolved through `registry.resolve()`
 * so transitive deps land in the payload — DFS topological order keeps
 * the build log diff-friendly even though arduino-cli doesn't care.
 */
function collectLibrariesForBoard(fqbn: string): CompileLibraryPayload[] {
  const platform = platformForFqbn(fqbn);
  if (platform === null) return [];
  const registry = getLibraryRegistry();
  const all = registry.list();
  if (all.length === 0) return [];
  const ids = all
    .filter((entry) => entry.definition.platforms.includes(platform))
    .map((entry) => entry.definition.id);
  if (ids.length === 0) return [];
  return registry.resolve(ids).map((entry) => ({
    id: entry.definition.id,
    version: entry.definition.version,
    files: entry.definition.files.map((file) => ({
      path: file.path,
      content: file.content,
    })),
  }));
}

export interface CompileResult {
  success: boolean;
  hex_content?: string;
  binary_content?: string; // base64-encoded .bin for RP2040
  binary_type?: 'bin' | 'uf2';
  has_wifi?: boolean; // True when sketch uses WiFi (ESP32 only)
  stdout: string;
  stderr: string;
  error?: string;
  core_install_log?: string;
}

export async function compileCode(
  files: SketchFile[],
  board: string = 'arduino:avr:uno',
): Promise<CompileResult> {
  const bus = getEventBus();
  const chain = getCompileMiddlewareChain();
  bus.emit('compile:start', {});
  const t0 = performance.now();
  const ctx = {
    runId: nextRunId(),
    board,
    startedAt: t0,
    notes: [] as Array<{ readonly pluginId: string; readonly message: string }>,
  };

  let transformedFiles: SketchFile[];
  try {
    // Pre-compile middleware chain: may transform the files or throw to
    // abort. Readonly → mutable cast is safe here because axios just
    // serializes as JSON.
    const out = await chain.runPre(files, ctx);
    transformedFiles = out as SketchFile[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bus.emit('compile:done', {
      ok: false,
      durationMs: performance.now() - t0,
      message: `pre-compile middleware failed: ${message}`,
    });
    throw err;
  }

  try {
    console.log('Sending compilation request to:', `${API_BASE}/compile`);
    console.log('Board:', board);
    console.log(
      'Files:',
      transformedFiles.map((f) => f.name),
    );

    const libraries = collectLibrariesForBoard(board);
    const requestBody: {
      files: SketchFile[];
      board_fqbn: string;
      libraries?: CompileLibraryPayload[];
    } = { files: transformedFiles, board_fqbn: board };
    if (libraries.length > 0) {
      requestBody.libraries = libraries;
    }

    const response = await axios.post<CompileResult>(
      `${API_BASE}/compile/`,
      requestBody,
      { withCredentials: true, timeout: 180000 },
    );

    console.log('Compilation response status:', response.status);
    const result = response.data;
    // Post middlewares: observe-only. Swallows errors, never throws.
    await chain.runPost(
      {
        ok: result.success === true,
        durationMs: performance.now() - t0,
        hex: result.hex_content,
        stderr: result.stderr,
        stdout: result.stdout,
      },
      ctx,
    );
    bus.emit('compile:done', {
      ok: result.success === true,
      durationMs: performance.now() - t0,
      bytes: result.hex_content?.length,
      message: result.error ?? undefined,
    });
    return result;
  } catch (error) {
    console.error('Compilation request failed:', error);

    if (axios.isAxiosError(error)) {
      if (error.response) {
        console.error('Error response data:', error.response.data);
        bus.emit('compile:done', {
          ok: false,
          durationMs: performance.now() - t0,
          message: String(error.response.data?.error ?? error.message),
        });
        return error.response.data;
      } else if (error.request) {
        bus.emit('compile:done', {
          ok: false,
          durationMs: performance.now() - t0,
          message: 'No response from server',
        });
        throw new Error('No response from server. Is the backend running on port 8001?');
      }
    }

    bus.emit('compile:done', {
      ok: false,
      durationMs: performance.now() - t0,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
