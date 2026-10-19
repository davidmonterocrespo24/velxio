/**
 * BoardDock — the per-board control row drawn under every board on the canvas.
 *
 * Left: the board's own capabilities, each shown only when the board has it —
 * SD card files, the camera / microphone streams and the tilt + battery
 * inputs, plus an overlay slot (`board-dock`, keyed by data-board-id) where a
 * private overlay hangs per-board extras such as the WiFi status.
 * Right: board editing actions, only while the canvas is editable and only on
 * the selected (active) board.
 *
 * Why here and not in the canvas header: the header controls acted on the
 * ACTIVE board only, so with two boards nobody could tell which one a Camera
 * or Mic button drove, and most people never found them at all. Next to the
 * board they are visible, unambiguous, and exist once per board.
 *
 * The row lives in canvas (world) coordinates so it follows the board through
 * pan and drag, and is counter-scaled by 1/zoom so the buttons keep their
 * screen size at any zoom — scaled with the world they were unreadable when
 * zoomed out and huge when zoomed in.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { getProBoard } from '../../lib/proBoardRegistry';
import { boardBox } from '../../utils/boardGeometry';
import type { BoardInstance } from '../../types/board';
import { CameraToggle } from './CameraToggle';
import { MicrophoneToggle } from './MicrophoneToggle';
import { BoardSensorControls } from './BoardSensorControls';
import './BoardDock.css';

interface BoardDockProps {
  board: BoardInstance;
  zoom: number;
  /** Any board running: the canvas is read-only, edit actions hide. */
  running: boolean;
  /** Show the edit actions (the selected / active board). */
  showEdit: boolean;
  /** Opens the board inspector at the given screen point. */
  onOpenInspector?: (x: number, y: number) => void;
  onRotate?: () => void;
  onCopy?: () => void;
  /** Paste the last copied board or component; undefined = nothing copied. */
  onPaste?: () => void;
  onRemove?: () => void;
}

/** Boards with an on-board camera: the two OSS kinds plus any overlay board
 *  whose def declares builtInCamera. */
function cameraFor(boardKind: string): { maxFrameBytes?: number } | null {
  if (boardKind === 'esp32-cam') return {};
  // The S3 esp32-camera build allocates width*height/5 bytes for a QVGA JPEG
  // frame (15360) and stops copying at fb_size - one 1 KiB DMA half-buffer:
  // frames must stay under ~14336 or the EOI marker is truncated (NO-EOI).
  if (boardKind === 'xiao-esp32s3-sense') return { maxFrameBytes: 14000 };
  const cam = getProBoard(boardKind)?.builtInCamera;
  if (!cam) return null;
  return typeof cam === 'object' ? { maxFrameBytes: cam.maxFrameBytes } : {};
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export const BoardDock: React.FC<BoardDockProps> = ({
  board,
  zoom,
  running,
  showEdit,
  onOpenInspector,
  onRotate,
  onCopy,
  onPaste,
  onRemove,
}) => {
  const { t } = useTranslation();
  const def = getProBoard(board.boardKind);
  const sd = def?.builtInSd !== undefined;
  const camera = cameraFor(board.boardKind);
  const mic = def?.builtInMicrophone === true;
  const imu = def?.builtInImu === true;
  const battery = def?.builtInBattery === true;
  const edit = showEdit && !running;
  // Under the board's ROTATED box, so a turned board keeps its row beneath it.
  const box = boardBox(board);
  const live = !!board.running;

  const openInspector = (e: React.MouseEvent) => {
    onOpenInspector?.(e.clientX, e.clientY);
  };

  return (
    <div
      className="board-dock"
      data-board-dock={board.id}
      style={{
        left: box.left,
        top: box.top + box.h + 6,
        width: box.w * zoom,
        transform: `scale(${1 / zoom})`,
      }}
      // The canvas starts a pan / board drag on mousedown, and right-click on
      // the board wrapper opens the inspector: neither belongs to this row.
      onMouseDown={stop}
      onClick={stop}
      onContextMenu={stop}
    >
      <div className={`board-dock-group${live ? '' : ' board-dock-group--idle'}`}>
        {sd && (
          <button
            type="button"
            className="board-dock-btn board-dock-btn--sd"
            title={t('editor.canvas.dock.sdFiles')}
            aria-label={t('editor.canvas.dock.sdFiles')}
            onClick={openInspector}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z" />
              <path d="M9 6v3M12 6v3M15 6v3" />
            </svg>
          </button>
        )}
        {/* Overlay extras for this board (e.g. WiFi). Empty in OSS builds. */}
        <span data-velxio-slot="board-dock" data-board-id={board.id} className="board-dock-slot" />
        {camera && <CameraToggle boardId={board.id} maxFrameBytes={camera.maxFrameBytes} />}
        {mic && <MicrophoneToggle boardId={board.id} />}
        {(imu || battery) && (
          <BoardSensorControls boardId={board.id} showImu={imu} showBattery={battery} />
        )}
      </div>

      {edit && (
        <div className="board-dock-group board-dock-group--edit">
          {onRotate && (
            <button
              type="button"
              className="board-dock-btn"
              title={t('editor.canvas.dock.rotate')}
              aria-label={t('editor.canvas.dock.rotate')}
              onClick={onRotate}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-3-6.7" />
                <path d="M21 3v6h-6" />
              </svg>
            </button>
          )}
          {onCopy && (
            <button
              type="button"
              className="board-dock-btn"
              title={t('editor.canvas.dock.copy')}
              aria-label={t('editor.canvas.dock.copy')}
              onClick={onCopy}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="12" height="12" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="board-dock-btn"
            title={t('editor.canvas.dock.paste')}
            aria-label={t('editor.canvas.dock.paste')}
            onClick={onPaste}
            disabled={!onPaste}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="8" y="2" width="8" height="4" rx="1" />
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            </svg>
          </button>
          {onOpenInspector && (
            <button
              type="button"
              className="board-dock-btn"
              title={t('editor.canvas.dock.settings')}
              aria-label={t('editor.canvas.dock.settings')}
              onClick={openInspector}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="board-dock-btn board-dock-btn--danger"
              title={t('editor.canvas.removeBoard')}
              aria-label={t('editor.canvas.removeBoard')}
              onClick={onRemove}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
