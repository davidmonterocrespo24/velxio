/**
 * `<PluginConsentDialog />` — pre-install permission consent.
 *
 * Triggered by the install flow when the host has resolved a plugin
 * manifest but hasn't yet executed `activate(ctx)`. Renders the
 * permission catalog rows for everything Medium/High the manifest
 * declares, with the catalog's "What it allows" copy. Low permissions
 * collapse into a one-line summary.
 *
 * Anti-clickjacking: the primary `Install` button stays disabled until
 * the user has scrolled the permissions list to the bottom. This is the
 * Mozilla-recommended consent-flow mitigation against transparent
 * overlay attacks. We measure scroll completion on the inner scrollable
 * region (NOT the whole modal) so a long allowlist doesn't lock the
 * button forever.
 *
 * Pure presentational component — owns no install state. The caller
 * decides what `onConfirm` and `onCancel` mean (write to store, fire
 * a network request, navigate away, etc).
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
  type PartitionedPermissions,
  type PluginPermission,
} from '@velxio/sdk';

export interface PluginIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly publisher?: string;
  readonly iconUrl?: string;
  /**
   * `'verified'` (signed by a trusted key), `'community-signed'` (signed
   * but not by a curated key), `'unsigned'` (sideload / dev). Display
   * only — the actual gate lives in `verifyLicense`.
   */
  readonly signatureStatus?: 'verified' | 'community-signed' | 'unsigned';
}

export interface PluginConsentDialogProps {
  readonly plugin: PluginIdentity;
  readonly permissions: ReadonlyArray<PluginPermission>;
  /**
   * The plugin's declared `http.allowlist` (HTTPS URL prefixes). Only
   * surfaced when `http.fetch` is in `permissions`. We render the array
   * verbatim — the user must see exactly what origins the plugin will
   * be able to talk to.
   */
  readonly httpAllowlist?: ReadonlyArray<string>;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** Optional URL for the "View full permission catalog" footer link. */
  readonly catalogDocUrl?: string;
  /** Optional callback for the "Report" footer link. */
  readonly onReport?: () => void;
}

const DEFAULT_CATALOG_DOC_URL =
  'https://github.com/davidmonterocrespo24/velxio/blob/master/docs/PLUGIN_PERMISSIONS.md';

