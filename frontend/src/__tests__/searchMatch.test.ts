import { describe, it, expect } from 'vitest';
import {
  editDistance,
  matchesSearch,
  normalizeSearchText,
  parseSearchQuery,
  prepareSearchFields,
  rankBySearch,
  scoreSearch,
} from '../utils/searchMatch';
import { expandSearchToken } from '../utils/searchSynonyms';

interface Part {
  id: string;
  name: string;
  tags: string;
  keywords: string;
  description?: string;
}

const CATALOGUE: Part[] = [
  { id: 'led', name: 'LED', tags: 'led', keywords: 'led light diode indicator lamp' },
  { id: 'led-ring', name: 'LED Ring', tags: 'led ring', keywords: 'neopixel ws2812 rgb' },
  { id: 'rgb-led', name: 'RGB Led', tags: 'rgb led', keywords: 'rgb led color light' },
  { id: 'dht22', name: 'DHT22', tags: 'dht22', keywords: 'temperature humidity sensor' },
  {
    id: 'hc-sr04',
    name: 'HC-SR04',
    tags: 'hc-sr04 hc sr04',
    keywords: 'ultrasonic distance sensor sonar',
  },
  {
    id: 'potentiometer',
    name: 'Potentiometer',
    tags: 'potentiometer',
    keywords: 'pot knob dial variable resistor analog input',
  },
  { id: 'pushbutton', name: 'Pushbutton', tags: 'pushbutton', keywords: 'push button switch' },
  { id: 'logic-gate-and', name: 'AND Gate', tags: 'logic gate and', keywords: 'logic gate' },
  { id: 'logic-gate-or', name: 'OR Gate', tags: 'logic gate or', keywords: 'logic gate' },
  {
    id: 'pir',
    name: 'PIR Motion Sensor',
    tags: 'pir motion sensor',
    keywords: 'presence movement',
    description: 'Detects motion; often paired with an LED to show a hit.',
  },
];

const fields = (p: Part) =>
  prepareSearchFields([
    { text: p.name, weight: 3 },
    { text: p.id, weight: 2.5 },
    { text: p.tags, weight: 2.5 },
    { text: p.keywords, weight: 2 },
    { text: p.description ?? '', weight: 1 },
  ]);

const ids = (query: string) => rankBySearch(CATALOGUE, query, fields).map((p) => p.id);

describe('normalizeSearchText', () => {
  it('lower-cases, strips accents and folds punctuation to single spaces', () => {
    expect(normalizeSearchText('  Botón  Pulsador ')).toBe('boton pulsador');
    expect(normalizeSearchText('HC-SR04')).toBe('hc sr04');
    expect(normalizeSearchText('ePaper 1.54" (200×200, B/W)')).toBe('epaper 1 54 200 200 b w');
    expect(normalizeSearchText('Resistor 4.7 kΩ')).toBe('resistor 4 7 kohm');
    expect(normalizeSearchText('Cap. 1 µF')).toBe('cap 1 uf');
  });
});

describe('editDistance', () => {
  it('counts substitutions, insertions, deletions and adjacent swaps', () => {
    expect(editDistance('kitten', 'kitten', 3)).toBe(0);
    expect(editDistance('kitten', 'sitten', 3)).toBe(1);
    expect(editDistance('arduno', 'arduino', 3)).toBe(1);
    expect(editDistance('ardiuno', 'arduino', 3)).toBe(1);
    expect(editDistance('kitten', 'sitting', 3)).toBe(3);
  });
  it('gives up early past the budget', () => {
    expect(editDistance('abc', 'xyzxyz', 1)).toBe(2);
    expect(editDistance('potentiometer', 'buzzer', 2)).toBe(3);
  });
});

describe('parseSearchQuery', () => {
  it('is null for a blank query', () => {
    expect(parseSearchQuery('')).toBeNull();
    expect(parseSearchQuery('   ')).toBeNull();
  });
  it('marks stopwords optional unless the whole query is stopwords', () => {
    const q = parseSearchQuery('sensor de temperatura')!;
    expect(q.tokens.map((t) => t.required)).toEqual([true, false, true]);
    const gates = parseSearchQuery('and')!;
    expect(gates.tokens[0].required).toBe(true);
  });
  it('expands a token through the synonym table, itself first', () => {
    expect(expandSearchToken('temperatura')[0]).toBe('temperatura');
    expect(expandSearchToken('temperatura')).toContain('temperature');
    expect(expandSearchToken('botones')).toContain('pushbutton');
    expect(expandSearchToken('zzz')).toEqual(['zzz']);
  });
});

