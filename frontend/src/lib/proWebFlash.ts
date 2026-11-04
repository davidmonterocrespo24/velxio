/**
 * Pro web-flash registry.
 *
 * Flashing a real board over Web Serial (esptool-js) is implemented in the
 * pro overlay; the OSS app only knows the doorbell. Mirrors the other
 * OSS->Pro seams (`proBoardGate.ts`, `proSaveAction.ts`, `proRoutes.ts`):
 * the OSS app defines a stable interface, the overlay plugs in.
 *
 *   - OSS without an overlay -> no impl installed. The board context menu
 *     keeps its desktop-only gate and the web build behaves exactly as
 *     before this seam existed.
 *   - With the pro overlay   -> installWebFlashImpl() provides the real
 *     flasher; the "Flash to real board" menu item appears in supported
 *     browsers for supported board kinds.
 *
 * The seam speaks plain data only (base64 program, progress callbacks) —
 * OSS must never see esptool-js types.
 */

export interface WebFlashProgress {
  phase: 'connecting' | 'erasing' | 'writing' | 'uploading' | 'resetting';
  /** 0-100, meaningful during 'writing' and 'uploading'. */
  pct: number;
  /** Optional log line to append to the modal's console. */
  line?: string;
}

export interface WebFlashRequest {
  boardId: string;
  boardKind: string;
  /**
   * The FQBN the image was built with. Omitted = the kind's own FQBN; set
   * when the user picked another hardware revision (see HardwareRevision),
   * so the flasher checks the image against THAT chip.
   */
  fqbn?: string;
  /** The board's compiled program: base64 of the merged flash image. */
  binaryBase64: string;
  onProgress: (p: WebFlashProgress) => void;
  /** Aborting disconnects the transport; the chip stays recoverable. */
  signal: AbortSignal;
}

/** A workspace source file, as the editor stores it. */
export interface WebFlashFile {
  name: string;
  content: string;
}

export interface MicroPythonFlashRequest {
  boardId: string;
  boardKind: string;
  /** The project's files; .py files are written to the board's filesystem. */
  files: WebFlashFile[];
  onProgress: (p: WebFlashProgress) => void;
  signal: AbortSignal;
}

export interface WebFlashResult {
  /** Chip name as detected by the loader, e.g. "ESP32-S3". */
  chipName: string;
  elapsedMs: number;
}

/**
 * How a board kind gets into its bootloader before a flash. Families whose
 * bootloader is a separate USB personality (the RP2040 / RP2350 BOOTSEL
 * mode) need the user to put the board there first; the flasher cannot do
 * it from the bootloader side. `manual` is the button-and-cable
 * instruction (the dialog has a default for it), `automatic` says whether
 * `enterBootloader` can do it over USB for this kind.
 */
export interface BootloaderHint {
  /** Overrides the dialog's default "hold the button while plugging in" copy. */
  manual?: string;
  /** True when `enterBootloader(boardKind)` is implemented for this kind. */
  automatic: boolean;
}

/**
 * Thrown by `preparePort` / `flash` when the board is not in bootloader
 * mode (the device picker had nothing to offer, or the running firmware
 * answered instead of the bootloader). The dialog turns it into the
 * bootloader panel rather than a generic failure.
 */
export class NotInBootloaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotInBootloaderError';
  }
}

export function isNotInBootloaderError(err: unknown): boolean {
  return (
    err instanceof NotInBootloaderError ||
    (err instanceof Error && err.name === 'NotInBootloaderError')
  );
}

/**
 * A real-board revision of a simulated kind that compiles differently.
 * Pimoroni sold the Stellar and Galactic Unicorn with a Pico W (RP2040)
 * before 2025 and with a Pico 2 W (RP2350) since; the simulator runs one
 * of them, the flash dialog lets the user build for the one on the desk.
 */
export interface HardwareRevision {
  id: string;
  label: string;
  fqbn: string;
}

