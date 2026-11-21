import { DiffEditor } from '@monaco-editor/react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, History, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getEditorLanguage } from '../../lib/editorLanguages';
import { useLocalWorkspace } from '../../lib/localWorkspace';
import { getDiskFileVersions, getLocalFileVersions, type LocalFileVersion } from '../../services/localProjects';
import { useEditorPreferences } from '../../store/useEditorPreferences';
import { useEditorStore, type WorkspaceFile } from '../../store/useEditorStore';
import { defineVelxioThemes, useMonacoTheme } from './monacoThemes';

function relativeSaveTime(formatter: Intl.RelativeTimeFormat, time: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes >= 1_440) return formatter.format(-Math.floor(minutes / 1_440), 'day');
  if (minutes >= 60) return formatter.format(-Math.floor(minutes / 60), 'hour');
  return formatter.format(-minutes, 'minute');
}

function positionTooltip(tooltip: HTMLDivElement, anchor: HTMLButtonElement) {
  const row = anchor.getBoundingClientRect();
  const section = anchor.closest('details')?.getBoundingClientRect();
  const header = anchor.closest('details')?.querySelector('summary')?.getBoundingClientRect();
  const margin = 8;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const right = window.innerWidth - width - margin;
  const bottom = window.innerHeight - height - margin;
  let left = row.right;
  let top = row.top;

  if (left > right) {
    left = row.left - width;
    if (left < margin) {
      left = Math.max(margin, Math.min(row.left, right));
      top = row.bottom <= bottom ? row.bottom : row.top - height;
    }
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(margin, Math.min(top, bottom))}px`;
  tooltip.style.visibility = section && row.top < section.bottom && row.bottom > (header?.bottom ?? section.top)
    ? 'visible'
    : 'hidden';
}

export function FileTimeline({ groupId, file }: { groupId: string; file?: WorkspaceFile }) {
  const { t, i18n } = useTranslation();
  const filePath = file?.name;
  const browserId = useLocalWorkspace((state) => state.browserId);
  const diskId = useLocalWorkspace((state) => state.diskId);
  const projectId = browserId ?? diskId;
  const lastSavedAt = useLocalWorkspace((state) => state.lastSavedAt);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [result, setResult] = useState<{ key: string; versions: LocalFileVersion[] | null }>();
  const fileKey = JSON.stringify([projectId, groupId, file?.id, filePath]);
  const key = JSON.stringify([fileKey, lastSavedAt]);
  const [active, setActive] = useState<{ key: string; index: number; row: HTMLButtonElement } | null>(null);
  const [preview, setPreview] = useState<{ fileKey: string; version: LocalFileVersion } | null>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const tooltipId = useId();

  useEffect(() => {
    if (!open || !projectId || !filePath) return;
    let cancelled = false;
    const readVersions = diskId ? getDiskFileVersions : getLocalFileVersions;
    void readVersions(projectId, groupId, filePath).then(
      (versions) => { if (!cancelled) setResult({ key, versions }); },
      () => { if (!cancelled) setResult({ key, versions: null }); },
    );
    return () => { cancelled = true; };
  }, [diskId, filePath, groupId, key, open, projectId]);

  const versions = result?.key === key ? result.versions : undefined;
  const activeEntry = open && active?.key === key && versions?.[active.index] !== undefined
    ? active
    : null;
  const formatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'long',
    timeStyle: 'medium',
  });
  const relativeFormatter = new Intl.RelativeTimeFormat(i18n.resolvedLanguage, {
    numeric: 'auto',
    style: 'short',
  });
  const label = t('editor.timeline.fileSaved', 'File Saved');
  const message = !filePath
    ? t('editor.timeline.selectFile', 'Select a file to see its save history.')
    : !projectId
      ? t('editor.timeline.saveProject', 'Save this project to start recording file history.')
      : versions === null
        ? t('editor.timeline.loadFailed', 'Could not read local file history.')
        : versions === undefined
          ? t('editor.timeline.loading', 'Loading file history…')
          : t('editor.timeline.empty', 'This file has no local saves yet.');

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useLayoutEffect(() => {
    const panel = tooltip.current;
    if (!activeEntry || !panel) return;
    const update = () => positionTooltip(panel, activeEntry.row);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(activeEntry.row);
    observer.observe(panel);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [activeEntry]);

  const activeTime = activeEntry ? versions?.[activeEntry.index]?.savedAt : undefined;
  const selectedVersion = preview?.fileKey === fileKey ? preview.version : null;

  const restoreVersion = (content: string) => {
    const editor = useEditorStore.getState();
    const workspace = useLocalWorkspace.getState();
    if (file && editor.activeGroupId === groupId && editor.activeFileId === file.id &&
        !editor.manifestViewBoardId && (workspace.browserId ?? workspace.diskId) === projectId) {
      editor.setFileContent(file.id, content);
    }
    setPreview(null);
  };

  return (
    <details
      className="file-explorer-timeline"
      onToggle={(event) => {
        const expanded = event.currentTarget.open;
        setOpen(expanded);
        if (expanded) setNow(Date.now());
        else setActive(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && activeEntry) {
          event.stopPropagation();
          setActive(null);
        }
      }}
    >
      <summary>
        <ChevronRight size={13} className="file-explorer-timeline-chevron" aria-hidden />
        <div className="file-explorer-timeline-text-container">
          <span className="file-explorer-timeline-title">{t('editor.timeline.title', 'Timeline')}</span>
          {filePath && (
            <span className="file-explorer-timeline-file" title={filePath}>
              {filePath.slice(filePath.lastIndexOf('/') + 1)}
            </span>
          )}
        </div>
      </summary>
      {versions?.length ? (
        <ol>
          {versions.map((version, index) => (
            <li key={`${version.savedAt}/${index}`}>
              <button
                type="button"
                className="file-explorer-timeline-entry"
                aria-haspopup="dialog"
                data-active={activeEntry?.index === index || undefined}
                aria-describedby={activeEntry?.index === index ? tooltipId : undefined}
                onClick={() => {
                  setActive(null);
                  setPreview({ fileKey, version });
                }}
                onFocus={(event) => setActive({ key, index, row: event.currentTarget })}
                onBlur={() => setActive(null)}
                onMouseEnter={(event) => setActive({ key, index, row: event.currentTarget })}
                onMouseLeave={(event) => {
                  if (event.currentTarget === document.activeElement) return;
                  if (event.relatedTarget instanceof Node && tooltip.current?.contains(event.relatedTarget)) return;
                  setActive(null);
                }}
              >
                <span className="file-explorer-timeline-dot" aria-hidden="true" />
                <span>{label}</span>
                <time dateTime={new Date(version.savedAt).toISOString()} aria-label={formatter.format(version.savedAt)}>
                  {relativeSaveTime(relativeFormatter, version.savedAt, now)}
                </time>
              </button>
            </li>
          ))}
        </ol>
      ) : <p>{message}</p>}
      {activeTime !== undefined && createPortal(
        <div
          id={tooltipId}
          ref={tooltip}
          className="file-explorer-timeline-tooltip"
          role="tooltip"
          onMouseLeave={(event) => {
            if (event.relatedTarget instanceof Node && activeEntry?.row.contains(event.relatedTarget)) return;
            if (activeEntry?.row !== document.activeElement) setActive(null);
          }}
        >
          <time dateTime={new Date(activeTime).toISOString()}>
            <History size={13} aria-hidden />
            {formatter.format(activeTime)}
          </time>
          <div>{label}</div>
        </div>,
        document.body,
      )}
      {file && selectedVersion && (
        <FileVersionComparison
          file={file}
          version={selectedVersion}
          savedTime={formatter.format(selectedVersion.savedAt)}
          onClose={() => setPreview(null)}
          onRestore={restoreVersion}
        />
      )}
    </details>
  );
}

function FileVersionComparison({ file, version, savedTime, onClose, onRestore }: {
  file: WorkspaceFile;
  version: LocalFileVersion;
  savedTime: string;
  onClose: () => void;
  onRestore: (content: string) => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const title = useId();
  const theme = useMonacoTheme();
  const fontSize = useEditorPreferences((settings) => settings.fontSize);
  const wordWrap = useEditorPreferences((settings) => settings.wordWrap);
  const savedLabel = t('editor.timeline.savedVersion', 'Saved version');
  const currentLabel = t('editor.timeline.currentFile', 'Current file');

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    closeButton.current?.focus();
    return () => element?.close();
  }, []);

  return createPortal(
    <dialog
      ref={dialog}
      className="file-version-comparison"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header>
        <div className="file-version-comparison-heading">
          <h2 id={title}>{t('editor.timeline.compareVersion', 'Compare saved version')}</h2>
          <span dir="auto" title={file.name}>{file.name}</span>
        </div>
        <button
          type="button"
          ref={closeButton}
          className="file-version-comparison-close"
          aria-label={t('editor.fileTabs.close', 'Close')}
          onClick={onClose}
        >
          <X size={18} aria-hidden />
        </button>
      </header>
      <div className="file-version-comparison-labels" dir="ltr">
        <div>
          <span dir="auto">{savedLabel}</span>
          <time dateTime={new Date(version.savedAt).toISOString()} dir="auto">{savedTime}</time>
        </div>
        <div><span dir="auto">{currentLabel}</span></div>
      </div>
      <DiffEditor
        original={version.content}
        modified={file.content}
        language={getEditorLanguage(file.name)}
        theme={theme}
        beforeMount={defineVelxioThemes}
        loading={t('editor.timeline.loadingComparison', 'Loading comparison…')}
        options={{
          readOnly: true,
          originalEditable: false,
          automaticLayout: true,
          renderSideBySide: true,
          useInlineViewWhenSpaceIsLimited: false,
          enableSplitViewResizing: false,
          originalAriaLabel: savedLabel,
          modifiedAriaLabel: currentLabel,
          fontSize,
          diffWordWrap: wordWrap ? 'on' : 'off',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
        }}
      />
      <footer>
        <button
          type="button"
          disabled={version.content === file.content}
          onClick={() => onRestore(version.content)}
        >
          {t('editor.timeline.restore', 'Restore version')}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
