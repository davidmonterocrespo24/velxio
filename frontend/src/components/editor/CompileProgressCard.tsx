/**
 * The panel that reports a running compile, over the simulator canvas.
 *
 * Until this existed, a build in progress showed up as a spinning icon on the
 * toolbar button and nothing else. That is fine for an AVR blink (two seconds)
 * and actively misleading for a cold ESP-IDF build, which looks identical to a
 * hung app for several minutes — and worse when velxio.dev is busy, because a
 * build waiting behind other people's builds also looked like a frozen editor.
 *
 * What it shows, and what it deliberately does not:
 *   - Elapsed time, always. The single most useful fact.
 *   - A real progress fraction when the build reports one (ninja's
 *     [done/total]), an estimate from this server's own recent build times
 *     otherwise, and a travelling sliver — never a growing bar — while the job
 *     is only queued. A bar that fills without a number behind it is a lie the
 *     user eventually catches.
 *   - Build server load as four coarse segments. It never shows a queue depth
 *     or a position: "you are 14th in line" is worse than saying nothing, and
 *     it publishes how busy the service is.
 *   - That a queued build is never dropped. We queue; we do not time people out.
 *
 * The upgrade line for free users is mounted by the pro overlay into the
 * `compile-queue-upsell` slot. OSS has no plans, so the slot stays empty and
 * collapses.
 */

import { Check, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ServerLoad } from '../../services/compilation';
import {
  useCompileProgressStore,
  type CompileProgressEntry,
} from '../../store/useCompileProgressStore';

import './CompileProgressCard.css';

interface CompileProgressCardProps {
  /** Opens the compilation console — the card links to it rather than
   *  duplicating the log. */
  onShowOutput?: () => void;
  /** Rendered over the editor instead of the canvas (code-only view). Drops
   *  the mobile offset that exists to clear the canvas header. */
  inEditor?: boolean;
}

/** Segments lit on the four-segment load meter. */
const LOAD_SEGMENTS: Record<ServerLoad, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  peak: 4,
};

/** Load levels that colour the meter as "busy" rather than neutral. */
const BUSY_LOADS = new Set<ServerLoad>(['high', 'peak']);

/** Tiers that get the upgrade line. 'local' (self-hosted OSS) gets nothing —
 *  there is no plan to sell there. */
const UPSELL_TIERS = new Set(['free', 'anonymous']);

function OutcomeIcon({ ok }: { ok: boolean }) {
  const Icon = ok ? Check : X;
  return (
    <Icon
      size={14}
      color={ok ? 'var(--color-feedback-success)' : 'var(--color-feedback-error)'}
      strokeWidth={2.5}
      aria-hidden
      style={{ flexShrink: 0 }}
    />
  );
}

/**
 * Collapse the per-board entries into the one thing the card renders.
 *
 * Multi-board projects compile every board at once, so several builds are in
 * flight and the card has to speak for all of them: the slowest stage wins the
 * headline, and the fraction is the mean so finishing one board of three moves
 * the bar by a third rather than snapping it to 100%.
 */
function summarize(entries: CompileProgressEntry[]) {
  const startedAt = Math.min(...entries.map((e) => e.startedAt));
  const queued = entries.filter((e) => e.stage === 'queued');
  const settled = entries.filter((e) => e.outcome !== null);
  const allSettled = settled.length === entries.length;
  const failed = settled.some((e) => e.outcome === 'error');

  // Only the entries that have actually started contribute a real fraction;
  // a queued board counts as zero rather than as unknown.
  const progress =
    entries.reduce((sum, e) => sum + (e.progress ?? 0), 0) / entries.length;

  // A queued build has no honest fraction. The card keeps the indeterminate
  // sliver until at least one board is really building.
  const determinate = entries.some((e) => e.progress !== null);

  // Worst (busiest) load any board reported — they poll the same server, so
  // they agree in practice; taking the max avoids a flicker between polls.
  const load = entries.reduce<ServerLoad>((worst, e) => {
    return LOAD_SEGMENTS[e.serverLoad] > LOAD_SEGMENTS[worst] ? e.serverLoad : worst;
  }, 'low');

  const lastLine = entries.find((e) => e.lastLine)?.lastLine ?? '';

  // Freeze the clock at the last completion. Without this the timer kept
  // running through the 1600 ms linger, so the final "Compiled successfully"
  // advertised up to 1.6 s more than the build actually took.
  const finishedAt = allSettled
    ? Math.max(...entries.map((e) => e.finishedAt ?? 0))
    : null;

  return {
    startedAt,
    finishedAt: finishedAt || null,
    allQueued: queued.length === entries.length && !allSettled,
    allSettled,
    failed,
    progress,
    determinate,
    load,
    lastLine,
    priority: entries.some((e) => e.priority),
    tier: entries[0]?.tier ?? 'local',
    boardCount: entries.length,
    label: entries[0]?.label ?? '',
  };
}