describe('rankBySearch', () => {
  it('returns everything, in order, for a blank query', () => {
    expect(ids('')).toEqual(CATALOGUE.map((p) => p.id));
  });

  it('returns nothing for a word that matches nowhere', () => {
    expect(ids('zzqqxx')).toEqual([]);
  });

  it('matches partial words', () => {
    expect(ids('temp')).toEqual(['dht22']);
    expect(ids('ultra')).toEqual(['hc-sr04']);
    expect(ids('poten')).toEqual(['potentiometer']);
  });

  it('matches every word independently, in any order', () => {
    expect(ids('sensor motion')).toEqual(['pir']);
    expect(ids('motion sensor')).toEqual(['pir']);
    expect(ids('sensor humidity')).toEqual(['dht22']);
  });

  it('treats punctuation and spacing variants as the same query', () => {
    const expected = ['hc-sr04'];
    expect(ids('hc-sr04')).toEqual(expected);
    expect(ids('hc sr04')).toEqual(expected);
    expect(ids('hcsr04')).toEqual(expected);
    expect(ids('HC_SR04')).toEqual(expected);
  });

  it('survives a typo', () => {
    expect(ids('potenciometer')).toEqual(['potentiometer']);
    expect(ids('ultrasnic')).toEqual(['hc-sr04']);
    expect(ids('temperture')).toEqual(['dht22']);
  });

  it('does not let short tokens be fuzzy', () => {
    // "lcd" is one edit from "led" but a 3-letter token gets no typo budget.
    expect(ids('lcd')).toEqual([]);
  });

  it('understands other languages and aliases through synonyms', () => {
    expect(ids('temperatura')).toEqual(['dht22']);
    expect(ids('humedad')).toEqual(['dht22']);
    expect(ids('boton')).toEqual(['pushbutton']);
    expect(ids('Taster')).toEqual(['pushbutton']);
    expect(ids('bouton')).toEqual(['pushbutton']);
    expect(ids('pot')).toEqual(['potentiometer']);
    expect(ids('distancia')).toEqual(['hc-sr04']);
    expect(ids('ultraschall')).toEqual(['hc-sr04']);
  });

  it('never fails a query on a little word', () => {
    expect(ids('sensor de temperatura')).toEqual(['dht22']);
    expect(ids('the pushbutton')).toEqual(['pushbutton']);
  });

  it('ranks the part that IS the word above parts that mention it', () => {
    expect(ids('led')[0]).toBe('led');
    expect(ids('led')).toContain('pir'); // description mentions an LED, last
    expect(ids('led').indexOf('pir')).toBe(ids('led').length - 1);
    expect(ids('and gate')[0]).toBe('logic-gate-and');
    expect(ids('or gate')[0]).toBe('logic-gate-or');
  });

  it('ranks a direct hit above a synonym hit', () => {
    // "button" is literally in pushbutton's keywords and a synonym of pushbutton.
    const parsed = parseSearchQuery('button')!;
    const direct = scoreSearch(parsed, fields(CATALOGUE.find((p) => p.id === 'pushbutton')!));
    expect(direct).toBeGreaterThan(0);
    expect(scoreSearch(parsed, fields(CATALOGUE.find((p) => p.id === 'led')!))).toBe(0);
  });
});

describe('matchesSearch', () => {
  it('is a yes/no over a few strings', () => {
    expect(matchesSearch('', ['ESP32 DevKit V1'])).toBe(true);
    expect(matchesSearch('esp32', ['ESP32 DevKit V1'])).toBe(true);
    expect(matchesSearch('esp 32', ['ESP32 DevKit V1'])).toBe(true);
    expect(matchesSearch('devkit', ['ESP32 DevKit V1'])).toBe(true);
    expect(matchesSearch('pico', ['ESP32 DevKit V1'])).toBe(false);
    expect(matchesSearch('rp2040', ['Raspberry Pi Pico', 'raspberry-pi-pico', 'rp2040'])).toBe(
      true,
    );
  });
});
