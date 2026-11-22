import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { ArrowLeft, FolderOpen, HardDrive, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  deleteBrowserWorkspace,
  hasUnsavedLocalChanges,
  renameBrowserWorkspace,
  saveLocalWorkspace,
  useLocalWorkspace,
} from '../../lib/localWorkspace';
import { listLocalProjects, type LocalProjectDetails } from '../../services/localProjects';
import { SearchBar } from '../ui/SearchBar';
import { NewProjectTemplates } from './NewProjectDialog';

type LocalProjectsContentProps =
  | { view: 'start'; onNew: () => void; onSaved: () => void; onOpenDisk?: () => Promise<void>; onClose: () => void }
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
 * Creates, opens, renames, and deletes projects stored in browser IndexedDB.
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
      onClick={(event) => {
        if (props.view !== 'start' || event.target !== event.currentTarget) return;
        const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
        if (event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom) {
          content.current?.cancel();
        }
      }}
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
  const [confirmation, setConfirmation] = useState<
    { kind: 'open'; id: string } | { kind: 'delete' | 'rename'; project: LocalProjectDetails } | null
  >(null);
  const [name, setName] = useState(workspaceName ?? '');
  const actionDialog = useRef<HTMLDialogElement>(null);
  const cancelAction = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = actionDialog.current;
    if (!confirmation || !element) return;
    element.showModal();
    if (confirmation.kind === 'rename') {
      nameInput.current?.focus();
      nameInput.current?.select();
    } else {
      cancelAction.current?.focus();
    }
    return () => element.close();
  }, [confirmation]);

  useImperativeHandle(ref, () => ({
    cancel: () => {
      if (busy) return;
      if (confirmation) setConfirmation(null);
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
    const confirmed = confirmation?.kind === 'open' && confirmation.id === id;
    if (browserId !== id && !confirmed && hasUnsavedLocalChanges()) {
      setConfirmation({ kind: 'open', id });
      return;
    }
    setConfirmation(null);
    props.onOpen(id);
  };

  const openDisk = async () => {
    if (props.view !== 'start' || !props.onOpenDisk || busy) return;
    setBusy(true);
    try {
      await props.onOpenDisk();
    } finally {
      setBusy(false);
    }
  };

  const refreshProjects = () => listLocalProjects().then(setProjects, () => undefined);

  const removeProject = async (project: LocalProjectDetails) => {
    setBusy(true);
    setError('');
    try {
      await deleteBrowserWorkspace(project.id, project.revision);
      setProjects((items) => items?.filter(({ id }) => id !== project.id) ?? null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('editor.localProjects.deleteError', 'Could not delete this local copy.'),
      );
      await refreshProjects();
    } finally {
      setConfirmation(null);
      setBusy(false);
    }
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
      } else if (confirmation?.kind === 'rename') {
        const { project } = confirmation;
        const { id, name, createdAt, updatedAt, revision } = await renameBrowserWorkspace(
          project.id,
          project.revision,
          projectName,
        );
        setProjects((items) => [
          { id, name, createdAt, updatedAt, revision },
          ...(items ?? []).filter((item) => item.id !== id),
        ]);
        setConfirmation(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshProjects();
      setConfirmation(null);
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
  const nameField = (
    <>
      <label htmlFor="local-project-name">
        {t('editor.localProjects.projectName', 'Project name')}
      </label>
      <input
        ref={nameInput}
        id="local-project-name"
        value={name}
        maxLength={100}
        required
        autoFocus={view === 'save'}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
      />
    </>
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
          <button type="button" className="local-projects-start-new" onClick={props.onNew} disabled={busy}>
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
          <button type="button" onClick={props.onSaved} disabled={busy}>
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
          {props.onOpenDisk && (
            <button type="button" className="local-projects-start-disk" onClick={() => void openDisk()} disabled={busy}>
              <span className="local-projects-start-icon">
                <HardDrive size={21} aria-hidden />
              </span>
              <strong>{t('editor.menu.openDisk', 'Open .vlx from disk…')}</strong>
            </button>
          )}
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
            <SearchBar
              className="local-projects-search"
              value={query}
              placeholder={t('editor.localProjects.search', 'Search projects')}
              onValueChange={setQuery}
            />
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
                        setName(name);
                        setConfirmation({ kind: 'rename', project });
                        setError('');
                      }}
                    >
                      <Pencil size={15} aria-hidden />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="local-projects-delete"
                      aria-label={t('editor.localProjects.deleteProject', 'Delete {{name}}', { name })}
                      title={t('editor.localProjects.deleteCopy', 'Delete local copy')}
                      onClick={() => {
                        setConfirmation({ kind: 'delete', project });
                        setError('');
                      }}
                    >
                      <Trash2 size={15} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {confirmation && (
            <dialog
              ref={actionDialog}
              className="local-projects-action-dialog"
              aria-labelledby="local-projects-action-title"
              aria-describedby={confirmation.kind === 'rename' ? undefined : 'local-projects-action-description'}
              onCancel={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!busy) setConfirmation(null);
              }}
            >
              <h3 id="local-projects-action-title">
                {confirmation.kind === 'rename'
                  ? t('editor.localProjects.renameTitle', 'Rename local copy')
                  : confirmation.kind === 'open'
                    ? t('editor.localProjects.openTitle', 'Open saved project')
                    : t('editor.localProjects.deleteCopy', 'Delete local copy')}
              </h3>
              {confirmation.kind === 'rename' ? (
                <form
                  className="local-projects-rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitName();
                  }}
                >
                  {nameField}
                  <footer className="local-projects-footer">
                    <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>
                      {t('editor.fileTabs.cancel', 'Cancel')}
                    </button>
                    <button type="submit" className="local-projects-primary" disabled={!name.trim() || busy}>
                      {t('editor.localProjects.rename', 'Rename')}
                    </button>
                  </footer>
                </form>
              ) : (
                <>
                  <p id="local-projects-action-description">
                    {confirmation.kind === 'open'
                      ? t('editor.localProjects.unsaved', 'This workspace has unsaved changes.')
                      : t(
                        'editor.localProjects.confirmDelete',
                        'Delete the local copy of “{{name}}” and its file history?',
                        { name: confirmation.project.name },
                      )}
                  </p>
                  {confirmation.kind === 'delete' && browserId === confirmation.project.id && (
                    <p>
                      {t(
                        'editor.localProjects.deleteOpenCopy',
                        'The open workspace will stay in the editor as an unsaved draft.',
                      )}
                    </p>
                  )}
                  <footer className="local-projects-footer">
                    <button ref={cancelAction} type="button" disabled={busy} onClick={() => setConfirmation(null)}>
                      {t('editor.fileTabs.cancel', 'Cancel')}
                    </button>
                    <button
                      type="button"
                      className={confirmation.kind === 'open' ? 'local-projects-discard' : 'local-projects-delete'}
                      disabled={busy}
                      onClick={() => {
                        if (confirmation.kind === 'open') open(confirmation.id);
                        else void removeProject(confirmation.project);
                      }}
                    >
                      {confirmation.kind === 'open'
                        ? t('editor.localProjects.discard', 'Discard changes and open')
                        : t('editor.localProjects.deleteCopy', 'Delete')}
                    </button>
                  </footer>
                </>
              )}
            </dialog>
          )}
        </>
      )}

      {view === 'save' && (
        <form
          className="local-projects-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitName();
          }}
        >
          {nameField}
          <button type="submit" className="local-projects-primary" disabled={!name.trim() || busy}>
            {t('editor.localProjects.saveTitle', 'Save project')}
          </button>
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
