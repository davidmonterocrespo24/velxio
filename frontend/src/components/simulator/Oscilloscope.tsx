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

import { DropdownSelect } from '../ui/DropdownSelect';
import React, { useRef, useEffect, useState, useCallback, useLayoutEffect, useMemo } from 'react';
import { useResolvedTheme } from '../../hooks/useTheme';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  useOscilloscopeStore,
  OSC_V_DIVS,
  displayShiftV,
  type OscChannel,
  type OscAnalogChannel,
  type OscSample,
  type TriggerMode,
  type TriggerEdge,
} from '../../store/useOscilloscopeStore';
import { parseValue } from '../../simulation/spice/valueParser';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { boardDisplayName } from '../../types/board';
import type { BoardKind } from '../../types/board';
import { boardPads } from '../../simulation/boardPads';
import { boardPinGroupFor } from '../../simulation/spice/boardPinGroups';
import {
  NUM_DIVS,
  prepareCanvas,
  drawWaveform,
  drawAnalogWaveform,
  drawRuler,
  formatVoltsPerDiv,
} from './oscilloscopeDraw';
import './Oscilloscope.css';

/** Vertical divisions an analog channel's row spans. */
const NUM_V_DIVS = OSC_V_DIVS;

/** V/div steps an analog channel can be set to by hand (1-2-5, as on a bench
 *  scope); "Auto" fits each capture instead. */
const VOLTS_DIV_OPTIONS = [
  0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20,
];

/**
 * A number typed into the scope's header: a voltage, read with the app's value
 * parser ("4.83", "500m", "-1.2"). The text is the user's while they type and
 * is committed on Enter or on leaving the field; an unreadable text goes back
 * to the value it had. With `allowEmpty`, an empty field commits null.
 */
