import React, { useState, useCallback } from 'react';
import { installLibrary } from '../../services/libraryService';
import './InstallLibrariesModal.css';

interface InstallLibrariesModalProps {
  isOpen: boolean;
  onClose: () => void;
  libraries: string[];
}

type ItemStatus = 'pending' | 'installing' | 'done' | 'error';

interface LibItem {
  /** Full spec as read from libraries.txt — may contain "@version" suffix */
  spec: string;
  /** Parsed library name (without @version or @wokwi:hash) */
  name: string;
  /** Version if present and valid semver, otherwise undefined */
  version?: string;
  status: ItemStatus;
  error?: string;
}

/** Split "LibName@version" into { name, version }.
 *  Returns version=undefined if no valid semver suffix.
 *  Handles wokwi-hosted "LibName@wokwi:hash" — version stays undefined. */
function parseLibSpec(spec: string): { name: string; version?: string } {
  if (spec.includes('@wokwi:')) {
    return { name: spec.split('@wokwi:')[0] };
  }
  const idx = spec.lastIndexOf('@');
  if (idx > 0) {
    const ver = spec.slice(idx + 1);
    if (/^\d+\.\d+\.\d+$/.test(ver)) {
      return { name: spec.slice(0, idx), version: ver };
    }
  }
  return { name: spec };
}

const Spinner: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    className="ilib-spinner"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

export const InstallLibrariesModal: React.FC<InstallLibrariesModalProps> = ({
  isOpen,
  onClose,
  libraries,
}) => {
  const [items, setItems] = useState<LibItem[]>(() =>
    libraries.map((spec) => {
      const { name, version } = parseLibSpec(spec);
      return { spec, name, version, status: 'pending' as ItemStatus };
    }),
  );
  const [running, setRunning] = useState(false);
  const [doneCount, setDoneCount] = useState(0);

  // Sync items when the libraries prop changes (new import)
  React.useEffect(() => {
    setItems(libraries.map((spec) => {
      const { name, version } = parseLibSpec(spec);
      return { spec, name, version, status: 'pending' as ItemStatus };
    }));
    setDoneCount(0);
    setRunning(false);
  }, [libraries]);

  const setItemStatus = useCallback(
    (spec: string, status: ItemStatus, error?: string) => {
      setItems((prev) =>
        prev.map((it) => (it.spec === spec ? { ...it, status, error } : it)),
      );
    },
    [],
  );

  const handleInstallAll = useCallback(async () => {
    setRunning(true);
    let completed = 0;
    for (const item of items) {
      if (item.status === 'done') { completed++; continue; }
      setItemStatus(item.spec, 'installing');
      try {
        const result = await installLibrary(item.spec);
        if (result.success) {
          setItemStatus(item.spec, 'done');
        } else {
          setItemStatus(item.spec, 'error', result.error || 'Install failed');
        }
      } catch (e) {
        setItemStatus(item.spec, 'error', e instanceof Error ? e.message : 'Install failed');
      }
      completed++;
      setDoneCount(completed);
    }
    setRunning(false);
  }, [items, setItemStatus]);

  if (!isOpen) return null;

  const pendingCount = items.filter((i) => i.status === 'pending').length;
  const installedCount = items.filter((i) => i.status === 'done').length;
  const allDone = items.length > 0 && pendingCount === 0 && !running;

  return (
    <div className="ilib-overlay" onClick={running ? undefined : onClose}>
      <div className="ilib-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="ilib-header">
          <div className="ilib-title">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#00b8d4"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
              <path d="m3.3 7 8.7 5 8.7-5" />
              <path d="M12 22V12" />
            </svg>
            <span>REQUIRED LIBRARIES</span>
          </div>
          <button className="ilib-close-btn" onClick={onClose} disabled={running}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Subtitle */}
        <div className="ilib-subtitle">
          {running ? (
            <span className="ilib-subtitle-installing">
              <Spinner size={13} />
              Installing {doneCount + 1} of {items.length}…
            </span>
          ) : allDone ? (
            <span className="ilib-subtitle-done">All libraries installed successfully</span>
          ) : (
            <span>
              This project requires {items.length} {items.length === 1 ? 'library' : 'libraries'}.
              Install them to compile correctly.
            </span>
          )}
        </div>

        {/* Library list */}
        <div className="ilib-list">
          {items.map((item) => {
            const isWokwiLib = item.spec.includes('@wokwi:');
            return (
              <div key={item.spec} className={`ilib-item ilib-item--${item.status}`}>
                <span className="ilib-item-name">
                  {item.name}
                  {item.version && (
                    <span className="ilib-version">v{item.version}</span>
                  )}
                  {isWokwiLib && (
                    <span className="ilib-badge ilib-badge--wokwi" title="Wokwi-hosted library">
                      wokwi
                    </span>
                  )}
                </span>
                <span className="ilib-item-status">
                  {item.status === 'pending' && (
                    <span className="ilib-badge ilib-badge--pending">pending</span>
                  )}
                  {item.status === 'installing' && (
                    <span className="ilib-badge ilib-badge--installing">
                      <Spinner size={12} />
                      installing…
                    </span>
                  )}
                  {item.status === 'done' && (
                    <span className="ilib-badge ilib-badge--done">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      installed
                    </span>
                  )}
                  {item.status === 'error' && (
                    <span className="ilib-badge ilib-badge--error" title={item.error}>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                      error
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="ilib-footer">
          {allDone ? (
            <button className="ilib-btn ilib-btn--primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button className="ilib-btn ilib-btn--ghost" onClick={onClose} disabled={running}>
                Skip
              </button>
              <button
                className="ilib-btn ilib-btn--primary"
                onClick={handleInstallAll}
                disabled={running || installedCount === items.length}
              >
                {running ? (
                  <>
                    <Spinner size={14} />
                    Installing…
                  </>
                ) : (
                  `Install All (${pendingCount})`
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
