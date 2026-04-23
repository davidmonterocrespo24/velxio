/**
 * `<PluginUpdateDiffDialog />` — permission diff prompt for plugin updates.
 *
 * Triggered when the loader detects a new manifest version for an
 * already-installed plugin AND `classifyUpdateDiff()` returned
 * `requires-consent` (added contains at least one Medium/High/unknown).
 *
 * Auto-approve cases (`added=∅`) don't render this — the caller installs
 * silently. The `auto-approve-with-toast` case (added contains only Low)
 * is shown here as an informational summary with the scroll gate
 * disabled, so the user can still see the diff and intervene.
 *
 * Three actions on accept-side:
 *   - `Update` (primary, gated by scroll for `requires-consent`).
 *   - `Skip this version` — persists a per-version reject so vNew+1
 *     re-prompts. Caller decides where to persist.
 *   - `Uninstall plugin` — escape hatch for users who don't want the
 *     plugin at all anymore.
 *
 * Pure presentational component; owns no install/skip/uninstall state.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
} from 'react';

import {
  partitionPermissionsByRisk,
  type PermissionCatalogEntry,
  type PluginPermission,
  type UpdateDiffDecision,
} from '@velxio/sdk';

import type { PluginIdentity } from './PluginConsentDialog';

export interface PluginUpdateDiffDialogProps {
  readonly plugin: PluginIdentity;
  readonly fromVersion: string;
  readonly toVersion: string;
  /**
   * The classification produced by `classifyUpdateDiff()`. The dialog
   * reads `kind` to decide which buttons to gate and what copy to show.
   * The caller MUST NOT render this component when `kind === 'auto-approve'`
   * (no diff = no dialog) — but if they do, it falls back to a "No new
   * permissions" notice rather than crashing.
   */
  readonly decision: UpdateDiffDecision;
  /**
   * The new manifest's `http.allowlist`. Only surfaced when `http.fetch`
   * is in `decision.added` (i.e. the plugin is asking for network access
   * for the first time, or replacing a prior allowlist).
   */
  readonly httpAllowlist?: ReadonlyArray<string>;
  readonly onUpdate: () => void;
  readonly onSkipVersion: () => void;
  readonly onUninstall: () => void;
  readonly onCancel: () => void;
  readonly catalogDocUrl?: string;
}

const DEFAULT_CATALOG_DOC_URL =
  'https://github.com/davidmonterocrespo24/velxio/blob/master/docs/PLUGIN_PERMISSIONS.md';

