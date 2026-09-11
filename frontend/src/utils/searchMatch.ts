/**
 * Search matching shared by the component picker, the examples gallery and
 * any other "type to filter a list" surface.
 *
 * What a query has to survive here:
 *   - partial words: "temp" finds "temperature", "ultra" finds "ultrasonic";
 *   - several words in any order, each matched independently ("esp32 oled");
 *   - punctuation and spacing differences: "hc-sr04", "hc sr04" and "hcsr04"
 *     are the same query, and "ssd 1306" finds the SSD1306;
 *   - accents: "botón" and "boton" are the same word;
 *   - typos: "potenciometer", "ultrasnic", "arduno" still land on the part;
 *   - another language or an alias: "temperatura", "pantalla", "btn" go
 *     through the synonym table in ./searchSynonyms.ts;
 *   - little words ("sensor de temperatura", "led and button") never make a
 *     query fail: a stopword only adds score, it is not required to match.
 *
 * And the result is RANKED, so a whole-word hit on the name outranks a
 * substring buried in a description, which outranks a typo-tolerant hit.
 *
 * The plain `includes()` this replaces failed every one of those: it needed
 * the literal query text inside one field, in the right order, spelled
 * exactly, in English.
 */

import { STOPWORDS, expandSearchToken } from './searchSynonyms';

// ── Normalisation ─────────────────────────────────────────────────────────

const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Lower-case, strip accents, fold the few symbols that appear in part names
 * (µ, Ω) to letters, and turn every other non-alphanumeric run into a single
 * space. Applied identically to the query and to the haystack, so any
 * spelling of "HC-SR04" meets any other.
 */
export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/µ/g, 'u')
    .replace(/[ωΩ]/g, 'ohm')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Edit distance ─────────────────────────────────────────────────────────

/**
 * Optimal-string-alignment distance (Levenshtein + adjacent transposition),
 * with an early exit once every cell of a row exceeds `max`. Returns
 * `max + 1` for "too far", so callers compare with `<= max`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev2: number[] = [];
  let prev: number[] = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    const cur: number[] = new Array<number>(lb + 1);
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cb = b.charCodeAt(j - 1);
      const cost = ca === cb ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb] > max ? max + 1 : prev[lb];
}

// ── Fields ────────────────────────────────────────────────────────────────

export interface SearchField {
  /** Raw text; normalised once by prepareSearchFields(). */
  text: string;
  /** Relative importance. Name-like fields around 3, tags 2, descriptions 1. */
  weight?: number;
}

interface PreparedField {
  text: string;
  compact: string;
  words: string[];
  weight: number;
}

export interface PreparedSearchFields {
  fields: PreparedField[];
  /** The first field, used for whole-phrase bonuses ("exactly this name"). */
  primary: PreparedField | null;
}

/**
 * Normalise a set of fields once. Callers that filter on every keystroke
 * should cache the result per item (a WeakMap keyed by the item works).
 */
export function prepareSearchFields(fields: SearchField[]): PreparedSearchFields {
  const prepared: PreparedField[] = [];
  for (const f of fields) {
    if (!f.text) continue;
    const text = normalizeSearchText(f.text);
    if (!text) continue;
    prepared.push({
      text,
      compact: text.replace(/ /g, ''),
      words: text.split(' '),
      weight: f.weight ?? 1,
    });
  }
  return { fields: prepared, primary: prepared[0] ?? null };
}

// ── Query ─────────────────────────────────────────────────────────────────

interface QueryToken {
  /** The token as typed (normalised) plus its synonyms, best-first. */
  forms: string[];
  /** Stopwords only add score; every other token must match somewhere. */
  required: boolean;
}

export interface ParsedSearchQuery {
  tokens: QueryToken[];
  /** Whole normalised query, for phrase bonuses on the primary field. */
  phrase: string;
  /** No token is a stopword? Then a phrase bonus makes sense. */
  hasRequired: boolean;
}

/** Null when the query is blank, so callers can short-circuit to "all". */
export function parseSearchQuery(query: string): ParsedSearchQuery | null {
  const phrase = normalizeSearchText(query);
  if (!phrase) return null;
  const words = phrase.split(' ');
  const tokens: QueryToken[] = words.map((w) => ({
    forms: expandSearchToken(w),
    required: !STOPWORDS.has(w),
  }));
  const hasRequired = tokens.some((t) => t.required);
  // A query made only of stopwords ("and", "or", "not") is a real query for
  // the logic gates of that name: nothing to relax, every token counts.
  if (!hasRequired) for (const t of tokens) t.required = true;
  return { tokens, phrase, hasRequired: true };
}

