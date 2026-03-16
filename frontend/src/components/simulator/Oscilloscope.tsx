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

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  useLayoutEffect,
} from 'react';
import ReactDOM from 'react-dom';
import { useOscilloscopeStore, type OscChannel, type OscSample } from '../../store/useOscilloscopeStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { BOARD_KIND_LABELS } from '../../types/board';
import type { BoardKind } from '../../types/board';
import './Oscilloscope.css';

// Horizontal divisions shown at once
const NUM_DIVS = 10;

/** Time/div options shown in the selector */
const TIME_DIV_OPTIONS: { label: string; ms: number }[] = [
  { label: '0.1 ms', ms: 0.1 },
  { label: '0.5 ms', ms: 0.5 },
  { label: '1 ms',   ms: 1 },
  { label: '5 ms',   ms: 5 },
  { label: '10 ms',  ms: 10 },
  { label: '50 ms',  ms: 50 },
  { label: '100 ms', ms: 100 },
  { label: '500 ms', ms: 500 },
];

/** Return the list of monitorable pins for a given board kind */
function getPinsForBoardKind(boardKind: BoardKind): { pin: number; label: string }[] {
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
    case 'riscv-generic':
      return Array.from({ length: 20 }, (_, i) => ({ pin: i, label: `D${i}` }));
    case 'raspberry-pi-3':
      return Array.from({ length: 28 }, (_, i) => ({ pin: i, label: `GPIO${i}` }));
    default:
      // arduino-uno, arduino-nano
      return [
        ...Array.from({ length: 14 }, (_, i) => ({ pin: i, label: `D${i}` })),
        ...Array.from({ length: 6  }, (_, i) => ({ pin: 14 + i, label: `A${i}` })),
      ];
  }
}

// ── Canvas rendering helpers ────────────────────────────────────────────────

function drawWaveform(
  canvas: HTMLCanvasElement,
  samples: OscSample[],
  color: string,
  windowEndMs: number,
  windowMs: number,
): void {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);

  // Background grid lines
  ctx.strokeStyle = '#1e1e1e';
  ctx.lineWidth = 1;
  for (let d = 0; d <= NUM_DIVS; d++) {
    const x = Math.round((d / NUM_DIVS) * width);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // Horizontal center guide
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  if (samples.length === 0) return;

  const windowStartMs = windowEndMs - windowMs;
  const toX = (t: number) => ((t - windowStartMs) / windowMs) * width;
  const HIGH_Y = Math.round(height * 0.15);
  const LOW_Y  = Math.round(height * 0.85);

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
  ctx.strokeStyle = '#444';
  ctx.fillStyle = '#888';
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
    const label = absMs >= 1000
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
}

