/**
 * ShareModal — shows a shareable project link and visibility toggle.
 */

import React, { useState } from 'react';
import { useProjectStore } from '../../store/useProjectStore';
import { updateProject } from '../../services/projectService';

interface ShareModalProps {
  onClose: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({ onClose }) => {
  const currentProject = useProjectStore((s) => s.currentProject);
  const setVisibility = useProjectStore((s) => s.setVisibility);
  const [copied, setCopied] = useState(false);
  const [toggling, setToggling] = useState(false);

  if (!currentProject) return null;

  const shareUrl = `${window.location.origin}/project/${currentProject.id}`;
  const isPublic = currentProject.isPublic;

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleToggleVisibility = async () => {
    setToggling(true);
    try {
      await updateProject(currentProject.id, { is_public: !isPublic });
      setVisibility(!isPublic);
    } catch {
      // Silently fail — user can retry
    } finally {
      setToggling(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.title}>Share project</h2>

        {/* Visibility toggle */}
        <div style={styles.visibilityRow}>
          <div style={styles.visibilityInfo}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {isPublic ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              )}
              <span style={{ color: isPublic ? '#4ade80' : '#f59e0b', fontWeight: 600, fontSize: 13 }}>
                {isPublic ? 'Public' : 'Private'}
              </span>
            </span>
            <span style={{ color: '#888', fontSize: 12 }}>
              {isPublic ? 'Anyone with the link can view this project' : 'Only you can see this project'}
            </span>
          </div>
          <button
            onClick={handleToggleVisibility}
            disabled={toggling}
            style={{
              ...styles.toggleBtn,
              opacity: toggling ? 0.5 : 1,
            }}
          >
            {toggling ? '...' : isPublic ? 'Make private' : 'Make public'}
          </button>
        </div>

        {/* Share link */}
        <div style={styles.linkRow}>
          <input
            type="text"
            value={shareUrl}
            readOnly
            style={styles.linkInput}
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <button onClick={handleCopy} style={styles.copyBtn}>
            {copied ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              'Copy'
            )}
          </button>
        </div>

        {!isPublic && (
          <div style={styles.warning}>
            This project is private. Others will see a 403 error when opening this link.
          </div>
        )}

        <div style={styles.actions}>
          <button onClick={onClose} style={styles.closeBtn}>Close</button>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  modal: {
    background: '#252526', border: '1px solid #3c3c3c', borderRadius: 8,
    padding: '1.75rem', width: 440, display: 'flex', flexDirection: 'column', gap: 16,
  },
  title: { color: '#ccc', margin: 0, fontSize: 18, fontWeight: 600 },
  visibilityRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, padding: '10px 12px', background: '#1e1e1e',
    border: '1px solid #333', borderRadius: 6,
  },
  visibilityInfo: {
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  toggleBtn: {
    background: 'transparent', border: '1px solid #555', borderRadius: 4,
    color: '#ccc', padding: '6px 12px', fontSize: 12, cursor: 'pointer',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  linkRow: { display: 'flex', gap: 6 },
  linkInput: {
    flex: 1, background: '#1e1e1e', border: '1px solid #444', borderRadius: 4,
    padding: '8px 10px', color: '#4fc3f7', fontSize: 13, fontFamily: 'monospace',
    outline: 'none',
  },
  copyBtn: {
    background: '#0e639c', border: 'none', borderRadius: 4,
    color: '#fff', padding: '8px 16px', fontSize: 13, cursor: 'pointer',
    fontWeight: 500, display: 'flex', alignItems: 'center',
  },
  warning: {
    background: '#3d2e00', border: '1px solid #f59e0b44', borderRadius: 4,
    color: '#f59e0b', padding: '8px 12px', fontSize: 12,
  },
  actions: { display: 'flex', justifyContent: 'flex-end' },
  closeBtn: {
    background: 'transparent', border: '1px solid #555', borderRadius: 4,
    color: '#ccc', padding: '8px 16px', fontSize: 13, cursor: 'pointer',
  },
};
