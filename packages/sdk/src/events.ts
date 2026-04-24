/**
 * Public event bus contract.
 *
 * The bus is strictly typed — every event name maps to a payload shape.
 * The host (Core) owns the emitter; plugins see only the read-only
 * `EventBusReader` interface (`on()` / `hasListeners()`).
 *
 * Performance contract (see docs/EVENT_BUS.md and docs/PERFORMANCE.md):
 *   - emit() with 0 listeners ≤ 10 ns
 *   - emit() with 100 listeners ≤ 1 µs
 *   - listeners are error-isolated: a throwing listener does not break others
 *   - `simulator:tick` and `spice:step` are throttled by the host
 */

// ── Event payloads ────────────────────────────────────────────────────────

export type BoardKind =
  | 'arduino-uno'
  | 'arduino-mega'
  | 'arduino-nano'
  | 'rp2040'
  | 'esp32'
  | 'esp32c3'
  | 'raspberry-pi-3';

export type SimulatorMode = 'mcu' | 'electrical';

export type StopReason = 'user' | 'crash' | 'completed' | 'reset';

export type PinState = 0 | 1 | 'z' | 'x';

/**
 * Every event the host can emit, keyed by name.
 *
 * Adding an event: put it here first, then update the host to emit it. The
 * type system will surface every call site that needs adjusting.
 */
export interface SimulatorEvents {
  'simulator:start': { readonly board: BoardKind; readonly mode: SimulatorMode };
  'simulator:stop': { readonly reason: StopReason };
  'simulator:reset': Record<string, never>;
  /** Throttled: at most 10 Hz. Sequence counter increases monotonically. */
  'simulator:tick': {
    readonly cycle: number;
    readonly ts: number;
  };
  'pin:change': {
    readonly componentId: string;
    readonly pinName: string;
    readonly state: PinState;
  };
  'serial:tx': { readonly port: number; readonly data: Uint8Array };
  'serial:rx': { readonly port: number; readonly data: Uint8Array };
  /**
   * An I2C transaction observed on the bus. Emitted either by the MCU
   * driver or by a part that acts as a bus monitor. `direction` is from
   * the master's perspective: `'write'` = master → slave, `'read'` =
   * master ← slave. `stop` is `true` when the transaction was terminated
   * by a STOP condition (as opposed to a repeated START).
   *
   * Parts subscribe via the high-level `api.i2c?.onTransfer(…)` helper.
   */
  'i2c:transfer': {
    readonly addr: number;
    readonly direction: 'read' | 'write';
    readonly data: Uint8Array;
    readonly stop: boolean;
  };
  /**
   * An SPI frame observed on the bus. `mosi` is the master-out / slave-in
   * byte stream, `miso` is the slave response. `cs` is the chip-select
   * line identifier the master asserted (useful when many slaves share
   * a bus). Either `mosi` or `miso` may be zero-length — the receiving
   * side only populates what it actually saw.
   */
  'spi:transfer': {
    readonly cs: string;
    readonly mosi: Uint8Array;
    readonly miso: Uint8Array;
  };
  /** Throttled: at most 5 Hz. `nodes` contains voltages at named SPICE nodes. */
  'spice:step': {
    readonly time: number;
    readonly nodes: Readonly<Record<string, number>>;
  };
  'board:change': { readonly from: BoardKind | null; readonly to: BoardKind };
  'compile:start': Record<string, never>;
  'compile:done': {
    readonly ok: boolean;
    readonly durationMs: number;
    readonly bytes?: number;
    readonly message?: string;
  };
  /**
   * A plugin update was applied automatically by the loader (no consent
   * dialog was shown). Emitted from `PluginLoader.checkForUpdates()`
   * after `manager.unload(id)` + `manager.load(latestManifest, ...)`
   * resolves with status `active`. NOT emitted on the `requires-consent`
   * path — those still need a user click via the badge UI.
   *
   * `addedPermissions` is the delta computed from the prior manifest
   * (post-hoc, after the user implicitly accepted via
   * `auto-approve-with-toast`). Cross-plugin observation requires
   * `simulator.events.read` (Low-risk) — same gate as the rest of the
   * EventBus.
   */
  'plugin:update:applied': {
    readonly pluginId: string;
    readonly fromVersion: string;
    readonly toVersion: string;
    readonly decision: 'auto-approve' | 'auto-approve-with-toast';
    readonly addedPermissions: readonly string[];
  };
}

export type SimulatorEventName = keyof SimulatorEvents;

export type SimulatorEventPayload<K extends SimulatorEventName> = SimulatorEvents[K];

export type SimulatorEventListener<K extends SimulatorEventName> = (
  payload: SimulatorEvents[K],
) => void;

// ── Reader interface (what plugins see) ──────────────────────────────────

/**
 * Subscription handle. Call the returned function to unsubscribe.
 * Always call it in `deactivate()` or you will leak listeners across
 * plugin hot reloads.
 */
export type Unsubscribe = () => void;

export interface EventBusReader {
  on<K extends SimulatorEventName>(
    event: K,
    listener: SimulatorEventListener<K>,
  ): Unsubscribe;
  /**
   * Cheap (O(1)) check. Use this in hot-path call sites to skip payload
   * construction when there are no listeners.
   */
  hasListeners<K extends SimulatorEventName>(event: K): boolean;
  /** Current listener count for an event — debug/diagnostics only. */
  listenerCount<K extends SimulatorEventName>(event: K): number;
}
