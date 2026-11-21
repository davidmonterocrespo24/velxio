import { useEffectEvent, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocaleFromPath, localizedPath } from '../i18n/path';
import {
  hasUnsavedLocalChanges,
  keepWorkspaceLocationState,
  openLocalWorkspace,
  useLocalWorkspace,
} from '../lib/localWorkspace';
import { whenNewsClear } from '../lib/newsGate';
import { showConfirmDialog } from '../store/useMessageDialogStore';
import { useProjectStore } from '../store/useProjectStore';
import { restoreStashedWorkspace } from '../utils/workspaceDraft';

export function useEditorProjectRoute({
  clearWorkspace,
  showStartup,
  closeProjectDialog,
}: {
  clearWorkspace: () => void;
  showStartup: () => void;
  closeProjectDialog: () => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const { localProjectId } = useParams<{ localProjectId: string }>();
  const projectId = useLocalWorkspace((state) => state.browserId ?? state.diskId);
  const editorPath = localizedPath('/editor', getLocaleFromPath(location.pathname));
  const bare = location.pathname.replace(/\/+$/, '') === editorPath;
  const bareEntry = useRef<{
    key: string;
    path: string;
    version: number;
    showStartup: boolean;
  } | null>(null);

  const syncProjectUrl = useEffectEvent((previousId: string | null) => {
    const pathname = window.location.pathname.replace(/\/+$/, '');
    const base = localizedPath('/editor', getLocaleFromPath(pathname));
    const { browserId, diskId } = useLocalWorkspace.getState();
    const id = browserId ?? diskId;
    if (id) {
      const destination = `${base}/${encodeURIComponent(id)}`;
      if (pathname !== destination) navigate(destination, { replace: true });
    } else if (previousId && pathname === `${base}/${encodeURIComponent(previousId)}`) {
      navigate(base, { replace: true, state: keepWorkspaceLocationState() });
    }
  });

  // IndexedDB commits may arrive while the router is rendering an earlier
  // navigation. Use the address bar as the source of the current route.
  useLayoutEffect(() => {
    let disposed = false;
    const unsubscribe = useLocalWorkspace.subscribe((next, previous) => {
      const previousId = previous.browserId ?? previous.diskId;
      if ((next.browserId ?? next.diskId) === previousId) return;
      queueMicrotask(() => {
        if (!disposed) syncProjectUrl(previousId);
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useLayoutEffect(() => {
    if (!bare && !localProjectId) return;
    const request = new AbortController();
    const initialize = async () => {
      const { browserId, diskId } = useLocalWorkspace.getState();
      const activeId = browserId ?? diskId;
      if (localProjectId) bareEntry.current = null;
      if (localProjectId && localProjectId === activeId) return;

      const version = useProjectStore.getState().workspaceVersion;
      const carriedVersion = location.state?.keepWorkspaceVersion;
      if (bare && version > 0 && carriedVersion === version) {
        bareEntry.current = { key: location.key, path: editorPath, version, showStartup: false };
        return;
      }

      if (navigationType === 'POP' && activeId && hasUnsavedLocalChanges()) {
        const discard = await showConfirmDialog(
          t('editor.localProjects.unsaved', 'This workspace has unsaved changes.'),
          {
            confirmLabel: t('editor.localProjects.discardChanges', 'Discard changes'),
            danger: true,
          },
        );
        if (request.signal.aborted) return;
        if (!discard) {
          navigate(`${editorPath}/${encodeURIComponent(activeId)}`, { replace: true });
          return;
        }
      }

      if (localProjectId) {
        closeProjectDialog();
        const opened = await openLocalWorkspace(localProjectId, request.signal).catch(() => false);
        if (!opened && !request.signal.aborted) navigate(editorPath, { replace: true });
        return;
      }

      // Locale switches within the same blank workspace keep the in-memory
      // state. An actual history visit to /editor starts a new workspace.
      if (bareEntry.current && bareEntry.current.path !== editorPath) {
        bareEntry.current = { ...bareEntry.current, key: location.key, path: editorPath };
      } else if (bareEntry.current?.key !== location.key) {
        closeProjectDialog();
        const restored = restoreStashedWorkspace();
        if (!restored) clearWorkspace();
        bareEntry.current = {
          key: location.key,
          path: editorPath,
          version: useProjectStore.getState().workspaceVersion,
          showStartup: !restored,
        };
      }
      const entry = bareEntry.current;
      if (!entry.showStartup) return;
      await whenNewsClear(2500);
      if (
        !request.signal.aborted &&
        entry.version === useProjectStore.getState().workspaceVersion
      ) {
        entry.showStartup = false;
        showStartup();
      }
    };
    void initialize();
    return () => request.abort();
  }, [
    bare,
    clearWorkspace,
    closeProjectDialog,
    editorPath,
    localProjectId,
    location.key,
    location.state,
    navigate,
    navigationType,
    showStartup,
    t,
  ]);

  return {
    openingProject: Boolean(localProjectId && localProjectId !== projectId),
    openProject: (id: string) => {
      closeProjectDialog();
      if (id !== localProjectId) navigate(`${editorPath}/${encodeURIComponent(id)}`);
    },
    leaveProjectRoute: () => {
      if (!bare) navigate(editorPath, { replace: true, state: keepWorkspaceLocationState() });
    },
  };
}