export interface WebFlashImpl {
  /**
   * Whether this board kind can be flashed over Web Serial in this
   * browser (chip family supported AND `navigator.serial` present).
   */
  available(boardKind: string): boolean;
  /**
   * Request a port, connect, write the image and hard-reset. Rejects
   * with an Error whose message is user-presentable.
   */
  flash(req: WebFlashRequest): Promise<WebFlashResult>;
  /**
   * MicroPython path: install the MicroPython firmware if the board
   * doesn't answer as a REPL, then upload the project's .py files over
   * raw REPL and soft-reset so main.py runs. Optional — absent means
   * MicroPython projects can't be flashed and the UI says so.
   */
  flashMicroPython?(req: MicroPythonFlashRequest): Promise<WebFlashResult>;
  /**
   * Ask the browser for the serial port NOW, from a user gesture, without
   * flashing. The Flash dialog calls this at the click, then compiles (which
   * can take minutes — long past any gesture window), then flashes to the
   * port already granted. Optional — without it the dialog compiles first
   * and asks for a second click to connect.
   */
  preparePort?(boardKind: string): Promise<void>;
  /**
   * Bootloader step for families that need one (see BootloaderHint).
   * Optional — absent (or returning null) means the dialog shows no
   * bootloader panel for that kind.
   */
  bootloaderHint?(boardKind: string): BootloaderHint | null;
  /**
   * Put the board into its bootloader over USB, from a user gesture (it
   * asks for a serial port). Resolves once the board has gone away to
   * re-enumerate as its bootloader; rejects with a user-presentable
   * message when the running firmware does not react.
   */
  enterBootloader?(
    boardKind: string,
    onProgress: (p: WebFlashProgress) => void,
  ): Promise<void>;
  /**
   * Hardware revisions of `boardKind` the user can pick in the flash
   * dialog, first = the one the simulator runs. Optional; null / absent
   * means the kind has exactly one real board.
   */
  hardwareRevisions?(boardKind: string): HardwareRevision[] | null;
}

let _impl: WebFlashImpl | null = null;
const _listeners = new Set<() => void>();

/** Installed by the pro overlay (mountPro). Pass null to clear (hot reload). */
export function installWebFlashImpl(impl: WebFlashImpl | null): void {
  _impl = impl;
  // The overlay installs after a dynamic import, so a component that asked
  // webFlashAvailable() during the first render got `false`; tell it to ask
  // again. Listener errors never reach the installer.
  for (const fn of _listeners) {
    try {
      fn();
    } catch {
      /* a broken listener must not stop the install */
    }
  }
}

/** Called whenever the flasher is installed or cleared. Returns unsubscribe. */
export function onWebFlashImplChange(fn: () => void): () => void {
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}

/** The overlay's flasher, or null in a pure OSS build. */
export function getWebFlashImpl(): WebFlashImpl | null {
  return _impl;
}

/**
 * Whether the installed flasher (if any) supports `boardKind` here.
 * Safe to call unconditionally — false in OSS builds and on browsers
 * without Web Serial.
 */
export function webFlashAvailable(boardKind: string): boolean {
  if (!_impl) return false;
  try {
    return _impl.available(boardKind);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[oss] web-flash impl threw in available():', err);
    return false;
  }
}

/**
 * Whether MicroPython projects on `boardKind` can be flashed here:
 * the installed impl must support the board AND implement the
 * MicroPython path.
 */
export function webFlashMpyAvailable(boardKind: string): boolean {
  if (!_impl?.flashMicroPython) return false;
  return webFlashAvailable(boardKind);
}

/**
 * The bootloader step the installed flasher wants for `boardKind`, or null
 * (no impl, no method, or a family that needs none).
 */
export function webFlashBootloaderHint(boardKind: string): BootloaderHint | null {
  if (!_impl?.bootloaderHint) return null;
  try {
    return _impl.bootloaderHint(boardKind);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[oss] web-flash impl threw in bootloaderHint():', err);
    return null;
  }
}

/** The revisions the installed flasher lists for `boardKind`, or null. */
export function webFlashHardwareRevisions(boardKind: string): HardwareRevision[] | null {
  if (!_impl?.hardwareRevisions) return null;
  try {
    const list = _impl.hardwareRevisions(boardKind);
    return list && list.length > 1 ? list : null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[oss] web-flash impl threw in hardwareRevisions():', err);
    return null;
  }
}

// ── Hardware-flash entitlement gate ─────────────────────────────────────
// Whether THIS build may flash real hardware at all. OSS default: allowed.
// The desktop overlay installs a gate that requires a paid (non-trial)
// license — issue #207 "upload to board" ships in the paid desktop app.
// The Flash dialog keeps its menu entry either way and, when blocked,
// renders the upgrade panel instead of the port picker.

export interface HardwareFlashGate {
  /** Called at open time (and re-evaluated on each render). */
  allowed(): boolean;
  /** Where "See plans" goes; opened externally on desktop. */
  upgradeUrl: string;
}

let _gate: HardwareFlashGate | null = null;

export function installHardwareFlashGate(gate: HardwareFlashGate | null): void {
  _gate = gate;
}

export function hardwareFlashAllowed(): boolean {
  return _gate ? _gate.allowed() : true;
}

export function hardwareFlashUpgradeUrl(): string {
  return _gate?.upgradeUrl ?? '/pricing';
}

