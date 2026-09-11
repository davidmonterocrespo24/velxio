import axios from 'axios';
import { getApiBase } from '../lib/apiBase';
import type { ESP32BoardOptions, SpiffsFile } from '../types/boardOptions';
import { implicitBoardOptions } from '../types/boardOptions';

export interface SketchFile {
  name: string;
  content: string;
}

/**
 * Per-board build options forwarded to the backend. Only meaningful for
 * ESP32 targets — `board_options` is structurally translated into sdkconfig
 * knobs and a generated partitions.csv by the ESP-IDF compiler. `spiffs_files`
 * (if non-empty) are baked into a SPIFFS partition image via `mkspiffs`.
 */
export interface CompileExtras {
  boardOptions?: ESP32BoardOptions;
  spiffsFiles?: SpiffsFile[];
  // P2.3 — declared library manifest (the loaded example/project's libraries).
  // Sent as the ESP-IDF resolution SCOPE; null/omitted = legacy scan-all.
  // Ignored by the backend for non-ESP32 (arduino-cli) boards.
  libraries?: string[] | null;
  // Pure ESP-IDF mode (issue #139): 'espidf' compiles the files as a pure
  // ESP-IDF project (user app_main, no arduino-esp32 component). Omitted /
  // undefined = classic Arduino sketch compile. ESP32 boards only.
  language?: 'espidf';
  // Who triggered the compile — 'agent' when the AI assistant's tool did.
  // Threads through to backend metrics; omitted = manual user action.
  initiatedBy?: 'agent';
  // The editor's BoardKind — analytics only. Distinct boards can share one
  // FQBN (Pimoroni RP2350 boards all compile as rpipico2); the kind is the
  // only identifier that tells them apart in the metrics.
  boardKind?: string;
  // Gallery example the workspace was loaded from — analytics only
  // ("which examples get compiled most"). Null/omitted outside examples.
  exampleId?: string | null;
}

export interface CompileResult {
  success: boolean;
  hex_content?: string;
  binary_content?: string; // base64-encoded .bin for RP2040
  binary_type?: 'bin' | 'uf2';
  /** RP2040 / RP2350: base64 .uf2 for hardware flash (the .bin above feeds the emulator). */
  uf2_content?: string | null;
  has_wifi?: boolean; // True when sketch uses WiFi (ESP32 only)
  stdout: string;
  stderr: string;
  error?: string;
  core_install_log?: string;
  /** P2.4 — the manifest is missing libraries the build really used. */
  manifest_incomplete?: boolean;
  /** { header: [candidate library display names] } — single-candidate
   * entries are safe to auto-declare (see utils/libraryManifest.ts). */
  manifest_suggested_libraries?: Record<string, string[]> | null;
}

interface CompileStartResponse {
  job_id: string;
}

/**
 * What the build is doing right now — finer than `state`, and the difference
 * the compile overlay is built around: 'queued' means other builds are ahead
 * of this one and nothing of ours is running yet, which is a completely
 * different thing to tell a waiting user than "compiling".
 */
export type CompileStage =
  | 'queued'
  | 'preparing'
  | 'compiling'
  | 'linking'
  | 'packaging'
  | 'done';

/**
 * Coarse build-server pressure. Four buckets by design: the backend never
 * sends a queue depth or a position, because "you are 14th in line" is worse
 * than saying nothing and it publishes how busy the service is.
 */
export type ServerLoad = 'low' | 'moderate' | 'high' | 'peak';

/**
 * Display label for the requester's plan. 'local' = a self-hosted OSS build
 * with no plan vocabulary at all (the UI shows neither a badge nor an
 * upgrade line). Never used as an entitlement — it only picks wording.
 */
export type CompileTier = 'local' | 'anonymous' | 'free' | 'maker' | 'pro' | string;

interface CompileStatusResponse {
  state: 'pending' | 'running' | 'done' | 'error';
  started_at: number;
  finished_at: number | null;
  stdout: string;
  result: CompileResult | null;
  error: string | null;
  stage?: CompileStage;
  progress?: number | null;
  estimated_seconds?: number | null;
  build_seconds?: number;
  server_load?: ServerLoad;
  tier?: CompileTier;
  priority?: boolean;
}

