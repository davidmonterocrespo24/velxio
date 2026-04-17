/**
 * CompilationConsole — shows compilation output (stdout, stderr, errors, core install logs).
 * Rendered below the code editor when open. Similar to VS Code's output panel.
 */

import React, { useRef, useEffect, useState } from 'react';
import type { CompilationLog } from '../../utils/compilationLogger';

interface CompilationConsoleProps {
  isOpen: boolean;
  onClose: () => void;
  logs: CompilationLog[];
  onClear: () => void;
}

export const CompilationConsole: React.FC<CompilationConsoleProps> = ({
  isOpen,
  onClose,
  logs,
  onClear,
}) => {
  const outputRef = useRef<HTMLDivElement>(null);
  const [autoscroll, setAutoscroll] = useState(true);
  const [filter, setFilter] = useState<'all' | 'errors' | 'warnings'>('all');
  const prevLogsLenRef = useRef(0);

  useEffect(() => {
    if (autoscroll && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [logs, autoscroll]);

  // Auto-switch to "Errors" filter when a new batch of logs arrives with errors
  useEffect(() => {
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

  if (!isOpen) return null;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.title}>Output</span>
          <div style={styles.badges}>
            {errorCount > 0 && (
              <span style={styles.errorBadge} title={`${errorCount} error(s)`}>
                ✕ {errorCount}
              </span>
            )}
            {warningCount > 0 && (
              <span style={styles.warningBadge} title={`${warningCount} warning(s)`}>
                ⚠ {warningCount}
              </span>
            )}
          </div>
        </div>
        <div style={styles.headerRight}>
          {/* Filter */}
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            style={styles.filterSelect}
          >
            <option value="all">All</option>
            <option value="errors">Errors</option>
            <option value="warnings">Warnings</option>
          </select>

          {/* Autoscroll */}
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
              style={styles.checkbox}
            />
            Auto
          </label>

          {/* Clear */}
          <button onClick={onClear} style={styles.iconBtn} title="Clear output">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>

          {/* Close */}
          <button onClick={onClose} style={styles.iconBtn} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Output content */}
      <div ref={outputRef} style={styles.output}>
        {filteredLogs.length === 0 ? (
          <div style={styles.emptyState}>No compilation output yet. Click Compile to start.</div>
        ) : (
          filteredLogs.map((log, i) => (
            <div key={i} style={styles.logLine}>
              <span style={styles.timestamp}>
                {log.timestamp.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span style={{ ...styles.logMessage, color: logColor(log.type) }}>
                {log.type === 'core-install' && (
                  <span style={styles.coreTag}>CORE </span>
                )}
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

function logColor(type: CompilationLog['type']): string {
  switch (type) {
    case 'error':        return '#ef5350';
    case 'warning':      return '#ffa726';
    case 'success':      return '#66bb6a';
    case 'core-install': return '#4fc3f7';
    default:             return '#cccccc';
  }
}

// ── Inline styles (dark VS Code theme) ────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    background: '#1e1e1e',
    borderTop: '1px solid #333',
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
    background: '#252526',
    borderBottom: '1px solid #333',
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
    color: '#cccccc',
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
    color: '#ef5350',
    background: 'rgba(239, 83, 80, 0.15)',
    padding: '1px 6px',
    borderRadius: 3,
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
  },
  warningBadge: {
    color: '#ffa726',
    background: 'rgba(255, 167, 38, 0.15)',
    padding: '1px 6px',
    borderRadius: 3,
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
  },
  filterSelect: {
    background: '#333',
    color: '#ccc',
    border: '1px solid #555',
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
    color: '#999',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'system-ui, sans-serif',
  },
  checkbox: {
    accentColor: '#0e639c',
  },
  iconBtn: {
    background: 'none',
    border: 'none',
    color: '#999',
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
    color: '#666',
    fontStyle: 'italic',
    padding: '12px 0',
    fontFamily: 'system-ui, sans-serif',
  },
  logLine: {
    display: 'flex',
    gap: 8,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  },
  timestamp: {
    color: '#555',
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
