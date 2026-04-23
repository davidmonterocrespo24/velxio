/**
 * `InstallFlowController` — host-side singleton that owns the consent /
 * update-diff dialog lifecycle (SDK-008c).
 *
 * The marketplace UI and the plugin loader call into this controller via
 * two narrow methods; the controller decides whether a dialog is needed
 * (delegating to the SDK's `requiresConsent` / `classifyUpdateDiff`
 * helpers) and either resolves immediately ("auto-approve" path) or
 * mounts the matching React dialog and waits for the user to act.
 *
 * Design constraints:
 *
 *   - **Singleton**. Only one modal can be open at a time — overlapping
 *     consent + update would steal focus from one another. A second
 *     `requestX` call while a dialog is already mounted is rejected with
 *     `InstallFlowBusyError` rather than silently queued, so the caller
 *     surfaces the conflict instead of getting a stuck promise.
 *
 *   - **Pure logic, no React dependency.** The controller exposes a
 *     `subscribe(listener)` callback so an `<InstallFlowOverlay />`
 *     component can subscribe via `useSyncExternalStore` and render the
 *     pending dialog. This file imports zero React APIs — testable in
 *     plain Vitest without jsdom.
 *
 *   - **Skipped versions** flow through `useInstalledPluginsStore` so a
 *     reload doesn't re-prompt for an already-declined release. The
 *     controller never touches localStorage directly — it calls the
 *     store's `markVersionSkipped` action.
 *
 *   - **Toast path is permission-free.** `auto-approve-with-toast` does
 *     not block the install — it resolves immediately and emits a
 *     `'plugin:update:toast'` callback the host can render through the
 *     existing notification surface. We do NOT mount a modal for it.
 */

import {
  classifyUpdateDiff,
  diffPermissions,
  requiresConsent,
  type PermissionCatalogEntry,
  type PluginManifest,
  type PluginPermission,
  type UpdateDiffDecision,
} from '@velxio/sdk';

// ── Public types ─────────────────────────────────────────────────────────

export type InstallDecision =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'cancelled' };

export type UpdateDecision =
  | { readonly kind: 'updated' }
  | { readonly kind: 'skipped'; readonly version: string }
  | { readonly kind: 'uninstalled' }
  | { readonly kind: 'cancelled' };

export interface InstallToastEvent {
  readonly pluginId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly added: ReadonlyArray<PermissionCatalogEntry>;
}

/**
 * Public hooks the controller calls when an update flow yields a
 * decision the host has to act on. Wired by `App.tsx` against the
 * production loader / store; tests pass mocks.
 */
export interface InstallFlowSinks {
  /**
   * Mark `version` as the user-declined release for `pluginId`. Default
   * wires through `useInstalledPluginsStore.markVersionSkipped`.
   */
  readonly markVersionSkipped: (pluginId: string, version: string) => void;
  /**
   * Surface a low-risk update notification (used for the
   * `auto-approve-with-toast` path). Optional — when absent, the toast
   * payload is silently dropped (the install still proceeds).
   */
  readonly emitToast?: (event: InstallToastEvent) => void;
}

/**
 * What the overlay component needs to render. Discriminated by `kind`.
 * `null` means no dialog is open.
 */
export type ActiveDialog =
  | {
      readonly kind: 'install';
      readonly manifest: PluginManifest;
      readonly httpAllowlist?: ReadonlyArray<string>;
      readonly onConfirm: () => void;
      readonly onCancel: () => void;
    }
  | {
      readonly kind: 'update';
      readonly manifest: PluginManifest;
      readonly fromVersion: string;
      readonly toVersion: string;
      readonly decision: UpdateDiffDecision;
      readonly httpAllowlist?: ReadonlyArray<string>;
      readonly onUpdate: () => void;
      readonly onSkipVersion: () => void;
      readonly onUninstall: () => void;
      readonly onCancel: () => void;
    };

export interface InstallFlowController {
  /**
   * Open the install consent dialog for `manifest`. Resolves with
   * `{ kind: 'confirmed' }` when the user clicks Install, or
   * `{ kind: 'cancelled' }` when they back out (Escape, Cancel, overlay
   * click). When the manifest declares only Low-risk permissions the
   * promise resolves immediately with `confirmed` — no dialog is mounted.
   *
   * @throws InstallFlowBusyError if a dialog is already open.
   */
  requestInstall(
    manifest: PluginManifest,
    options?: { readonly httpAllowlist?: ReadonlyArray<string> },
  ): Promise<InstallDecision>;
  /**
   * Open the update-diff dialog. Behaviour depends on the diff:
   *   - `auto-approve`               → resolves `{ kind: 'updated' }` immediately.
   *   - `auto-approve-with-toast`    → fires `emitToast`, resolves `{ kind: 'updated' }`.
   *   - `requires-consent`           → mounts the dialog; resolves on user action.
   *
   * @throws InstallFlowBusyError if a dialog is already open.
   */
  requestUpdate(
    installed: { readonly manifest: PluginManifest },
    latest: { readonly manifest: PluginManifest; readonly httpAllowlist?: ReadonlyArray<string> },
  ): Promise<UpdateDecision>;
  /** What the overlay should render right now. `null` = nothing. */
  getActiveDialog(): ActiveDialog | null;
  /** Subscribe to dialog changes (open/close). Returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
  /**
   * Cancel any open dialog (synchronously). Used by the host shell to
   * close the modal when the user signs out or navigates away. Resolves
   * the pending promise with `cancelled`/`cancelled` semantics.
   */
  cancelActive(): void;
}

export class InstallFlowBusyError extends Error {
  constructor() {
    super(
      'InstallFlowController: a consent or update dialog is already open. ' +
        'Wait for the active flow to resolve before requesting another.',
    );
    this.name = 'InstallFlowBusyError';
  }
}

