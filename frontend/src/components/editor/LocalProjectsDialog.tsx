import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { ArrowLeft, FolderOpen, Pencil, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  hasUnsavedLocalChanges,
  renameBrowserWorkspace,
  saveLocalWorkspace,
  useLocalWorkspace,
} from '../../lib/localWorkspace';
import { listLocalProjects, type LocalProjectDetails } from '../../services/localProjects';
import { NewProjectTemplates } from './NewProjectDialog';

type LocalProjectsContentProps =
  | { view: 'start'; onNew: () => void; onSaved: () => void; onClose?: () => void }
  | { view: 'saved'; onOpen: (id: string) => void; onBack?: () => void; onSaveCopy?: () => void; onClose: () => void }
  | { view: 'save'; copy: boolean; onClose: () => void };

type LocalProjectsDialogProps =
  | LocalProjectsContentProps
  | {
      view: 'templates';
      onClose: () => void;
      onBack: () => void;
      onSaveFailed: () => void;
    };

/**
 * Creates, opens, and renames projects stored in browser IndexedDB.
 * Saved projects can be reopened in the same browser profile.
 */
export function LocalProjectsDialog(props: LocalProjectsDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<{ cancel: () => void }>(null);
  const { view } = props;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element?.open && !element.contains(document.activeElement)) {
      element.querySelector<HTMLElement>('button:enabled, input:enabled')?.focus();
    }
  }, [view]);

  return (
    <dialog
      className={view === 'templates' ? 'new-project-dialog' : 'local-projects-dialog'}
      ref={dialog}
      aria-labelledby="local-projects-title"
      onCancel={(event) => {
        event.preventDefault();
        content.current?.cancel();
      }}
    >
      {props.view === 'templates' ? (
        <NewProjectTemplates
          ref={content}
          onBack={props.onBack}
          onClose={props.onClose}
          onSaveFailed={props.onSaveFailed}
        />
      ) : (
        <LocalProjectsContent key={view} ref={content} {...props} />
      )}
    </dialog>
  );
}

