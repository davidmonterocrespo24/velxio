/**
 * Pro save-action registry.
 *
 * EditorPage used to import useAuthStore + SaveProjectModal + LoginPromptModal
 * directly, branching on `user` to decide which modal to open when the
 * user pressed Save. After Phase 3 of the OSS split, all of those live
 * in the pro overlay. The OSS editor exposes a stable `triggerSaveAction()`
 * that:
 *
 *   - In OSS, or when a local project is open, save to the browser or the
 *     selected file. Exporting a portable .vlx is a separate command.
 *   - With the pro overlay loaded → installSaveActionImpl() overrides
 *     the default. The overlay's impl inspects the auth store and opens
 *     SaveProjectModal (logged in) or LoginPromptModal (anonymous).
 *
 * Impl receives no arguments and returns nothing. State lives in the
 * caller's React tree (modal open/close, project data) — this registry
 * is just the doorbell.
 */

import { hasLocalWorkspace, saveLocalWorkspace } from './localWorkspace';

let _impl: (() => void) | null = null;

export function installSaveActionImpl(impl: (() => void) | null): void {
  _impl = impl;
}

export function triggerSaveAction(onFirstLocalSave?: () => void): void {
  if (!_impl && !hasLocalWorkspace() && onFirstLocalSave) {
    onFirstLocalSave();
    return;
  }
  if (!_impl || hasLocalWorkspace()) {
    void saveLocalWorkspace();
    return;
  }
  try {
    _impl();
  } catch (err) {
    console.warn('[oss] save-action impl threw:', err);
  }
}

/** Whether an overlay has installed its own save handler. */
export function hasSaveActionImpl(): boolean {
  return _impl !== null;
}
