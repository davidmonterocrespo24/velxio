/**
 * proBoardRegistry — runtime registration seam for boards a private overlay
 * (velxio.com) ships outside the OSS tree.
 *
 * The OSS BoardKind union and its compiler-enforced Record maps stay exactly
 * as they are for the open boards. An overlay calls registerProBoards() at
 * mount with data-only definitions; registration patches the exported maps in
 * types/board.ts (labels / FQBN / MicroPython set) so every existing read site
 * keeps working untouched, and the handful of sites a map can't cover (canvas
 * render, pin-name mapping, simulator construction, firmware load) consult
 * getProBoard() as a fallback.
 *
 * The OSS build never registers anything here — like the proRoutes /
 * __velxio_pro_gate__ / registerComponentDoc seams, this module is dead code
 * until an overlay imports it. Board ad cards (ONLINE_ONLY_BOARD_ADS) hide
 * automatically for registered kinds: the picker filter checks
 * `ad.id in BOARD_KIND_LABELS`, and registration inserts the label.
 */
import type React from 'react';
import type { ESP32BoardOptions } from '../types/boardOptions';
import {
  BOARD_KIND_LABELS,
  BOARD_KIND_FQBN,
  BOARD_KIND_ESPIDF_FQBN,
  BOARD_SUPPORTS_ESPIDF,
  BOARD_SUPPORTS_MICROPYTHON,
  registerPiFamilyKind,
  type BoardKind,
} from '../types/board';

/** Structural contract for an overlay-provided in-browser board simulator.
 *  Mirrors the surface the store already uses on RP2040Simulator — the store
 *  only ever duck-types these members for pro simulators. */
export interface ProBoardSimulator {
  /** Brand flag so the store can recognize overlay simulators without a class. */
  readonly isProBoardSimulator: true;
  onSerialData: ((ch: string) => void) | null;
  onPinChangeWithTime: ((pin: number, state: boolean, time: number) => void) | null;
  /** The line the console is clocking (see store/serialWire.ts); optional — a
   *  simulator that does not report one leaves the monitor making no claim. */
  onBaudRateChange?:
    | ((baudRate: number, link: import('../store/serialWire').SerialLink) => void)
    | null;
  stop(): void;
  detachPioPeripheral?(): void;
}

/**
 * A microSD slot the board carries itself.
 *
 * The BUS is what the host has to model. An SPI slot shares SCK/MOSI/MISO with
 * whatever else sits on that bus, so the bridge needs the CS pin to know when
 * the card is the one being addressed (a standalone SD component on the canvas
 * still overrides this to un-gated). An SDMMC slot is its own controller with
 * no chip select at all — declaring a CS pin for it would be a fiction, which
 * is why this is a union and not an optional number.
 *
 * What both have in common is the part the user sees: a place to put files.
 * That is why the board's properties panel offers the same upload panel a card
 * component gets, and why the run path builds the card image either way.
 */
export type BuiltInSdSlot =
  /**
   * A slot on an SPI bus. The chip select is what puts the card panel on the
   * board's context menu; the other three wires are the same hardware fact and
   * say WHICH bus the slot is on, which is what a host outside this tab needs
   * to be told (project board-buses-2026-09, F4). A board whose builtins
   * already register the slot themselves may leave them out.
   */
  | { bus: 'spi'; csPin: number; sck?: number; mosi?: number; miso?: number }
  /** A slot on the chip's own SDMMC host: no bus to share, no select to gate. */
  | { bus: 'sdmmc' };