export const PluginConsentDialog: FC<PluginConsentDialogProps> = ({
  plugin,
  permissions,
  httpAllowlist,
  onConfirm,
  onCancel,
  catalogDocUrl = DEFAULT_CATALOG_DOC_URL,
  onReport,
}) => {
  const partitioned = useMemo(
    () => partitionPermissionsByRisk(permissions),
    [permissions],
  );

  const consentNeeded =
    partitioned.medium.length > 0 ||
    partitioned.high.length > 0 ||
    partitioned.unknown.length > 0;
  const [scrollComplete, setScrollComplete] = useState(!consentNeeded);
  const [lowExpanded, setLowExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Recompute scroll completion when the partition or the scrollable
  // region's geometry changes (e.g. expanding the Low section).
  const recomputeScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (!consentNeeded) {
      setScrollComplete(true);
      return;
    }
    // If the content fits without scrolling, the user is already at the
    // bottom — unlock immediately.
    const fitsWithoutScroll = el.scrollHeight <= el.clientHeight + 1;
    if (fitsWithoutScroll) {
      setScrollComplete(true);
      return;
    }
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining <= 4) setScrollComplete(true);
  }, [consentNeeded]);

  useEffect(() => {
    recomputeScroll();
  }, [recomputeScroll, lowExpanded, permissions]);

  const onScroll = () => recomputeScroll();

  // Escape closes (the same as Cancel).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  // Focus management: default focus on Cancel (safer destructive default).
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const installEnabled = scrollComplete;
  const showsAllowlist =
    permissions.includes('http.fetch') &&
    httpAllowlist !== undefined &&
    httpAllowlist.length > 0;

  return (
    <div
      style={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="plugin-consent-title"
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
            <h2 id="plugin-consent-title" style={styles.title}>
              Install {plugin.displayName}
            </h2>
            <p style={styles.subtitle}>
              {plugin.publisher !== undefined ? `${plugin.publisher} · ` : ''}
              v{plugin.version}
              {plugin.signatureStatus !== undefined && (
                <SignatureBadge status={plugin.signatureStatus} />
              )}
            </p>
          </div>
        </header>

        <div ref={scrollRef} style={styles.scroll} onScroll={onScroll}>
          {consentNeeded ? (
            <>
              <SectionHeader>Permissions requiring your approval</SectionHeader>
              <RiskList
                entries={partitioned.high}
                riskBadge="high"
                showDenies
                showAllowlist={showsAllowlist}
                allowlist={httpAllowlist}
              />
              <RiskList entries={partitioned.medium} riskBadge="medium" />
              {partitioned.unknown.length > 0 && (
                <UnknownPermissions perms={partitioned.unknown} />
              )}
              {partitioned.low.length > 0 && (
                <LowSection
                  entries={partitioned.low}
                  expanded={lowExpanded}
                  onToggle={() => setLowExpanded((v) => !v)}
                />
              )}
            </>
          ) : (
            <SafePluginNotice count={partitioned.low.length} />
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
            {onReport !== undefined && (
              <button type="button" onClick={onReport} style={styles.linkBtn}>
                Report
              </button>
            )}
            <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              style={styles.secondaryBtn}
              data-testid="plugin-consent-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!installEnabled}
              style={installEnabled ? styles.primaryBtn : styles.primaryBtnDisabled}
              title={
                installEnabled
                  ? 'Install this plugin'
                  : 'Scroll the permissions list to the bottom to enable'
              }
              data-testid="plugin-consent-install"
            >
              Install
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

// ── Sub-components ───────────────────────────────────────────────────────

const SignatureBadge: FC<{ status: NonNullable<PluginIdentity['signatureStatus']> }> = ({
  status,
}) => {
  const palette: Record<typeof status, { bg: string; fg: string; label: string }> = {
    verified: { bg: '#1e3a1e', fg: '#9ee29e', label: 'Verified' },
    'community-signed': { bg: '#3a3120', fg: '#e8c87e', label: 'Community signed' },
    unsigned: { bg: '#3a1e1e', fg: '#ff9595', label: 'Unsigned' },
  };
  const p = palette[status];
  return (
    <span
      style={{
        ...styles.signatureBadge,
        background: p.bg,
        color: p.fg,
      }}
    >
      {p.label}
    </span>
  );
};

const SectionHeader: FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 style={styles.sectionHeader}>{children}</h3>
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

const LowSection: FC<{
  entries: ReadonlyArray<PermissionCatalogEntry>;
  expanded: boolean;
  onToggle: () => void;
}> = ({ entries, expanded, onToggle }) => (
  <div style={styles.lowSection}>
    <button type="button" onClick={onToggle} style={styles.lowToggle}>
      {expanded ? '▾' : '▸'} Standard editor features ({entries.length})
    </button>
    {expanded && (
      <ul style={styles.lowList}>
        {entries.map((entry) => (
          <li key={entry.permission} style={styles.lowItem}>
            <span style={styles.lowName}>{entry.permission}</span>
            <span style={styles.lowAllows}>{entry.allows}</span>
          </li>
        ))}
      </ul>
    )}
  </div>
);

const UnknownPermissions: FC<{ perms: ReadonlyArray<string> }> = ({ perms }) => (
  <div style={styles.unknownBox}>
    <p style={styles.unknownTitle}>
      ⚠ This plugin declares permissions this version of the editor does not
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
      You are running an older editor than the plugin expects. Update the
      editor to see what these permissions allow.
    </p>
  </div>
);

const SafePluginNotice: FC<{ count: number }> = ({ count }) => (
  <div style={styles.safeNotice}>
    <p style={styles.safeText}>
      This plugin uses {count === 0 ? 'no special' : 'only standard editor'}{' '}
      features and can be installed safely.
    </p>
  </div>
);

// ── Pure helpers exported for tests ──────────────────────────────────────

/**
 * Whether scrolling has reached the bottom of an element. Exported so
 * the test suite can drive the gate without rendering a real scroll
 * container (jsdom does not implement layout).
 */
export function isScrolledToBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  toleranceMs = 4,
): boolean {
  const fitsWithoutScroll = el.scrollHeight <= el.clientHeight + 1;
  if (fitsWithoutScroll) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= toleranceMs;
}

export function _partition(
  permissions: ReadonlyArray<PluginPermission>,
): PartitionedPermissions {
  return partitionPermissionsByRisk(permissions);
}

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
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  headerText: { display: 'flex', flexDirection: 'column', gap: 2 },
  icon: { borderRadius: 6, background: '#1f1f20' },
  title: { color: '#e0e0e0', margin: 0, fontSize: 18, fontWeight: 600 },
  subtitle: {
    color: '#aaa',
    margin: 0,
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  signatureBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
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
  permList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  permRow: {
    border: '1px solid #3c3c3c',
    borderRadius: 6,
    padding: '10px 12px',
    background: '#1f1f20',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  permRowHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
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
  lowSection: {
    marginTop: 8,
    paddingTop: 8,
    borderTop: '1px dashed #2f2f30',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  lowToggle: {
    background: 'transparent',
    border: 'none',
    color: '#aaa',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
    textAlign: 'left',
  },
  lowList: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  lowItem: {
    display: 'flex',
    gap: 8,
    fontSize: 12,
    color: '#bbb',
  },
  lowName: {
    fontFamily: 'ui-monospace, Menlo, monospace',
    color: '#9ec3ff',
    minWidth: 180,
  },
  lowAllows: { flex: 1, lineHeight: 1.4 },
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
