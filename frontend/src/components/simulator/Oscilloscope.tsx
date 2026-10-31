/**
 * Oscilloscope / Logic Analyzer panel.
 *
 * Supports multiple boards: each channel is tied to a specific (boardId, pin)
 * pair, so D13 on board A and D13 on board B are tracked independently.
 *
 * Usage:
 *  - Click "+ Add Channel" → choose a board → choose a pin.
 *  - Adjust Time/div to zoom in or out.
 *  - Click Run / Pause to freeze the display without stopping the simulation.
 *  - Click Clear to wipe all captured samples.
 */

import React, { useRef, useEffect, useState, useCallback, useLayoutEffect, useMemo } from 'react';
import { cssVar } from '../../lib/theme';
import { useResolvedTheme } from '../../hooks/useTheme';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  useOscilloscopeStore,
  OSC_V_DIVS,
  type OscChannel,
  type OscSample,
  type TriggerMode,
  type TriggerEdge,
} from '../../store/useOscilloscopeStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { boardDisplayName } from '../../types/board';
import type { BoardKind } from '../../types/board';
import { boardPads } from '../../simulation/boardPads';
import { boardPinGroupFor } from '../../simulation/spice/boardPinGroups';
import './Oscilloscope.css';

// Horizontal divisions shown at once
const NUM_DIVS = 10;
/** Vertical divisions an analog channel's row spans. */
const NUM_V_DIVS = OSC_V_DIVS;

/** Time/div options shown in the selector */
const TIME_DIV_OPTIONS: { label: string; ms: number }[] = [
  { label: '0.1 ms', ms: 0.1 },
  { label: '0.5 ms', ms: 0.5 },
  { label: '1 ms', ms: 1 },
  { label: '5 ms', ms: 5 },
  { label: '10 ms', ms: 10 },
  { label: '50 ms', ms: 50 },
  { label: '100 ms', ms: 100 },
  { label: '500 ms', ms: 500 },
];

/**
 * Pins to offer for a board whose element is not mounted, so the picker still
 * has something to show. The mounted board answers for itself — see
 * simulation/boardPads, which is what every family here and every family this
 * list never heard of goes through.
 */
function fallbackPinsForBoardKind(boardKind: BoardKind): { pin: number; label: string }[] {
  switch (boardKind) {
    case 'arduino-mega':
      return [
        ...Array.from({ length: 54 }, (_, i) => ({ pin: i, label: `D${i}` })),
        ...Array.from({ length: 16 }, (_, i) => ({ pin: 54 + i, label: `A${i}` })),
      ];
    case 'attiny85':
      return Array.from({ length: 6 }, (_, i) => ({ pin: i, label: `D${i}` }));
    case 'raspberry-pi-pico':
    case 'pi-pico-w':
      return Array.from({ length: 29 }, (_, i) => ({ pin: i, label: `GP${i}` }));
    case 'esp32':
    case 'esp32-devkit-c-v4':
    case 'esp32-cam':
    case 'wemos-lolin32-lite':
      return Array.from({ length: 40 }, (_, i) => ({ pin: i, label: `GPIO${i}` }));
    case 'esp32-s3':
    case 'xiao-esp32-s3':
    case 'arduino-nano-esp32':
      return Array.from({ length: 45 }, (_, i) => ({ pin: i, label: `GPIO${i}` }));
    case 'esp32-c3':
    case 'xiao-esp32-c3':
    case 'aitewinrobot-esp32c3-supermini':
      return Array.from({ length: 22 }, (_, i) => ({ pin: i, label: `GPIO${i}` }));
    case 'raspberry-pi-3':
    case 'raspberry-pi-4':
    case 'raspberry-pi-5':
      return Array.from({ length: 28 }, (_, i) => ({ pin: i, label: `GPIO${i}` }));
    default:
      // arduino-uno, arduino-nano
      return [
        ...Array.from({ length: 14 }, (_, i) => ({ pin: i, label: `D${i}` })),
        ...Array.from({ length: 6 }, (_, i) => ({ pin: 14 + i, label: `A${i}` })),
      ];
  }
}

// ── Canvas rendering helpers ────────────────────────────────────────────────

/** Chrome colours for the scope's 2D canvases.
 *
 * A canvas cannot inherit a CSS custom property, so the grid, the axes and
 * the trigger cursor read their values from the token layer at draw time.
 * The channel TRACE colour is not in here on purpose — it comes from the
 * channel's own configuration and identifies the signal, so it stays put
 * across themes the way a probe's clip colour does.
 */
