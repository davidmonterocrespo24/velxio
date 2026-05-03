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
import React from 'react';
import { useWebcamFrames } from '../../hooks/useWebcamFrames';

interface CameraToggleProps {
  boardId: string | null;
}

export const CameraToggle: React.FC<CameraToggleProps> = ({ boardId }) => {
  const { status, errorMessage, framesSent, lastFrameBytes, start, stop } =
    useWebcamFrames();

  const handleClick = () => {
    if (!boardId) return;
    if (status === 'streaming') {
      stop();
    } else {
      void start(boardId);
    }
  };

  const isOn = status === 'streaming';
  const tooltip =
    status === 'streaming'
      ? `Streaming webcam (${framesSent} frames, last=${(lastFrameBytes / 1024).toFixed(1)} KB) — click to stop`
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
      style={{
        background: isOn ? 'rgba(63,185,80,0.15)' : 'transparent',
        border: `1px solid ${isOn ? '#3fb950' : '#555'}`,
        borderRadius: 4,
        padding: '4px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color,
        fontSize: 13,
        cursor: boardId ? 'pointer' : 'not-allowed',
        animation:
          status === 'requesting'
            ? 'velxio-pulse 1s ease-in-out infinite'
            : 'none',
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
        <circle cx="12" cy="13" r="4" />
      </svg>
      <span>
        {isOn ? `Camera ${framesSent}` : 'Camera'}
      </span>
    </button>
  );
};
