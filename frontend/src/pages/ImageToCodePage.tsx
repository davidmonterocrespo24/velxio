/**
 * /tools/image-to-code. Drop, pick or paste an image and get a monochrome C byte
 * array for an SSD1306-class OLED, previewed on the emulated panel. Conversion is
 * in utils/imageToCArray.ts.
 *
 * Prerendered, so the first render must not touch the DOM: decoding runs in
 * handlers, previews in effects, and the OLED element is imported dynamically.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import {
  DEFAULT_MONO_OPTIONS,
  OLED_LIT_RGB,
  formatCArray,
  frameOnOled,
  monoToRgba,
  packMono,
  placeOnWhite,
  toMonochrome,
  type DitherMode,
  type DrawMode,
  type OutputFormat,
  type ScaleMode,
} from '../utils/imageToCArray';
import './ImageToCodePage.css';

const OLED_W = 128;
const OLED_H = 64;
const MAX_DIM = 1024;
const OLED_HOST_ID = 'i2c-oled-host';
const ACCEPT = 'image/png,image/jpeg,image/gif,image/bmp,image/webp,image/svg+xml';

/** The bits of Ssd1306I2cElement this page drives. */
type OledElement = Element & { imageData?: ImageData; redraw?: () => void };

interface DecodedImage {
  name: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

function clampDim(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_DIM, Math.round(value)));
}