function scopeChrome() {
  return {
    grid: cssVar('--wb-2'),
    centre: cssVar('--wb-4'),
    zero: cssVar('--color-border-strong'),
    axisText: cssVar('--wb-10'),
    rulerLine: cssVar('--wb-7'),
    rulerText: cssVar('--wb-10'),
    trigger: cssVar('--color-feedback-warning'),
  };
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  samples: OscSample[],
  color: string,
  windowEndMs: number,
  windowMs: number,
  /**
   * Trigger marker — when not null, render a vertical orange line at this
   * X fraction (0..1) of the canvas to show where the trigger event
   * landed.  Mirrors the orange "T" cursor on a real Tektronix / Rigol.
   */
  triggerXFrac: number | null = null,
): void {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);

  const chrome = scopeChrome();

  // Background grid lines
  ctx.strokeStyle = chrome.grid;
  ctx.lineWidth = 1;
  for (let d = 0; d <= NUM_DIVS; d++) {
    const x = Math.round((d / NUM_DIVS) * width);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // Horizontal center guide
  ctx.strokeStyle = chrome.centre;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  // Trigger marker — drawn under the trace so the waveform sits on top.
  if (triggerXFrac !== null) {
    const x = Math.round(triggerXFrac * width);
    ctx.strokeStyle = chrome.trigger;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = chrome.trigger;
    ctx.font = 'bold 9px monospace';
    ctx.fillText('T', x + 2, 10);
  }

  if (samples.length === 0) return;

  const windowStartMs = windowEndMs - windowMs;
  const toX = (t: number) => ((t - windowStartMs) / windowMs) * width;
  const HIGH_Y = Math.round(height * 0.15);
  const LOW_Y = Math.round(height * 0.85);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  let initState = false;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].timeMs <= windowStartMs) {
      initState = samples[i].state;
      break;
    }
  }

  let currentY = initState ? HIGH_Y : LOW_Y;
  ctx.moveTo(0, currentY);

  for (const s of samples) {
    if (s.timeMs < windowStartMs) continue;
    if (s.timeMs > windowEndMs) break;

    const x = Math.max(0, Math.min(width, toX(s.timeMs)));
    const nextY = s.state ? HIGH_Y : LOW_Y;
    ctx.lineTo(x, currentY);
    ctx.lineTo(x, nextY);
    currentY = nextY;
  }

  ctx.lineTo(width, currentY);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = '9px monospace';
  ctx.fillText('H', width - 12, HIGH_Y + 3);
  ctx.fillText('L', width - 12, LOW_Y + 3);
}

/**
 * Draw one analog channel: a continuous trace on a volts axis.
 *
 * Not the digital step function with a different colour — an analog capture is
 * a dense block of samples where consecutive points can land on the same pixel
 * column, so the trace is drawn as a polyline and collapsed to a vertical
 * min/max bar wherever more than one sample shares a column. Plotting only
 * every Nth point instead would silently smooth away exactly the spikes a
 * scope exists to show.
 *
 * The vertical mapping is the scope's own: `voltsPerDiv` per division over
 * NUM_V_DIVS divisions, centred on `yOffsetV`, so a 3.3 V trace and a 5 V
 * square wave can share one row honestly.
 */
