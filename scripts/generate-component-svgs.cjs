#!/usr/bin/env node
/**
 * generate-component-svgs.cjs
 *
 * Extracts real SVG artwork from wokwi-elements CJS builds and saves each
 * component's SVG to frontend/public/component-svgs/<tagname>.svg
 *
 * Strategy:
 *  1. Intercept require('lit'), require('lit/decorators.js'), etc. so that
 *     html`` / svg`` tagged template literals just concatenate strings, and
 *     LitElement is a plain JS class.
 *  2. Require each element file → its class is registered in elementRegistry.
 *  3. Instantiate with default props, call renderSVG() or render().
 *  4. Extract the <svg> block from the result string.
 *  5. Write to frontend/public/component-svgs/<name>.svg
 *
 * Run:  node scripts/generate-component-svgs.cjs
 */

'use strict';

const Module = require('module');
const path   = require('path');
const fs     = require('fs');

const CJS_DIR    = path.resolve(__dirname, '../wokwi-libs/wokwi-elements/dist/cjs');
const OUT_DIR    = path.resolve(__dirname, '../frontend/public/component-svgs');
const BOARDS_DIR = path.resolve(__dirname, '../frontend/public/boards');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Lit mock ─────────────────────────────────────────────────────────────────
// html/svg/css tagged template literals → plain string concatenation.
// We also strip Lit-specific bindings that would corrupt the SVG XML:
//   @eventName=${handler}   → event handlers (value is a function object)
//   .propName=${value}      → property bindings
//   ?boolAttr=${value}      → boolean attribute bindings
//   style=--css-var:${val}  → unquoted CSS custom property bindings
function tagConcat(strings, ...values) {
  let result = '';
  for (let i = 0; i < strings.length; i++) {
    let str = strings[i];
    if (i > 0) {
      const val = values[i - 1];
      // Check what the preceding static string ends with to classify the binding
      const prevStr = strings[i - 1];
      const attrMatch = prevStr.match(/\s+(@[\w:-]+|\.[\w:-]+|\?[\w:-]+)\s*=\s*$/);
      if (attrMatch) {
        // Drop the attribute name from result (it was already added) and skip value
        result = result.slice(0, result.length - attrMatch[0].length);
        // Skip the value entirely
      } else if (/\s+style\s*=\s*--[\w-]+:[^"'\s]*$/.test(prevStr + String(val != null ? val : ''))) {
        // unquoted CSS custom property — drop
        result = result.replace(/\s+style\s*=\s*--[\w-]+:[^"'\s]*$/, '');
      } else {
        result += val != null ? String(val) : '';
      }
    }
    result += str;
  }
  return result;
}

const mockLit = {
  LitElement: class LitElement {
    constructor() {}
    dispatchEvent() {}
    requestUpdate() {}
    // Subclasses set these properties before calling render; returning '' is fine
  },
  html:    tagConcat,
  svg:     tagConcat,
  css:     () => '',
  nothing: '',
  unsafeHTML: (s) => s,
};

const mockDecorators = {
  customElement: () => (cls) => cls,
  property:      () => () => {},
  state:         () => () => {},
  query:         () => () => {},
};

const mockClassMap  = { classMap:  (m) => Object.entries(m).filter(([,v]) => v).map(([k]) => k).join(' ') };
const mockStyleMap  = { styleMap:  (m) => Object.entries(m).map(([k,v]) => `${k}:${v}`).join(';') };

// ── Intercept require() for lit packages ─────────────────────────────────────
const origLoad = Module._load.bind(Module);
Module._load = function(request, parent, isMain) {
  if (request === 'lit')                          return mockLit;
  if (request === 'lit/decorators.js')            return mockDecorators;
  if (request === 'lit/directives/class-map.js')  return mockClassMap;
  if (request === 'lit/directives/style-map.js')  return mockStyleMap;
  return origLoad(request, parent, isMain);
};

// Also provide browser globals expected by some elements
if (typeof globalThis.customElements === 'undefined') {
  globalThis.customElements = { define: () => {} };
}

// ── Elements to extract ───────────────────────────────────────────────────────
// [ tagName, elementFile, defaultProps, useRenderSVG ]
const ELEMENTS = [
  // component elements
  ['wokwi-led',                    'led-element',                    { color: 'red',   value: false, brightness: 1.0, flip: false, label: '' }, true  ],
  ['wokwi-led-green',              'led-element',                    { color: 'green', value: false, brightness: 1.0, flip: false, label: '' }, true  ],
  ['wokwi-led-blue',               'led-element',                    { color: 'blue',  value: false, brightness: 1.0, flip: false, label: '' }, true  ],
  ['wokwi-led-yellow',             'led-element',                    { color: 'yellow',value: false, brightness: 1.0, flip: false, label: '' }, true  ],
  ['wokwi-rgb-led',                'rgb-led-element',                { rValue: 0, gValue: 0, bValue: 0, commonAnode: false }, true  ],
  ['wokwi-resistor',               'resistor-element',               { value: '1000' },                                                         false ],
  ['wokwi-pushbutton',             'pushbutton-element',             { color: 'green', label: '', key: '' },                                    true  ],
  ['wokwi-pushbutton-6mm',         'pushbutton-6mm-element',         { color: 'red',   label: '' },                                             true  ],
  ['wokwi-dht22',                  'dht22-element',                  {},                                                                         false ],
  ['wokwi-hc-sr04',                'hc-sr04-element',                {},                                                                         false ],
  ['wokwi-mpu6050',                'mpu6050-element',                {},                                                                         false ],
  ['wokwi-bmp280',                 'bmp280-element',                 {},                                                                         false ],
  ['wokwi-lcd2004',                'lcd2004-element',                {},                                                                         false ],
  ['wokwi-ssd1306',                'ssd1306-element',                { width: 128, height: 64 },                                                 false ],
  ['wokwi-ili9341',                'ili9341-element',                {},                                                                         false ],
  ['wokwi-7segment',               '7segment-element',               { value: '0', color: 'red', common: 'cathode' },                           false ],
  ['wokwi-potentiometer',          'potentiometer-element',          { value: 0.5 },                                                             false ],
  ['wokwi-servo',                  'servo-element',                  { value: 90 },                                                              false ],
  ['wokwi-ntc-temperature-sensor', 'ntc-temperature-sensor-element', {},                                                                         false ],
  ['wokwi-photoresistor-sensor',   'photoresistor-sensor-element',   {},                                                                         false ],
  ['wokwi-pir-motion-sensor',      'pir-motion-sensor-element',      {},                                                                         false ],
  ['wokwi-analog-joystick',        'analog-joystick-element',        { xValue: 0, yValue: 0 },                                                  false ],
  ['wokwi-buzzer',                 'buzzer-element',                 {},                                                                         false ],
  ['wokwi-neopixel',               'neopixel-element',               {},                                                                         false ],
  ['wokwi-neopixel-matrix',        'neopixel-matrix-element',        { rows: 4, cols: 4 },                                                       false ],
  ['wokwi-led-ring',               'led-ring-element',               { pixels: 12 },                                                             false ],
  ['wokwi-ds1307',                 'ds1307-element',                 {},                                                                         false ],
  // boards — arduino-uno/nano/mega are copied from public/boards/ instead
  // (their Lit element render() contains unquoted event handlers that corrupt XML)
  ['wokwi-esp32-devkit-v1',        'esp32-devkit-v1-element',        {},                                                                         false ],
  ['wokwi-nano-rp2040-connect',    'nano-rp2040-connect-element',    {},                                                                         false ],
];

// ── Strip Lit-specific noise from raw render output ──────────────────────────
// Lit html`` templates serialise event handlers literally when mocked as plain
// string concatenation.  @handler attributes may be:
//   a) single-line unquoted:  @click=() => foo()
//   b) multi-line unquoted:   @mousedown=handler(e) {\n  ...\n}
//   c) multi-line quoted:     @click="handler() {\n  ...\n}"
// All of them contain raw ">" characters that corrupt XML.
// Strategy: process line-by-line and track skip state.
function cleanRawHtml(raw) {
  const lines = raw.split('\n');
  const kept = [];
  let skipping = false;
  let skipMode = ''; // 'quoted' | 'brace'

  for (const line of lines) {
    if (skipping) {
      if (skipMode === 'quoted' && /"\s*$/.test(line)) {
        skipping = false;
      } else if (skipMode === 'brace' && /^\s*\}\s*$/.test(line)) {
        skipping = false;
      }
      // discard this line regardless
      continue;
    }

    const trimmed = line.trimStart();

    // Lines that ARE an @handler attribute (possibly with value on same line)
    if (/^@[\w:-]+\s*=/.test(trimmed)) {
      // Does a quoted value open AND close on this line?
      const afterEq = trimmed.replace(/^@[\w:-]+\s*=\s*/, '');
      if (/^"[^"]*"\s*$/.test(afterEq) || /^'[^']*'\s*$/.test(afterEq)) {
        // fully self-contained quoted value — just drop the line
      } else if (afterEq.startsWith('"')) {
        // multi-line quoted value
        skipping = true; skipMode = 'quoted';
      } else if (/\{\s*$/.test(trimmed)) {
        // unquoted, opens a brace block
        skipping = true; skipMode = 'brace';
      }
      // drop this line in all cases
      continue;
    }

    // Lines that are the TAIL of an @handler value left over on the PREVIOUS tag line
    // e.g.  filter="url(#noise)"> this.keyup(e)
    // These happen when the Lit template has  filter="${...}" @keyup=${...}
    // and the tag ends mid-line.  Detect: line contains "> someIdentifier.method("
    if (/>\s+this\.[\w]+\(/.test(line)) {
      // Keep only the part up to and including the first >
      const gtIdx = line.indexOf('>');
      kept.push(line.slice(0, gtIdx + 1));
      continue;
    }

    // Drop tabindex, role, unquoted style=--var, empty class=
    if (/^\s*tabindex\s*=/.test(line)) continue;
    if (/^\s*role\s*=/.test(line)) continue;
    if (/^\s*style\s*=\s*--/.test(line)) continue;
    if (/^\s*class\s*=\s*$/.test(line)) continue;

    kept.push(line);
  }

  return kept.join('\n');
}

// ── Extract SVG from a rendered string ───────────────────────────────────────
function extractSvg(html) {
  // Strip Lit event handlers before touching the XML
  html = cleanRawHtml(html);
  // Find the first <svg ...> to its matching </svg> using depth tracking
  const start = html.indexOf('<svg');
  if (start === -1) return null;
  let depth = 0, i = start;
  while (i < html.length) {
    if (html.slice(i, i + 4) === '<svg') { depth++; i += 4; }
    else if (html.slice(i, i + 6) === '</svg>') {
      depth--;
      if (depth === 0) return html.slice(start, i + 6);
      i += 6;
    } else { i++; }
  }
  return null;
}

// ── Normalize SVG for reliable <img> rendering ───────────────────────────────
// 1. Convert mm-based width/height to px.
// 2. Move stray <filter> and <pattern> elements into <defs> — browsers may
//    refuse to render SVGs where paint-server elements appear in the main tree.
// 3. Modernize deprecated xlink:href → href in <use> elements.
// 4. Remove xmlns:xlink declaration.
function normalizeSvgDimensions(svgStr) {
  const MM_TO_PX = 96 / 25.4;
  const hasViewBox = /viewBox\s*=/i.test(svgStr);

  // 1. mm → px
  let result = svgStr.replace(
    /width="([\d.]+)mm"\s+height="([\d.]+)mm"/,
    (_, wMm, hMm) => {
      const wPx = Math.round(parseFloat(wMm) * MM_TO_PX);
      const hPx = Math.round(parseFloat(hMm) * MM_TO_PX);
      if (hasViewBox) {
        return `width="${wPx}" height="${hPx}"`;
      }
      return `width="${wPx}" height="${hPx}" viewBox="0 0 ${wMm} ${hMm}"`;
    }
  );

  // 2. Move <filter>…</filter> and <pattern>…</pattern> that sit outside <defs>
  //    into an existing <defs> block (or create one if absent).
  result = movePaintServersIntoDefs(result);

  // 3. Modernize xlink:href → href in <use> elements
  result = result.replace(/(<use\b[^>]*?)\s+xlink:href\s*=\s*"([^"]*)"/g, '$1 href="$2"');
  result = result.replace(/(<use\b[^>]*?)\s+xlink:href\s*=\s*'([^']*)'/g, "$1 href='$2'");

  // 4. Remove xmlns:xlink declaration (no longer needed)
  result = result.replace(/\s+xmlns:xlink\s*=\s*["'][^"']*["']/g, '');

  // 5. Remove empty / bare attributes left after stripping Lit bindings:
  //    style=\n, class=\n, and any attr= not followed by a quote
  result = result.replace(/\s+(?:style|class|opacity|fill|stroke|transform|filter|d)=\s*(?=[\n\r\s>\/])/g, '');

  // 6. Quote ALL unquoted attribute values: fill=#444, opacity=0, cx=9.91 etc.
  //    Match: word= followed by non-quote, non-whitespace, non-> content
  result = result.replace(/\b([\w:-]+)=([^"'\s\n\r>\/][^\s\n\r>]*)/g, (match, name, val) => {
    // Skip xml/xmlns declarations and already-ok numeric-only handled below
    if (name.startsWith('xml') || name === 'version') return match;
    return name + '="' + val + '"';
  });

  return result;
}

// Extract every top-level <tagName>…</tagName> block that appears outside <defs>
// and inject it inside <defs>.  Works for multi-line blocks via a simple depth-
// aware scan (no full XML parser needed — the SVGs are well-formed).
function movePaintServersIntoDefs(svgStr) {
  const TAGS = ['filter', 'pattern'];

  // Find the <defs> close position (we'll inject before </defs>)
  let defsClose = svgStr.indexOf('</defs>');

  // Collect all paint-server blocks that sit outside <defs>
  const extracted = [];

  for (const tag of TAGS) {
    const openRe  = new RegExp(`<${tag}\\b`, 'g');
    const closeTag = `</${tag}>`;

    let match;
    while ((match = openRe.exec(svgStr)) !== null) {
      const start = match.index;

      // Is this occurrence inside the existing <defs> block?
      const defsOpen = svgStr.indexOf('<defs');
      if (defsOpen !== -1 && defsClose !== -1 && start > defsOpen && start < defsClose) {
        continue; // already inside defs — leave it
      }

      // Find the matching close tag
      const end = svgStr.indexOf(closeTag, start);
      if (end === -1) continue;
      const blockEnd = end + closeTag.length;

      extracted.push({ start, blockEnd });
    }
  }

  if (extracted.length === 0) return svgStr; // nothing to do

  // Sort descending by start so removal doesn't shift earlier indices
  extracted.sort((a, b) => b.start - a.start);

  // Build the combined block text and remove each occurrence from the source
  const blocks = extracted.slice().sort((a, b) => a.start - b.start)
    .map(({ start, blockEnd }) => svgStr.slice(start, blockEnd));

  for (const { start, blockEnd } of extracted) {
    // Remove the block (replace with empty string, strip surrounding blank line)
    svgStr = svgStr.slice(0, start) + svgStr.slice(blockEnd);
    // Recalculate defsClose after removal
    defsClose = svgStr.indexOf('</defs>');
  }

  // Now inject all extracted blocks inside <defs>
  if (defsClose !== -1) {
    // Append before the closing </defs>
    svgStr = svgStr.slice(0, defsClose) +
      '\n' + blocks.join('\n') + '\n' +
      svgStr.slice(defsClose);
  } else {
    // No <defs> yet — create one right after the <svg ...> opening tag
    const svgTagEnd = svgStr.indexOf('>') + 1;
    svgStr = svgStr.slice(0, svgTagEnd) +
      '\n<defs>\n' + blocks.join('\n') + '\n</defs>' +
      svgStr.slice(svgTagEnd);
  }

  return svgStr;
}

// ── Main loop ─────────────────────────────────────────────────────────────────
let ok = 0, skip = 0, fail = 0;

for (const [tagName, fileName, defaultProps, useRenderSVG] of ELEMENTS) {
  const filePath = path.join(CJS_DIR, `${fileName}.js`);
  if (!fs.existsSync(filePath)) {
    console.warn(`  ⚠ skip  ${tagName} — ${fileName}.js not found`);
    skip++;
    continue;
  }

  try {
    // Clear from require cache so props can vary between iterations (e.g. LED colors)
    delete require.cache[require.resolve(filePath)];
    const mod = require(filePath);

    // Find the exported class (the element)
    const ExportedClass = Object.values(mod).find(
      (v) => typeof v === 'function' && v.prototype && typeof v.prototype.render === 'function'
    );
    if (!ExportedClass) {
      console.warn(`  ⚠ skip  ${tagName} — no renderable class found`);
      skip++;
      continue;
    }

    // Instantiate and apply default props
    const el = new ExportedClass();
    Object.assign(el, defaultProps);

    // Call the appropriate render method
    let result;
    if (useRenderSVG && typeof el.renderSVG === 'function') {
      result = el.renderSVG();
    } else if (typeof el.render === 'function') {
      result = el.render();
    } else {
      console.warn(`  ⚠ skip  ${tagName} — no render() method`);
      skip++;
      continue;
    }

    const svgStr = extractSvg(String(result));
    if (!svgStr) {
      console.warn(`  ⚠ skip  ${tagName} — no <svg> found in render output`);
      skip++;
      continue;
    }

    // Wrap in a proper SVG document header if not already present
    let fullSvg = svgStr.includes('xmlns=')
      ? svgStr
      : svgStr.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');

    // Convert mm-based dimensions to px so <img> can determine intrinsic size
    fullSvg = normalizeSvgDimensions(fullSvg);

    // Ensure XML declaration with UTF-8 encoding so <img> handles non-ASCII correctly
    if (!fullSvg.startsWith('<?xml')) {
      fullSvg = '<?xml version="1.0" encoding="UTF-8"?>\n' + fullSvg;
    }

    const outFile = path.join(OUT_DIR, `${tagName.replace(/^wokwi-/, '')}.svg`);
    fs.writeFileSync(outFile, fullSvg, 'utf-8');
    console.log(`  ✓ ${tagName}`);
    ok++;

  } catch (err) {
    console.error(`  ✗ fail  ${tagName}: ${err.message}`);
    fail++;
  }
}

// ── Copy board SVGs from public/boards/ ──────────────────────────────────────
const BOARD_COPIES = [
  ['wokwi-raspberry-pi-pico', 'pi-pico.svg'],
  ['wokwi-raspberry-pi-pico-w', 'pi-pico-w.svg'],
  // Arduino boards: use clean board SVGs for both the element name and the -board alias
  // (the Lit element render() produces invalid XML with unquoted event handlers)
  ['wokwi-arduino-uno',       'arduino-uno.svg'],
  ['wokwi-arduino-uno-board', 'arduino-uno.svg'],
  ['wokwi-arduino-nano',      'arduino-nano.svg'],
  ['wokwi-arduino-nano-board','arduino-nano.svg'],
  ['wokwi-arduino-mega',      'arduino-mega.svg'],
  ['wokwi-arduino-mega-board','arduino-mega.svg'],
  ['wokwi-esp32-board', 'esp32-devkit-c-v4.svg'],
  ['wokwi-raspberry-pi-3', 'Raspberry_Pi_3.svg'],
];

console.log('\n📋 Copying board SVGs from public/boards/...');
for (const [tagName, srcFile] of BOARD_COPIES) {
  const src = path.join(BOARDS_DIR, srcFile);
  const dst = path.join(OUT_DIR, `${tagName.replace(/^wokwi-/, '')}.svg`);
  if (fs.existsSync(src)) {
    const normalized = normalizeSvgDimensions(fs.readFileSync(src, 'utf-8'));
    fs.writeFileSync(dst, normalized, 'utf-8');
    console.log(`  ✓ ${tagName} ← boards/${srcFile}`);
    ok++;
  } else {
    console.warn(`  ⚠ skip  ${tagName} — boards/${srcFile} not found`);
    skip++;
  }
}

console.log(`\n✅ Done: ${ok} generated, ${skip} skipped, ${fail} failed`);
console.log(`   → ${OUT_DIR}`);
