"""A board's redirect stays on the board (velxio/velxio-prod#179).

The gateway serves a board's pages under /api/gateway/<client_id>/, and the
injected shim points the page's own requests there. A redirect is followed
by the browser before any script runs, though: a form handler answering
"303 See Other" with "Location: /", or arduino-esp32's SimpleAuthentification
example sending "/login", resolved against velxio.dev's root and left the
board for the site's home page (inside the device panel's iframe on the
in-browser engines). Both proxies passed the header through untouched: the
QEMU one (httpx does not follow redirects) and the overlay's, for the boards
whose network lives in the browser. Their responses meet in the gateway
route, which now points the URL headers under the prefix, by the shim's rules.
"""

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from fastapi import Response
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend"))

from app.api.routes import iot_gateway  # noqa: E402

PREFIX = "/api/gateway/c1::esp32/"


def _request(path: str, method: str = "GET") -> Request:
    full = PREFIX + path
    scope = {
        "type": "http",
        "method": method,
        "path": full,
        "raw_path": full.encode(),
        "query_string": b"",
        "headers": [(b"accept", b"text/html")],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8001),
        "scheme": "http",
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(scope, receive)


async def _through_qemu(path: str, board_response: httpx.Response, method: str = "GET") -> Response:
    """The gateway route, its QEMU proxy talking to a board that answers
    `board_response`."""
    real_client = httpx.AsyncClient

    def client(**kwargs):
        return real_client(transport=httpx.MockTransport(lambda req: board_response), **kwargs)

    inst = SimpleNamespace(wifi_enabled=True, wifi_hostfwd_port=40000)
    with patch.object(iot_gateway.httpx, "AsyncClient", side_effect=client), \
            patch.object(iot_gateway.esp_lib_manager, "get_instance", return_value=inst):
        return await iot_gateway.gateway_proxy("c1::esp32", path, _request(path, method))


async def _through_overlay(path: str, board_response: Response) -> Response:
    """The gateway route, the overlay's proxy (the browser-side boards)
    answering `board_response`."""
    async def overlay(client_id, p, request):
        return board_response

    with patch.object(iot_gateway.esp_lib_manager, "get_instance", return_value=None), \
            patch.object(iot_gateway, "dispatch_gateway_proxy", side_effect=overlay):
        return await iot_gateway.gateway_proxy("c1::esp32", path, _request(path))


# ── Through the route, as the browser gets it ──────────────────────────────

@pytest.mark.asyncio
async def test_a_redirect_to_the_root_stays_on_the_board():
    resp = await _through_qemu("led", httpx.Response(303, headers={"location": "/"}), "POST")
    assert resp.status_code == 303
    assert resp.headers["location"] == PREFIX


@pytest.mark.asyncio
async def test_the_simple_authentification_example_lands_on_its_login_page():
    resp = await _through_qemu("", httpx.Response(301, headers={"location": "/login"}))
    assert resp.headers["location"] == PREFIX + "login"


@pytest.mark.asyncio
async def test_a_board_that_names_its_own_address():
    resp = await _through_qemu(
        "", httpx.Response(302, headers={"location": "http://192.168.4.15/setup?step=2"}))
    assert resp.headers["location"] == PREFIX + "setup?step=2"


@pytest.mark.asyncio
async def test_the_browser_side_boards_too():
    board = Response(status_code=302, headers={"location": "http://10.13.37.42/login"})
    resp = await _through_overlay("", board)
    assert resp.headers["location"] == PREFIX + "login"


@pytest.mark.asyncio
async def test_a_redirect_elsewhere_is_the_boards_to_make():
    resp = await _through_qemu("", httpx.Response(302, headers={"location": "https://example.com/x"}))
    assert resp.headers["location"] == "https://example.com/x"


@pytest.mark.asyncio
async def test_content_location_and_refresh_follow():
    resp = await _through_qemu("", httpx.Response(
        200, text="saved", headers={"content-location": "/saved", "refresh": "3; url=/"}))
    assert resp.headers["content-location"] == PREFIX + "saved"
    assert resp.headers["refresh"] == "3; url=" + PREFIX


# ── The rules, one by one ──────────────────────────────────────────────────

@pytest.mark.parametrize(
    "given,expected",
    [
        ("/", PREFIX),
        ("/login", PREFIX + "login"),
        ("/a/b?x=1#top", PREFIX + "a/b?x=1#top"),
        ("http://192.168.4.15/", PREFIX),
        ("http://192.168.4.15:80/x", PREFIX + "x"),
        ("https://10.13.37.42/x?y=2", PREFIX + "x?y=2"),
        ("//192.168.4.15/a", PREFIX + "a"),
        # Already right: relative references resolve under the prefix.
        ("login", "login"),
        ("../up", "../up"),
        ("?page=2", "?page=2"),
        ("#anchor", "#anchor"),
        (PREFIX + "x", PREFIX + "x"),
        # Not the board's: left as sent.
        ("https://example.com/", "https://example.com/"),
        ("//example.com/a", "//example.com/a"),
        ("http://192.168.4.150.example.com/", "http://192.168.4.150.example.com/"),
        ("http://192.168.40.1/", "http://192.168.40.1/"),
        ("mailto:me@example.com", "mailto:me@example.com"),
        ("", ""),
    ],
)
def test_the_rules(given, expected):
    assert iot_gateway.board_url_under_prefix(given, PREFIX) == expected
