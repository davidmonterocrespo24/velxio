import { getProBoard } from '../lib/proBoardRegistry';

export type BoardKind =
  | 'arduino-uno'
  | 'arduino-nano'
  | 'arduino-mega'
  | 'raspberry-pi-pico' // RP2040, browser emulation
  | 'pi-pico-w' // RP2040 + WiFi, browser emulation (WiFi ignored)
  | 'raspberry-pi-zero' // QEMU virt + Cortex-A7 (armhf), backend — looks-like Pi Zero
  | 'raspberry-pi-1'    // QEMU virt + Cortex-A7 (armhf), backend — looks-like Pi 1
  | 'raspberry-pi-2'    // QEMU virt + Cortex-A7 (armhf), backend
  | 'raspberry-pi-3' // QEMU virt + Cortex-A53, backend
  | 'raspberry-pi-4' // QEMU virt + Cortex-A72, backend
  | 'raspberry-pi-5' // QEMU virt + Cortex-A76, backend
  | 'esp32' // Xtensa LX6, QEMU backend
  | 'esp32-devkit-c-v4' // ESP32 DevKit C V4, QEMU (esp32)
  | 'esp32-cam' // ESP32-CAM, QEMU (esp32)
  | 'wemos-lolin32-lite' // Wemos Lolin32 Lite, QEMU (esp32)
  | 'esp32-s3' // Xtensa LX7, QEMU backend
  | 'xiao-esp32-s3' // Seeed XIAO ESP32-S3, QEMU (esp32-s3)
  | 'arduino-nano-esp32' // Arduino Nano ESP32 (S3), QEMU (esp32-s3)
  | 'esp32-c3' // RISC-V RV32IMC, QEMU backend
  | 'xiao-esp32-c3' // Seeed XIAO ESP32-C3, QEMU backend
  | 'aitewinrobot-esp32c3-supermini' // ESP32-C3 SuperMini, QEMU backend
  | 'stm32-bluepill' // STM32F103C8 (Cortex-M3), QEMU backend (libqemu-arm)
  | 'stm32-blackpill' // STM32F411CE (Cortex-M4), QEMU backend (libqemu-arm)
  | 'stm32-bluepill-f103cb' // STM32F103CB (Cortex-M3, 128KB), QEMU (F100 SoC)
  | 'stm32-blackpill-f401' // STM32F401CE (Cortex-M4), QEMU (F405 SoC)
  | 'stm32-f4-discovery' // STM32F407VG Discovery (Cortex-M4), QEMU (F405 SoC)
  | 'stm32-olimex-h405' // Olimex STM32-H405 (F405RG, Cortex-M4), QEMU
  | 'stm32-netduino-plus2' // Netduino Plus 2 (F405, Cortex-M4), QEMU
  | 'stm32-netduino2' // Netduino 2 (F205, Cortex-M3), QEMU (serial until F205 GPIO wired)
  | 'attiny85'; // AVR ATtiny85, browser emulation (avr8js)

export type LanguageMode = 'arduino' | 'micropython' | 'espidf';

/** Extra QEMU-Linux board kinds registered at runtime by a private overlay
 *  (proBoardRegistry defs with `piFamily: true`). They route through the same
 *  backend qemu bridge, VFS panel and terminal UX as the Raspberry Pi family. */
const PI_FAMILY_EXTRA_KINDS = new Set<string>();

export function registerPiFamilyKind(kind: string): void {
  PI_FAMILY_EXTRA_KINDS.add(kind);
}

/** True for every Raspberry Pi backed by the QEMU bridge (Zero, 1, 2, 3, 4, 5)
 *  and any overlay-registered QEMU-Linux board (registerPiFamilyKind).
 *  Excludes the Pico boards (RP2040, browser emulation). */
export function isPiBoardKind(kind: BoardKind | string): boolean {
  if (typeof kind !== 'string') return false;
  return (
    (kind.startsWith('raspberry-pi-') && kind !== 'raspberry-pi-pico') ||
    PI_FAMILY_EXTRA_KINDS.has(kind)
  );
}

/** True for STM32 boards backed by the QEMU bridge (libqemu-arm via
 *  stm32_lib_manager). */
export function isStm32BoardKind(kind: BoardKind | string): boolean {
  return typeof kind === 'string' && kind.startsWith('stm32-');
}

