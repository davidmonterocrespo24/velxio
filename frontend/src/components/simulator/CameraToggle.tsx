/**
 * Camera button rendered on the canvas header for ESP32-CAM boards.
 *
 * Click → asks for webcam permission → starts streaming JPEG frames at
 * 10 fps over the existing simulator WebSocket. The frames flow into
 * the QEMU OV2640+I²S peripheral so user sketches that call
 * `esp_camera_fb_get()` see real webcam content (subject to the
 * upstream-driver caveats documented in test/test-esp32-cam/autosearch/10).
 *
 * Visual states:
 *   idle       grey camera icon
 *   requesting orange (pulsing) — browser permission prompt visible
 *   streaming  green + frame counter — frames flowing
 *   denied     red, click-to-retry
 *   error      red, hover for message
 */
import { CameraIcon } from '../ui/CustomIcons';
import React from 'react';
import { useWebcamFrames } from '../../hooks/useWebcamFrames';
import { useSimulatorStore } from '../../store/useSimulatorStore';

interface CameraToggleProps {
  boardId: string | null;
  /** Per-board frame byte budget (see useWebcamFrames). Omit for the
   *  default QEMU ESP32-CAM bound. */
  maxFrameBytes?: number;
}

export const CameraToggle: React.FC<CameraToggleProps> = ({ boardId, maxFrameBytes }) => {
  const {
    status,
    errorMessage,
    framesSent,
    lastFrameBytes,
    lastQualityUsed,
    lastDownscaled,
    start,
    stop,
  } = useWebcamFrames(maxFrameBytes);

  // Auto-start when the sketch RUNS. An ESP32-CAM sketch exists to capture, so
  // waiting for a click on this toggle just reads as "the camera is broken":
  // the guest boots, esp_camera_init succeeds against the modelled OV2640, and
  // then cam_hal times out forever waiting for frames nobody is sending. Ask
  // for the webcam the moment the run starts - the browser's permission prompt
  // is the user consent, so the toggle stays as the manual off-switch. Only
  // once per run: stopping the stream by hand must not re-trigger it.
  const running = useSimulatorStore((st) => st.running);
  const autoStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (!running) {
      autoStartedRef.current = false;
      return;
    }
    if (autoStartedRef.current || !boardId || status === 'streaming') return;
    autoStartedRef.current = true;
    void start(boardId);
  }, [running, boardId, status, start]);

  const handleClick = () => {
    if (!boardId) return;
    if (status === 'streaming') {
      stop();
    } else {
      void start(boardId);
    }
  };

  const isOn = status === 'streaming';

  // Build a streaming tooltip that exposes the adaptive encoder state.
  // Users see "auto-tuned" hints when the encoder had to drop quality
  // or downscale — useful diagnostic for HD/4K webcams.
  const streamingTooltip = () => {
    const kb = (lastFrameBytes / 1024).toFixed(1);
    const q = lastQualityUsed.toFixed(2);
    const tuneNote = lastDownscaled
      ? ` (auto-downscaled, q=${q})`
      : lastQualityUsed < 0.3
        ? ` (auto-tuned to q=${q})`
        : ` (q=${q})`;
    return `Streaming webcam (${framesSent} frames, last=${kb} KB${tuneNote}) — click to stop`;
  };

  const tooltip =
    status === 'streaming'
      ? streamingTooltip()
      : status === 'requesting'
        ? 'Asking for camera permission…'
        : status === 'denied'
          ? `Permission denied. Click to retry.`
          : status === 'error'
            ? `Webcam error: ${errorMessage ?? 'unknown'}`
            : 'Use webcam as ESP32-CAM camera';

  const color =
    status === 'streaming'
      ? '#3fb950'
      : status === 'requesting'
        ? '#f0883e'
        : status === 'denied' || status === 'error'
          ? '#f85149'
          : '#ccc';

  return (
    <button
      onClick={handleClick}
      disabled={!boardId || status === 'requesting'}
      title={tooltip}
      // Ants while the button wants a click DURING a run (idle after a
      // failed/stopped auto-start, denied, error): a camera sketch is
      // starving without frames. Never while the sim is stopped — the
      // button is not asking for anything then. Solid border once
      // streaming or asking.
      // Static layout is in .canvas-cam-mic-btn so the toolbar @container
      // query can collapse the label to icon-only (an inline font-size would
      // beat it). Only state-driven styles stay inline below.
      className={`canvas-cam-mic-btn${
        running && boardId && status !== 'streaming' && status !== 'requesting'
          ? ' velxio-btn-ants'
          : ''
      }`}
      style={{
        // backgroundColor, NOT the background shorthand: inline shorthand
        // would wipe the class's background-image and kill the ants.
        backgroundColor: isOn ? 'rgba(63,185,80,0.15)' : 'transparent',
        border: `1px solid ${
          isOn ? '#3fb950' : status === 'requesting' ? '#555' : 'transparent'
        }`,
        color,
        cursor: boardId ? 'pointer' : 'not-allowed',
        // Inline only while requesting. 'none' here would OVERRIDE the
        // .velxio-btn-ants class animation (inline beats class), which is
        // exactly how the ants shipped dead the first time.
        animation:
          status === 'requesting'
            ? 'velxio-pulse 1s ease-in-out infinite'
            : undefined,
      }}
    >
      <CameraIcon size={16} />
      <span>
        {isOn ? `Camera ${framesSent}` : 'Camera'}
      </span>
    </button>
  );
};