export function CompileProgressCard({ onShowOutput, inEditor }: CompileProgressCardProps) {
  const { t } = useTranslation();
  const entriesMap = useCompileProgressStore((s) => s.entries);
  const runId = useCompileProgressStore((s) => s.runId);
  const [now, setNow] = useState(() => Date.now());
  // The run the user dismissed, or null. Keyed on the store's run id rather
  // than a boolean (which would suppress every later build) or on
  // min(startedAt) (which shifts as entries settle and drop, resurrecting a
  // dismissed card and suppressing a fresh one).
  const [dismissedRun, setDismissedRun] = useState<number | null>(null);

  const entries = Object.values(entriesMap);
  const active = entries.length > 0;

  // Re-render ~10x/s so the timer counts smoothly between the 2s status polls.
  // Only while something is running: an idle interval on the editor page is a
  // wakeup every 100ms for nothing.
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;

  const s = summarize(entries);
  // The dismissal covers ONE compile, not the session — pressing Compile again
  // must bring the card back, or the user has silently turned off their only
  // feedback for good.
  if (dismissedRun === runId) return null;
  const elapsed = Math.max(0, ((s.finishedAt ?? now) - s.startedAt) / 1000);
  const percent = Math.round(s.progress * 100);

  const title = s.allSettled
    ? s.failed
      ? t('editor.compileProgress.failed', 'Build failed')
      : t('editor.compileProgress.done', 'Compiled successfully')
    : s.allQueued
      ? t('editor.compileProgress.queued', 'Waiting for a build slot...')
      : s.boardCount > 1
        ? t('editor.compileProgress.compilingBoards', {
            count: s.boardCount,
            defaultValue: 'Compiling {{count}} boards...',
          })
        : t('editor.compileProgress.compiling', {
            board: s.label,
            defaultValue: 'Compiling {{board}}...',
          });

  const litSegments = LOAD_SEGMENTS[s.load];
  const busy = BUSY_LOADS.has(s.load);

  return (
    <div className={`compile-card${inEditor ? ' compile-card--in-editor' : ''}`}>
      {/* The live region holds the TITLE ONLY. It used to wrap the whole card
          including the 100 ms timer, so a screen reader re-announced the card
          about ten times a second for the entire build. */}
      <span className="compile-card__sr" role="status" aria-live="polite">
        {title}
      </span>
      <div className="compile-card__head">
        {s.allSettled ? (
          <OutcomeIcon ok={!s.failed} />
        ) : (
          <LoaderCircle size={14} strokeWidth={2.5} className="compile-card__spinner" aria-hidden />
        )}
        <span className="compile-card__title" aria-hidden="true">{title}</span>
        <span className="compile-card__timer" aria-hidden="true">{elapsed.toFixed(1)}s</span>
        <button
          type="button"
          className="compile-card__dismiss"
          onClick={() => setDismissedRun(runId)}
          title={t('editor.compileProgress.hide', 'Hide (the build keeps running)')}
          aria-label={t('editor.compileProgress.hide', 'Hide (the build keeps running)')}
        >
          <X size={12} strokeWidth={2.5} aria-hidden />
        </button>
      </div>

      <div
        className={`compile-card__bar${
          !s.allSettled && !s.determinate ? ' compile-card__bar--indeterminate' : ''
        }`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(s.determinate || s.allSettled ? { 'aria-valuenow': percent } : {})}
      >
        {(s.determinate || s.allSettled) && (
          <div
            className={`compile-card__fill${
              s.allSettled
                ? s.failed
                  ? ' compile-card__fill--error'
                  : ' compile-card__fill--success'
                : ''
            }`}
            style={{ width: `${s.allSettled ? 100 : percent}%` }}
          />
        )}
      </div>

      <div className="compile-card__status">
        <span className="compile-card__stage" title={s.lastLine}>
          {s.allQueued
            ? t(
                'editor.compileProgress.queuedHint',
                'Your build is in the queue. It starts automatically and is never cancelled.',
              )
            : s.lastLine || t('editor.compileProgress.preparing', 'Preparing the build...')}
        </span>
        {s.determinate && !s.allSettled && (
          <span className="compile-card__percent">{percent}%</span>
        )}
      </div>

      <div className="compile-card__foot">
        <span className="compile-card__load">
          <span>{t('editor.compileProgress.serverLoad', 'Build server load')}</span>
          <span
            className="compile-card__meter"
            title={t(`editor.compileProgress.load.${s.load}`, s.load)}
          >
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={`compile-card__seg${
                  i < litSegments
                    ? busy
                      ? ' compile-card__seg--busy'
                      : ' compile-card__seg--on'
                    : ''
                }`}
              />
            ))}
          </span>
        </span>

        {s.priority ? (
          <span className="compile-card__badge">
            {t('editor.compileProgress.priority', 'Priority build')}
          </span>
        ) : onShowOutput ? (
          <button type="button" className="compile-card__details" onClick={onShowOutput}>
            {t('editor.compileProgress.showOutput', 'Show output')}
          </button>
        ) : null}
      </div>

      {/* The pro overlay mounts the "skip the build queue" upgrade line here.
          Rendered only for tiers that HAVE something to upgrade to — never in
          a self-hosted OSS install, which has no plans at all. */}
      {UPSELL_TIERS.has(s.tier) && (
        <div className="compile-card__upsell" data-velxio-slot="compile-queue-upsell" />
      )}
    </div>
  );
}
