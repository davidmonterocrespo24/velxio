/**
 * Product-news source registry ("What's New" modal).
 *
 * Same seam pattern as proSession.ts: OSS ships a default source and the
 * pro overlay may replace it.
 *
 *   - OSS default: fetch the local backend's /api/news/feed (a cached,
 *     opt-out-able proxy of velxio.dev's public feed — see
 *     backend/app/api/routes/news.py) and run the delivery queue in the
 *     browser, with seen-state in localStorage. An anonymous install has
 *     no accounts, so "once per user" means "once per browser" here.
 *   - Pro overlay: registers a server-backed source (GET /api/pro/news/next)
 *     where the queue and per-user seen tracking live in the database.
 *
 * Queue semantics (identical in both sources):
 *   - only posts with publish_date <= today and not expired;
 *   - at most one post per calendar day;
 *   - oldest publish_date first;
 *   - a post is marked seen when SERVED, never repeated.
 */

import { getApiBase } from './apiBase';

export interface NewsPost {
  id: string;
  title: string;
  body_md: string;
  publish_date: string; // YYYY-MM-DD
  expires_date?: string | null;
}

type NewsSource = () => Promise<NewsPost | null>;

let _source: NewsSource | null = null;
let _sourceRegistered: (() => void) | null = null;

// In a pro build the real source arrives via registerNewsSource() from a
// DYNAMICALLY IMPORTED overlay chunk, and the announcement fetch fires a
// mere 250ms after editor mount — early enough to race that import. If
// the race is lost the OSS fallback runs instead, which on the cloud
// deployment queries its own (empty) self-host proxy and silently shows
// nothing. So: in pro builds getNextNews() waits — bounded — for the
// registration before picking a source. OSS builds resolve immediately
// and never wait.
const PRO_BUILD = Boolean(import.meta.env.VITE_PRO_BUILD);
const _sourceReady: Promise<void> = PRO_BUILD
  ? new Promise((resolve) => {
      _sourceRegistered = resolve;
    })
  : Promise.resolve();
/** How long a pro build waits for the overlay chunk before degrading to
 *  the OSS source. Generous: a lost overlay means no announcement at all
 *  on the cloud, while the wait only delays a modal nobody is blocked on. */
const SOURCE_WAIT_MS = 8000;

export function registerNewsSource(source: NewsSource): void {
  _source = source;
  _sourceRegistered?.();
}

const SEEN_KEY = 'velxio_news_seen';
const LAST_SHOWN_KEY = 'velxio_news_last_shown';

function localToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function readSeen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

async function ossFeedNext(): Promise<NewsPost | null> {
  const today = localToday();
  // Max one post per day — bail before even fetching.
  if (localStorage.getItem(LAST_SHOWN_KEY) === today) return null;

  const resp = await fetch(`${getApiBase()}/news/feed`);
  if (!resp.ok) return null;
  const posts: NewsPost[] = await resp.json();
  if (!Array.isArray(posts)) return null;

  const seen = readSeen();
  const pending = posts
    .filter(
      (p) =>
        p && typeof p.id === 'string' && !seen.has(p.id) &&
        p.publish_date <= today &&
        (!p.expires_date || p.expires_date >= today),
    )
    .sort((a, b) => a.publish_date.localeCompare(b.publish_date));
  const post = pending[0];
  if (!post) return null;

  // Mark seen at delivery time so a refresh can't show it twice.
  seen.add(post.id);
  localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  localStorage.setItem(LAST_SHOWN_KEY, today);
  return post;
}

/** Longest wait for a post's pictures before the modal opens anyway. */
export const NEWS_IMAGE_WAIT_MS = 4000;
const NEWS_IMAGE_MAX = 6;
const IMAGE_URL_RE = /https?:\/\/[^\s()<>"'\]]+?\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#][^\s()<>"'\]]*)?(?=[\s)"'\]>]|$)/gi;

/** The picture URLs a post body shows (markdown images and bare image
 *  links), in order, without repeats. */
export function newsImageUrls(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(IMAGE_URL_RE)) {
    if (!out.includes(m[0])) out.push(m[0]);
    if (out.length >= NEWS_IMAGE_MAX) break;
  }
  return out;
}

/**
 * Fetch and decode a post's pictures before the modal opens. A picture
 * that arrives after the modal pushes the text down while it is being
 * read; one already in the document's image list lays out at its real
 * size on the first frame. Bounded: after `timeoutMs` the post is shown
 * anyway, and a picture that fails never holds it.
 */
export function preloadNewsImages(md: string, timeoutMs = NEWS_IMAGE_WAIT_MS): Promise<void> {
  const urls = newsImageUrls(md);
  if (!urls.length || typeof Image === 'undefined') return Promise.resolve();
  const loads = urls.map(
    (src) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => {
          if (typeof img.decode === 'function') img.decode().then(() => resolve(), () => resolve());
          else resolve();
        };
        img.onerror = () => resolve();
        img.src = src;
      }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.all(loads).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Resolve the next news post to show, or null, with its pictures already
 * loaded (see preloadNewsImages). Never throws — news is strictly
 * best-effort and must not disturb the editor.
 */
export async function getNextNews(): Promise<NewsPost | null> {
  try {
    if (PRO_BUILD && !_source) {
      await Promise.race([
        _sourceReady,
        new Promise<void>((resolve) => setTimeout(resolve, SOURCE_WAIT_MS)),
      ]);
    }
    const post = _source ? await _source() : await ossFeedNext();
    if (post && typeof post.body_md === 'string') await preloadNewsImages(post.body_md);
    return post;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.debug('[oss] news source failed:', err);
    return null;
  }
}