export const BOARD_SUPPORTS_MICROPYTHON = new Set<BoardKind>([
  'raspberry-pi-pico',
  'pi-pico-w',
  // ESP32 Xtensa (QEMU bridge)
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  // ESP32-S3 Xtensa (QEMU bridge)
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
  // ESP32-C3 RISC-V (QEMU bridge)
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
]);

/** Boards that can run pure ESP-IDF projects (app_main entry point, IDF
 *  APIs only — no Arduino core). The backend compiles them through the same
 *  ESP-IDF toolchain it already uses for ESP32 Arduino sketches, just
 *  without the arduino-esp32 component. ESP32 family only (issue #139). */
export const BOARD_SUPPORTS_ESPIDF = new Set<BoardKind>([
  // ESP32 Xtensa (QEMU bridge)
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  // ESP32-S3 Xtensa (QEMU bridge)
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
  // ESP32-C3 RISC-V (QEMU bridge)
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
]);

export interface WifiStatus {
  status: string; // 'initializing' | 'connected' | 'got_ip' | 'disconnected'
  ssid?: string;
  ip?: string;
  /** True when the board's network stack lives in THIS browser tab (in-browser
   *  JS engine). The IoT gateway must then open in the in-app iframe: a new
   *  tab backgrounds this one, the emulation gets timer-throttled, and the
   *  in-chip HTTP server can't answer. Unset = server runs backend-side. */
  inBrowser?: boolean;
}

export interface BleStatus {
  status: string; // 'initialized' | 'advertising'
}

export interface BoardInstance {
  id: string; // unique in canvas, e.g. 'arduino-uno', 'raspberry-pi-3'
  /** Optional user-given display name. Falls back to the kind label when
   *  empty. Lets the user tell two same-kind boards apart in the file
   *  explorer, the compile console, and the canvas selector. */
  name?: string;
  boardKind: BoardKind;
  x: number;
  y: number;
  running: boolean;
  // QEMU-Linux (Raspberry Pi 3/4/5/Zero/1/2) only. `running` flips true the
  // instant the user clicks Start (the WebSocket opens in ~1s), but the guest
  // Linux still takes 30-60s to reach a shell. `piBooted` flips true only when
  // the bridge sees the boot-complete marker, and drives the "Booting…" overlay
  // and gates file uploads. Undefined/false for non-Pi boards and pre-boot.
  piBooted?: boolean;
  /** QEMU-Linux boards only. Which engine this board is running on (or ran
   *  last): 'instant' = in-browser Python, 'linux' = the QEMU guest. Drives
   *  the mode chip and the terminal panel (interactive shell only exists in
   *  Linux mode). Undefined until the first run. */
  engineMode?: 'instant' | 'linux';
  /** User override for the engine, persisted with the project. Set by the
   *  mode chip or by turning on the Linux terminal; wins over the detector
   *  so a project doesn't silently change behaviour between runs. */
  enginePinned?: 'instant' | 'linux';
  /** QEMU-Linux boards only. The backend running this board's guest answers
   *  the guest's I2C / SPI requests from the parts on the canvas (it said so
   *  with a `bus_relay` system event). Until then a part that needs the
   *  guest to reach it has to be handed to the backend some other way. */
  busRelay?: boolean;
  compiledProgram: string | null; // hex for AVR/RP2040, null for Pi (runs Python)
  /**
   * Fingerprint of the sources (+ build options) `compiledProgram` was built
   * from — see utils/sourceFingerprint.ts. Lets the UI tell a build that
   * matches the code on screen from a stale one (the Flash dialog warns
   * and rebuilds). Undefined for builds recorded before this field existed.
   */
  compiledSourceHash?: string | null;
  /**
   * RP2040 / RP2350 only: the .uf2 the compile produced next to the .bin,
   * base64. `compiledProgram` stays the raw .bin the emulator loads; this is
   * what real hardware takes (BOOTSEL drive, picotool, the flash dialog's
   * download link). Null for other families and for builds recorded before
   * the field existed.
   */
  compiledUf2?: string | null;
  /**
   * Hardware revision picked in the flash dialog (HardwareRevision.id),
   * for kinds whose real board comes in more than one chip. Undefined =
   * the one the simulator runs.
   */
  flashRevision?: string | null;
  serialOutput: string;
  serialBaudRate: number;
  serialMonitorOpen: boolean;
  activeFileGroupId: string;
  languageMode: LanguageMode; // 'arduino' (default), 'micropython' or 'espidf'
  hasWifi?: boolean; // set by compiler — true when sketch uses WiFi
  wifiStatus?: WifiStatus;
  bleStatus?: BleStatus;
  // ESP32-only — populated when the user opens Board Options... on the
  // canvas context menu. Undefined for AVR / RP2040 / Pi3 and for
  // pre-feature saved projects (compiler falls back to defaults).
  // Types live in `./boardOptions` to avoid a circular import.
  boardOptions?: import('./boardOptions').ESP32BoardOptions;
  spiffsFiles?: import('./boardOptions').SpiffsFile[];
  /** User uploads for a board's BUILT-IN microSD slot (a ProBoardDef with
   *  builtInSdCsPin, e.g. the XIAO ESP32S3 Sense). Same shape the
   *  microsd-card component persists in properties.sdFiles, and consumed the
   *  same way: merged into buildProjectSdImage on Run, overriding same-named
   *  project files. Undefined for boards without a slot. */
  sdFiles?: Array<{ name: string; contentB64: string }>;
  // P2.4 — this board's declared library manifest (its velxio.json). The ESP32
  // compile scope: each board resolves ONLY its own declared libraries, so two
  // boards in the same project can use different (even conflicting) libraries
  // without clashing. Undefined for pre-feature boards (-> legacy scan-all).
  libraries?: string[];
}

