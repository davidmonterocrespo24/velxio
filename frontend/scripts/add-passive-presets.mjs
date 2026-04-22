/**
 * Idempotently inject the passive-component preset variants into
 * `scripts/component-overrides.json` (the documented extension point that
 * survives metadata regeneration via `npm run generate:metadata`).
 *
 * Adds:
 *   - resistor-220 / 330 / 470 / 1k / 2k2 / 4k7 / 10k / 22k / 47k / 100k / 1m
 *   - cap-10p / 22p / 100p / 1n / 10n / 100n / 1u  (ceramic, non-polarized)
 *   - capacitor-electrolytic + cap-elec-1u / 10u / 47u / 100u / 470u / 1000u
 *   - ind-100u / 1m / 10m
 *
 * Plus name/thumbnail overrides for the canonical resistor / capacitor /
 * inductor entries so they read "(custom)" in the picker once presets exist.
 *
 * Run:  node frontend/scripts/add-passive-presets.mjs
 * Then: npm run generate:metadata     (or just `npm run dev`)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = resolve(__dirname, '../../scripts/component-overrides.json');

const overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));

// ── SVG thumbnail factories ────────────────────────────────────────────────

function frame(inner) {
  return `<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" fill="#1a2332" rx="4"/>${inner}</svg>`;
}

function valueLabel(text) {
  return `<text x="32" y="56" text-anchor="middle" font-size="10" font-family="sans-serif" fill="#e5e7eb" font-weight="bold">${text}</text>`;
}

// Resistor color-band lookup (matches the wokwi-resistor element).
const BAND = {
  '-1': '#F1D863', '0': '#000', '1': '#8F4814', '2': '#FB0000',
  '3': '#FC9700', '4': '#FCF800', '5': '#00B800', '6': '#0000FF',
  '7': '#A803D6', '8': '#808080', '9': '#FCFCFC',
};

function bandsFor(ohms) {
  if (!ohms || ohms <= 0) return ['0', '0', '0'];
  const exp = Math.floor(Math.log10(ohms)) - 1;
  const base = Math.round(ohms / 10 ** exp);
  return [String(Math.floor(base / 10)), String(base % 10), String(exp)];
}

function resistorThumb(ohms, label) {
  const [b1, b2, b3] = bandsFor(ohms);
  return frame(`
    <rect x="6" y="29" width="52" height="3" fill="#aaa"/>
    <rect x="14" y="22" width="36" height="17" rx="3" fill="#d5b597" stroke="#a37b4f" stroke-width="0.6"/>
    <rect x="20" y="22" width="3" height="17" fill="${BAND[b1]}"/>
    <rect x="26" y="22" width="3" height="17" fill="${BAND[b2]}"/>
    <rect x="32" y="22" width="3" height="17" fill="${BAND[b3]}"/>
    <rect x="42" y="22" width="3" height="17" fill="#F1D863"/>
    ${valueLabel(label)}`);
}

function capacitorCeramicThumb(label) {
  return frame(`
    <rect x="6" y="29" width="52" height="3" fill="#aaa"/>
    <ellipse cx="32" cy="30" rx="14" ry="9" fill="#165696"/>
    <ellipse cx="28" cy="26" rx="5" ry="3" fill="#3a7cc8" opacity="0.5"/>
    ${valueLabel(label)}`);
}

function capacitorElectrolyticThumb(label) {
  return frame(`
    <rect x="20" y="40" width="2.5" height="9" fill="#aaa"/>
    <rect x="40" y="40" width="2.5" height="9" fill="#aaa"/>
    <rect x="14" y="10" width="36" height="32" rx="2" fill="#1f3b6b"/>
    <ellipse cx="32" cy="10" rx="18" ry="3" fill="#2a4d8a"/>
    <rect x="38" y="10" width="12" height="32" rx="2" fill="#dfe3ec"/>
    <text x="44" y="22" text-anchor="middle" font-size="10" font-weight="bold" fill="#1f3b6b">−</text>
    <text x="44" y="34" text-anchor="middle" font-size="10" font-weight="bold" fill="#1f3b6b">−</text>
    ${valueLabel(label)}`);
}

function inductorThumb(label) {
  return frame(`
    <rect x="6" y="29" width="52" height="3" fill="#aaa"/>
    <path d="M 12 30 Q 16 18 20 30 Q 24 18 28 30 Q 32 18 36 30 Q 40 18 44 30 Q 48 18 52 30"
          fill="none" stroke="#B23820" stroke-width="2.5" stroke-linecap="round"/>
    ${valueLabel(label)}`);
}

// ── Preset definitions ─────────────────────────────────────────────────────

const RESISTORS = [
  ['resistor-220',  '220 Ω',  '220',    220],
  ['resistor-330',  '330 Ω',  '330',    330],
  ['resistor-470',  '470 Ω',  '470',    470],
  ['resistor-1k',   '1 kΩ',   '1000',   1000],
  ['resistor-2k2',  '2.2 kΩ', '2200',   2200],
  ['resistor-4k7',  '4.7 kΩ', '4700',   4700],
  ['resistor-10k',  '10 kΩ',  '10000',  10000],
  ['resistor-22k',  '22 kΩ',  '22000',  22000],
  ['resistor-47k',  '47 kΩ',  '47000',  47000],
  ['resistor-100k', '100 kΩ', '100000', 100000],
  ['resistor-1m',   '1 MΩ',   '1000000', 1000000],
];

const CAPS_CERAMIC = [
  ['cap-10p',  '10 pF',  '10p'],
  ['cap-22p',  '22 pF',  '22p'],
  ['cap-100p', '100 pF', '100p'],
  ['cap-1n',   '1 nF',   '1n'],
  ['cap-10n',  '10 nF',  '10n'],
  ['cap-100n', '100 nF', '100n'],
  ['cap-1u',   '1 µF',   '1u'],
];

const CAPS_ELEC = [
  ['cap-elec-1u',    '1 µF',    '1u'],
  ['cap-elec-10u',   '10 µF',   '10u'],
  ['cap-elec-47u',   '47 µF',   '47u'],
  ['cap-elec-100u',  '100 µF',  '100u'],
  ['cap-elec-470u',  '470 µF',  '470u'],
  ['cap-elec-1000u', '1000 µF', '1000u'],
];

const INDUCTORS = [
  ['ind-100u', '100 µH', '100u'],
  ['ind-1m',   '1 mH',   '1m'],
  ['ind-10m',  '10 mH',  '10m'],
];

const valueProp = (defaultValue) => ({
  name: 'value', type: 'string', defaultValue, control: 'text',
});

function makeEntry({ id, tagName, name, thumbnail, defaultValue, tags }) {
  return {
    id,
    tagName,
    name,
    category: 'passive',
    thumbnail,
    properties: [valueProp(defaultValue)],
    defaultValues: { value: defaultValue },
    pinCount: 0,
    tags,
  };
}

// Build the new entries array
const newEntries = [];

// Canonical generic non-polarized cap and inductor — used to live in the
// upstream wokwi-elements submodule but we removed those mutations, so we
// have to inject them here.
newEntries.push(makeEntry({
  id: 'capacitor', tagName: 'wokwi-capacitor',
  name: 'Cap. ceramic (custom)',
  thumbnail: capacitorCeramicThumb('?µF'), defaultValue: '1u',
  tags: ['capacitor', 'ceramic', 'custom'],
}));
newEntries.push(makeEntry({
  id: 'inductor', tagName: 'wokwi-inductor',
  name: 'Inductor (custom)',
  thumbnail: inductorThumb('?mH'), defaultValue: '1m',
  tags: ['inductor', 'custom'],
}));

for (const [id, label, value, ohms] of RESISTORS) {
  newEntries.push(makeEntry({
    id, tagName: 'wokwi-resistor', name: `Resistor ${label}`,
    thumbnail: resistorThumb(ohms, label), defaultValue: value,
    tags: ['resistor', 'preset', label.toLowerCase().replace(/\s+/g, '')],
  }));
}
for (const [id, label, value] of CAPS_CERAMIC) {
  newEntries.push(makeEntry({
    id, tagName: 'wokwi-capacitor', name: `Cap. ${label}`,
    thumbnail: capacitorCeramicThumb(label), defaultValue: value,
    tags: ['capacitor', 'ceramic', 'preset', label.toLowerCase().replace(/\s+/g, '')],
  }));
}
newEntries.push(makeEntry({
  id: 'capacitor-electrolytic', tagName: 'velxio-capacitor-electrolytic',
  name: 'Electrolytic Cap. (custom)',
  thumbnail: capacitorElectrolyticThumb('?µF'), defaultValue: '10u',
  tags: ['capacitor', 'electrolytic', 'polarized', 'custom'],
}));
for (const [id, label, value] of CAPS_ELEC) {
  newEntries.push(makeEntry({
    id, tagName: 'velxio-capacitor-electrolytic',
    name: `Electrolytic ${label}`,
    thumbnail: capacitorElectrolyticThumb(label), defaultValue: value,
    tags: ['capacitor', 'electrolytic', 'polarized', 'preset', label.toLowerCase().replace(/\s+/g, '')],
  }));
}
for (const [id, label, value] of INDUCTORS) {
  newEntries.push(makeEntry({
    id, tagName: 'wokwi-inductor', name: `Inductor ${label}`,
    thumbnail: inductorThumb(label), defaultValue: value,
    tags: ['inductor', 'preset', label.toLowerCase().replace(/\s+/g, '')],
  }));
}

// ── Mutate the overrides JSON ──────────────────────────────────────────────

if (!Array.isArray(overrides._customComponents)) overrides._customComponents = [];

// Replace any existing entries with the same id (idempotent).
const newIds = new Set(newEntries.map((e) => e.id));
overrides._customComponents = [
  ...overrides._customComponents.filter((c) => !newIds.has(c.id)),
  ...newEntries,
];

// Rename canonical entries to "(custom)" via name/thumbnail overrides.
const renames = [
  { id: 'resistor', name: 'Resistor (custom)', thumbnail: resistorThumb(1000, '?Ω') },
  { id: 'capacitor', name: 'Cap. ceramic (custom)', thumbnail: capacitorCeramicThumb('?µF') },
  { id: 'inductor', name: 'Inductor (custom)', thumbnail: inductorThumb('?mH') },
];
for (const { id, name, thumbnail } of renames) {
  overrides[id] = { ...(overrides[id] ?? {}), name, thumbnail };
}

writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2) + '\n');

console.log(`✓ Wrote ${newEntries.length} preset entries to _customComponents`);
console.log(`✓ Renamed ${renames.length} canonical passives to "(custom)"`);
console.log(`→ Run \`npm run generate:metadata\` (or just \`npm run dev\`) to materialize them.`);
