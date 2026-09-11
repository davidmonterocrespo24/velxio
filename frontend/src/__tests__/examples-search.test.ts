/**
 * The examples gallery search over the REAL gallery: the same matcher the
 * component picker uses, fed with each example's title, tags, parts (and
 * what people call those parts), board, category and description.
 */
import { describe, it, expect } from 'vitest';
import { exampleProjects, type ExampleProject } from '../data/examples';
import { parseSearchQuery, scoreSearch } from '../utils/searchMatch';
import { exampleSearchFields } from '../utils/exampleSearch';

function boardFilter(example: ExampleProject): string {
  if (example.boardFilter) return example.boardFilter;
  if (example.boards) return 'multi';
  return example.boardType ?? 'arduino-uno';
}

function search(query: string): ExampleProject[] {
  const parsed = parseSearchQuery(query);
  if (!parsed) return [...exampleProjects];
  return exampleProjects
    .map((example) => ({
      example,
      score: scoreSearch(parsed, exampleSearchFields(example, boardFilter(example))),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.example);
}

const partsOf = (e: ExampleProject) =>
  (e.components ?? []).map((c) => c.type.replace(/^(wokwi|velxio)-/, ''));
const text = (e: ExampleProject) =>
  `${e.title} ${e.description} ${(e.tags ?? []).join(' ')}`.toLowerCase();

describe('examples gallery search over the real gallery', () => {
  it('finds every example by its own exact title, first', () => {
    // A sample across the gallery, not just the first few Arduino ones.
    const step = Math.max(1, Math.floor(exampleProjects.length / 25));
    for (let i = 0; i < exampleProjects.length; i += step) {
      const example = exampleProjects[i];
      const hits = search(example.title);
      expect(hits.length, example.title).toBeGreaterThan(0);
      // Duplicate titles exist across boards; the top hit must share the title.
      expect(hits[0].title, `query: ${example.title}`).toBe(example.title);
    }
  });

  it('reaches an example through the parts on its canvas', () => {
    const hits = search('temperature');
    expect(hits.length).toBeGreaterThan(0);
    for (const e of hits) {
      const viaParts = partsOf(e).some((p) =>
        ['dht22', 'bmp280', 'ntc-temperature-sensor', 'ds3231', 'pro-bme280'].includes(p),
      );
      expect(viaParts || /temp|weather|thermo/.test(text(e)), e.title).toBe(true);
    }
  });

  it('understands a query in the user language', () => {
    expect(search('temperatura').length).toBeGreaterThan(0);
    expect(search('sensor de temperatura').length).toBeGreaterThan(0);
    expect(search('semaforo').some((e) => /traffic/i.test(e.title))).toBe(true);
    expect(
      search('pantalla oled').some((e) => partsOf(e).some((p) => p.startsWith('ssd1306'))),
    ).toBe(true);
    expect(search('boton').some((e) => partsOf(e).includes('pushbutton'))).toBe(true);
  });

  it('survives a typo and any spelling of a part number', () => {
    const canonical = search('hc-sr04').map((e) => e.id);
    expect(canonical.length).toBeGreaterThan(0);
    expect(search('hc sr04').map((e) => e.id)).toEqual(canonical);
    expect(search('hcsr04').map((e) => e.id)).toEqual(canonical);
    const typo = search('ultrasnic');
    expect(typo.length).toBeGreaterThan(0);
    for (const e of typo) {
      expect(partsOf(e).includes('hc-sr04') || /ultrason/.test(text(e)), e.title).toBe(true);
    }
  });

  it('several words narrow, in any order', () => {
    const a = search('esp32 oled');
    const b = search('oled esp32');
    // Same set either way; the order may differ because a title that starts
    // with the phrase as typed earns a small bonus.
    expect(a.map((e) => e.id).sort()).toEqual(b.map((e) => e.id).sort());
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThan(search('oled').length);
    for (const e of a)
      expect(boardFilter(e).startsWith('esp32') || /esp32/.test(text(e))).toBe(true);
  });

  it('filters by board, category and difficulty words too', () => {
    expect(
      search('beginner').every((e) => e.difficulty === 'beginner' || /beginner/.test(text(e))),
    ).toBe(true);
    expect(search('principiante').length).toBeGreaterThan(0);
    expect(search('pico').some((e) => boardFilter(e).includes('pico'))).toBe(true);
  });
});
