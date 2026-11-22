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


# ── What a board's reply may set in the browser ─────────────────────────────
# The board's page is served on this site's own origin, so the headers of its
# reply are applied to the site for whoever opens the link. Both lanes (the
# QEMU one here, and an overlay's) keep only what a page needs.

from fastapi import FastAPI  # noqa: E402
from starlette.responses import Response as _Response  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

PAGE = b"<!doctype html><html><head><title>board</title></head><body>LED is ON</body></html>"
NOT_THE_BOARDS = {
    "set-cookie": "access_token=chosen-by-the-board; Path=/; HttpOnly",
    "service-worker-allowed": "/",
    "clear-site-data": '"cookies"',
    "access-control-allow-origin": "https://other.example",
    "access-control-allow-credentials": "true",
    "strict-transport-security": "max-age=0",
    "alt-svc": "clear",
    "report-to": '{"group":"g","max_age":86400,"endpoints":[{"url":"https://other.example/r"}]}',
    "nel": '{"report_to":"g","max_age":86400}',
    "origin-agent-cluster": "?0",
    "cross-origin-opener-policy": "unsafe-none",
    "content-security-policy": "default-src *",
    "x-accel-redirect": "/health",
    "x-board-note": "1",
}
THE_BOARDS = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    "etag": '"v1"',
    "refresh": "30",
}


def _gateway(monkeypatch, board_headers: dict, *, status: int = 200, body: bytes = PAGE, lane: str = "qemu"):
    def board(req: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body, headers=board_headers)

    real_client = httpx.AsyncClient

    def client(**kwargs):
        return real_client(transport=httpx.MockTransport(board), **kwargs)

    monkeypatch.setattr(iot_gateway.httpx, "AsyncClient", client)
    inst = SimpleNamespace(wifi_enabled=True, wifi_hostfwd_port=40000)
    monkeypatch.setattr(iot_gateway, "esp_lib_manager", SimpleNamespace(
        get_instance=lambda cid: inst if lane == "qemu" else None))

    async def overlay(client_id, path, request):
        if lane != "overlay":
            return None
        return _Response(content=body, status_code=status, headers=board_headers)

    monkeypatch.setattr(iot_gateway, "dispatch_gateway_proxy", overlay)

    async def no_gate(request):
        return None

    monkeypatch.setattr(iot_gateway, "iot_gateway_gate", no_gate)
    app = FastAPI()
    app.include_router(iot_gateway.router, prefix="/api/gateway")
    return TestClient(app)


@pytest.mark.parametrize("lane", ["qemu", "overlay"])
def test_a_board_cannot_set_what_belongs_to_the_site(monkeypatch, lane):
    c = _gateway(monkeypatch, {**THE_BOARDS, **NOT_THE_BOARDS}, lane=lane)
    r = c.get("/api/gateway/c1/", headers={"accept": "text/html"})
    assert r.status_code == 200
    leaked = sorted(set(NOT_THE_BOARDS) & {k.lower() for k in r.headers.keys()})
    assert not leaked, f"the board set {leaked}"
    for name, value in THE_BOARDS.items():
        assert r.headers.get(name) == value, name
    assert b"LED is ON" in r.content and b"__velxioGatewayShim" in r.content


@pytest.mark.parametrize("lane", ["qemu", "overlay"])
def test_a_reply_that_is_not_a_page_cannot_set_them_either(monkeypatch, lane):
    # A service worker is a script, served as JavaScript: the allow-list holds
    # for every reply, not only for the pages that get the shim.
    script = b"self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));"
    c = _gateway(monkeypatch, {"content-type": "text/javascript", **NOT_THE_BOARDS}, body=script, lane=lane)
    r = c.get("/api/gateway/c1/sw.js")
    assert r.status_code == 200
    leaked = sorted(set(NOT_THE_BOARDS) & {k.lower() for k in r.headers.keys()})
    assert not leaked, f"the board set {leaked}"
    assert r.headers["content-type"].startswith("text/javascript")
    assert r.content == script


@pytest.mark.parametrize("lane", ["qemu", "overlay"])
@pytest.mark.parametrize("status,headers", [
    # Release 9 points a redirect under the gateway prefix (#179); the
    # allow-list keeps the header, rewritten.
    (303, {"location": "/"}),
    (401, {"www-authenticate": 'Basic realm="Login Required"', "content-type": "text/plain"}),
    (206, {"content-type": "text/csv", "content-range": "bytes 0-3/10", "accept-ranges": "bytes"}),
    (200, {"content-type": "text/csv", "content-disposition": 'attachment; filename="log.csv"'}),
    (405, {"allow": "GET, POST", "content-type": "text/plain"}),
    (503, {"retry-after": "5", "content-type": "text/plain"}),
])
def test_what_a_board_page_needs_still_reaches_the_browser(monkeypatch, lane, status, headers):
    c = _gateway(monkeypatch, headers, status=status, body=b"t,h\n", lane=lane)
    r = c.get("/api/gateway/c1/form", follow_redirects=False)
    assert r.status_code == status
    moved = {"location": "/api/gateway/c1/"}
    for name, value in headers.items():
        assert r.headers.get(name) == moved.get(name, value), name
