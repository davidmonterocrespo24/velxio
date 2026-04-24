/**
 * `<UpdateFeedBanner />` — in-modal banner that surfaces the
 * `auto-approve-with-toast` plugin update feed (SDK-008d sub-task 2,
 * Option A from the task spec).
 *
 * Mounts inside the Installed Plugins modal header. Pure presentational
 * — owns no install state. Subscribes to `useToastFeedStore` via Zustand
 * so a fresh `push()` from `App.tsx`'s `configureInstallFlow` sink
 * shows up without closing/reopening the modal.
 *
 * Renders nothing when the feed is empty so the modal layout is
 * unaffected on the common path. Collapsed by default — clicking the
 * pill expands the entry list. Each entry has a per-id Dismiss button
 * plus a global "Dismiss all" action.
 *
 * The toast surface is visually distinct from `<MarketplaceBanner />`
 * (positive update tone, not a warning) and from `<ErrorBanner>` (not
 * an error condition). Uses the same `bannerBase` shape as the modal's
 * other banners so spacing stays consistent.
 */

import { useState } from 'react';

import { useToastFeedStore } from '../../store/useToastFeedStore';
import { useTranslate } from '../../i18n/useLocale';

export const UpdateFeedBanner: React.FC = () => {
  const t = useTranslate();
  // Zustand subscription — re-renders when entries mutate. Reading
  // `getRecent()` off the live state lets the TTL filter run on every
  // render without us paying a sweep cost.
  const tick = useToastFeedStore((s) => s.tick);
  void tick;
  const recent = useToastFeedStore.getState().getRecent();

  const dismiss = useToastFeedStore((s) => s.dismiss);
  const dismissAll = useToastFeedStore((s) => s.dismissAll);

  const [expanded, setExpanded] = useState(false);

  if (recent.length === 0) return null;

  const summaryKey = recent.length === 1
    ? 'plugins.toast.summary'
    : 'plugins.toast.summary.plural';

  return (
    <div style={styles.banner} role="status" aria-label={t('plugins.toast.title')}>
      <div style={styles.summaryRow}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={styles.summaryBtn}
          aria-expanded={expanded}
          aria-controls="update-feed-list"
        >
          <span style={styles.icon} aria-hidden>↑</span>
          <span>{t(summaryKey, { count: String(recent.length) })}</span>
          <span style={styles.chevron} aria-hidden>{expanded ? '▾' : '▸'}</span>
        </button>
        <button
          type="button"
          onClick={() => dismissAll()}
          style={styles.dismissAllBtn}
        >
          {t('plugins.toast.dismissAll')}
        </button>
      </div>

      {expanded && (
        <ul id="update-feed-list" style={styles.list}>
          {recent.map((entry) => {
            const addedCount = entry.added.length;
            const permsKey = addedCount === 1
              ? 'plugins.toast.entry.permissions'
              : 'plugins.toast.entry.permissions.plural';
            return (
              <li key={entry.id} style={styles.entry}>
                <div style={styles.entryText}>
                  <span style={styles.entryName}>
                    {t('plugins.toast.entry', {
                      name: entry.pluginId,
                      version: entry.toVersion,
                    })}
                  </span>
                  {addedCount > 0 && (
                    <span style={styles.entryPerms}>
                      {t(permsKey, { count: String(addedCount) })}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(entry.id)}
                  style={styles.entryDismiss}
                  aria-label={t('plugins.toast.dismiss')}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const styles = {
  banner: {
    background: '#1f3a2a',
    color: '#a8e6b8',
    border: '1px solid #2f5a3f',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 13,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  summaryRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  summaryBtn: {
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    textAlign: 'left' as const,
  },
  icon: {
    display: 'inline-flex',
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: '#2f5a3f',
    color: '#d8f3df',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 700,
  },
  chevron: {
    fontSize: 10,
    opacity: 0.7,
  },
  dismissAllBtn: {
    background: 'transparent',
    border: '1px solid #2f5a3f',
    color: '#a8e6b8',
    borderRadius: 3,
    padding: '2px 8px',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    borderTop: '1px solid #2f5a3f',
    paddingTop: 6,
  },
  entry: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '2px 0',
  },
  entryText: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    minWidth: 0,
  },
  entryName: {
    color: '#d8f3df',
    fontSize: 13,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  entryPerms: {
    color: '#dda85c',
    fontSize: 11,
  },
  entryDismiss: {
    background: 'transparent',
    border: 'none',
    color: '#a8e6b8',
    cursor: 'pointer',
    fontSize: 18,
    lineHeight: 1,
    padding: '0 4px',
    fontFamily: 'inherit',
  },
} satisfies Record<string, React.CSSProperties>;
