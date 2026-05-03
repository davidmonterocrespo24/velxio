"""
Diagnostic — runs sccb_probe.ino against the live backend and dumps
every serial line (no assertions, no xfail). Use to see what the
firmware actually printed when the formal test reports XFAIL.

Usage:
    VELXIO_BACKEND_URL=http://127.0.0.1:8001 \
      python test/test-esp32-cam/tests/diag_sccb_probe.py
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys
from urllib.parse import urlparse

THIS = pathlib.Path(__file__).resolve()
SKETCH = THIS.parent.parent / "sketches" / "sccb_probe" / "sccb_probe.ino"


def base() -> str:
    u = os.environ.get("VELXIO_BACKEND_URL", "http://127.0.0.1:8001")
    return u.rstrip("/")


def ws_url(client_id: str) -> str:
    u = urlparse(base())
    scheme = "wss" if u.scheme == "https" else "ws"
    host = u.hostname or "localhost"
    port = f":{u.port}" if u.port else ""
    return f"{scheme}://{host}{port}/api/simulation/ws/{client_id}"


async def main():
    import httpx
    import websockets

    sketch = SKETCH.read_text(encoding="utf-8")

    print(f"[diag] compiling {SKETCH.name}…", flush=True)
    async with httpx.AsyncClient(base_url=base(), timeout=300.0) as http:
        res = await http.post(
            "/api/compile/",
            json={
                "files": [{"name": SKETCH.name, "content": sketch}],
                "board_fqbn": "esp32:esp32:esp32cam",
            },
        )
        body = res.json()
    if not body.get("success"):
        print(f"[diag] compile FAILED: "
              f"{(body.get('error') or body.get('stderr', ''))[:600]}",
              flush=True)
        return 1
    fw = body.get("binary_content") or body.get("firmware_b64")
    print(f"[diag] firmware {len(fw)//1024} KB", flush=True)

    cid = f"diag-sccb-{int(asyncio.get_event_loop().time()*1000)}"
    print(f"[diag] WS connect {ws_url(cid)}", flush=True)
    async with websockets.connect(ws_url(cid), ping_interval=None,
                                  max_size=4 * 1024 * 1024) as ws:
        await ws.send(json.dumps({
            "type": "start_esp32",
            "data": {"board": "esp32-cam", "firmware_b64": fw},
        }))
        deadline = asyncio.get_event_loop().time() + 60.0
        try:
            while asyncio.get_event_loop().time() < deadline:
                rem = deadline - asyncio.get_event_loop().time()
                if rem <= 0:
                    break
                raw = await asyncio.wait_for(ws.recv(), timeout=rem)
                try:
                    m = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                t = m.get("type")
                d = m.get("data", {}) or {}
                if t == "serial_output":
                    txt = d.get("data", "")
                    sys.stdout.write(txt)
                    sys.stdout.flush()
                elif t == "system":
                    print(f"\n[diag] system: {d}", flush=True)
                elif t == "error":
                    print(f"\n[diag] ERROR: {d}", flush=True)
        except asyncio.TimeoutError:
            pass
        finally:
            try:
                await ws.send(json.dumps({"type": "stop_esp32", "data": {}}))
            except Exception:
                pass
    print("\n[diag] done", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
