/**
 * ShareModal — shows a shareable project link and 3-level visibility picker.
 *
 * Phase 1 D1.4 — replaced the binary public/private toggle with a
 * three-option enum (public / unlisted / private). The UI is intentionally
 * "optimistic": every option renders for every user, regardless of plan.
 * The backend gates by `user.plan_id` and responds with HTTP 403 +
 * `{ error: "visibility_not_allowed", upgrade_to: "Maker"|"Pro" }` when
 * the user picks something their plan doesn't cover. We surface that as
 * a redirect to /pricing with a `from=visibility_<level>` hint so the
 * pricing page can lead the right pitch.
 *
 * Why "optimistic-then-redirect" instead of locked buttons:
 *   1. Discovery — Free / Maker users SEE that Pro unlocks 'private',
 *      which is exactly the conversion signal we want surfaced.
 *   2. Discovery without surprise — clicking the locked option goes
 *      somewhere actionable (/pricing) rather than a no-op or generic
 *      modal.
 *   3. Less plan-coupling — this upstream component doesn't need to
 *      import from the pro overlay's auth store. The backend is the
 *      single source of truth.
 */

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { updateProject } from '../../services/projectService';
import type { ProjectVisibility } from '../../services/projectService';

interface ShareModalProps {
  onClose: () => void;
}

type VisibilityErrorDetail = {
  error?: string;
  upgrade_to?: 'Maker' | 'Pro';
  upgrade_url?: string;
  requested_visibility?: ProjectVisibility;
};