export interface CompileProgressInfo {
  state: 'pending' | 'running' | 'done';
  stdout: string;
  elapsedSeconds: number;
  /** Where the job is: queued behind other builds, or actually building. */
  stage: CompileStage;
  /** 0..1, or null when there is nothing honest to draw (a queued job). */
  progress: number | null;
  /** What the estimate is based on, in seconds. Null while queued. */
  estimatedSeconds: number | null;
  /** Seconds spent BUILDING (excludes queue time), so the timer matches the bar. */
  buildSeconds: number;
  serverLoad: ServerLoad;
  tier: CompileTier;
  /** This build was admitted ahead of standard ones (paid plan). */
  priority: boolean;
}

/**
 * Live progress callback — called on every poll while state ∈ {pending,
 * running}, plus one final call with state 'done' carrying the complete
 * buffer (the lines that landed between the last running-poll and job
 * completion would otherwise never be delivered). `stdout` is the full live
 * cmake + ninja output captured so far (cap of ~256 KB on the server side,
 * tail kept). Caller can compute a delta against the previous call if it
 * wants to append-only render.
 */
export type CompileProgress = (info: CompileProgressInfo) => void;

// Queued jobs poll slower: while we're waiting for a slot there is nothing
// new to show, and a deep queue means many clients polling at once — exactly
// when the server can least afford the extra requests.
const POLL_INTERVAL_MS = 2000;
const QUEUED_POLL_INTERVAL_MS = 3000;

// Two budgets, and NEITHER of them charges queue time. A build that has STARTED
// gets 15 minutes (covers a cold ESP-IDF build); the wider cap exists only so a
// wedged server can't leave a tab polling forever.
//
// Time spent queued is subtracted from both. The product promise is that a
// queued build always eventually runs — a client-side timeout would quietly
// break it on exactly the busy days it matters, and the card would say "Build
// failed" for a build the server is still perfectly willing to run, directly
// contradicting its own "never cancelled" copy.
const MAX_BUILD_DURATION_MS = 15 * 60 * 1000;
const MAX_TOTAL_DURATION_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The manifest field, three-state. `undefined` / `null`: the board never
 * declared anything (a fresh board, a legacy project row without the field)
 * -> the request omits it and the server scans every installed library, as
 * it always did. `[]`: the board DECLARED an empty manifest (a gallery
 * example that needs nothing, the Library Manager after the last entry was
 * removed) -> sent as `[]`, which a deployment with a library lock may treat
 * as a closed scope. Non-empty -> sent as-is, pins included. Until 2026-09-11
 * `[]` was coerced to `null` here, so a declared-empty manifest could never
 * be told from an undeclared one.
 */
export function manifestFieldFor(libraries: string[] | null | undefined): string[] | null {
  return libraries == null ? null : libraries;
}

/**
 * A refusal or a server error arrives as a 4xx/5xx body. The compilers'
 * own refusals are already shaped like a CompileResult (`success: false`,
 * `error`); a FastAPI validation error or a bare HTTPException is
 * `{detail}`, which used to reach the editor as `success === undefined`
 * and render as the literal "Compile failed". Map it to the same shape.
 */
export function compileResultFromErrorBody(data: unknown): CompileResult {
  if (data && typeof data === 'object' && 'success' in (data as Record<string, unknown>)) {
    return data as CompileResult;
  }
  const detail = data && typeof data === 'object' ? (data as { detail?: unknown }).detail : undefined;
  const message =
    typeof detail === 'string'
      ? detail
      : detail !== undefined
        ? JSON.stringify(detail)
        : 'The server refused the compile request.';
  return { success: false, stdout: '', stderr: '', error: message } as CompileResult;
}

/** 502 (the host proxy while the backend is still in its lifespan) and 503
 *  (the backend itself, seeding its library set) both mean "starting". */
export function isServerStarting(status: number | undefined): boolean {
  return status === 502 || status === 503;
}

const SERVER_STARTING_RETRY_MS = 5000;
const SERVER_STARTING_MAX_MS = 90_000;

/** Fill in the queue fields for a backend that predates them (self-hosted OSS
 *  running an older image behind a newer frontend). */