// ── Implementation ───────────────────────────────────────────────────────

class InstallFlowControllerImpl implements InstallFlowController {
  private active: ActiveDialog | null = null;
  private listeners = new Set<() => void>();
  private readonly sinks: InstallFlowSinks;

  constructor(sinks: InstallFlowSinks) {
    this.sinks = sinks;
  }

  getActiveDialog(): ActiveDialog | null {
    return this.active;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  cancelActive(): void {
    const current = this.active;
    if (current === null) return;
    if (current.kind === 'install') current.onCancel();
    else current.onCancel();
  }

  /**
   * Note: NOT declared `async` — the busy guard throws *synchronously*
   * so a misbehaving caller sees the exception immediately instead of an
   * unhandled rejection on a microtask. The body returns a Promise built
   * from `Promise.resolve(...)` / `new Promise(...)` to honour the public
   * type while preserving sync throws.
   */
  requestInstall(
    manifest: PluginManifest,
    options?: { readonly httpAllowlist?: ReadonlyArray<string> },
  ): Promise<InstallDecision> {
    if (this.active !== null) throw new InstallFlowBusyError();
    const permissions: ReadonlyArray<PluginPermission> = manifest.permissions ?? [];
    if (!requiresConsent(permissions)) {
      return Promise.resolve<InstallDecision>({ kind: 'confirmed' });
    }
    return new Promise<InstallDecision>((resolve) => {
      const settle = (decision: InstallDecision) => {
        this.clearActive();
        resolve(decision);
      };
      this.setActive({
        kind: 'install',
        manifest,
        ...(options?.httpAllowlist !== undefined ? { httpAllowlist: options.httpAllowlist } : {}),
        onConfirm: () => settle({ kind: 'confirmed' }),
        onCancel: () => settle({ kind: 'cancelled' }),
      });
    });
  }

  /** Same sync-throw discipline as `requestInstall` (see comment above). */
  requestUpdate(
    installed: { readonly manifest: PluginManifest },
    latest: { readonly manifest: PluginManifest; readonly httpAllowlist?: ReadonlyArray<string> },
  ): Promise<UpdateDecision> {
    if (this.active !== null) throw new InstallFlowBusyError();
    const fromVersion = installed.manifest.version;
    const toVersion = latest.manifest.version;
    const oldPerms = installed.manifest.permissions ?? [];
    const newPerms = latest.manifest.permissions ?? [];
    const diff = diffPermissions(oldPerms, newPerms);
    const decision = classifyUpdateDiff(diff);

    if (decision.kind === 'auto-approve') {
      return Promise.resolve<UpdateDecision>({ kind: 'updated' });
    }
    if (decision.kind === 'auto-approve-with-toast') {
      this.sinks.emitToast?.({
        pluginId: latest.manifest.id,
        fromVersion,
        toVersion,
        added: decision.added,
      });
      return Promise.resolve<UpdateDecision>({ kind: 'updated' });
    }
    // requires-consent: actually mount the dialog.
    return new Promise<UpdateDecision>((resolve) => {
      const settle = (next: UpdateDecision) => {
        this.clearActive();
        resolve(next);
      };
      this.setActive({
        kind: 'update',
        manifest: latest.manifest,
        fromVersion,
        toVersion,
        decision,
        ...(latest.httpAllowlist !== undefined ? { httpAllowlist: latest.httpAllowlist } : {}),
        onUpdate: () => settle({ kind: 'updated' }),
        onSkipVersion: () => {
          this.sinks.markVersionSkipped(latest.manifest.id, toVersion);
          settle({ kind: 'skipped', version: toVersion });
        },
        onUninstall: () => settle({ kind: 'uninstalled' }),
        onCancel: () => settle({ kind: 'cancelled' }),
      });
    });
  }

  private setActive(next: ActiveDialog): void {
    this.active = next;
    this.notify();
  }

  private clearActive(): void {
    this.active = null;
    this.notify();
  }

  private notify(): void {
    // Snapshot the listener set so a listener that mutates `listeners`
    // (e.g. an unsubscribe fired during render) doesn't break iteration.
    const snapshot = Array.from(this.listeners);
    for (const fn of snapshot) {
      try {
        fn();
      } catch {
        // Listener bug — fault-isolated, same convention as EventBus.
      }
    }
  }
}

// ── Module-level singleton ────────────────────────────────────────────────

let singleton: InstallFlowController | null = null;

/**
 * Initialise the host-wide controller. The editor calls this once at
 * startup with the production sinks; tests inject mocks via
 * `setInstallFlowController` directly. Idempotent — re-calling replaces
 * the previous instance (useful for HMR).
 */
export function configureInstallFlow(sinks: InstallFlowSinks): InstallFlowController {
  singleton = new InstallFlowControllerImpl(sinks);
  return singleton;
}

/**
 * Read the configured controller. Throws if `configureInstallFlow` was
 * not called yet — the marketplace UI / loader code paths are wired to
 * invoke this only after editor bootstrap, and a missing controller is a
 * programmer error, not a user-facing degraded state.
 */
export function getInstallFlowController(): InstallFlowController {
  if (singleton === null) {
    throw new Error(
      'InstallFlowController not configured. Call configureInstallFlow() during editor startup.',
    );
  }
  return singleton;
}

/** Test seam — replaces the singleton with `instance`, or clears it when null. */
export function setInstallFlowControllerForTests(
  instance: InstallFlowController | null,
): void {
  singleton = instance;
}

/** Test seam — construct a controller without touching the singleton. */
export function createInstallFlowControllerForTests(
  sinks: InstallFlowSinks,
): InstallFlowController {
  return new InstallFlowControllerImpl(sinks);
}
