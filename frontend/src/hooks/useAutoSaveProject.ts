/**
 * Silent debounced auto-save for the currently loaded project.
 *
 * Mounted once at the top of the editor page. Subscribes to the simulator
 * and editor stores, hashes their persisted slice, and PUTs to the backend
 * 2.5 s after the last change. Keeps a "saved snapshot" hash so it doesn't
 * fire on no-op state churn (e.g. selecting a wire, opening a panel) or
 * immediately after loadProjectState restores a project.
 *
 * Pre-conditions for auto-save to run:
 *   - User is authenticated.
 *   - currentProject is set with a UUID id (not anonymous local state).
 *   - The project has changed since the last successful save.
 *
 * Manual saves through SaveProjectModal continue to work — they update the
 * snapshot hash on completion via the same path (project response triggers
 * setCurrentProject, which the hook treats as "this is the new baseline").
 */

import { useEffect, useRef, useState } from 'react';
import { updateProject } from '../services/projectService';
import { useAuthStore } from '../store/useAuthStore';
import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { buildSavePayload, computeProjectStateHash } from '../utils/projectPayload';

export type AutoSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const DEBOUNCE_MS = 2500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AutoSaveState {
  status: AutoSaveStatus;
  lastSavedAt: number | null;
  errorMessage: string | null;
}

export function useAutoSaveProject(): AutoSaveState {
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Refs let async callbacks read the latest values without restarting effects.
  const lastSavedHashRef = useRef<string | null>(null);
  const inFlightRef = useRef<boolean>(false);
  const debounceTimerRef = useRef<number | null>(null);
  const projectIdRef = useRef<string | null>(null);

  useEffect(() => {
    const flushSave = async () => {
      if (inFlightRef.current) return;
      const projectId = projectIdRef.current;
      if (!projectId) return;
      const currentHash = computeProjectStateHash();
      if (currentHash === lastSavedHashRef.current) return;

      inFlightRef.current = true;
      setStatus('saving');
      try {
        const payload = buildSavePayload();
        // The server signature requires `name` for create but tolerates an
        // empty/omitted name on update; we never change the name from
        // auto-save. Strip it to be explicit.
        const { name: _name, description: _desc, is_public: _pub, ...rest } = payload;
        void _name;
        void _desc;
        void _pub;
        await updateProject(projectId, rest);
        lastSavedHashRef.current = currentHash;
        setStatus('saved');
        setLastSavedAt(Date.now());
        setErrorMessage(null);
      } catch (err: unknown) {
        const e = err as { response?: { status?: number; data?: { detail?: string } } };
        const detail = e?.response?.data?.detail;
        const sc = e?.response?.status;
        setErrorMessage(detail ?? (sc ? `HTTP ${sc}` : 'network error'));
        setStatus('error');
      } finally {
        inFlightRef.current = false;
        // Coalesced changes during the in-flight save: re-evaluate.
        if (computeProjectStateHash() !== lastSavedHashRef.current) {
          scheduleSave();
        }
      }
    };

    const scheduleSave = () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        void flushSave();
      }, DEBOUNCE_MS);
    };

    const onChange = () => {
      const projectId = projectIdRef.current;
      if (!projectId) return;
      const currentHash = computeProjectStateHash();
      if (currentHash === lastSavedHashRef.current) {
        if (status !== 'saved' && status !== 'idle') setStatus('saved');
        return;
      }
      setStatus('dirty');
      scheduleSave();
    };

    // ── Watch identity (auth + currentProject) ───────────────────────────
    const reset = () => {
      const user = useAuthStore.getState().user;
      const proj = useProjectStore.getState().currentProject;
      const eligible = !!user && !!proj && UUID_RE.test(proj.id);
      projectIdRef.current = eligible ? proj!.id : null;
      // Take a snapshot of the freshly-loaded state — this is the baseline
      // for dirty detection. Without this, the very first change would fire
      // an auto-save of the just-loaded project against itself.
      lastSavedHashRef.current = eligible ? computeProjectStateHash() : null;
      setStatus('idle');
      setErrorMessage(null);
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };

    reset();

    const unsubAuth = useAuthStore.subscribe((s, prev) => {
      if (s.user?.id !== prev.user?.id) reset();
    });
    const unsubProject = useProjectStore.subscribe((s, prev) => {
      if (s.currentProject?.id !== prev.currentProject?.id) reset();
    });
    const unsubSim = useSimulatorStore.subscribe(onChange);
    const unsubEditor = useEditorStore.subscribe(onChange);

    // Best-effort flush on tab close — fetch with keepalive survives unload
    // (unlike sendBeacon, it supports PUT and includes credentials).
    const onBeforeUnload = () => {
      const projectId = projectIdRef.current;
      if (!projectId) return;
      const currentHash = computeProjectStateHash();
      if (currentHash === lastSavedHashRef.current) return;
      const payload = buildSavePayload();
      const { name: _n, description: _d, is_public: _p, ...rest } = payload;
      void _n; void _d; void _p;
      try {
        fetch(`/api/projects/${projectId}`, {
          method: 'PUT',
          credentials: 'include',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rest),
        });
      } catch {
        /* no-op */
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      unsubAuth();
      unsubProject();
      unsubSim();
      unsubEditor();
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
    // Run once on mount; the inner subscriptions track state internally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, lastSavedAt, errorMessage };
}