/**
 * Is this string a board kind Velxio can actually put on a canvas?
 *
 * BOARD_KIND_LABELS is exhaustive over the OSS union by construction (the
 * compiler enforces the Record), and the overlay's kinds live in the pro
 * registry, so the two together are the whole space. Callers that receive a
 * kind from OUTSIDE the app — an imported project file, a URL, a saved
 * document — need this: importing a diagram used to answer 'arduino-uno' for
 * anything it did not recognise, and the user got an Uno with no explanation
 * (issue #268).
 */
export function isKnownBoardKind(kind: string): kind is BoardKind {
  // hasOwnProperty, not `in`: `in` walks the prototype chain, so 'toString',
  // 'constructor' and '__proto__' would all pass — and the strings reaching
  // here come from files people send each other.
  return (
    Object.prototype.hasOwnProperty.call(BOARD_KIND_LABELS, kind) ||
    getProBoard(kind) !== undefined
  );
}

/**
 * The networks the emulated radio broadcasts — all open, no password.
 *
 * Both backends beacon the same four (the QEMU fork's esp32_wifi_ap.c and the
 * in-browser engines' ACCESS_POINTS), and a station can only ever associate
 * with one of them. Sketches COMPILED in Velxio never have to know: the
 * compiler rewrites their SSID literal on the way to the emulator. Firmware
 * that arrives already built does not pass through that step, so its own SSID
 * is what it hunts for — which is why an otherwise-working binary sits there
 * failing to connect (issue #270).
 */
export const EMULATED_WIFI_SSIDS = [
  'Velxio-GUEST',
  'PICSimLabWifi',
  'Espressif',
  'MasseyWifi',
] as const;

export const BOARD_KIND_LABELS: Record<BoardKind, string> = {
  'arduino-uno': 'Arduino Uno',
  'arduino-nano': 'Arduino Nano',
  'arduino-mega': 'Arduino Mega 2560',
  'raspberry-pi-pico': 'Raspberry Pi Pico',
  'pi-pico-w': 'Raspberry Pi Pico W',
  'raspberry-pi-zero': 'Raspberry Pi Zero',
  'raspberry-pi-1': 'Raspberry Pi 1B+',
  'raspberry-pi-2': 'Raspberry Pi 2B',
  'raspberry-pi-3': 'Raspberry Pi 3B',
  'raspberry-pi-4': 'Raspberry Pi 4B',
  'raspberry-pi-5': 'Raspberry Pi 5',
  esp32: 'ESP32 DevKit V1',
  'esp32-devkit-c-v4': 'ESP32 DevKit C V4',
  'esp32-cam': 'ESP32-CAM',
  'wemos-lolin32-lite': 'Wemos Lolin32 Lite',
  'esp32-s3': 'ESP32-S3 DevKit',
  'xiao-esp32-s3': 'XIAO ESP32-S3',
  'arduino-nano-esp32': 'Arduino Nano ESP32',
  'esp32-c3': 'ESP32-C3 DevKit',
  'xiao-esp32-c3': 'XIAO ESP32-C3',
  'aitewinrobot-esp32c3-supermini': 'ESP32-C3 SuperMini',
  'stm32-bluepill': 'STM32 Blue Pill',
  'stm32-blackpill': 'STM32 Black Pill',
  'stm32-bluepill-f103cb': 'STM32 Blue Pill (F103CB)',
  'stm32-blackpill-f401': 'STM32 Black Pill (F401)',
  'stm32-f4-discovery': 'STM32F4 Discovery',
  'stm32-olimex-h405': 'Olimex STM32-H405',
  'stm32-netduino-plus2': 'Netduino Plus 2',
  'stm32-netduino2': 'Netduino 2',
  attiny85: 'ATtiny85',
};