export const PluginUpdateDiffDialog: FC<PluginUpdateDiffDialogProps> = ({
  plugin,
  fromVersion,
  toVersion,
  decision,
  httpAllowlist,
  onUpdate,
  onSkipVersion,
  onUninstall,
  onCancel,
  catalogDocUrl = DEFAULT_CATALOG_DOC_URL,
}) => {
  // Derive the full added/removed picture for rendering. For
  // `requires-consent`, the SDK already partitioned added — reuse it.
  // For `auto-approve-with-toast`, partition `added` so we render
  // a uniform list. For `auto-approve` (rare path), render an empty
  // notice.
  const view = useMemo(() => buildView(decision), [decision]);

  // Scroll gate: only `requires-consent` needs it. The toast and
  // auto-approve modes are informational, so the Update button is
  // enabled immediately.
  const needsScrollGate = decision.kind === 'requires-consent';
  const [scrollComplete, setScrollComplete] = useState(!needsScrollGate);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const recomputeScroll = useCallback(() => {
    if (!needsScrollGate) {
      setScrollComplete(true);
      return;
    }
    const el = scrollRef.current;
    if (el === null) return;
    const fitsWithoutScroll = el.scrollHeight <= el.clientHeight + 1;
    if (fitsWithoutScroll) {
      setScrollComplete(true);
      return;
    }
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining <= 4) setScrollComplete(true);
  }, [needsScrollGate]);

  useEffect(() => {
    recomputeScroll();
  }, [recomputeScroll, view, decision]);

  const onScroll = () => recomputeScroll();

  // Escape closes (Cancel — keeps current version installed, no skip).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const updateEnabled = scrollComplete;
  const showsAllowlist =
    view.added.flatMap((e) => [e.permission]).includes('http.fetch') &&
    httpAllowlist !== undefined &&
    httpAllowlist.length > 0;
  const [removedExpanded, setRemovedExpanded] = useState(false);

  return (
    <div
      style={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="plugin-update-title"
      onClick={onCancel}
    >
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header style={styles.header}>
          {plugin.iconUrl !== undefined && (
            <img
              src={plugin.iconUrl}
              alt=""
              width={36}
              height={36}
              style={styles.icon}
            />
          )}
          <div style={styles.headerText}>
            <h2 id="plugin-update-title" style={styles.title}>
              Update available: {plugin.displayName}
            </h2>
            <p style={styles.subtitle}>
              <span style={styles.versionFrom}>v{fromVersion}</span>
              <span style={styles.versionArrow}>→</span>
              <span style={styles.versionTo}>v{toVersion}</span>
              {plugin.publisher !== undefined && (
                <span style={styles.subtitleSep}> · {plugin.publisher}</span>
              )}
            </p>
          </div>
        </header>

        <div ref={scrollRef} style={styles.scroll} onScroll={onScroll}>
          {decision.kind === 'auto-approve' && <NoChangesNotice />}

          {decision.kind === 'auto-approve-with-toast' && (
            <ToastNotice added={view.added} />
          )}

          {decision.kind === 'requires-consent' && (
            <>
              <SectionHeader>New permissions requested</SectionHeader>
              {view.unknown.length > 0 && (
                <UnknownPermissions perms={view.unknown} />
              )}
              <RiskList
                entries={view.high}
                riskBadge="high"
                showDenies
                showAllowlist={showsAllowlist}
                allowlist={httpAllowlist}
              />
              <RiskList entries={view.medium} riskBadge="medium" />
              {view.low.length > 0 && (
                <p style={styles.lowSummary}>
                  Plus {view.low.length} new standard editor feature
                  {view.low.length === 1 ? '' : 's'} (low-risk).
                </p>
              )}
            </>
          )}

          {view.removed.length > 0 && (
            <RemovedSection
              perms={view.removed}
              expanded={removedExpanded}
              onToggle={() => setRemovedExpanded((v) => !v)}
            />
          )}
        </div>

        <footer style={styles.footer}>
          <a
            href={catalogDocUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.docLink}
          >
            View full permission catalog ↗
          </a>
          <div style={styles.footerActions}>
            <button
              type="button"
              onClick={onUninstall}
              style={styles.dangerLinkBtn}
              data-testid="plugin-update-uninstall"
            >
              Uninstall
            </button>
            <button
              type="button"
              onClick={onSkipVersion}
              style={styles.linkBtn}
              data-testid="plugin-update-skip"
              title={`Skip v${toVersion}; future versions will re-prompt`}
            >
              Skip this version
            </button>
            <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              style={styles.secondaryBtn}
              data-testid="plugin-update-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onUpdate}
              disabled={!updateEnabled}
              style={updateEnabled ? styles.primaryBtn : styles.primaryBtnDisabled}
              title={
                updateEnabled
                  ? `Update to v${toVersion}`
                  : 'Scroll the permissions list to the bottom to enable'
              }
              data-testid="plugin-update-confirm"
            >
              Update
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

// ── View model ───────────────────────────────────────────────────────────

interface UpdateDiffView {
  readonly added: ReadonlyArray<PermissionCatalogEntry>;
  readonly low: ReadonlyArray<PermissionCatalogEntry>;
  readonly medium: ReadonlyArray<PermissionCatalogEntry>;
  readonly high: ReadonlyArray<PermissionCatalogEntry>;
  readonly unknown: ReadonlyArray<PluginPermission>;
  readonly removed: ReadonlyArray<PluginPermission>;
}

function buildView(decision: UpdateDiffDecision): UpdateDiffView {
  if (decision.kind === 'auto-approve') {
    return { added: [], low: [], medium: [], high: [], unknown: [], removed: [] };
  }
  if (decision.kind === 'auto-approve-with-toast') {
    return {
      added: decision.added,
      low: decision.added,
      medium: [],
      high: [],
      unknown: [],
      removed: [],
    };
  }
  // requires-consent: SDK already partitioned added.
  const all = [
    ...decision.addedHighRisk.high,
    ...decision.addedHighRisk.medium,
    ...decision.addedHighRisk.low,
  ];
  return {
    added: all,
    low: decision.addedHighRisk.low,
    medium: decision.addedHighRisk.medium,
    high: decision.addedHighRisk.high,
    unknown: decision.addedHighRisk.unknown,
    removed: decision.removed,
  };
}

// ── Sub-components ───────────────────────────────────────────────────────

const SectionHeader: FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 style={styles.sectionHeader}>{children}</h3>
);

const NoChangesNotice: FC = () => (
  <div style={styles.safeNotice}>
    <p style={styles.safeText}>
      This update does not request any new permissions. It will be installed
      silently — you should not normally see this dialog.
    </p>
  </div>
);

const ToastNotice: FC<{ added: ReadonlyArray<PermissionCatalogEntry> }> = ({
  added,
}) => (
  <div style={styles.toastNotice}>
    <p style={styles.toastText}>
      This update adds {added.length} new low-risk feature
      {added.length === 1 ? '' : 's'}:
    </p>
    <ul style={styles.toastList}>
      {added.map((entry) => (
        <li key={entry.permission} style={styles.toastItem}>
          <span style={styles.toastName}>{entry.permission}</span>
          <span style={styles.toastAllows}>{entry.allows}</span>
        </li>
      ))}
    </ul>
  </div>
);

const RiskList: FC<{
  entries: ReadonlyArray<PermissionCatalogEntry>;
  riskBadge: 'medium' | 'high';
  showDenies?: boolean;
  showAllowlist?: boolean;
  allowlist?: ReadonlyArray<string>;
}> = ({ entries, riskBadge, showDenies = false, showAllowlist = false, allowlist }) => {
  if (entries.length === 0) return null;
  return (
    <ul style={styles.permList}>
      {entries.map((entry) => (
        <PermissionRow
          key={entry.permission}
          entry={entry}
          riskBadge={riskBadge}
          showDenies={showDenies}
          showAllowlist={showAllowlist && entry.permission === 'http.fetch'}
          allowlist={entry.permission === 'http.fetch' ? allowlist : undefined}
        />
      ))}
    </ul>
  );
};

const PermissionRow: FC<{
  entry: PermissionCatalogEntry;
  riskBadge: 'medium' | 'high';
  showDenies: boolean;
  showAllowlist: boolean;
  allowlist?: ReadonlyArray<string>;
}> = ({ entry, riskBadge, showDenies, showAllowlist, allowlist }) => {
  const [expanded, setExpanded] = useState(false);
  const canExpand = showDenies || showAllowlist;
  const palette =
    riskBadge === 'high'
      ? { bg: '#3a1e1e', fg: '#ff9595', label: 'High' }
      : { bg: '#3a3120', fg: '#e8c87e', label: 'Medium' };
  return (
    <li style={styles.permRow}>
      <div style={styles.permRowHeader}>
        <span style={styles.newBadge}>NEW</span>
        <span
          style={{
            ...styles.riskBadge,
            background: palette.bg,
            color: palette.fg,
          }}
        >
          {palette.label}
        </span>
        <span style={styles.permName}>{entry.permission}</span>
        {canExpand && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={styles.disclose}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide details' : 'Show details'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}
      </div>
      <p style={styles.permAllows}>{entry.allows}</p>
      {expanded && (
        <>
          {showDenies && (
            <p style={styles.permDenies}>
              <strong>Cannot:</strong> {entry.denies}
            </p>
          )}
          {showAllowlist && allowlist !== undefined && allowlist.length > 0 && (
            <div style={styles.allowlistBox}>
              <p style={styles.allowlistTitle}>Allowed origins:</p>
              <ul style={styles.allowlist}>
                {allowlist.map((origin) => (
                  <li key={origin} style={styles.allowlistItem}>
                    <code>{origin}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </li>
  );
};

const UnknownPermissions: FC<{ perms: ReadonlyArray<PluginPermission> }> = ({
  perms,
}) => (
  <div style={styles.unknownBox}>
    <p style={styles.unknownTitle}>
      ⚠ This update declares permissions this version of the editor does not
      recognize:
    </p>
    <ul style={styles.unknownList}>
      {perms.map((p) => (
        <li key={p}>
          <code>{p}</code>
        </li>
      ))}
    </ul>
    <p style={styles.unknownHint}>
      Update the editor first so you can see what these permissions allow.
    </p>
  </div>
);

const RemovedSection: FC<{
  perms: ReadonlyArray<PluginPermission>;
  expanded: boolean;
  onToggle: () => void;
}> = ({ perms, expanded, onToggle }) => (
  <div style={styles.removedSection}>
    <button type="button" onClick={onToggle} style={styles.removedToggle}>
      {expanded ? '▾' : '▸'} Permissions removed in this update ({perms.length})
    </button>
    {expanded && (
      <ul style={styles.removedList}>
        {perms.map((p) => (
          <li key={p} style={styles.removedItem}>
            <code>{p}</code>
          </li>
        ))}
      </ul>
    )}
  </div>
);

// ── Pure helpers exported for tests ──────────────────────────────────────

/**
 * Whether a `UpdateDiffDecision` should render this dialog at all. The
 * caller can use this to decide between "open the dialog" and "install
 * silently". `auto-approve` returns false; the others return true.
 */
export function shouldShowUpdateDiffDialog(decision: UpdateDiffDecision): boolean {
  return decision.kind !== 'auto-approve';
}

/**
 * Whether the decision needs a scroll-to-bottom anti-clickjacking gate.
 * Only `requires-consent` does — the toast variant is informational.
 */
export function decisionNeedsScrollGate(decision: UpdateDiffDecision): boolean {
  return decision.kind === 'requires-consent';
}

export const _buildView = buildView;
export const _partitionForView = partitionPermissionsByRisk;

// ── Styles ───────────────────────────────────────────────────────────────

const styles: Record<string, CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1100,
  },
  modal: {
    background: '#252526',
    border: '1px solid #3c3c3c',
    borderRadius: 8,
    padding: '1.5rem',
    width: 'min(640px, 92vw)',
    maxHeight: '85vh',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    boxShadow: '0 10px 40px rgba(0,0,0,.6)',
  },
  header: { display: 'flex', alignItems: 'center', gap: 12 },
  headerText: { display: 'flex', flexDirection: 'column', gap: 2 },
  icon: { borderRadius: 6, background: '#1f1f20' },
  title: { color: '#e0e0e0', margin: 0, fontSize: 18, fontWeight: 600 },
  subtitle: {
    color: '#aaa',
    margin: 0,
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  versionFrom: { color: '#888', fontFamily: 'ui-monospace, Menlo, monospace' },
  versionArrow: { color: '#9ec3ff' },
  versionTo: { color: '#9ee29e', fontFamily: 'ui-monospace, Menlo, monospace', fontWeight: 600 },
  subtitleSep: { color: '#777' },
  scroll: {
    overflowY: 'auto',
    paddingRight: 8,
    minHeight: 200,
    maxHeight: '55vh',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  sectionHeader: {
    color: '#e0e0e0',
    margin: '0 0 4px',
    fontSize: 13,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  permList: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  permRow: {
    border: '1px solid #3c3c3c',
    borderRadius: 6,
    padding: '10px 12px',
    background: '#1f1f20',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  permRowHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  newBadge: {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: 3,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.6,
    background: '#1e3a4a',
    color: '#9ec3ff',
  },
  riskBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  permName: {
    color: '#ccc',
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 12,
    flex: 1,
  },
  disclose: {
    background: 'transparent',
    border: 'none',
    color: '#9ec3ff',
    cursor: 'pointer',
    fontSize: 12,
    padding: '2px 6px',
  },
  permAllows: { color: '#ddd', fontSize: 13, margin: 0, lineHeight: 1.4 },
  permDenies: { color: '#aaa', fontSize: 12, margin: 0, lineHeight: 1.4 },
  allowlistBox: {
    border: '1px solid #2f2f30',
    borderRadius: 4,
    padding: '6px 8px',
    background: '#161617',
  },
  allowlistTitle: { color: '#aaa', fontSize: 11, margin: '0 0 4px' },
  allowlist: { listStyle: 'none', padding: 0, margin: 0 },
  allowlistItem: { color: '#9ec3ff', fontSize: 12, padding: '2px 0' },
  lowSummary: { color: '#aaa', fontSize: 12, margin: '4px 0', fontStyle: 'italic' },
  removedSection: {
    marginTop: 8,
    paddingTop: 8,
    borderTop: '1px dashed #2f2f30',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  removedToggle: {
    background: 'transparent',
    border: 'none',
    color: '#aaa',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
    textAlign: 'left',
  },
  removedList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  removedItem: {
    color: '#9ec3ff',
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 12,
  },
  unknownBox: {
    border: '1px solid #5a4a29',
    borderRadius: 6,
    padding: '10px 12px',
    background: '#2a2418',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  unknownTitle: { color: '#e8c87e', fontSize: 13, margin: 0 },
  unknownList: { listStyle: 'none', padding: 0, margin: 0, color: '#e8c87e', fontSize: 12 },
  unknownHint: { color: '#bbaa88', fontSize: 11, margin: 0 },
  safeNotice: {
    border: '1px solid #2f4a2f',
    borderRadius: 6,
    padding: '12px',
    background: '#1d2a1d',
    textAlign: 'center',
  },
  safeText: { color: '#9ee29e', fontSize: 13, margin: 0 },
  toastNotice: {
    border: '1px solid #2f3a4a',
    borderRadius: 6,
    padding: '12px',
    background: '#1d242a',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  toastText: { color: '#9ec3ff', fontSize: 13, margin: 0 },
  toastList: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  toastItem: { display: 'flex', gap: 8, fontSize: 12, color: '#bbb' },
  toastName: { fontFamily: 'ui-monospace, Menlo, monospace', color: '#9ec3ff', minWidth: 180 },
  toastAllows: { flex: 1, lineHeight: 1.4 },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingTop: 8,
    borderTop: '1px solid #2f2f30',
  },
  footerActions: { display: 'flex', alignItems: 'center', gap: 8 },
  docLink: { color: '#9ec3ff', fontSize: 12, textDecoration: 'none' },
  linkBtn: {
    background: 'transparent',
    border: 'none',
    color: '#aaa',
    fontSize: 12,
    cursor: 'pointer',
    padding: '6px 8px',
  },
  dangerLinkBtn: {
    background: 'transparent',
    border: 'none',
    color: '#ff9595',
    fontSize: 12,
    cursor: 'pointer',
    padding: '6px 8px',
  },
  primaryBtn: {
    background: '#0e639c',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '8px 18px',
    fontSize: 13,
    cursor: 'pointer',
    fontWeight: 600,
  },
  primaryBtnDisabled: {
    background: '#2a3a48',
    color: '#7a8a98',
    border: 'none',
    borderRadius: 4,
    padding: '8px 18px',
    fontSize: 13,
    cursor: 'not-allowed',
    fontWeight: 600,
  },
  secondaryBtn: {
    background: 'transparent',
    color: '#ccc',
    border: '1px solid #555',
    borderRadius: 4,
    padding: '8px 14px',
    fontSize: 13,
    cursor: 'pointer',
  },
};