/** Decode a file to raw RGBA through an offscreen canvas. Handlers only. */
async function decodeImageFile(file: File): Promise<DecodedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error('image has no intrinsic size');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0, width, height);
    return {
      name: file.name || 'pasted image',
      width,
      height,
      rgba: ctx.getImageData(0, 0, width, height).data,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const ImageToCodePage: React.FC = () => {
  const { t } = useTranslation();
  useSEO(getSeoMeta('/tools/image-to-code')!);

  const [image, setImage] = useState<DecodedImage | null>(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState(false);

  const [outW, setOutW] = useState(OLED_W);
  const [outH, setOutH] = useState(OLED_H);
  const [scaleMode, setScaleMode] = useState<ScaleMode>('fit');
  const [center, setCenter] = useState(true);
  const [threshold, setThreshold] = useState(DEFAULT_MONO_OPTIONS.threshold);
  const [invert, setInvert] = useState(false);
  const [dither, setDither] = useState<DitherMode>('none');
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [drawMode, setDrawMode] = useState<DrawMode>('horizontal');
  const [format, setFormat] = useState<OutputFormat>('arduino');
  const [name, setName] = useState('myBitmap');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);

  // ── pipeline (pure, so it is safe to run during render) ───────────────────
  const placed = useMemo(
    () =>
      image
        ? placeOnWhite(image.rgba, image.width, image.height, outW, outH, { scaleMode, center })
        : null,
    [image, outW, outH, scaleMode, center],
  );

  const mono = useMemo(
    () =>
      placed ? toMonochrome(placed, outW, outH, { threshold, invert, dither, flipH, flipV }) : null,
    [placed, outW, outH, threshold, invert, dither, flipH, flipV],
  );

  const bytes = useMemo(
    () => (mono ? packMono(mono, outW, outH, drawMode) : null),
    [mono, outW, outH, drawMode],
  );

  const code = useMemo(
    () => (bytes ? formatCArray(bytes, { format, name, width: outW, height: outH, drawMode }) : ''),
    [bytes, format, name, outW, outH, drawMode],
  );

  // ── input ─────────────────────────────────────────────────────────────────
  const loadFile = useCallback(
    async (file: File) => {
      try {
        const decoded = await decodeImageFile(file);
        setImage(decoded);
        setError('');
        // Default to the image's own size, but never larger than the panel.
        setOutW(clampDim(Math.min(decoded.width, OLED_W)));
        setOutH(clampDim(Math.min(decoded.height, OLED_H)));
      } catch {
        setImage(null);
        setError(
          t('tools.imageToCode.errorDecode', 'Could not read that image. Try a PNG or JPG.'),
        );
      }
    },
    [t],
  );

  // Paste anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith('image/'),
      );
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        void loadFile(file);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loadFile]);

  // ── previews (DOM only, no state writes) ──────────────────────────────────
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!mono) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    canvas.width = outW;
    canvas.height = outH;
    ctx.putImageData(new ImageData(monoToRgba(mono, outW, outH, OLED_LIT_RGB), outW, outH), 0, 0);
  }, [mono, outW, outH]);

  // The OLED preview is a web component, and importing its module is what
  // defines it, so the import is dynamic and never runs during SSR. The host
  // div is found by id rather than by ref: the element's imageData setter is
  // a plain property write, which React's immutability lint forbids on a value
  // reached through a ref.
  useEffect(() => {
    let cancelled = false;
    void import('../components/velxio-components/Ssd1306I2cElement').then(() => {
      if (cancelled) return;
      const host = document.getElementById(OLED_HOST_ID);
      if (!host) return;
      if (!host.firstElementChild) {
        host.appendChild(document.createElement('velxio-ssd1306-i2c-4pin'));
      }
      const el = host.firstElementChild as OledElement | null;
      if (!el || typeof el.redraw !== 'function') return;
      const framed = mono
        ? frameOnOled(mono, outW, outH, OLED_W, OLED_H)
        : new Uint8Array(OLED_W * OLED_H);
      el.imageData = new ImageData(
        monoToRgba(framed, OLED_W, OLED_H, OLED_LIT_RGB),
        OLED_W,
        OLED_H,
      );
      el.redraw();
    });
    return () => {
      cancelled = true;
    };
  }, [mono, outW, outH]);

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError(
        t(
          'tools.imageToCode.errorCopy',
          'Clipboard blocked. Select the code and copy it manually.',
        ),
      );
    }
  };

  const fitToPanel = () => {
    setOutW(OLED_W);
    setOutH(OLED_H);
    setScaleMode('fit');
    setCenter(true);
  };

  return (
    <div className="i2c-page">
      <AppHeader />
      <main className="i2c-main">
        <div className="i2c-intro">
          <h1>{t('tools.imageToCode.title', 'Image to C array for OLED displays')}</h1>
          <p>
            {t(
              'tools.imageToCode.intro',
              'Drop in a picture and get a monochrome C byte array you can paste straight into an Arduino sketch. Tune the threshold and dithering, then check the result on a simulated 128x64 SSD1306 before you flash it.',
            )}
          </p>
        </div>

        <div className="i2c-body">
          {/* ── left column: input + options ── */}
          <div>
            <section className="i2c-card">
              <h2>{t('tools.imageToCode.inputHeading', 'Image')}</h2>
              <button
                type="button"
                className={dragOver ? 'i2c-drop i2c-drop-over' : 'i2c-drop'}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const file = e.dataTransfer.files[0];
                  if (file) void loadFile(file);
                }}
              >
                <span className="i2c-drop-title">
                  {t('tools.imageToCode.dropTitle', 'Drop an image, or click to choose one')}
                </span>
                <span className="i2c-drop-hint">
                  {t(
                    'tools.imageToCode.dropHint',
                    'PNG, JPG, GIF, BMP, WebP or SVG. You can also paste one with Ctrl+V.',
                  )}
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT}
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void loadFile(file);
                  e.target.value = '';
                }}
              />
              {image && (
                <p className="i2c-file">
                  {t('tools.imageToCode.loaded', 'Loaded')}: {image.name} ({image.width}x
                  {image.height}px)
                </p>
              )}
              {error && <p className="i2c-error">{error}</p>}
            </section>

            <section className="i2c-card">
              <h2>{t('tools.imageToCode.optionsHeading', 'Options')}</h2>
              <div className="i2c-grid">
                <div className="i2c-field">
                  <label htmlFor="i2c-width">
                    {t('tools.imageToCode.width', 'Output width (px)')}
                  </label>
                  <input
                    id="i2c-width"
                    type="number"
                    min={1}
                    max={MAX_DIM}
                    value={outW}
                    onChange={(e) => setOutW(clampDim(Number(e.target.value)))}
                  />
                </div>
                <div className="i2c-field">
                  <label htmlFor="i2c-height">
                    {t('tools.imageToCode.height', 'Output height (px)')}
                  </label>
                  <input
                    id="i2c-height"
                    type="number"
                    min={1}
                    max={MAX_DIM}
                    value={outH}
                    onChange={(e) => setOutH(clampDim(Number(e.target.value)))}
                  />
                </div>

                <div className="i2c-field i2c-span">
                  <button type="button" className="i2c-btn" onClick={fitToPanel}>
                    {t('tools.imageToCode.fitButton', 'Fit to 128x64')}
                  </button>
                </div>

                <div className="i2c-field">
                  <label htmlFor="i2c-scale">
                    {t('tools.imageToCode.scaleMode', 'Scale mode')}
                  </label>
                  <select
                    id="i2c-scale"
                    value={scaleMode}
                    onChange={(e) => setScaleMode(e.target.value as ScaleMode)}
                  >
                    <option value="original">
                      {t('tools.imageToCode.scaleOriginal', 'Original size')}
                    </option>
                    <option value="fit">{t('tools.imageToCode.scaleFit', 'Scale to fit')}</option>
                    <option value="stretch">
                      {t('tools.imageToCode.scaleStretch', 'Stretch to fill')}
                    </option>
                  </select>
                </div>

                <div className="i2c-field">
                  <span className="i2c-legend">
                    {t('tools.imageToCode.placement', 'Placement')}
                  </span>
                  <label className="i2c-check">
                    <input
                      type="checkbox"
                      checked={center}
                      onChange={(e) => setCenter(e.target.checked)}
                    />
                    {t('tools.imageToCode.center', 'Centre on canvas')}
                  </label>
                </div>

                <div className="i2c-field i2c-span">
                  <label htmlFor="i2c-threshold">
                    {t('tools.imageToCode.threshold', 'Brightness threshold')}: {threshold}
                  </label>
                  <input
                    id="i2c-threshold"
                    type="range"
                    min={0}
                    max={255}
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                  />
                  <span className="i2c-hint">
                    {t(
                      'tools.imageToCode.thresholdHint',
                      'Pixels brighter than this are lit on the display.',
                    )}
                  </span>
                </div>

                <div className="i2c-field">
                  <label htmlFor="i2c-dither">{t('tools.imageToCode.dither', 'Dithering')}</label>
                  <select
                    id="i2c-dither"
                    value={dither}
                    onChange={(e) => setDither(e.target.value as DitherMode)}
                  >
                    <option value="none">{t('tools.imageToCode.ditherNone', 'None')}</option>
                    <option value="bayer">{t('tools.imageToCode.ditherBayer', 'Bayer 4x4')}</option>
                    <option value="floyd-steinberg">
                      {t('tools.imageToCode.ditherFloyd', 'Floyd-Steinberg')}
                    </option>
                    <option value="atkinson">
                      {t('tools.imageToCode.ditherAtkinson', 'Atkinson')}
                    </option>
                  </select>
                </div>

                <div className="i2c-field">
                  <span className="i2c-legend">
                    {t('tools.imageToCode.transform', 'Transform')}
                  </span>
                  <div className="i2c-checks">
                    <label className="i2c-check">
                      <input
                        type="checkbox"
                        checked={invert}
                        onChange={(e) => setInvert(e.target.checked)}
                      />
                      {t('tools.imageToCode.invert', 'Invert')}
                    </label>
                    <label className="i2c-check">
                      <input
                        type="checkbox"
                        checked={flipH}
                        onChange={(e) => setFlipH(e.target.checked)}
                      />
                      {t('tools.imageToCode.flipH', 'Flip H')}
                    </label>
                    <label className="i2c-check">
                      <input
                        type="checkbox"
                        checked={flipV}
                        onChange={(e) => setFlipV(e.target.checked)}
                      />
                      {t('tools.imageToCode.flipV', 'Flip V')}
                    </label>
                  </div>
                </div>

                <div className="i2c-field i2c-span">
                  <label htmlFor="i2c-drawmode">
                    {t('tools.imageToCode.drawMode', 'Draw mode')}
                  </label>
                  <select
                    id="i2c-drawmode"
                    value={drawMode}
                    onChange={(e) => setDrawMode(e.target.value as DrawMode)}
                  >
                    <option value="horizontal">
                      {t(
                        'tools.imageToCode.drawHorizontal',
                        'Horizontal (Adafruit GFX drawBitmap)',
                      )}
                    </option>
                    <option value="vertical">
                      {t('tools.imageToCode.drawVertical', 'Vertical (SSD1306 page buffer)')}
                    </option>
                  </select>
                  <span className="i2c-hint">
                    {drawMode === 'horizontal'
                      ? t(
                          'tools.imageToCode.drawHorizontalHint',
                          'One bit per pixel, most significant bit first, each row padded to a whole byte. This is what display.drawBitmap() expects.',
                        )
                      : t(
                          'tools.imageToCode.drawVerticalHint',
                          'One byte per column per 8-row page, bit 0 at the top. This is the raw SSD1306 display buffer layout.',
                        )}
                  </span>
                </div>

                <div className="i2c-field">
                  <label htmlFor="i2c-format">
                    {t('tools.imageToCode.format', 'Output format')}
                  </label>
                  <select
                    id="i2c-format"
                    value={format}
                    onChange={(e) => setFormat(e.target.value as OutputFormat)}
                  >
                    <option value="arduino">
                      {t('tools.imageToCode.formatArduino', 'Arduino PROGMEM array')}
                    </option>
                    <option value="plain">
                      {t('tools.imageToCode.formatPlain', 'Plain bytes')}
                    </option>
                  </select>
                </div>

                <div className="i2c-field">
                  <label htmlFor="i2c-name">
                    {t('tools.imageToCode.identifier', 'Array name')}
                  </label>
                  <input
                    id="i2c-name"
                    type="text"
                    value={name}
                    spellCheck={false}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
              </div>
            </section>
          </div>

          {/* ── right column: previews + output ── */}
          <div>
            <section className="i2c-card">
              <h2>{t('tools.imageToCode.previewHeading', 'Pixel preview')}</h2>
              <div className="i2c-preview-bed">
                <canvas
                  ref={previewRef}
                  className="i2c-preview-canvas"
                  width={outW}
                  height={outH}
                  style={{ width: `${Math.min(512, outW * 4)}px`, height: 'auto' }}
                />
              </div>
            </section>

            <section className="i2c-card">
              <h2>{t('tools.imageToCode.oledHeading', 'On a 128x64 SSD1306')}</h2>
              <div className="i2c-oled" id={OLED_HOST_ID} />
              <span className="i2c-hint">
                {t(
                  'tools.imageToCode.oledHint',
                  'The bitmap is centred on the panel, exactly as the simulator would render it.',
                )}
              </span>
            </section>

            <section className="i2c-card">
              <div className="i2c-output-head">
                <h2>{t('tools.imageToCode.outputHeading', 'C byte array')}</h2>
                <div className="i2c-output-actions">
                  <span className="i2c-bytes">
                    {bytes?.length ?? 0} {t('tools.imageToCode.bytes', 'bytes')}
                  </span>
                  <button
                    type="button"
                    className="i2c-btn i2c-btn-primary"
                    onClick={copy}
                    disabled={!code}
                  >
                    {copied
                      ? t('tools.imageToCode.copied', 'Copied')
                      : t('tools.imageToCode.copy', 'Copy')}
                  </button>
                </div>
              </div>
              <textarea
                className="i2c-code"
                readOnly
                spellCheck={false}
                value={code}
                placeholder={t(
                  'tools.imageToCode.outputPlaceholder',
                  'Add an image to generate the array.',
                )}
              />
              {drawMode === 'horizontal' && (
                <pre className="i2c-usage">
                  {`display.drawBitmap(0, 0, ${name || 'myBitmap'}, ${outW}, ${outH}, SSD1306_WHITE);`}
                </pre>
              )}
              <p className="i2c-credit">
                {t('tools.imageToCode.credit', 'Ported from image2cpp by javl, GPL-3.0')}:{' '}
                <a
                  href="https://github.com/javl/image2cpp"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  github.com/javl/image2cpp
                </a>
              </p>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
};
