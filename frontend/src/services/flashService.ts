/**
 * Frontend client for the hardware flash endpoint.
 *
 * Wraps `POST /api/flash/upload` (SSE response) and yields parsed
 * events back to the caller. The Flash controls send the stream to the terminal
 * line-by-line and updates a progress bar based on the optional
 * `progress` field.
 *
 * Why a generator: the modal needs per-event UI updates AND a final
 * success/error verdict. Returning the whole log as a promise
 * forces the modal to wait until the flash is done before showing
 * anything; an AsyncGenerator gives it both.
 */

import { getApiBase } from '../lib/apiBase';

export type FlashEvent =
  | { phase: 'queued'; line: string }
  | { phase: 'starting'; line: string }
  | { phase: 'writing'; line: string; progress?: number }
  | { phase: 'done'; success: true; elapsed_ms: number }
  | { phase: 'done'; success: false; error: string; elapsed_ms: number };

export interface FlashRequest {
  /** Board UUID from useSimulatorStore - echoed in log lines so
   *  the user can tell which board's log they're reading. */
  boardId: string;
  /** OS-native port string from listSerialPorts(). */
  port: string;
  /** arduino-cli FQBN (`arduino:avr:uno`, `esp32:esp32:esp32`, ...). */
  fqbn: string;
  /** "hex" | "bin" | "uf2" | "elf" - matches the file the compile
   *  endpoint produced and what arduino-cli expects. */
  programFormat: 'hex' | 'bin' | 'uf2' | 'elf';
  /** The compiled bytes. AVR compile returns Intel HEX text;
   *  ESP32 / RP2040 return binary. The store keeps it as a string
   *  either way - we wrap it in a Blob for the multipart upload. */
  programData: string;
}

/**
 * Decode a base64 string into a Uint8Array. atob is browser-native;
 * we wrap it because TypeScript's lib.dom types still mark it as
 * deprecated despite every browser supporting it.
 */
function base64ToUint8Array(b64: string): Uint8Array {
  const cleaned = b64.replace(/\s+/g, '');
  const binary = atob(cleaned);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Open the SSE stream and yield events as they arrive. Caller
 * MUST consume the generator to completion (or call `return`)
 * to release the underlying ReadableStream.
 *
 * Throws on transport errors (network down, sidecar crashed mid-
 * stream); arduino-cli failures come back as `phase:'done',
 * success:false` events, not exceptions.
 */
export async function* streamFlash(req: FlashRequest): AsyncGenerator<FlashEvent> {
  const fd = new FormData();
  fd.append('board_id', req.boardId);
  fd.append('port', req.port);
  fd.append('fqbn', req.fqbn);
  fd.append('program_format', req.programFormat);
  // The compile endpoint returns Intel HEX as plain text but
  // binary formats (.bin / .uf2) as base64 to keep the JSON safe.
  // For binary we MUST decode before posting - otherwise the form
  // upload encodes the base64 ASCII as the file contents and
  // arduino-cli sees a non-binary text blob.
  const isBinary = req.programFormat !== 'hex';
  const bytes = isBinary
    ? base64ToUint8Array(req.programData)
    : new TextEncoder().encode(req.programData);
  fd.append(
    'program',
    new Blob([bytes], { type: 'application/octet-stream' }),
    `program.${req.programFormat}`,
  );

  const res = await fetch(`${getApiBase()}/flash/upload`, {
    method: 'POST',
    body: fd,
    // No credentials needed - the flash endpoint is unauthenticated
    // because it's hardware-local. The desktop sidecar binds to
    // 127.0.0.1 only, so cross-machine attacks aren't a concern.
  });

  if (!res.ok || !res.body) {
    // Errors BEFORE the stream starts (validation, 503 missing
    // toolchain, etc.) come back as plain JSON, not SSE.
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.detail ?? detail;
    } catch {
      /* keep the status-line detail */
    }
    yield {
      phase: 'done',
      success: false,
      error: detail,
      elapsed_ms: 0,
    };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE: events are delimited by blank lines (\n\n). Each event
      // is `data: <json>` (one line). We don't use multi-line `data:`
      // continuations, so a simple split is enough.
      const chunks = buf.split('\n\n');
      buf = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        try {
          yield JSON.parse(json) as FlashEvent;
        } catch (err) {
          // Garbled event - keep going so a single bad packet
          // doesn't kill the whole stream.
          console.warn('[flashService] malformed SSE event:', json, err);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
