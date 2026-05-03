"""
Tiny WebSocket echo server for the webcam_capture.html prototype.

Run:
    pip install websockets
    python test/test-esp32-cam/prototypes/echo_server.py

Open test/test-esp32-cam/prototypes/webcam_capture.html in a browser,
click "Start camera". The page should show the live feed on the left
and the echoed JPEG on the right, with a frame counter incrementing.

What this proves: the browser-side path of autosearch/03 works as
specified — JPEGs are encoded at the requested quality, sent as binary
WS frames, and round-trip without corruption.

What this does NOT prove: anything about the firmware-side shim. That's
a separate validation step, see autosearch/04 + the live test layer.
"""

from __future__ import annotations

import asyncio
import sys

try:
    import websockets
except ImportError:
    sys.stderr.write(
        "websockets not installed. Run: pip install websockets\n"
    )
    sys.exit(1)


async def handler(ws):
    n = 0
    async for msg in ws:
        if isinstance(msg, (bytes, bytearray)):
            n += 1
            print(f"frame {n}: {len(msg)} bytes", file=sys.stderr)
            await ws.send(msg)


async def main(host: str = "localhost", port: int = 8765):
    print(f"echo server listening on ws://{host}:{port}", file=sys.stderr)
    async with websockets.serve(handler, host, port):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
