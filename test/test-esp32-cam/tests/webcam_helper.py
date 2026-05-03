"""
Capture a single JPEG frame for the live camera tests.

Two modes:

  - **Live webcam** (preferred when running interactively): uses OpenCV
    to grab one frame from the default camera. Falls back to synthetic
    when OpenCV isn't installed or no camera is attached. Triggered by
    setting `VELXIO_USE_WEBCAM=1`.

  - **Synthetic** (default — keeps CI deterministic): a 4×4 RGB JPEG
    encoded with PIL or a precomputed b64-encoded blob if PIL is
    missing. ~600 bytes.

The synthetic blob has a recognisable byte pattern at offsets 2..7
(JFIF marker `J F I F \0 \1`) that the QEMU device tests look for to
prove the host bytes round-tripped into firmware memory.
"""

from __future__ import annotations

import base64
import os


# Pre-baked 4×4 red JPEG (PIL-generated, valid JFIF). Used when neither
# OpenCV nor PIL is available, OR when running in CI deterministic mode.
_SYNTHETIC_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEm"
    "KzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7"
    "Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAEAAQDASIAAhEBAxEB/8QA"
    "HwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIh"
    "MUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW"
    "V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG"
    "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQF"
    "BgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAV"
    "YnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE"
    "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq"
    "8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlaKKK+dP2Y//Z"
)


def _try_opencv_webcam() -> bytes | None:
    """Capture one frame from the default webcam. Returns JPEG bytes or
    None if OpenCV is unavailable or capture fails."""
    try:
        import cv2  # type: ignore
    except ImportError:
        return None
    cap = cv2.VideoCapture(0)
    try:
        if not cap.isOpened():
            return None
        # Some webcams need a few grabs to warm up exposure; throw out
        # the first 3 frames.
        for _ in range(3):
            cap.read()
        ok, frame = cap.read()
        if not ok or frame is None:
            return None
        # Down-scale to QVGA so the test doesn't ship a 2 MB JPEG.
        h, w = frame.shape[:2]
        target = (320, 240)
        if (w, h) != target:
            frame = cv2.resize(frame, target, interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        if not ok:
            return None
        return bytes(buf)
    finally:
        cap.release()


def _try_pil_synthetic() -> bytes | None:
    """A larger, more realistic synthetic JPEG via PIL. Returns None if
    PIL isn't installed."""
    try:
        from PIL import Image, ImageDraw  # type: ignore
    except ImportError:
        return None
    import io
    img = Image.new("RGB", (320, 240), color=(40, 80, 160))
    draw = ImageDraw.Draw(img)
    # A few coloured shapes give us non-uniform bytes — easier to
    # differentiate from the QEMU idle pattern (0xAA).
    draw.rectangle((20, 30, 100, 120), fill=(220, 30, 30))
    draw.ellipse((150, 60, 280, 200), fill=(30, 200, 30))
    draw.text((10, 10), "VELXIO TEST", fill=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=70)
    return buf.getvalue()


def get_test_jpeg(prefer_webcam: bool | None = None) -> tuple[bytes, str]:
    """Return (jpeg_bytes, source_label).

    `source_label` is one of "webcam", "pil-synthetic", "embedded" so
    test logs make it obvious where the bytes came from.

    `prefer_webcam` defaults to the env var VELXIO_USE_WEBCAM=1.
    """
    if prefer_webcam is None:
        prefer_webcam = os.environ.get("VELXIO_USE_WEBCAM", "") == "1"

    if prefer_webcam:
        cam = _try_opencv_webcam()
        if cam is not None:
            return cam, "webcam"
    pil = _try_pil_synthetic()
    if pil is not None:
        return pil, "pil-synthetic"
    return base64.b64decode(_SYNTHETIC_JPEG_B64), "embedded"


if __name__ == "__main__":
    data, src = get_test_jpeg()
    print(f"source: {src}")
    print(f"size:   {len(data)} bytes")
    print(f"head:   {data[:16].hex()}")
    print(f"is_jpeg: {data[:2] == b'\\xff\\xd8'}")
