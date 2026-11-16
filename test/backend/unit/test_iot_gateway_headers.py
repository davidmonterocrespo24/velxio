"""What a board's web server is told about the visitor (#182).

The gateway forwards a visitor's request into the board's own web server,
which runs whatever firmware the board's owner wrote. The headers the
browser and our proxies put on that request (session cookies, proxy
headers, the CDN's view of the visitor) stay on velxio's side; the board
gets the ones a sketch actually reads.
"""

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend"))

from app.api.routes import iot_gateway  # noqa: E402


def _request(headers: dict[str, str], body: bytes = b"", method: str = "POST") -> Request:
    scope = {
        "type": "http",
        "method": method,
        "path": "/api/gateway/c1/led",
        "raw_path": b"/api/gateway/c1/led",
        "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8001),
        "scheme": "http",
    }
    sent = {"done": False}

    async def receive():
        if sent["done"]:
            return {"type": "http.disconnect"}
        sent["done"] = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(scope, receive)


async def _forwarded(headers: dict[str, str], body: bytes = b"") -> httpx.Headers:
    seen: dict = {}

    def board(req: httpx.Request) -> httpx.Response:
        seen["headers"] = req.headers
        seen["body"] = req.content
        return httpx.Response(200, text="ok", headers={"content-type": "text/plain"})

    real_client = httpx.AsyncClient

    def client(**kwargs):
        return real_client(transport=httpx.MockTransport(board), **kwargs)

    inst = SimpleNamespace(wifi_hostfwd_port=40000)
    with patch.object(iot_gateway.httpx, "AsyncClient", side_effect=client):
        resp = await iot_gateway._proxy_esp32(inst, "led", _request(headers, body))
    assert resp.status_code == 200
    assert seen["body"] == body
    return seen["headers"]


VISITOR = {
    "Cookie": "access_token=the-visitors-session; vx_anon=abc.def",
    "X-Velxio-Proxy": "per-container-secret",
    "X-Forwarded-For": "198.51.100.7, 172.19.0.1",
    "X-Real-IP": "172.19.0.1",
    "X-Forwarded-Proto": "https",
    "CF-Connecting-IP": "198.51.100.7",
    "CF-IPCountry": "ES",
    "Forwarded": "for=198.51.100.7",
    "Referer": "https://velxio.dev/project/abc?token=x",
    "Origin": "https://velxio.dev",
    "Sec-Fetch-Site": "same-origin",
    # What a sketch reads:
    "Accept": "text/html",
    "Accept-Language": "es-ES",
    "Authorization": "Basic YWRtaW46YWRtaW4=",
    "Content-Type": "application/x-www-form-urlencoded",
    "If-None-Match": '"v1"',
    "Range": "bytes=0-99",
    "User-Agent": "Mozilla/5.0",
    "X-Requested-With": "XMLHttpRequest",
}


@pytest.mark.asyncio
async def test_the_board_never_sees_the_visitors_session_or_our_proxy_headers():
    got = await _forwarded(VISITOR, b"state=1")
    for name in ("cookie", "x-velxio-proxy", "x-forwarded-for", "x-real-ip",
                 "x-forwarded-proto", "cf-connecting-ip", "cf-ipcountry",
                 "forwarded", "referer", "origin", "sec-fetch-site"):
        assert name not in got, f"{name} reached the board"


@pytest.mark.asyncio
async def test_the_headers_a_sketch_reads_still_arrive():
    got = await _forwarded(VISITOR, b"state=1")
    assert got["content-type"] == "application/x-www-form-urlencoded"
    assert got["authorization"] == "Basic YWRtaW46YWRtaW4="
    assert got["accept"] == "text/html"
    assert got["accept-language"] == "es-ES"
    assert got["if-none-match"] == '"v1"'
    assert got["range"] == "bytes=0-99"
    assert got["user-agent"] == "Mozilla/5.0"
    assert got["x-requested-with"] == "XMLHttpRequest"
    assert got["content-length"] == "7"