export interface ProBoardDef {
  /** The board id — behaves like a BoardKind everywhere at runtime. */
  kind: string;
  label: string;
  /** arduino-cli FQBN, or null when the board has no backend compile. */
  fqbn: string | null;
  /** One-line picker description. */
  description: string;
  /** The board's custom-element tag. The overlay's import must have run
   *  customElements.define for it before the board is placed. */
  tag: string;
  /** True pixel size of the element (selection ring + pin overlays). */
  size: { w: number; h: number };
  /** Attributes the picker sets on the thumbnail element. A tag shared by
   *  several boards (one element, a `variant` attribute) otherwise previews
   *  its default look for every one of them. */
  thumbnailAttrs?: Record<string, string>;
  supportsMicroPython?: boolean;
  /** Board can run pure ESP-IDF projects (app_main entry, no Arduino
   *  core). Registers the kind into BOARD_SUPPORTS_ESPIDF, which is what
   *  gates the toolbar's ESP-IDF option AND setBoardLanguageMode — an
   *  overlay board without it silently ignores every attempt to enter
   *  ESP-IDF mode, so an `languageMode: 'espidf'` gallery example opens
   *  in Arduino mode instead. ESP32 family only. */
  supportsEspIdf?: boolean;
  /** FQBN the ESP-IDF lane compiles this board with, when the board has
   *  no Arduino FQBN of its own (`fqbn: null`) or needs a different one.
   *  Only used to derive the backend's IDF target. */
  espidfFqbn?: string;
  /** ESP32 run-path routing: the base chip the board carries. Routes the run
   *  through the ESP32 bridge path and picks the machine/engine type. Omit for
   *  boards that provide createSimulator (RP2350 class) or AVR/RP2040. */
  esp32Family?: 'esp32' | 'esp32-s3' | 'esp32-c3' | 'esp32-c6' | 'esp32-p4' | 'esp32-c5';
  /** QEMU-Linux run-path routing: route this kind through the Raspberry Pi
   *  bridge (backend qemu WebSocket, VFS panel, boot terminal). The overlay
   *  must also register a matching backend profile for the kind. */
  piFamily?: boolean;
  /** One shell line sent to the guest right after it reaches the boot
   *  prompt (piFamily boards only). Lets a board de-brand the generic
   *  image, e.g. set its own hostname/PS1 and clear the stock motd. */
  guestSetup?: string;
  /** Home directory of the guest user for the VFS panel and uploads
   *  (piFamily boards only; default '/home/pi'). Boards whose guest logs
   *  in as root pass '/root'; these also drop the hello.sh sample. */
  guestHome?: string;
  /** Shell command run automatically after boot: the VFS is uploaded and
   *  this line executed, so a single click on Run boots, uploads and
   *  starts the user's script (piFamily boards only). */
  autoRun?: string;
  /** Suppress the guest's boot chatter in the terminal (piFamily boards
   *  only): the shared rootfs prints another product's banner/motd during
   *  boot, before guestSetup can re-brand it. With quietBoot the terminal
   *  shows a neutral Velxio boot-progress line instead and reveals the
   *  shell right before the auto-run command executes. */
  quietBoot?: boolean;
  /** Canvas renderer. Receives the placed board's props; return a React node.
   *  When omitted, the canvas renders `<tag id=... style=absolute@x,y>`. */
  render?: (props: { id: string; x: number; y: number; running: boolean }) => React.ReactNode;
  /** pinInfo name -> GPIO number (power/ground pins -> -1). Falls back to the
   *  generic numeric parse when omitted. Return null for "not mine". */
  pinToNumber?: (pinName: string) => number | null;
  /**
   * Which pads reach the ADC, and on which channel — the overlay's own version
   * of the OSS ADC_PIN_MAP.
   *
   * That map is keyed by the BoardKind union, which no overlay kind can join,
   * so the SPICE analog path skipped every pro board outright: a divider or an
   * LDR wired to one of these boards solved correctly and then had nowhere to
   * go. Parts that inject directly (a potentiometer through partUtils) were
   * unaffected, which is why this looked like it worked.
   *
   * Names are pad names as they appear in pinInfo. A pad that is analog under a
   * different silk (the Pimoroni Pico Plus 2 W ties GP26/27/28 to the ADC-
   * capable GP40/41/42 through 1k) is declared under the name a wire uses.
   */
  adcPins?: Array<{ pinName: string; channel: number }>;
  /**
   * Supply pads and logic voltage, for the SPICE netlist — the overlay's
   * version of BOARD_PIN_GROUPS, which is keyed by the BoardKind union and so
   * can never name a pro board.
   *
   * Without it a board falls back to that table's `default`: 5 V, ground pads
   * called GND/GND.1/GND.2, supply pads called 5V/VCC. For a 3.3 V board with a
   * "3V3" pad that is wrong twice over, and silently — the rail is simply
   * solved at 5 V, so every divider, pull-up and LED current on the board is
   * off by 1.5x.
   *
   * Shape matches BoardPinGroup: { vcc, gnd[], vcc_pins[], aux? }.
   */
  power?: {
    vcc: number;
    gnd: string[];
    vcc_pins: string[];
    aux?: { volts: number; pins: string[] };
  };
  /** In-browser simulator factory (e.g. the RP2350/Hazard3 emulator). The pm
   *  argument is the store's PinManager instance. */
  createSimulator?: (pm: unknown) => ProBoardSimulator;
  /** Load compiled firmware into a createSimulator() instance at run time —
   *  the overlay owns the whole sequence (PIO attach, binary load, the
   *  board's own I2C chips, ...). `program` is the compiled artifact exactly as the store
   *  holds it (base64/hex string, same value RP2040Simulator.loadBinary gets). */
  loadFirmware?: (
    sim: ProBoardSimulator,
    program: string,
    ctx: { boardKind: string; boardId: string },
  ) => void;
  /** Built-in bridge sensors registered without wiring (e.g. an on-board I2C
   *  keyboard): pushed into the ESP32 bridge's sensor config on every run. */
  builtInSensors?: Array<{ sensor_type: string; pin: number; addr?: number }>;
  /** A microSD slot the board carries itself — see BuiltInSdSlot. */
  builtInSd?: BuiltInSdSlot;
  /** Board carries an on-board microphone whose bridge implements
   *  setMicrophoneSource (I2S RX sample injection): shows the canvas-header
   *  Mic toggle that streams the computer's microphone into it. */
  builtInMicrophone?: boolean;
  /** The board carries a camera fed from the host webcam (CameraToggle in the
   *  canvas header; the bridge implements pushCameraFrame). An object form
   *  caps the injected JPEG size for drivers with tight frame buffers. */
  builtInCamera?: boolean | { maxFrameBytes?: number };
  /** Display-controller identity for panel autodetect probes. Vendor
   *  libraries (M5GFX and friends) identify a board by reading the panel's
   *  RDDID over SPI with the display's own chip-select — and reject the
   *  board, or misdetect it as something else entirely, when the answer is
   *  the bus's idle 0xFF. A bridge that supports this answers `idByte` on
   *  MISO while `csPin` is low. Board DATA, not bridge code: the M5Stack
   *  Core is `{ csPin: 14, idByte: 0xE3 }` (ILI9342C), the Cardputer ADV
   *  `{ csPin: 37, idByte: 0x85 }` (ST7789V2). */
  spiPanelId?: { csPin: number; idByte: number };
  /** Board carries an IMU whose bridge implements setImuAcceleration /
   *  setImuGyro: shows the canvas-header tilt pad. Without it the emulated
   *  part faithfully reports the board lying flat for the whole run. */
  builtInImu?: boolean;
  /** Board reads a battery through its bridge (setBatteryVoltage): shows the
   *  canvas-header charge slider, so low-battery code paths can be reached. */
  builtInBattery?: boolean;
  /** Power-management IC on the internal I2C bus, when the board carries one
   *  the vendor library probes. Board DATA like spiPanelId: the bridge that
   *  supports the type instantiates the model at the given address, and
   *  setBatteryVoltage drives it. The M5Stack Core is
   *  { type: 'ip5306', addr: 0x75 }. */
  i2cPmic?: { type: 'ip5306'; addr?: number };
  /** Built-in peripheral attachment for a RUNNING board (LCD decoder onto the
   *  element's own canvas, speaker, on-board button/keyboard event forwarding).
   *  Called shortly after run start with the board's DOM element plus its
   *  simulator shim and ESP32 bridge (either may be null depending on the run
   *  path); must return a cleanup that detaches everything. */
  attachBuiltins?: (ctx: { el: HTMLElement; sim: unknown; bridge: unknown }) => () => void;

