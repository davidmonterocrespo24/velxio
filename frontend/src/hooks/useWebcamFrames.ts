/**
 * Stream frames from the user's webcam to the simulator's ESP32-CAM
 * peripheral over WebSocket.
 *
 * Lifecycle:
 *   - start(boardId): asks for camera permission, starts capture loop.
 *   - stop():         turns the webcam off, tells backend to detach.
 *   - status:         'idle' | 'requesting' | 'streaming' | 'denied' | 'error'.
 *
 * The frame transport goes through Esp32Bridge.sendCameraFrame(), which
 * is also what the test suite uses. The ctypes binding in the worker
 * pushes the bytes into the QEMU OV2640+I²S peripheral.
 *
 * Implementation notes:
 *   - QVGA (320×240) at 10 fps. Larger sizes work but bandwidth
 *     scales linearly and the firmware's DMA buffer is fixed-size.
 *   - JPEG quality 0.6 keeps each frame in the 8–14 KB range.
 *   - We use OffscreenCanvas when available (Chrome/Edge); fall back
 *     to a hidden DOM canvas for Safari < 17.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getEsp32Bridge } from '../store/useSimulatorStore';

export type WebcamStatus =
  | 'idle'
  | 'requesting'
  | 'streaming'
  | 'denied'
  | 'error';

export interface UseWebcamFramesResult {
  status: WebcamStatus;
  errorMessage: string | null;
  /** Frames sent since the last start(). Useful for live counter UI. */
  framesSent: number;
  /** Last frame payload size (bytes). */
  lastFrameBytes: number;
  start: (boardId: string) => Promise<void>;
  stop: () => void;
  /** A `<video>` element ref the caller can render for a self-preview. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;
const FRAME_INTERVAL_MS = 100; // 10 fps
const JPEG_QUALITY = 0.6;

export function useWebcamFrames(): UseWebcamFramesResult {
  const [status, setStatus] = useState<WebcamStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [framesSent, setFramesSent] = useState(0);
  const [lastFrameBytes, setLastFrameBytes] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const boardIdRef = useRef<string | null>(null);
  const canvasRef = useRef<OffscreenCanvas | HTMLCanvasElement | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (boardIdRef.current) {
      const bridge = getEsp32Bridge(boardIdRef.current);
      bridge?.sendCameraDetach();
      boardIdRef.current = null;
    }
    setStatus('idle');
    setFramesSent(0);
  }, []);

  const start = useCallback(async (boardId: string) => {
    setStatus('requesting');
    setErrorMessage(null);
    setFramesSent(0);
    boardIdRef.current = boardId;

    // 1. Request camera permission + media stream.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: FRAME_WIDTH,
          height: FRAME_HEIGHT,
          frameRate: { ideal: 10, max: 15 },
        },
        audio: false,
      });
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'NotAllowedError') {
        setStatus('denied');
        setErrorMessage('Camera permission denied');
      } else if (e.name === 'NotFoundError') {
        setStatus('error');
        setErrorMessage('No camera detected');
      } else {
        setStatus('error');
        setErrorMessage(e.message ?? 'getUserMedia failed');
      }
      return;
    }
    streamRef.current = stream;

    // 2. Wire stream into a hidden <video> for the canvas to draw from.
    if (!videoRef.current) {
      videoRef.current = document.createElement('video');
      videoRef.current.muted = true;
      videoRef.current.autoplay = true;
      videoRef.current.playsInline = true;
    }
    videoRef.current.srcObject = stream;
    try {
      await videoRef.current.play();
    } catch {
      // Some browsers reject .play() until user gesture; harmless if it
      // throws — the next animation tick will proceed anyway.
    }

    // 3. Prepare canvas for JPEG encode.
    if (!canvasRef.current) {
      if (typeof OffscreenCanvas !== 'undefined') {
        canvasRef.current = new OffscreenCanvas(FRAME_WIDTH, FRAME_HEIGHT);
      } else {
        const c = document.createElement('canvas');
        c.width = FRAME_WIDTH;
        c.height = FRAME_HEIGHT;
        canvasRef.current = c;
      }
    }

    // 4. Tell the backend a frame source is on its way.
    const bridge = getEsp32Bridge(boardId);
    if (!bridge) {
      setStatus('error');
      setErrorMessage(`No ESP32 bridge for board ${boardId}`);
      stop();
      return;
    }
    bridge.sendCameraAttach();

    // 5. Start the capture loop.
    setStatus('streaming');
    timerRef.current = window.setInterval(async () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v || !c || v.readyState < 2) return;

      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);

      let blob: Blob | null;
      if (c instanceof OffscreenCanvas) {
        blob = await c.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
      } else {
        blob = await new Promise<Blob | null>((resolve) =>
          (c as HTMLCanvasElement).toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
        );
      }
      if (!blob) return;
      const buf = await blob.arrayBuffer();
      const id = boardIdRef.current;
      if (!id) return;
      const b = getEsp32Bridge(id);
      if (!b) return;
      b.sendCameraFrame(buf, FRAME_WIDTH, FRAME_HEIGHT);
      setFramesSent((n) => n + 1);
      setLastFrameBytes(buf.byteLength);
    }, FRAME_INTERVAL_MS);
  }, [stop]);

  // Stop on unmount.
  useEffect(() => () => stop(), [stop]);

  return { status, errorMessage, framesSent, lastFrameBytes, start, stop, videoRef };
}