function LocalProjectsContent(
  props: LocalProjectsContentProps & { ref: Ref<{ cancel: () => void }> },
) {
  const { t, i18n } = useTranslation();
  const { view, onClose, ref } = props;
  const browserId = useLocalWorkspace((state) => state.browserId);
  const workspaceName = useLocalWorkspace((state) => state.name);
  const [projects, setProjects] = useState<LocalProjectDetails[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<LocalProjectDetails | null>(null);
  const [name, setName] = useState(workspaceName ?? '');

  useImperativeHandle(ref, () => ({
    cancel: () => {
      if (busy) return;
      if (confirmId) setConfirmId(null);
      else if (renaming) setRenaming(null);
      else if (props.view === 'saved' && props.onBack) props.onBack();
      else onClose?.();
    },
  }));

  useEffect(() => {
    if (view !== 'saved') return;
    let cancelled = false;
    void listLocalProjects().then(
      (records) => {
        if (!cancelled) setProjects(records);
      },
      () => {
        if (!cancelled)
          setError(
            t('editor.localProjects.loadError', 'Could not read projects saved in this browser.'),
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [view, t]);

  const open = (id: string) => {
    if (props.view !== 'saved') return;
    if (browserId !== id && confirmId !== id && hasUnsavedLocalChanges()) {
      setConfirmId(id);
      setRenaming(null);
      return;
    }
    props.onOpen(id);
  };

  const submitName = async () => {
    const projectName = name.trim();
    if (!projectName) return;
    setBusy(true);
    setError('');
    try {
      if (view === 'save') {
        if (await saveLocalWorkspace({ copyName: projectName })) onClose();
        else
          setError(
            useLocalWorkspace.getState().errorMessage ??
              t('editor.localProjects.saveError', 'Could not save this project.'),
          );
      } else if (renaming) {
        const { id, name, createdAt, updatedAt, revision } = await renameBrowserWorkspace(
          renaming.id,
          renaming.revision,
          projectName,
        );
        setProjects((items) => [
          { id, name, createdAt, updatedAt, revision },
          ...(items ?? []).filter((item) => item.id !== id),
        ]);
        setRenaming(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      try {
        setProjects(await listLocalProjects());
      } catch {
        // Keep the current list if a failing browser store cannot be read.
      }
      setRenaming(null);
    } finally {
      setBusy(false);
    }
  };

  const savedTitle = t('editor.localProjects.title', 'Saved projects');
  const title =
    view === 'start'
      ? t('editor.localProjects.startTitle', 'Start a project')
      : view === 'saved'
        ? savedTitle
        : props.copy
          ? t('editor.localProjects.saveCopy', 'Save a local copy')
          : t('editor.localProjects.saveTitle', 'Save project');
  const formatDate = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const term = query.trim().toLocaleLowerCase(i18n.resolvedLanguage);
  const visibleProjects = projects?.filter((project) =>
    project.name.toLocaleLowerCase(i18n.resolvedLanguage).includes(term),
  );

  return (
    <>
      <header className="local-projects-heading">
        {props.view === 'saved' && props.onBack && (
          <button
            type="button"
            disabled={busy}
            onClick={props.onBack}
            aria-label={t('editor.localProjects.back', 'Back')}
          >
            <ArrowLeft size={16} aria-hidden />
          </button>
        )}
        <h2 id="local-projects-title">{title}</h2>
      </header>

      {props.view === 'start' && (
        <div className="local-projects-start">
          <button type="button" className="local-projects-start-new" onClick={props.onNew}>
            <span className="local-projects-start-icon">
              <Plus size={21} aria-hidden />
            </span>
            <span>
              <strong>{t('editor.localProjects.new', 'New project')}</strong>
              <small>
                {t(
                  'editor.localProjects.newDescription',
                  'Start blank or choose a board template.',
                )}
              </small>
            </span>
          </button>
          <button type="button" onClick={props.onSaved}>
            <span className="local-projects-start-icon">
              <FolderOpen size={21} aria-hidden />
            </span>
            <span>
              <strong>{savedTitle}</strong>
              <small>
                {t(
                  'editor.localProjects.savedDescription',
                  'Open a project saved in this browser.',
                )}
              </small>
            </span>
          </button>
        </div>
      )}

      {error && (
        <p className="local-projects-error" role="alert">
          {error}
        </p>
      )}
      {view === 'saved' && (
        <>
          {!projects && !error && (
            <p role="status">{t('editor.localProjects.loading', 'Loading local projects…')}</p>
          )}
          {projects?.length === 0 && (
            <p>{t('editor.localProjects.empty', 'No projects saved in this browser yet.')}</p>
          )}
          {projects && projects.length > 0 && (
            <label className="local-projects-search">
              <Search size={16} aria-hidden />
              <input
                type="search"
                value={query}
                aria-label={t('editor.localProjects.search', 'Search projects')}
                placeholder={t('editor.localProjects.search', 'Search projects')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          {projects && projects.length > 0 && visibleProjects?.length === 0 && (
            <p role="status">
              {t('editor.localProjects.noMatches', 'No projects match your search.')}
            </p>
          )}
          {visibleProjects && visibleProjects.length > 0 && (
            <ul className="local-projects-list">
              {visibleProjects.map((project) => {
                const { id, name, createdAt, updatedAt } = project;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => open(id)}
                      className="local-projects-item"
                      aria-current={browserId === id ? 'true' : undefined}
                      title={name}
                    >
                      <strong>{name}</strong>
                      <span className="local-projects-metadata">
                        <span>
                          {t('editor.localProjects.lastSaved', 'Last saved')}{' '}
                          <time dateTime={new Date(updatedAt).toISOString()}>
                            {formatDate.format(updatedAt)}
                          </time>
                        </span>
                        <span>
                          {t('editor.localProjects.created', 'Created')}{' '}
                          <time dateTime={new Date(createdAt).toISOString()}>
                            {formatDate.format(createdAt)}
                          </time>
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="local-projects-rename"
                      aria-label={t('editor.localProjects.renameProject', 'Rename {{name}}', {
                        name,
                      })}
                      title={t('editor.localProjects.rename', 'Rename')}
                      onClick={() => {
                        setRenaming(project);
                        setName(name);
                        setConfirmId(null);
                        setError('');
                      }}
                    >
                      <Pencil size={15} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {confirmId && (
            <div className="local-projects-confirm">
              <p>{t('editor.localProjects.unsaved', 'This workspace has unsaved changes.')}</p>
              <button type="button" onClick={() => open(confirmId)}>
                {t('editor.localProjects.discard', 'Discard changes and open')}
              </button>
              <button type="button" onClick={() => setConfirmId(null)}>
                {t('editor.fileTabs.cancel', 'Cancel')}
              </button>
            </div>
          )}
        </>
      )}

      {(view === 'save' || renaming) && (
        <form
          className="local-projects-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitName();
          }}
        >
          <label htmlFor="local-project-name">
            {t('editor.localProjects.projectName', 'Project name')}
          </label>
          <input
            id="local-project-name"
            value={name}
            maxLength={100}
            required
            autoFocus
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="local-projects-primary" disabled={!name.trim() || busy}>
            {renaming
              ? t('editor.localProjects.rename', 'Rename')
              : t('editor.localProjects.saveTitle', 'Save project')}
          </button>
          {renaming && (
            <button type="button" disabled={busy} onClick={() => setRenaming(null)}>
              {t('editor.fileTabs.cancel', 'Cancel')}
            </button>
          )}
        </form>
      )}

      {view !== 'start' && (
        <footer className="local-projects-footer">
          {props.view === 'saved' && props.onSaveCopy && (
            <button type="button" disabled={busy} onClick={props.onSaveCopy}>
              {t('editor.localProjects.saveCopy', 'Save a local copy')}
            </button>
          )}
          <button type="button" disabled={busy} onClick={onClose}>
            {t('editor.fileTabs.close', 'Close')}
          </button>
        </footer>
      )}
    </>
  );
}