const VoltsField: React.FC<{
  value: number | null;
  onCommit: (value: number | null) => void;
  allowEmpty?: boolean;
  className: string;
  title: string;
  placeholder?: string;
}> = ({ value, onCommit, allowEmpty = false, className, title, placeholder }) => {
  const shown = value === null ? '' : String(Number(value.toPrecision(6)));
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (text === '') {
      if (allowEmpty) onCommit(null);
      return;
    }
    const parsed = parseValue(text);
    if (parsed.ok && Number.isFinite(parsed.value)) onCommit(parsed.value);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      className={`osc-input ${className}`}
      value={draft ?? shown}
      placeholder={placeholder}
      title={title}
      aria-label={title}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
};

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
  const isAnalog = channel.kind === 'analog';
  const { color, voltsPerDiv, yOffsetV } = channel;
  // What an analog row draws besides its samples: the mean AC coupling takes
  // away, and its scale, written in the row ("500mV/div AC").
  const shiftV = displayShiftV(channel);
  const scaleText = isAnalog
    ? `${formatVoltsPerDiv(voltsPerDiv)}/div${channel.coupling === 'ac' ? ' AC' : ''}`
    : null;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    // Drawn in CSS pixels on a context scaled to the backing store
    // (prepareCanvas), whatever the devicePixelRatio.
    const { width, height } = wrap.getBoundingClientRect();
    const size = { width, height };
    const ctx = prepareCanvas(canvas, size);
    if (!ctx) return;
    // Two genuinely different traces: a GPIO channel is a step function
    // between two fixed rails, an analog one is a continuous curve on a volts
    // axis. Drawing the latter with the former's H/L mapping would flatten
    // every waveform into a square wave.
    if (isAnalog) {
      drawAnalogWaveform(
        ctx, size, samples, color, windowEndMs, windowMs,
        voltsPerDiv, yOffsetV, NUM_V_DIVS, triggerXFrac, shiftV, scaleText,
      );
    } else {
      drawWaveform(ctx, size, samples, color, windowEndMs, windowMs, triggerXFrac);
    }
    // `theme` is not read inside the effect — scopeChrome() picks the new
    // values up on its own — but it belongs in the deps so a stopped scope
    // still repaints its grid when the user switches appearance.
  }, [
    samples, color, isAnalog, windowEndMs, windowMs, triggerXFrac,
    voltsPerDiv, yOffsetV, shiftV, scaleText, theme,
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
    const size = { width, height };
    const ctx = prepareCanvas(canvas, size);
    if (!ctx) return;
    drawRuler(ctx, size, windowEndMs, windowMs, timeDivMs);
  }, [windowEndMs, windowMs, timeDivMs, theme]);

  // The ruler is a row like the channels': a cell as wide as their label
  // column, then the drawing area, so its ticks fall on the traces' time
  // divisions. Spanning the whole panel put tick 0 under the labels and
  // drifted 72 px to 0 across the screen (velxio/velxio-prod#115).
  return (
    <div className="osc-ruler">
      <div className="osc-ruler-spacer" />
      <div ref={wrapRef} className="osc-ruler-canvas-wrap">
        <canvas ref={canvasRef} className="osc-ruler-canvas" />
      </div>
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
    triggerLevelV,
    setTriggerLevelV,
    setChannelVoltsPerDiv,
    setChannelOffset,
    setChannelAutoScale,
    setChannelCoupling,
  } = useOscilloscopeStore();

  // The vertical controls act on one analog channel at a time, as a bench
  // scope's knobs act on the selected channel; the first one by default.
  const analogChannels = channels.filter((c): c is OscAnalogChannel => c.kind === 'analog');
  const [vChannelId, setVChannelId] = useState<string | null>(null);
  const vChannel = analogChannels.find((c) => c.id === vChannelId) ?? analogChannels[0];
  // The channel the trigger listens on (the first one unless one is picked).
  const triggerChannel = channels.find((c) => c.id === triggerChannelId) ?? channels[0];

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
  /** Its tooltip: the board, or the net and the part pin it was probed at
   *  (which the channel follows when an edit renumbers the nets). */
  const channelSourceTitle = (c: OscChannel): string =>
    c.kind === 'digital'
      ? c.boardId
      : c.probe
        ? `net ${c.netName} · ${c.probe.componentId}:${c.probe.pinName}`
        : `net ${c.netName}`;

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
        <DropdownSelect
          className="osc-select"
          value={timeDivMs}
          onValueChange={(value) => setTimeDivMs(Number(value))}
        >
          {TIME_DIV_OPTIONS.map(({ label, ms }) => (
            <option key={ms} value={ms}>
              {label}
            </option>
          ))}
        </DropdownSelect>

        {/* ── Vertical: V/div, offset and coupling of an analog channel ──
            Auto fits each capture (with 0 V in view under DC coupling); a
            V/div or an offset typed here fixes the scale until Auto is
            chosen again (velxio/velxio-prod#114). */}
        {vChannel && (
          <>
            <span className="osc-label">{t('editor.oscilloscope.voltsDiv')}</span>
            {analogChannels.length > 1 && (
              <DropdownSelect
                className="osc-select osc-vchannel"
                value={vChannel.id}
                onValueChange={(value) => setVChannelId(value)}
                title={t('editor.oscilloscope.vChannelTitle')}
                aria-label={t('editor.oscilloscope.vChannelTitle')}
              >
                {analogChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </DropdownSelect>
            )}
            <DropdownSelect
              className="osc-select osc-vdiv"
              value={vChannel.autoScale === false ? String(vChannel.voltsPerDiv) : 'auto'}
              onValueChange={(value) =>
                value === 'auto'
                  ? setChannelAutoScale(vChannel.id)
                  : setChannelVoltsPerDiv(vChannel.id, Number(value))
              }
              title={t('editor.oscilloscope.voltsDivTitle')}
              aria-label={t('editor.oscilloscope.voltsDivTitle')}
            >
              <option value="auto">
                {t('editor.oscilloscope.auto')} ({formatVoltsPerDiv(vChannel.voltsPerDiv)})
              </option>
              {VOLTS_DIV_OPTIONS.concat(
                vChannel.autoScale === false && !VOLTS_DIV_OPTIONS.includes(vChannel.voltsPerDiv)
                  ? [vChannel.voltsPerDiv]
                  : [],
              ).map((v) => (
                <option key={v} value={String(v)}>
                  {formatVoltsPerDiv(v)}
                </option>
              ))}
            </DropdownSelect>
            <span className="osc-label">{t('editor.oscilloscope.offset')}</span>
            <VoltsField
              className="osc-offset"
              value={vChannel.yOffsetV}
              onCommit={(v) => v !== null && setChannelOffset(vChannel.id, v)}
              title={t('editor.oscilloscope.offsetTitle')}
            />
            <button
              className={`osc-btn osc-coupling${vChannel.coupling === 'ac' ? ' osc-btn-active' : ''}`}
              onClick={() =>
                setChannelCoupling(vChannel.id, vChannel.coupling === 'ac' ? 'dc' : 'ac')
              }
              title={t('editor.oscilloscope.couplingTitle')}
              aria-label={t('editor.oscilloscope.couplingTitle')}
            >
              {vChannel.coupling === 'ac' ? 'AC' : 'DC'}
            </button>
          </>
        )}

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
        <DropdownSelect
          className="osc-select"
          value={triggerMode}
          onValueChange={(value) => setTriggerMode(value as TriggerMode)}
          title="Trigger mode"
        >
          <option value="auto">Auto</option>
          <option value="normal">Normal</option>
          <option value="single">Single</option>
        </DropdownSelect>

        {triggerMode !== 'auto' && (
          <>
            <DropdownSelect
              className="osc-select"
              value={triggerChannelId ?? channels[0]?.id ?? ''}
              onValueChange={(value) => setTriggerChannel(value || null)}
              title="Trigger source"
              disabled={channels.length <= 1}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {channelSource(c)}:{c.label}
                </option>
              ))}
            </DropdownSelect>

            <DropdownSelect
              className="osc-select"
              value={triggerEdge}
              onValueChange={(value) => setTriggerEdge(value as TriggerEdge)}
              title="Trigger edge"
            >
              <option value="rising">↑ Rising</option>
              <option value="falling">↓ Falling</option>
              <option value="either">⇅ Either</option>
            </DropdownSelect>

            {/* An analog source crosses a level; empty is the middle of each
                capture, so any signal that moves triggers. */}
            {triggerChannel?.kind === 'analog' && (
              <>
                <span className="osc-label">{t('editor.oscilloscope.triggerLevel')}</span>
                <VoltsField
                  className="osc-trigger-level"
                  value={triggerLevelV}
                  allowEmpty
                  placeholder={t('editor.oscilloscope.auto')}
                  onCommit={setTriggerLevelV}
                  title={t('editor.oscilloscope.triggerLevelTitle')}
                />
              </>
            )}

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
              <div
                key={ch.id}
                className={`osc-channel-row${ch.kind === 'analog' && ch.lost ? ' osc-channel-lost' : ''}`}
              >
                <div className="osc-channel-label">
                  <span className="osc-channel-board" title={channelSourceTitle(ch)}>
                    {channelSource(ch)}
                  </span>
                  <span
                    className="osc-channel-name"
                    style={{ color: ch.color }}
                    title={
                      ch.kind === 'analog' && ch.lost
                        ? t('editor.oscilloscope.probeLost')
                        : undefined
                    }
                  >
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