function drawAnalogWaveform(
  canvas: HTMLCanvasElement,
  samples: OscSample[],
  color: string,
  windowEndMs: number,
  windowMs: number,
  voltsPerDiv: number,
  yOffsetV: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas.getBoundingClientRect();
  if (samples.length === 0) return;

  const chrome = scopeChrome();
  const windowStartMs = windowEndMs - windowMs;
  const toX = (t: number) => ((t - windowStartMs) / windowMs) * width;
  const spanV = voltsPerDiv * NUM_V_DIVS;
  // Volts increase upward; y grows downward.
  const toY = (v: number) => height / 2 - ((v - yOffsetV) / spanV) * height;

  // Zero-volt reference, so the reader can see where ground sits.
  const zeroY = toY(0);
  if (zeroY > 0 && zeroY < height) {
    ctx.strokeStyle = chrome.zero;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(width, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  let started = false;
  let col = -1;
  let colMin = 0;
  let colMax = 0;

  const flushColumn = () => {
    if (col < 0) return;
    const yA = toY(colMax);
    const yB = toY(colMin);
    if (!started) {
      ctx.moveTo(col, yA);
      started = true;
    } else {
      ctx.lineTo(col, yA);
    }
    if (yB !== yA) ctx.lineTo(col, yB);
  };

  for (const smp of samples) {
    if (smp.volts === undefined) continue;
    if (smp.timeMs < windowStartMs || smp.timeMs > windowEndMs) continue;
    const x = Math.round(Math.max(0, Math.min(width, toX(smp.timeMs))));
    if (x !== col) {
      flushColumn();
      col = x;
      colMin = smp.volts;
      colMax = smp.volts;
    } else {
      if (smp.volts < colMin) colMin = smp.volts;
      if (smp.volts > colMax) colMax = smp.volts;
    }
  }
  flushColumn();
  if (started) ctx.stroke();

  // Volts axis: the top and bottom of the visible span, plus the centre.
  ctx.fillStyle = chrome.axisText;
  ctx.font = '9px monospace';
  const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));
  ctx.fillText(`${fmt(yOffsetV + spanV / 2)}V`, 2, 9);
  ctx.fillText(`${fmt(yOffsetV)}V`, 2, height / 2 + 3);
  ctx.fillText(`${fmt(yOffsetV - spanV / 2)}V`, 2, height - 3);
}

function drawRuler(
  canvas: HTMLCanvasElement,
  windowEndMs: number,
  windowMs: number,
  timeDivMs: number,
): void {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);
  const chrome = scopeChrome();
  ctx.strokeStyle = chrome.rulerLine;
  ctx.fillStyle = chrome.rulerText;
  ctx.font = '9px monospace';
  ctx.lineWidth = 1;

  const windowStartMs = windowEndMs - windowMs;

  for (let d = 0; d <= NUM_DIVS; d++) {
    const timeAtDiv = windowStartMs + d * timeDivMs;
    const x = Math.round((d / NUM_DIVS) * width);

    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 5);
    ctx.stroke();

    const absMs = Math.abs(timeAtDiv);
    const label =
      absMs >= 1000
        ? `${(timeAtDiv / 1000).toFixed(1)}s`
        : `${timeAtDiv.toFixed(absMs < 1 ? 2 : 1)}ms`;

    if (d < NUM_DIVS) {
      ctx.fillText(label, x + 2, height - 3);
    }
  }
}

// ── Channel canvas ──────────────────────────────────────────────────────────

interface ChannelCanvasProps {
  channel: OscChannel;
  samples: OscSample[];
  windowEndMs: number;
  windowMs: number;
  /** X fraction (0..1) of the trigger marker, or null when no marker should
   *  be drawn (e.g. auto mode or the trigger event is outside the window). */
  triggerXFrac: number | null;
}

const ChannelCanvas: React.FC<ChannelCanvasProps> = ({
  channel,
  samples,
  windowEndMs,
  windowMs,
  triggerXFrac,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const { width, height } = wrap.getBoundingClientRect();
    if (width === 0 || height === 0) return;

    canvas.width = Math.floor(width) * window.devicePixelRatio;
    canvas.height = Math.floor(height) * window.devicePixelRatio;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    // Two genuinely different traces: a GPIO channel is a step function
    // between two fixed rails, an analog one is a continuous curve on a volts
    // axis. Drawing the latter with the former's H/L mapping would flatten
    // every waveform into a square wave.
    if (channel.kind === 'analog') {
      drawAnalogWaveform(
        canvas, samples, channel.color, windowEndMs, windowMs,
        channel.voltsPerDiv, channel.yOffsetV,
      );
    } else {
      drawWaveform(canvas, samples, channel.color, windowEndMs, windowMs, triggerXFrac);
    }
    // `theme` is not read inside the effect — scopeChrome() picks the new
    // values up on its own — but it belongs in the deps so a stopped scope
    // still repaints its grid when the user switches appearance.
  }, [
    samples, channel.color, channel.kind, windowEndMs, windowMs, triggerXFrac,
    channel.kind === 'analog' ? channel.voltsPerDiv : 0,
    channel.kind === 'analog' ? channel.yOffsetV : 0,
    theme,
  ]);

  return (
    <div ref={wrapRef} className="osc-channel-canvas-wrap">
      <canvas ref={canvasRef} className="osc-channel-canvas" />
    </div>
  );
};

// ── Ruler canvas ─────────────────────────────────────────────────────────────