// ── Scoring ───────────────────────────────────────────────────────────────

const LEVEL_EXACT_WORD = 1.0;
const LEVEL_WORD_PREFIX = 0.8;
const LEVEL_SUBSTRING = 0.6;
const LEVEL_FUZZY = 0.4;
const LEVEL_FUZZY_PREFIX = 0.3;
/** A hit reached through a synonym is worth a little less than a direct one. */
const SYNONYM_PENALTY = 0.9;

/** How many typos a token may carry, by its length. Short tokens: none. */
function typoBudget(token: string): number {
  if (token.length >= 8) return 2;
  if (token.length >= 5) return 1;
  return 0;
}

function matchTokenForm(form: string, field: PreparedField): number {
  const { words } = field;
  for (const w of words) if (w === form) return LEVEL_EXACT_WORD;
  for (const w of words) if (w.startsWith(form)) return LEVEL_WORD_PREFIX;
  if (field.text.includes(form) || field.compact.includes(form)) return LEVEL_SUBSTRING;

  const budget = typoBudget(form);
  if (budget === 0) return 0;
  let best = 0;
  for (const w of words) {
    if (w.length < 4) continue;
    const d = editDistance(form, w, budget);
    if (d <= budget) {
      const level = LEVEL_FUZZY - (d - 1) * 0.1;
      if (level > best) best = level;
    }
  }
  if (best > 0) return best;
  // A typo inside the first letters of a longer word ("potenc" vs
  // "potentiometer" typed as "potenz"): compare against the word's prefix.
  for (const w of words) {
    if (w.length <= form.length) continue;
    const d = editDistance(form, w.slice(0, form.length), budget);
    if (d <= budget) return LEVEL_FUZZY_PREFIX;
  }
  return 0;
}

function scoreToken(token: QueryToken, prepared: PreparedSearchFields): number {
  let best = 0;
  token.forms.forEach((form, i) => {
    const penalty = i === 0 ? 1 : SYNONYM_PENALTY;
    for (const field of prepared.fields) {
      const level = matchTokenForm(form, field);
      if (level === 0) continue;
      const s = level * penalty * field.weight;
      if (s > best) best = s;
    }
  });
  return best;
}

/**
 * Score an item against a parsed query. 0 means "does not match": some
 * required token found nothing in any field. Higher is a better match.
 */
export function scoreSearch(query: ParsedSearchQuery, prepared: PreparedSearchFields): number {
  let total = 0;
  for (const token of query.tokens) {
    const s = scoreToken(token, prepared);
    if (s === 0 && token.required) return 0;
    total += s;
  }
  if (total === 0) return 0;

  // Phrase bonuses on the primary (name) field: "led" should list the part
  // called LED before the 40 parts that merely mention one.
  const primary = prepared.primary;
  if (primary) {
    const phrase = query.phrase;
    if (primary.text === phrase || primary.compact === phrase.replace(/ /g, '')) {
      total += 3 * primary.weight;
    } else if (primary.text.startsWith(phrase)) {
      total += 2 * primary.weight;
    } else if (primary.text.includes(phrase)) {
      total += 1 * primary.weight;
    }
    // Shorter names are the more specific hit for the same score ("LED"
    // over "LED Ring" over "Led Bar Graph").
    total += 1 / (1 + primary.words.length);
  }
  return total;
}

/**
 * Filter + rank `items` by `query`. Blank query returns `items` untouched.
 * Ties keep the input order (Array.sort is stable), so callers can pass a
 * list already sorted by their own browsing order.
 */
export function rankBySearch<T>(
  items: readonly T[],
  query: string,
  prepare: (item: T) => PreparedSearchFields,
): T[] {
  const parsed = parseSearchQuery(query);
  if (!parsed) return [...items];
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = scoreSearch(parsed, prepare(item));
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/** Yes/no for tiny lists (a boards row, a handful of ads). */
export function matchesSearch(query: string, texts: readonly string[]): boolean {
  const parsed = parseSearchQuery(query);
  if (!parsed) return true;
  return scoreSearch(parsed, prepareSearchFields(texts.map((text) => ({ text })))) > 0;
}