/** Display name for a board instance: the user's custom name if set, else the
 *  kind label. Route every user-facing board label through this so renamed
 *  boards show their name everywhere (file explorer, compile console, canvas). */
export function boardDisplayName(board: Pick<BoardInstance, 'name' | 'boardKind'>): string {
  return board.name?.trim() || BOARD_KIND_LABELS[board.boardKind];
}

export const BOARD_KIND_FQBN: Record<BoardKind, string | null> = {
  'arduino-uno': 'arduino:avr:uno',
  'arduino-nano': 'arduino:avr:nano:cpu=atmega328',
  'arduino-mega': 'arduino:avr:mega',
  'raspberry-pi-pico': 'rp2040:rp2040:rpipico',
  'pi-pico-w': 'rp2040:rp2040:rpipicow',
  'raspberry-pi-zero': null,
  'raspberry-pi-1': null,
  'raspberry-pi-2': null,
  'raspberry-pi-3': null,
  'raspberry-pi-4': null,
  'raspberry-pi-5': null,
  esp32: 'esp32:esp32:esp32',
  'esp32-devkit-c-v4': 'esp32:esp32:esp32',
  'esp32-cam': 'esp32:esp32:esp32cam',
  'wemos-lolin32-lite': 'esp32:esp32:lolin32-lite',
  'esp32-s3': 'esp32:esp32:esp32s3',
  'xiao-esp32-s3': 'esp32:esp32:XIAO_ESP32S3',
  'arduino-nano-esp32': 'esp32:esp32:nano_nora',
  'esp32-c3': 'esp32:esp32:esp32c3',
  'xiao-esp32-c3': 'esp32:esp32:XIAO_ESP32C3',
  'aitewinrobot-esp32c3-supermini': 'esp32:esp32:esp32c3',
  'stm32-bluepill': 'STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8',
  'stm32-blackpill': 'STMicroelectronics:stm32:GenF4:pnum=BLACKPILL_F411CE',
  'stm32-bluepill-f103cb': 'STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103CB',
  'stm32-blackpill-f401': 'STMicroelectronics:stm32:GenF4:pnum=BLACKPILL_F401CE',
  'stm32-f4-discovery': 'STMicroelectronics:stm32:Disco:pnum=DISCO_F407VG',
  'stm32-olimex-h405': 'STMicroelectronics:stm32:GenF4:pnum=GENERIC_F405RGTX',
  'stm32-netduino-plus2': 'STMicroelectronics:stm32:GenF4:pnum=GENERIC_F405RGTX',
  'stm32-netduino2': 'STMicroelectronics:stm32:GenF2:pnum=GENERIC_F205RGTX',
  attiny85: 'ATTinyCore:avr:attinyx5:chip=85,clock=16pll',
};

/**
 * FQBN used ONLY by the pure ESP-IDF language mode, for boards where it
 * differs from the Arduino one — in practice, boards that have NO Arduino
 * FQBN at all. The ESP32-C5 kits are the case: no arduino-esp32 core supports
 * the C5 (the backend refuses that target for Arduino on purpose), but the
 * ESP-IDF lane builds them fine and only needs the FQBN to derive its IDF
 * target. Overlay boards fill this through ProBoardDef.espidfFqbn.
 */
export const BOARD_KIND_ESPIDF_FQBN: Partial<Record<BoardKind, string>> = {};

/**
 * The FQBN a compile should use for a board in a given language mode. Every
 * compile site must go through this: reading BOARD_KIND_FQBN directly makes an
 * Arduino-less board (FQBN null) fail with "No FQBN for board kind" even when
 * its ESP-IDF mode is perfectly buildable.
 */
export function fqbnForLanguage(
  kind: BoardKind,
  mode: LanguageMode | undefined,
): string | null {
  if (mode === 'espidf' && BOARD_KIND_ESPIDF_FQBN[kind]) {
    return BOARD_KIND_ESPIDF_FQBN[kind] as string;
  }
  return BOARD_KIND_FQBN[kind] ?? null;
}