  /**
   * Seed code a freshly placed board starts with, per language mode.
   *
   * Without this the editor falls back to the family default — the Arduino
   * `LED_BUILTIN` blink, the Pico `Pin(25)` blink, or the Raspberry Pi
   * `RPi.GPIO` script — and NONE of those run on a board that has no such
   * LED, no RPi.GPIO and its own vendor library (an M5Stack needs
   * `M5.begin()`, the UNIHIKER needs pinpong/unihiker). The user's very
   * first Run then fails on a board they have not touched yet. Keep each
   * entry as close to the vendor's own first example as the emulator
   * allows, and self-contained: a freshly placed board has nothing wired
   * to it, so the code must do something visible on the board itself.
   *
   * Keys are the board's language modes plus 'python' for QEMU-Linux
   * (piFamily) boards, whose seed is the guest script.
   */
  defaultFiles?: Partial<
    Record<
      'arduino' | 'micropython' | 'espidf' | 'python',
      Array<{ name: string; content: string }>
    >
  >;
  /** Library manifest seeded together with `defaultFiles.arduino` — the seed
   *  sketch includes the vendor library, so the board must declare it or the
   *  first compile resolves against nothing. */
  defaultLibraries?: string[];

  /**
   * Build options this board is physically born with, merged over the family
   * defaults whenever the project has not saved its own.
   *
   * A module carries the RAM and flash it carries: the ESP32-S3-EYE always has
   * 8 MB of octal PSRAM, and its camera driver allocates the frame buffer with
   * MALLOC_CAP_SPIRAM. Compiled with the conservative family default
   * (CONFIG_SPIRAM=n) the sketch builds fine and then dies at run time with
   * `cam_dma_config(509): frame buffer malloc failed` — a hardware fact
   * reported as a mysterious driver error. Boards that ship the RAM say so
   * here; everything else keeps sending no options at all.
   */
  defaultBoardOptions?: Partial<ESP32BoardOptions>;

