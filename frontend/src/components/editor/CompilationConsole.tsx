/**
 * CompilationConsole — shows compilation output (stdout, stderr, errors, core install logs).
 * Rendered below the code editor when open. Similar to VS Code's output panel.
 */

import { DropdownSelect } from '../ui/DropdownSelect';
import React, { useRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { compileErrorCount, type CompilationLog, type CompileTarget } from '../../utils/compilationLogger';

/** One contiguous run of log lines for the same target (or none). */
interface LogGroup {
  target?: CompileTarget;
  entries: { log: CompilationLog; index: number }[];
}

/** Group consecutive log lines by target so the console renders a section per
 *  board/chip. Consecutive-run (not collapse-all) preserves chronological order
 *  — a leading "Compiling all targets" and a trailing "Done" stay where they
 *  are, around the per-target sections. */
function groupLogs(logs: CompilationLog[]): LogGroup[] {
  const groups: LogGroup[] = [];
  logs.forEach((log, index) => {
    const last = groups[groups.length - 1];
    if (last && (last.target?.id ?? null) === (log.target?.id ?? null)) {
      last.entries.push({ log, index });
    } else {
      groups.push({ target: log.target, entries: [{ log, index }] });
    }
  });
  return groups;
}

/** A target section's overall outcome, derived from its lines. */
function groupStatus(entries: LogGroup['entries']): 'error' | 'success' | 'running' {
  if (entries.some((e) => e.log.type === 'error')) return 'error';
  if (entries.some((e) => e.log.type === 'success')) return 'success';
  return 'running';
}

interface CompilationConsoleProps {
  isOpen: boolean;
  onClose: () => void;
  logs: CompilationLog[];
  onClear: () => void;
}

// Memoized: the console lives inside EditorPage, which re-renders on every
// simulator-store change (component drags, pin updates, etc.). Without memo,
// each of those re-rendered every log line even though `logs` was untouched.
export const CompilationConsole: React.FC<CompilationConsoleProps> = React.memo(({
  isOpen,
  onClose,
  logs,
  onClear,
}) => {
  const { t } = useTranslation();
  const outputRef = useRef<HTMLDivElement>(null);
  const [autoscroll, setAutoscroll] = useState(true);
  const [filter, setFilter] = useState<'all' | 'errors' | 'warnings'>('all');
  const prevLogsLenRef = useRef(0);

  useEffect(() => {
    if (autoscroll && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [logs, autoscroll]);

  // Auto-switch to "Errors" filter when a new batch of logs arrives with
  // errors — but reset to "all" the moment a fresh compile clears/shrinks
  // the log. Without that reset the 'errors' filter was sticky: after one
  // failing compile, every later SUCCESSFUL compile (info/success lines
  // only) was filtered out and the console looked empty while the sim
  // started. (Reported: "output doesn't refresh after the first compile,
  // unless there's an error".)
  useEffect(() => {
    if (logs.length < prevLogsLenRef.current) {
      // A clear() or reset shrank the list — treat it as a brand-new
      // compile and drop any sticky filter so the next batch is visible.
      prevLogsLenRef.current = logs.length;
      setFilter('all');
      return;
    }
    if (logs.length === prevLogsLenRef.current) return;
    const newLogs = logs.slice(prevLogsLenRef.current);
    prevLogsLenRef.current = logs.length;
    const hasNewErrors = newLogs.some((l) => l.type === 'error');
    if (hasNewErrors) setFilter('errors');
  }, [logs]);

  const filteredLogs = logs.filter((log) => {
    if (filter === 'errors') return log.type === 'error';
    if (filter === 'warnings') return log.type === 'warning' || log.type === 'error';
    return true;
  });

  const errorCount = logs.filter((l) => l.type === 'error').length;
  const warningCount = logs.filter((l) => l.type === 'warning').length;
  // The badge counts every error line shown; a diagnosis is offered only
  // for the compiler's (velxio/velxio-prod#222).
  const compileErrors = compileErrorCount(logs);

  if (!isOpen) return null;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.title}>{t('editor.console.title')}</span>
          <div style={styles.badges}>
            {errorCount > 0 && (
              <span
                style={styles.errorBadge}
                title={t('editor.console.errorCount', { count: errorCount })}
              >
                ✕ {errorCount}
              </span>
            )}
            {warningCount > 0 && (
              <span
                style={styles.warningBadge}
                title={t('editor.console.warningCount', { count: warningCount })}
              >
                ⚠ {warningCount}
              </span>
            )}
            {/* Pro overlay mounts a "Diagnose with AI" button here when
                the compiler wrote errors (the Circuit check's lines are
                not a failed compile). Empty in the OSS image — slotMounter
                only fires when the pro tree is present. */}
            {compileErrors > 0 && (
              <div data-velxio-slot="compile-console-actions" />
            )}
          </div>
        </div>
        <div style={styles.headerRight}>
          {/* Filter */}
          <DropdownSelect
            value={filter}
            onValueChange={(value) => setFilter(value as typeof filter)}
            style={styles.filterSelect}
          >
            <option value="all">{t('editor.console.filterAll')}</option>
            <option value="errors">{t('editor.console.filterErrors')}</option>
            <option value="warnings">{t('editor.console.filterWarnings')}</option>
          </DropdownSelect>

          {/* Autoscroll */}
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
              style={styles.checkbox}
            />
            {t('editor.console.auto')}
          </label>

          {/* Clear */}
          <button onClick={onClear} style={styles.iconBtn} title={t('editor.console.clear')}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>

          {/* Close */}
          <button onClick={onClose} style={styles.iconBtn} title={t('editor.console.close')}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Output content — grouped into a section per board/chip target. */}
      <div ref={outputRef} style={styles.output}>
        {filteredLogs.length === 0 ? (
          <div style={styles.emptyState}>{t('editor.console.empty')}</div>
        ) : (
          groupLogs(filteredLogs).map((group, gi) =>
            group.target ? (
              <div key={`g-${gi}`} style={styles.targetGroup}>
                <div style={styles.targetHeader}>
                  <span
                    style={{ ...styles.targetStatus, color: statusColor(groupStatus(group.entries)) }}
                  >
                    {statusGlyph(groupStatus(group.entries))}
                  </span>
                  <span style={styles.targetLabel}>{group.target.label}</span>
                  <span style={styles.targetKind}>{group.target.kind}</span>
                </div>
                <div style={styles.targetBody}>
                  {group.entries.map(({ log, index }) => (
                    <LogLine key={index} log={log} />
                  ))}
                </div>
              </div>
            ) : (
              // No target — plain narration ("Compiling all targets...", "Done").
              group.entries.map(({ log, index }) => <LogLine key={index} log={log} />)
            ),
          )
        )}
      </div>
    </div>
  );
});
CompilationConsole.displayName = 'CompilationConsole';