function readQueueInfo(status: CompileStatusResponse): Omit<
  CompileProgressInfo,
  'state' | 'stdout' | 'elapsedSeconds'
> {
  return {
    stage: status.stage ?? (status.state === 'pending' ? 'queued' : 'compiling'),
    progress: status.progress ?? null,
    estimatedSeconds: status.estimated_seconds ?? null,
    buildSeconds: status.build_seconds ?? 0,
    serverLoad: status.server_load ?? 'low',
    tier: status.tier ?? 'local',
    priority: status.priority ?? false,
  };
}

/**
 * Compile a sketch via the async job pipeline.
 *
 *   POST /compile/start                  → { job_id }
 *   GET  /compile/status/<job_id>  (×N)  → { state, stdout, result?, error? }
 *
 * Each individual request returns in milliseconds, so Cloudflare's 100s edge
 * timeout never kicks in — even when the underlying ESP-IDF cold build runs
 * for 5-7 minutes. Falls back to throwing an Error after MAX_POLL_DURATION_MS.
 *
 * `onProgress` (optional): called every poll with the live cmake + ninja
 * output so the editor can stream the compilation console instead of
 * waiting for everything at the end.
 */
export async function compileCode(
  files: SketchFile[],
  board: string = 'arduino:avr:uno',
  projectId?: string | null,
  onProgress?: CompileProgress,
  extras?: CompileExtras,
): Promise<CompileResult> {
  console.log('Sending compilation request to:', `${getApiBase()}/compile/start`);
  console.log('Board:', board);
  console.log(
    'Files:',
    files.map((f) => f.name),
  );

  // Translate camelCase frontend keys to snake_case backend keys. Backend
  // only inspects these fields for esp32:* FQBNs — other boards pass them
  // through unread.
  // A project that never opened the Board Options modal still has to build for
  // the module it is running on: ask the board what it ships with. Null for
  // every board that declares nothing, which is all of the OSS ones.
  const board_options = extras?.boardOptions
    ? { ...extras.boardOptions }
    : extras?.boardKind
      ? implicitBoardOptions(extras.boardKind as never)
      : null;
  const spiffs_files = extras?.spiffsFiles?.length
    ? extras.spiffsFiles.map((f) => ({ name: f.name, content_b64: f.contentB64 }))
    : null;
  // P2.3 — library manifest (resolution scope), three-state (see
  // manifestFieldFor): omitted = scan-all, [] = declared empty, else the list.
  const libraries = manifestFieldFor(extras?.libraries);
  // Custom WiFi access points (overlay feature): when the project carries its
  // own AP parts, their SSIDs ride along and the backend's SSID rewriter
  // stands down — the sketch connects to the network the user actually wrote.
  // OSS builds have no provider installed → null → legacy rewrite.
  const customWifiSsids =
    (window as { __velxio_custom_wifi_ssids__?: () => string[] | null })
      .__velxio_custom_wifi_ssids__?.() ?? null;

  let jobId: string;
  // A deployment that seeds its libraries at boot answers 503 + Retry-After
  // while it does, and the host proxy answers 502 while the backend is still
  // in its lifespan. Neither is a failed compile: wait, say so, try again,
  // for a bounded while.
  const startingSince = Date.now();
  let startAttempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
  startAttempt += 1;
  try {
    const startResp = await axios.post<CompileStartResponse>(
      `${getApiBase()}/compile/start`,
      {
        files,
        board_fqbn: board,
        project_id: projectId ?? null,
        board_options,
        spiffs_files,
        board_kind: extras?.boardKind ?? null,
        example_id: extras?.exampleId ?? null,
        libraries,
        language: extras?.language ?? null,
        initiated_by: extras?.initiatedBy ?? null,
        custom_wifi_ssids: customWifiSsids,
      },
      { withCredentials: true, timeout: 30000 },
    );
    jobId = startResp.data.job_id;
    console.log('[compile] queued job', jobId);
    break;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const status = error.response.status;
      if (isServerStarting(status) && Date.now() - startingSince < SERVER_STARTING_MAX_MS) {
        const retryAfter = Number(error.response.headers?.['retry-after']);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : SERVER_STARTING_RETRY_MS;
        console.warn(`[compile] server starting (${status}), retrying in ${waitMs} ms (attempt ${startAttempt})`);
        onProgress?.({
          state: 'pending',
          stage: 'queued',
          stdout: `Server is starting, waiting for it (${Math.round((Date.now() - startingSince) / 1000)} s)...`,
          elapsedSeconds: Math.round((Date.now() - startingSince) / 1000),
          progress: null,
          estimatedSeconds: null,
          buildSeconds: 0,
          serverLoad: 'low',
          tier: 'local',
          priority: false,
        });
        await sleep(waitMs);
        continue;
      }
      console.error('Compilation request failed:', error);
      // Server returned a structured error (422, 500, ...) — surface as a
      // failed CompileResult so the editor can show stderr/error.
      return compileResultFromErrorBody(error.response.data);
    }
    console.error('Compilation request failed:', error);
    throw error instanceof Error
      ? error
      : new Error('No response from server. Is the backend running?');
  }
  }

  const startedAt = Date.now();
  // When the build itself started (first poll that is no longer queued). Queue
  // time is deliberately excluded from the build budget below.
  let buildStartedAt: number | null = null;
  // Total milliseconds observed in the `queued` stage, subtracted from both
  // budgets so waiting for a slot can never time a build out.
  let queuedMs = 0;
  let lastPollAt = Date.now();
  // Initial small delay so we don't hit /status before the background task
  // has even moved past 'pending'.
  await sleep(500);

  while (true) {
    if (Date.now() - startedAt - queuedMs > MAX_TOTAL_DURATION_MS) {
      throw new Error(
        `Compile timed out client-side after ${Math.round(MAX_TOTAL_DURATION_MS / 1000)}s`,
      );
    }
    if (
      buildStartedAt !== null &&
      Date.now() - buildStartedAt - queuedMs > MAX_BUILD_DURATION_MS
    ) {
      throw new Error(
        `Build timed out client-side after ${Math.round(MAX_BUILD_DURATION_MS / 1000)}s`,
      );
    }

    let status: CompileStatusResponse;
    try {
      const resp = await axios.get<CompileStatusResponse>(
        `${getApiBase()}/compile/status/${jobId}`,
        { withCredentials: true, timeout: 30000 },
      );
      status = resp.data;
    } catch (error) {
      // Transient poll error — log, wait, retry. Only abort on 404 (job
      // expired or never existed).
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error(`Compile job ${jobId} not found (server may have restarted)`);
      }
      console.warn('[compile] status poll error, retrying:', error);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (status.state === 'done' && status.result) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[compile] job ${jobId} done in ${elapsed}s`);
      // Final flush: the buffer grew between the last running-poll and
      // completion (esptool + binary-size lines usually live there).
      if (onProgress) {
        try {
          onProgress({
            ...readQueueInfo(status),
            state: 'done',
            stage: 'done',
            progress: 1,
            stdout: status.stdout || '',
            elapsedSeconds: elapsed,
          });
        } catch (err) {
          console.warn('[compile] onProgress threw:', err);
        }
      }
      return status.result;
    }

    if (status.state === 'error') {
      console.error(`[compile] job ${jobId} errored:`, status.error);
      return {
        success: false,
        stdout: status.stdout || '',
        stderr: '',
        error: status.error || 'Compile failed',
      };
    }

    // state ∈ {pending, running} — surface live build output if requested
    const queueInfo = readQueueInfo(status);
    const nowMs = Date.now();
    if (queueInfo.stage === 'queued') {
      // Credit the interval since the previous poll back: a job can also drop
      // BACK into the queue (the per-target lock re-gates a build behind
      // another compile of the same target), so this accumulates rather than
      // measuring one contiguous stretch.
      queuedMs += nowMs - lastPollAt;
    } else if (buildStartedAt === null) {
      buildStartedAt = nowMs;
    }
    lastPollAt = nowMs;
    if (onProgress) {
      try {
        onProgress({
          ...queueInfo,
          state: status.state,
          stdout: status.stdout || '',
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        });
      } catch (err) {
        // A faulty UI hook must never break the polling loop.
        console.warn('[compile] onProgress threw:', err);
      }
    }

    await sleep(queueInfo.stage === 'queued' ? QUEUED_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
  }
}