  /** Sidebar / toolbar accents (fall back to a neutral chip icon). */
  icon?: string;
  color?: string;
}

const registry = new Map<string, ProBoardDef>();

// Registration happens when the overlay's dynamic import lands - potentially
// AFTER a consumer rendered and memoized its board list. Subscribers re-render
// on every registration (same contract as proRoutes / registerProExamples).
let version = 0;
const listeners = new Set<() => void>();

export function subscribeProBoards(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getProBoardsVersion(): number {
  return version;
}

export function registerProBoards(defs: ProBoardDef[]): void {
  for (const def of defs) {
    registry.set(def.kind, def);
    const kind = def.kind as BoardKind;
    // Patch the exported maps so every existing read site sees the board —
    // labels also make the picker's ONLINE ad for this kind disappear.
    (BOARD_KIND_LABELS as Record<string, string>)[kind] = def.label;
    (BOARD_KIND_FQBN as Record<string, string | null>)[kind] = def.fqbn;
    if (def.supportsMicroPython) BOARD_SUPPORTS_MICROPYTHON.add(kind);
    if (def.supportsEspIdf) BOARD_SUPPORTS_ESPIDF.add(kind);
    if (def.espidfFqbn) {
      (BOARD_KIND_ESPIDF_FQBN as Record<string, string>)[kind] = def.espidfFqbn;
    }
    if (def.piFamily) registerPiFamilyKind(def.kind);
  }
  version++;
  for (const l of listeners) l();
}

export function getProBoard(kind: string): ProBoardDef | undefined {
  return registry.get(kind);
}

// ── Guest setup lines for boards the OSS tree already owns ───────────────
//
// A QEMU-Linux board that is NOT overlay-registered (the Raspberry Pi
// family) may still need a line run at the boot prompt — an overlay can
// mount something on the guest for it. Registering a whole ProBoardDef
// just to carry that string is the wrong tool: `getProBoard` is what
// BoardOnCanvas checks to decide whether to render the overlay's custom
// element instead of the OSS board art, so a stub def silently replaced
// the Pi's illustration with a bare schematic box and left the wires
// hanging at the corner. This registry carries the line and nothing else.
const guestSetups = new Map<string, string>();

export function registerGuestSetup(kind: string, line: string): void {
  guestSetups.set(kind, line);
}

/** The line to run at the guest's boot prompt: an overlay board's own
 *  `guestSetup` first, then anything registered for an OSS board kind. */
export function getGuestSetup(kind: string): string | undefined {
  return registry.get(kind)?.guestSetup ?? guestSetups.get(kind);
}

// ── Extra request ops for a Linux board's guest ─────────────────────────
//
// A Linux guest asks the canvas for things through one grammar of request
// lines (`I2C ...`, `SPI ...`, `W1 ...`), answered by the board's shim in the
// browser whether the script runs in the tab or in a guest behind the relay.
// The grammar is the open-source tree's; what hangs off a board is not always:
// a camera on the CSI ribbon has no pins and no bus, and whoever provides the
// camera needs a way to answer `CAM ...` without the shim learning what a
// camera is. An op registered here is consulted for any first token the
// built-in grammar does not know. Return the reply line, or null for none.
export type PiBusOpHandler = (boardId: string, tokens: string[]) => string | null;

const piBusOps = new Map<string, PiBusOpHandler>();

/** Returns the function that removes it again. */
export function registerPiBusOp(op: string, handler: PiBusOpHandler): () => void {
  piBusOps.set(op, handler);
  return () => {
    if (piBusOps.get(op) === handler) piBusOps.delete(op);
  };
}

export function getPiBusOp(op: string): PiBusOpHandler | undefined {
  return piBusOps.get(op);
}

// ── Built-in peripheral attachment for boards the OSS tree already owns ──
//
// Same reasoning as the guest setups above: an overlay may need to wire
// something to a run of an OSS-rendered board — the Pi family has no
// built-in screen, but an overlay can route the guest's display frames to
// a panel wired on the canvas. Carrying that through a stub ProBoardDef
// would take over the board's artwork, so it gets its own registry.
type BuiltinsAttach = (ctx: { el: HTMLElement; sim: unknown; bridge: unknown }) => () => void;

const boardBuiltins = new Map<string, BuiltinsAttach>();

export function registerBoardBuiltins(kind: string, attach: BuiltinsAttach): void {
  boardBuiltins.set(kind, attach);
}

/** How to attach built-in peripherals for a board kind: an overlay board's
 *  own `attachBuiltins` first, then anything registered for an OSS kind. */
export function getBoardBuiltins(kind: string): BuiltinsAttach | undefined {
  return registry.get(kind)?.attachBuiltins ?? boardBuiltins.get(kind);
}

// ── Line-owning sensor support per board kind (simulation/line) ────────────
// A board that hosts a line-owning sensor (DHT22, HC-SR04) a way the generic
// simulator shim cannot see declares it here. The Raspberry Pi family reads
// its pins over a serial link and models no timed edges, so it defaults to a
// refusal; the UNIHIKER serves those two sensors as named slider values (a
// hosted model, like the ESP32 QEMU worker), so the overlay registers a
// `hosted` declaration for it. Kept as a per-kind registry rather than a
// ProBoardDef field so an OSS-rendered kind can carry it without a stub def —
// the same seam as registerBoardBuiltins / registerGuestSetup above.
//
// Typed structurally so this OSS module does not import the line contract's
// types: `mode` is 'local' | 'hosted' | 'none', with the fields each carries.
export type BoardLineSupport =
  | { mode: 'local' }
  | { mode: 'hosted'; models: readonly string[] }
  | { mode: 'none'; why: string };

const boardLineSupport = new Map<string, BoardLineSupport>();

export function registerBoardLineSupport(kind: string, support: BoardLineSupport): void {
  boardLineSupport.set(kind, support);
}

/** The line-support declaration an overlay registered for a board kind, or
 *  undefined when none — the caller applies its own default. */
export function getBoardLineSupport(kind: string): BoardLineSupport | undefined {
  return boardLineSupport.get(kind);
}

/**
 * Seed files for a board kind in a given language mode, or undefined when the
 * board carries no seed of its own (the editor's family default applies).
 * `mode` is 'python' for QEMU-Linux boards — see ProBoardDef.defaultFiles.
 */
export function getBoardSeedFiles(
  kind: string,
  mode: 'arduino' | 'micropython' | 'espidf' | 'python',
): Array<{ name: string; content: string }> | undefined {
  const files = registry.get(kind)?.defaultFiles?.[mode];
  return files && files.length ? files : undefined;
}

export function listProBoards(): ProBoardDef[] {
  return Array.from(registry.values());
}

export function isProBoardSimulator(sim: unknown): sim is ProBoardSimulator {
  return !!sim && (sim as { isProBoardSimulator?: boolean }).isProBoardSimulator === true;
}