// Shared formatter: `Date.toLocaleTimeString(...)` builds a fresh Intl
// formatter on every call (~0.1-0.3 ms). With hundreds of log lines and the
// console re-rendering on every editor state change, that alone produced
// ~150 ms render tasks — a major slice of the frozen-browser-after-Run bug.
const TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

// Memoized: a log entry is immutable once appended, so a line never needs to
// re-render — appends only mount NEW lines instead of re-rendering all.
const LogLine = React.memo<{ log: CompilationLog }>(({ log }) => (
  <div style={styles.logLine}>
    <span style={styles.timestamp}>{TIME_FORMAT.format(log.timestamp)}</span>
    <span style={{ ...styles.logMessage, color: logColor(log.type) }}>
      {log.type === 'core-install' && <span style={styles.coreTag}>CORE </span>}
      {log.message}
    </span>
  </div>
));
LogLine.displayName = 'LogLine';

function statusColor(status: 'error' | 'success' | 'running'): string {
  return status === 'error'
    ? 'var(--color-feedback-error)'
    : status === 'success'
      ? 'var(--color-feedback-success)'
      : 'var(--wb-11)';
}

function statusGlyph(status: 'error' | 'success' | 'running'): string {
  return status === 'error' ? '✕' : status === 'success' ? '✓' : '▸';
}

