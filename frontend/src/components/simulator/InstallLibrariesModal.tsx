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
  name: string;
  status: ItemStatus;
  error?: string;
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
    libraries.map((name) => ({ name, status: 'pending' })),
  );
  const [running, setRunning] = useState(false);
  const [doneCount, setDoneCount] = useState(0);

  // Sync items when the libraries prop changes (new import)
  React.useEffect(() => {
    setItems(libraries.map((name) => ({ name, status: 'pending' })));
    setDoneCount(0);
    setRunning(false);
  }, [libraries]);

  const setItemStatus = useCallback((name: string, status: ItemStatus, error?: string) => {
    setItems((prev) => prev.map((it) => (it.name === name ? { ...it, status, error } : it)));
  }, []);

  const handleInstallAll = useCallback(async () => {
    setRunning(true);
    let completed = 0;
    for (const item of items) {
      if (item.status === 'done') {
        completed++;
        continue;
      }
      setItemStatus(item.name, 'installing');
      try {
        const result = await installLibrary(item.name);
        if (result.success) {
          setItemStatus(item.name, 'done');
        } else {
          setItemStatus(item.name, 'error', result.error || 'Install failed');
        }
      } catch (e) {
        setItemStatus(item.name, 'error', e instanceof Error ? e.message : 'Install failed');
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
            // For Wokwi-hosted libraries ("LibName@wokwi:hash"), show only the LibName
            const displayName = item.name.includes('@wokwi:')
              ? item.name.split('@wokwi:')[0]
              : item.name;
            const isWokwiLib = item.name.includes('@wokwi:');
            return (
              <div key={item.name} className={`ilib-item ilib-item--${item.status}`}>
                <span className="ilib-item-name">
                  {displayName}
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