interface RulerCanvasProps {
  windowEndMs: number;
  windowMs: number;
  timeDivMs: number;
}

const RulerCanvas: React.FC<RulerCanvasProps> = ({ windowEndMs, windowMs, timeDivMs }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const { width, height } = wrap.getBoundingClientRect();
    if (width === 0 || height === 0) return;

    canvas.width = Math.floor(width) * window.devicePixelRatio;
    canvas.height = Math.floor(height) * window.devicePixelRatio;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    drawRuler(canvas, windowEndMs, windowMs, timeDivMs);
  }, [windowEndMs, windowMs, timeDivMs, theme]);

  return (
    <div ref={wrapRef} className="osc-ruler">
      <canvas ref={canvasRef} className="osc-ruler-canvas" />
    </div>
  );
};

// ── Channel picker (two-step: board → pin) ───────────────────────────────────

interface ChannelPickerProps {
  onAdd: (boardId: string, pin: number, pinLabel: string) => void;
  activeChannels: OscChannel[];
  onClose: () => void;
  anchorRect: DOMRect;
  dropdownRef: React.RefObject<HTMLDivElement>;
}

const ChannelPicker: React.FC<ChannelPickerProps> = ({
  onAdd,
  activeChannels,
  onClose,
  anchorRect,
  dropdownRef,
}) => {
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const [selectedBoardId, setSelectedBoardId] = useState<string>(
    activeBoardId ?? boards[0]?.id ?? '',
  );

  const selectedBoard = boards.find((b) => b.id === selectedBoardId) ?? boards[0];
  // Ask the board on the canvas what pads it has; the static list is only for
  // a board that is not rendered (it knows a handful of families and answers
  // the Uno's pins for the rest).
  const pins = useMemo(() => {
    if (!selectedBoard) return [];
    const pads = boardPads(selectedBoard.id, selectedBoard.boardKind);
    return pads.length > 0 ? pads : fallbackPinsForBoardKind(selectedBoard.boardKind);
  }, [selectedBoard]);

  const activePinsForBoard = new Set(
    activeChannels
      .filter((c) => c.kind === 'digital' && c.boardId === selectedBoardId)
      .map((c) => (c as { pin: number }).pin),
  );

  // Open upward from the anchor button, fixed in the viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: anchorRect.left,
    bottom: window.innerHeight - anchorRect.top + 4,
    zIndex: 9999,
  };

  return ReactDOM.createPortal(
    <div ref={dropdownRef} className="osc-picker-dropdown osc-picker-multiboard" style={style}>
      {/* Board tabs */}
      <div className="osc-picker-board-tabs">
        {boards.map((b) => (
          <button
            key={b.id}
            className={`osc-picker-board-tab${b.id === selectedBoard?.id ? ' active' : ''}`}
            onClick={() => setSelectedBoardId(b.id)}
            title={boardDisplayName(b)}
          >
            {boardDisplayName(b)}
          </button>
        ))}
      </div>

      {/* Board label */}
      {selectedBoard && (
        <div className="osc-picker-board-label">{boardDisplayName(selectedBoard)}</div>
      )}

      {/* Pin grid */}
      <div className="osc-picker-pins">
        {pins.map(({ pin, label }) => {
          const added = activePinsForBoard.has(pin);
          return (
            <button
              key={pin}
              className={`osc-pin-btn${added ? ' osc-pin-btn-active' : ''}`}
              onClick={() => {
                if (!added) {
                  onAdd(selectedBoardId, pin, label);
                  onClose();
                }
              }}
              title={added ? 'Already added' : `Monitor ${label}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
};

// ── Main component ─────────────────────────────────────────────────────────

export const Oscilloscope: React.FC = () => {
  const { t } = useTranslation();
  const {
    running: capturing,
    timeDivMs,
    channels,
    samples,
    setCapturing,
    setTimeDivMs,
    addChannel,
    removeChannel,
    clearSamples,
    triggerMode,
    triggerChannelId,
    triggerEdge,
    triggerPosition,
    triggeredAtMs,
    triggerStatus,
    setTriggerMode,
    setTriggerChannel,
    setTriggerEdge,
    rearmTrigger,
  } = useOscilloscopeStore();

  // Any board running → oscilloscope can capture
  const anyRunning = useSimulatorStore((s) => s.boards.some((b) => b.running));

  const [showPicker, setShowPicker] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const handleTogglePicker = () => {
    if (showPicker) {
      setShowPicker(false);
      setPickerAnchor(null);
    } else {
      const rect = addBtnRef.current?.getBoundingClientRect() ?? null;
      setPickerAnchor(rect);
      setShowPicker(true);
    }
  };

  // Close picker on outside click (checks both the button and the portal dropdown)
  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inBtn = addBtnRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inBtn && !inDropdown) {
        setShowPicker(false);
        setPickerAnchor(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPicker]);

  // ── Display window ──────────────────────────────────────────────────────
  const [, forceRedraw] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (anyRunning && capturing) {
      const tick = () => {
        forceRedraw((n) => n + 1);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      };
    }
  }, [anyRunning, capturing]);

  const windowMs = NUM_DIVS * timeDivMs;

  // ── Window positioning ─────────────────────────────────────────────────
  // Auto mode: window's right edge tracks the most recent sample across
  // all channels (free-running).  Normal / single mode with a latched
  // trigger: pin the window around the trigger event so it lands at
  // `triggerPosition * windowMs` from the left.  Normal / single mode
  // with NO trigger yet: fall back to free-running so the user can still
  // see what's happening while waiting for the first edge.
  let windowEndMs = 0;
  if (triggerMode !== 'auto' && triggeredAtMs !== null) {
    windowEndMs = triggeredAtMs + (1 - triggerPosition) * windowMs;
  } else {
    for (const ch of channels) {
      const buf = samples[ch.id] ?? [];
      if (buf.length > 0) {
        windowEndMs = Math.max(windowEndMs, buf[buf.length - 1].timeMs);
      }
    }
  }
  windowEndMs = Math.max(windowEndMs, windowMs);

  // X fraction (0..1) of the trigger marker within the visible window.
  // null = no marker (auto mode or trigger event outside the window).
  let triggerXFrac: number | null = null;
  if (triggerMode !== 'auto' && triggeredAtMs !== null) {
    const windowStartMs = windowEndMs - windowMs;
    if (triggeredAtMs >= windowStartMs && triggeredAtMs <= windowEndMs) {
      triggerXFrac = (triggeredAtMs - windowStartMs) / windowMs;
    }
  }

  const handleAddChannel = useCallback(
    (boardId: string, pin: number, pinLabel: string) => {
      // The square wave has to sit at the board's own logic level: the default
      // is 5 V, which drew every 3.3 V board's trace at the wrong height on a
      // volts axis it may be sharing with an analog probe. Same source the wire
      // probe uses (probeResolve's vccOf).
      const board = useSimulatorStore.getState().boards.find((b) => b.id === boardId);
      const amplitudeV = board ? boardPinGroupFor(board.boardKind).vcc : undefined;
      addChannel(boardId, pin, pinLabel, amplitudeV);
    },
    [addChannel],
  );

  /** What to show in the channel's source column: the board for a GPIO
   *  channel, a net marker for an analog one. */
  const channelSource = (c: OscChannel): string =>
    c.kind === 'digital' ? boardShortName(c.boardId) : 'net';

  // Short display name for a board id — strip leading "arduino-", "raspberry-pi-", etc.
  const boardShortName = (boardId: string) => {
    const parts = boardId.split('-');
    // If numeric suffix like "arduino-uno-2", keep the suffix
    const last = parts[parts.length - 1];
    const isNum = /^\d+$/.test(last);
    if (isNum && parts.length >= 2) {
      return `${parts[parts.length - 2]}-${last}`;
    }
    return last;
  };

  return (
    <div className="osc-container">
      {/* ── Header ── */}
      <div className="osc-header">
        <span className="osc-title">{t('editor.oscilloscope.title')}</span>

        {/* Add Channel button + portal picker */}
        <button
          ref={addBtnRef}
          className="osc-btn"
          onClick={handleTogglePicker}
          title={t('editor.oscilloscope.addChannelTitle')}
        >
          + {t('editor.oscilloscope.addChannel')}
        </button>

        {showPicker && pickerAnchor && (
          <ChannelPicker
            onAdd={handleAddChannel}
            activeChannels={channels}
            onClose={() => {
              setShowPicker(false);
              setPickerAnchor(null);
            }}
            anchorRect={pickerAnchor}
            dropdownRef={dropdownRef}
          />
        )}

        {/* Time / div */}
        <span className="osc-label">{t('editor.oscilloscope.timeDiv')}</span>
        <select
          className="osc-select"
          value={timeDivMs}
          onChange={(e) => setTimeDivMs(Number(e.target.value))}
        >
          {TIME_DIV_OPTIONS.map(({ label, ms }) => (
            <option key={ms} value={ms}>
              {label}
            </option>
          ))}
        </select>

        {/* Run / Pause */}
        <button
          className={`osc-btn${capturing ? '' : ' osc-btn-active'}`}
          onClick={() => setCapturing(!capturing)}
          title={capturing ? t('editor.oscilloscope.pauseTitle') : t('editor.oscilloscope.resumeTitle')}
        >
          {capturing ? `⏸ ${t('editor.oscilloscope.pause')}` : `▶ ${t('editor.oscilloscope.run')}`}
        </button>

        {/* ── Trigger ─────────────────────────────────────────────────────
            Mode + source + edge are the three knobs a real DSO exposes.
            Auto = free-running (current default).  Normal = window pins
            on every triggering edge.  Single = arm once, freeze on first
            edge — click again to re-arm. */}
        <span className="osc-label" title="Trigger configuration">Trigger</span>
        <select
          className="osc-select"
          value={triggerMode}
          onChange={(e) => setTriggerMode(e.target.value as TriggerMode)}
          title="Trigger mode"
        >
          <option value="auto">Auto</option>
          <option value="normal">Normal</option>
          <option value="single">Single</option>
        </select>

        {triggerMode !== 'auto' && (
          <>
            <select
              className="osc-select"
              value={triggerChannelId ?? channels[0]?.id ?? ''}
              onChange={(e) => setTriggerChannel(e.target.value || null)}
              title="Trigger source"
              disabled={channels.length <= 1}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {channelSource(c)}:{c.label}
                </option>
              ))}
            </select>

            <select
              className="osc-select"
              value={triggerEdge}
              onChange={(e) => setTriggerEdge(e.target.value as TriggerEdge)}
              title="Trigger edge"
            >
              <option value="rising">↑ Rising</option>
              <option value="falling">↓ Falling</option>
              <option value="either">⇅ Either</option>
            </select>

            <span
              className={`osc-trigger-status osc-trigger-status-${triggerStatus}`}
              title={`Trigger status: ${triggerStatus}`}
            >
              {triggerStatus === 'armed' && 'Armed'}
              {triggerStatus === 'triggered' && 'Triggered'}
              {triggerStatus === 'captured' && 'Captured'}
              {triggerStatus === 'idle' && 'Idle'}
            </span>

            {triggerMode === 'single' && triggerStatus === 'captured' && (
              <button
                className="osc-btn osc-btn-active"
                onClick={rearmTrigger}
                title="Re-arm and capture the next triggering edge"
              >
                Re-arm
              </button>
            )}
          </>
        )}

        {/* Clear */}
        <button
          className="osc-btn osc-btn-danger"
          onClick={clearSamples}
          title={t('editor.oscilloscope.clearTitle')}
        >
          {t('editor.oscilloscope.clear')}
        </button>
      </div>

      {/* ── Waveforms ── */}
      {channels.length === 0 ? (
        <div className="osc-empty">
          <span>{t('editor.oscilloscope.noChannels')}</span>
          <span style={{ color: 'var(--wb-9)' }}>{t('editor.oscilloscope.noChannelsHint')}</span>
        </div>
      ) : (
        <>
          <div className="osc-waveforms">
            {channels.map((ch) => (
              <div key={ch.id} className="osc-channel-row">
                <div className="osc-channel-label">
                  <span
                    className="osc-channel-board"
                    title={ch.kind === 'digital' ? ch.boardId : `net ${ch.netName}`}
                  >
                    {channelSource(ch)}
                  </span>
                  <span className="osc-channel-name" style={{ color: ch.color }}>
                    {ch.label}
                  </span>
                  <button
                    className="osc-channel-remove"
                    onClick={() => removeChannel(ch.id)}
                    title={t('editor.oscilloscope.removeChannel', { label: ch.label })}
                  >
                    ×
                  </button>
                </div>

                <ChannelCanvas
                  channel={ch}
                  samples={samples[ch.id] ?? []}
                  windowEndMs={windowEndMs}
                  windowMs={windowMs}
                  triggerXFrac={triggerXFrac}
                />
              </div>
            ))}
          </div>

          <RulerCanvas windowEndMs={windowEndMs} windowMs={windowMs} timeDivMs={timeDivMs} />
        </>
      )}
    </div>
  );
};