function logColor(type: CompilationLog['type']): string {
  switch (type) {
    case 'error':
      return 'var(--color-feedback-error)';
    case 'warning':
      return 'var(--color-feedback-warning)';
    case 'success':
      return '#66bb6a';
    case 'core-install':
      return '#4fc3f7';
    default:
      return 'var(--wb-12)';
  }
}

// ── Inline styles (dark VS Code theme) ────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--wb-2)',
    borderTop: '1px solid var(--wb-6)',
    fontSize: 12,
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
    overflow: 'hidden',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 10px',
    background: 'var(--wb-3)',
    borderBottom: '1px solid var(--wb-6)',
    flexShrink: 0,
    minHeight: 30,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    color: 'var(--wb-12)',
    fontWeight: 600,
    fontSize: 12,
    fontFamily: 'system-ui, sans-serif',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  badges: {
    display: 'flex',
    gap: 6,
  },
  errorBadge: {
    color: 'var(--color-feedback-error)',
    background: 'rgba(239, 83, 80, 0.15)',
    padding: '1px 6px',
    borderRadius: 3,
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
  },
  warningBadge: {
    color: 'var(--color-feedback-warning)',
    background: 'rgba(255, 167, 38, 0.15)',
    padding: '1px 6px',
    borderRadius: 3,
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
  },
  filterSelect: {
    background: 'var(--wb-6)',
    color: 'var(--wb-12)',
    border: '1px solid var(--wb-8)',
    borderRadius: 3,
    fontSize: 11,
    padding: '2px 4px',
    cursor: 'pointer',
    fontFamily: 'system-ui, sans-serif',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    color: 'var(--wb-10)',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'system-ui, sans-serif',
  },
  checkbox: {
    accentColor: 'var(--color-action-primary)',
  },
  iconBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--wb-10)',
    cursor: 'pointer',
    padding: '3px 4px',
    borderRadius: 3,
    display: 'flex',
    alignItems: 'center',
  },
  output: {
    flex: 1,
    overflow: 'auto',
    padding: '4px 10px',
    lineHeight: 1.6,
  },
  emptyState: {
    color: 'var(--wb-9)',
    fontStyle: 'italic',
    padding: '12px 0',
    fontFamily: 'system-ui, sans-serif',
  },
  targetGroup: {
    marginTop: 6,
    borderLeft: '2px solid var(--wb-6)',
    paddingLeft: 8,
  },
  targetHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '1px 0 2px',
  },
  targetStatus: {
    fontWeight: 700,
    flexShrink: 0,
  },
  targetLabel: {
    color: 'var(--wb-13)',
    fontWeight: 700,
    fontSize: 11.5,
    fontFamily: 'system-ui, sans-serif',
  },
  targetKind: {
    color: 'var(--wb-9)',
    fontSize: 9,
    fontFamily: 'system-ui, sans-serif',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    border: '1px solid var(--wb-6)',
    borderRadius: 3,
    padding: '0 4px',
  },
  targetBody: {
    paddingLeft: 4,
  },
  logLine: {
    display: 'flex',
    gap: 8,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  },
  timestamp: {
    color: 'var(--wb-8)',
    flexShrink: 0,
    userSelect: 'none' as const,
  },
  logMessage: {
    flex: 1,
  },
  coreTag: {
    background: 'rgba(79, 195, 247, 0.15)',
    color: '#4fc3f7',
    padding: '0 4px',
    borderRadius: 2,
    marginRight: 4,
    fontSize: 10,
    fontFamily: 'system-ui, sans-serif',
  },
};
