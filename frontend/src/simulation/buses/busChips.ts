/**
 * The compiled portable responders (project board-buses-2026-09, F4).
 *
 * A responder is a device that DRIVES MISO, and on a board whose CPU runs in a
 * backend QEMU worker it has to run beside that CPU: the worker asks for the
 * byte's answer synchronously and a tab cannot answer in time (D-004). The
 * answer is one model in C on velxio-chip.h, compiled once and run by
 * `wasm_chip_runtime.py` in the worker, by the Linux-board host, and by
 * `ChipRuntime.ts` here.
 *
 * This module is how a part gets hold of that artifact. The files are served
 * from the public tree (`/bus-chips/<name>.wasm`), exactly as the Grove chips
 * are, so they are fetched once per page and shared by every instance of the
 * part.
 *
 * Why a synchronous read on top of an async fetch: `remoteModel()` is
 * deliberately synchronous (see SpiDeviceDescriptor), because a model that
 * arrives after the guest started clocking is the same late answer the whole
 * design exists to avoid. So a part asks for the bytes it already has, and the
 * fetch that lands later tells the registry to publish the bus map again. Until
 * then the part carries no model and its bus says so once
 * (`bus-remote-responder-missing`) rather than pretending.
 */

const bytesByName = new Map<string, Uint8Array>();
const pending = new Map<string, Promise<Uint8Array | null>>();
const warned = new Set<string>();

/** Called when a fetch lands, so the maps that were built without it go again. */
let onLoaded: (() => void) | null = null;

/** The registry installs this; kept as a hook so this module imports nothing
 *  from the registry and the two cannot form a cycle. */
export function setBusChipLoadListener(fn: (() => void) | null): void {
  onLoaded = fn;
}

/**
 * Start (or join) the fetch of one model. Safe to call on every attach: the
 * bytes are cached by name for the life of the page, and a part that mounts
 * while the fetch is in flight is picked up by the map push that follows it.
 */
export function loadBusChip(name: string): Promise<Uint8Array | null> {
  const have = bytesByName.get(name);
  if (have) return Promise.resolve(have);
  let p = pending.get(name);
  if (p) return p;
  p = fetch(`/bus-chips/${name}.wasm`)
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      bytesByName.set(name, bytes);
      // The maps were built while this was missing, so every board that could
      // host this model has to hear about it. One notification, not one per
      // part: the registry walks its own devices.
      onLoaded?.();
      return bytes;
    })
    .catch((e) => {
      // A missing artifact is not fatal here. The responder keeps working in
      // the tab for every in-browser engine, and a remote lane reports the gap
      // through its own diagnostic, which names the part the user can see.
      // Said once per model: a canvas with four cards on it would otherwise
      // print the same line four times.
      if (!warned.has(name)) {
        warned.add(name);
        console.warn(`[bus-chips] ${name}.wasm could not be loaded`, e);
      }
      // The failed promise stays in the map on purpose, so this is tried once
      // per page and not once per part that mounts. A model that is not being
      // served is not going to appear halfway through a session, and four
      // cards on a canvas asking four times would only make the wait longer.
      return null;
    });
  pending.set(name, p);
  return p;
}

/** Hand a model to the cache directly. For tests and for a host with no
 *  network of its own; the fetch above is the only other way in. */
export function primeBusChip(name: string, bytes: Uint8Array): void {
  bytesByName.set(name, bytes);
  onLoaded?.();
}

/** Base64 of a byte array, in chunks small enough for the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}

/**
 * The model's bytes as base64, cached so a map push does not re-encode a
 * multi-kilobyte artifact for every device on every membership change.
 */
const b64ByName = new Map<string, string>();
export function busChipB64(name: string): string | null {
  const cached = b64ByName.get(name);
  if (cached !== undefined) return cached;
  const bytes = bytesByName.get(name);
  if (!bytes) return null;
  const s = bytesToBase64(bytes);
  b64ByName.set(name, s);
  return s;
}

/** Test seam: forget everything, so one suite's fixture cannot leak into the
 *  next one's expectations. */
export function resetBusChipsForTest(): void {
  bytesByName.clear();
  b64ByName.clear();
  pending.clear();
  warned.clear();
}