export const ShareModal: React.FC<ShareModalProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const currentProject = useProjectStore((s) => s.currentProject);
  const setVisibility = useProjectStore((s) => s.setVisibility);
  const [copied, setCopied] = useState(false);
  const [savingTo, setSavingTo] = useState<ProjectVisibility | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pick the project's current effective visibility. The backend fills
  // this in post-migration; old payloads (or cached pages from before the
  // deploy) might be missing it — fall back to is_public so the modal
  // never renders empty.
  const initialVisibility: ProjectVisibility =
    currentProject?.visibility ?? (currentProject?.isPublic ? 'public' : 'private');
  const [active, setActive] = useState<ProjectVisibility>(initialVisibility);

  useEffect(() => {
    setActive(initialVisibility);
  }, [initialVisibility]);

  if (!currentProject) return null;

  const shareUrl = `${window.location.origin}/project/${currentProject.id}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handlePick = async (next: ProjectVisibility) => {
    if (next === active || savingTo) return;
    setError(null);
    setSavingTo(next);
    try {
      await updateProject(currentProject.id, {
        visibility: next,
        // Keep the legacy boolean in sync so any code path still reading
        // it (older callers) sees a consistent value.
        is_public: next === 'public',
      });
      setActive(next);
      setVisibility(next === 'public');
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { detail?: VisibilityErrorDetail } } };
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail;
      if (status === 403 && detail?.error === 'visibility_not_allowed') {
        // Backend rejected — route the user to /pricing with a hint
        // matching the level they tried to set.
        const url = detail.upgrade_url || '/pricing';
        const from = `visibility_${next}`;
        window.location.href = `${url}?from=${from}`;
        return;
      }
      setError(t('editor.share.updateFailed'));
    } finally {
      setSavingTo(null);
    }
  };

  const options: Array<{
    value: ProjectVisibility;
    label: string;
    hint: string;
    badge?: string;
  }> = [
    {
      value: 'public',
      label: t('editor.share.visibility.publicLabel'),
      hint: t('editor.share.visibility.publicHint'),
    },
    {
      value: 'unlisted',
      label: t('editor.share.visibility.unlistedLabel'),
      hint: t('editor.share.visibility.unlistedHint'),
      badge: 'Maker',
    },
    {
      value: 'private',
      label: t('editor.share.visibility.privateLabel'),
      hint: t('editor.share.visibility.privateHint'),
      badge: 'Pro',
    },
  ];

  return createPortal(
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.title}>{t('editor.share.title')}</h2>

        {/* Three-option visibility picker */}
        <div style={styles.visibilityList}>
          {options.map((opt) => {
            const isActive = active === opt.value;
            const isSaving = savingTo === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => handlePick(opt.value)}
                disabled={isSaving}
                style={{
                  ...styles.visibilityOption,
                  borderColor: isActive ? '#0e639c' : 'var(--wb-6)',
                  background: isActive ? 'rgba(14,99,156,0.12)' : 'var(--wb-2)',
                  opacity: isSaving ? 0.6 : 1,
                  cursor: isSaving ? 'wait' : 'pointer',
                }}
              >
                <div style={styles.optionHead}>
                  <span style={styles.optionLabel}>{opt.label}</span>
                  {opt.badge && (
                    <span style={styles.badge}>{opt.badge}</span>
                  )}
                  {isActive && (
                    <Check size={14} color="#4ade80" strokeWidth={3} />
                  )}
                </div>
                <div style={styles.optionHint}>{opt.hint}</div>
              </button>
            );
          })}
        </div>

        {error && <div style={styles.warning}>{error}</div>}

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
              <Check size={16} color="#4ade80" />
            ) : (
              t('editor.share.copy')
            )}
          </button>
        </div>

        {active === 'private' && (
          <div style={styles.warning}>{t('editor.share.privateWarning')}</div>
        )}

        <div style={styles.actions}>
          <button onClick={onClose} style={styles.closeBtn}>
            {t('editor.share.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  modal: {
    background: 'var(--wb-3)', border: '1px solid var(--wb-7)', borderRadius: 8,
    padding: '1.75rem', width: 460,
    display: 'flex', flexDirection: 'column', gap: 16,
  },
  title: { color: 'var(--wb-12)', margin: 0, fontSize: 18, fontWeight: 600 },
  visibilityList: { display: 'flex', flexDirection: 'column', gap: 6 },
  visibilityOption: {
    textAlign: 'left',
    padding: '10px 12px',
    borderRadius: 6,
    border: '1px solid var(--wb-6)',
    background: 'var(--wb-2)',
    color: 'var(--wb-12)',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    transition: 'all .12s ease',
  },
  optionHead: { display: 'flex', alignItems: 'center', gap: 8 },
  optionLabel: { fontWeight: 600, fontSize: 13, color: 'var(--wb-13)' },
  optionHint: { fontSize: 11, color: 'var(--wb-10)', lineHeight: 1.4 },
  badge: {
    fontSize: 10,
    background: '#0e639c',
    color: 'var(--color-fg-on-action)',
    padding: '1px 6px',
    borderRadius: 3,
    fontWeight: 600,
  },
  linkRow: { display: 'flex', gap: 6 },
  linkInput: {
    flex: 1, background: 'var(--wb-2)', border: '1px solid var(--wb-7)', borderRadius: 4,
    padding: '8px 10px', color: '#4fc3f7', fontSize: 13,
    fontFamily: 'monospace', outline: 'none',
  },
  copyBtn: {
    background: '#0e639c', border: 'none', borderRadius: 4, color: 'var(--color-fg-on-action)',
    padding: '8px 16px', fontSize: 13, cursor: 'pointer', fontWeight: 500,
    display: 'flex', alignItems: 'center',
  },
  warning: {
    background: 'var(--color-feedback-warning-soft)', border: '1px solid #f59e0b44', borderRadius: 4,
    color: '#f59e0b', padding: '8px 12px', fontSize: 12,
  },
  actions: { display: 'flex', justifyContent: 'flex-end' },
  closeBtn: {
    background: 'transparent', border: '1px solid var(--wb-8)', borderRadius: 4,
    color: 'var(--wb-12)', padding: '8px 16px', fontSize: 13, cursor: 'pointer',
  },
};