const ChannelCanvas: React.FC<ChannelCanvasProps> = ({
  channel, samples, windowEndMs, windowMs,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef  = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const { width, height } = wrap.getBoundingClientRect();
    if (width === 0 || height === 0) return;

    canvas.width  = Math.floor(width)  * window.devicePixelRatio;
    canvas.height = Math.floor(height) * window.devicePixelRatio;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    drawWaveform(canvas, samples, channel.color, windowEndMs, windowMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, channel.color, windowEndMs, windowMs]);

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

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const { width, height } = wrap.getBoundingClientRect();
    if (width === 0 || height === 0) return;

    canvas.width  = Math.floor(width)  * window.devicePixelRatio;
    canvas.height = Math.floor(height) * window.devicePixelRatio;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    drawRuler(canvas, windowEndMs, windowMs, timeDivMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowEndMs, windowMs, timeDivMs]);

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
  onAdd, activeChannels, onClose, anchorRect, dropdownRef,
}) => {
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const [selectedBoardId, setSelectedBoardId] = useState<string>(
    activeBoardId ?? boards[0]?.id ?? '',
  );

  const selectedBoard = boards.find((b) => b.id === selectedBoardId) ?? boards[0];
  const pins = selectedBoard ? getPinsForBoardKind(selectedBoard.boardKind) : [];

  const activePinsForBoard = new Set(
    activeChannels.filter((c) => c.boardId === selectedBoardId).map((c) => c.pin),
  );

  // Open upward from the anchor button, fixed in the viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: anchorRect.left,
    bottom: window.innerHeight - anchorRect.top + 4,
    zIndex: 9999,
  };

  return ReactDOM.createPortal(
    <div
      ref={dropdownRef}
      className="osc-picker-dropdown osc-picker-multiboard"
      style={style}
    >
      {/* Board tabs */}
      <div className="osc-picker-board-tabs">
        {boards.map((b) => (
          <button
            key={b.id}
            className={`osc-picker-board-tab${b.id === selectedBoard?.id ? ' active' : ''}`}
            onClick={() => setSelectedBoardId(b.id)}
            title={BOARD_KIND_LABELS[b.boardKind]}
          >
            {b.id}
          </button>
        ))}
      </div>

      {/* Board label */}
      {selectedBoard && (
        <div className="osc-picker-board-label">
          {BOARD_KIND_LABELS[selectedBoard.boardKind]}
        </div>
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

  let windowEndMs = 0;
  for (const ch of channels) {
    const buf = samples[ch.id] ?? [];
    if (buf.length > 0) {
      windowEndMs = Math.max(windowEndMs, buf[buf.length - 1].timeMs);
    }
  }
  windowEndMs = Math.max(windowEndMs, windowMs);

  const handleAddChannel = useCallback((boardId: string, pin: number, pinLabel: string) => {
    addChannel(boardId, pin, pinLabel);
  }, [addChannel]);

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
        <span className="osc-title">Oscilloscope</span>

        {/* Add Channel button + portal picker */}
        <button
          ref={addBtnRef}
          className="osc-btn"
          onClick={handleTogglePicker}
          title="Add a pin channel"
        >
          + Add Channel
        </button>

        {showPicker && pickerAnchor && (
          <ChannelPicker
            onAdd={handleAddChannel}
            activeChannels={channels}
            onClose={() => { setShowPicker(false); setPickerAnchor(null); }}
            anchorRect={pickerAnchor}
            dropdownRef={dropdownRef}
          />
        )}

        {/* Time / div */}
        <span className="osc-label">Time/div:</span>
        <select
          className="osc-select"
          value={timeDivMs}
          onChange={(e) => setTimeDivMs(Number(e.target.value))}
        >
          {TIME_DIV_OPTIONS.map(({ label, ms }) => (
            <option key={ms} value={ms}>{label}</option>
          ))}
        </select>

        {/* Run / Pause */}
        <button
          className={`osc-btn${capturing ? '' : ' osc-btn-active'}`}
          onClick={() => setCapturing(!capturing)}
          title={capturing ? 'Pause capture' : 'Resume capture'}
        >
          {capturing ? '⏸ Pause' : '▶ Run'}
        </button>

        {/* Clear */}
        <button
          className="osc-btn osc-btn-danger"
          onClick={clearSamples}
          title="Clear all captured samples"
        >
          Clear
        </button>
      </div>

      {/* ── Waveforms ── */}
      {channels.length === 0 ? (
        <div className="osc-empty">
          <span>No channels added.</span>
          <span style={{ color: '#777' }}>Click &quot;+ Add Channel&quot; to monitor a pin.</span>
        </div>
      ) : (
        <>
          <div className="osc-waveforms">
            {channels.map((ch) => (
              <div key={ch.id} className="osc-channel-row">
                <div className="osc-channel-label">
                  <span className="osc-channel-board" title={ch.boardId}>
                    {boardShortName(ch.boardId)}
                  </span>
                  <span className="osc-channel-name" style={{ color: ch.color }}>
                    {ch.label}
                  </span>
                  <button
                    className="osc-channel-remove"
                    onClick={() => removeChannel(ch.id)}
                    title={`Remove ${ch.label}`}
                  >
                    ×
                  </button>
                </div>

                <ChannelCanvas
                  channel={ch}
                  samples={samples[ch.id] ?? []}
                  windowEndMs={windowEndMs}
                  windowMs={windowMs}
                />
              </div>
            ))}
          </div>

          <RulerCanvas
            windowEndMs={windowEndMs}
            windowMs={windowMs}
            timeDivMs={timeDivMs}
          />
        </>
      )}
    </div>
  );
};
