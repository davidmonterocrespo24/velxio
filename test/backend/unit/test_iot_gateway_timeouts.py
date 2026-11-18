"""What the gateway says when the board does not answer (velxio/velxio-prod#180).

Two dead ends, two answers:
- nothing listens on port 80: "No web server on this board" (404);
- the board did not reply in time: "The board did not answer in time" (408),
  with the seconds the proxy waited and no claim that a server is there,
  since a slow handler, a throttled simulation and a board that has not
  answered the connection yet all look the same from here.

On the QEMU lane slirp's host forward accepts the connection before it dials
the board, so "nothing listens" reaches the proxy as a connection closed
without a reply, not as a refused connect. That escaped the proxy as a 500,
and its timeout page said "A web server is listening on this board". These
tests stand up real sockets that behave like that forward.
"""

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend"))

from app.api.routes import iot_gateway  # noqa: E402


def _request(accept: str = "application/json") -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/gateway/c1/",
        "raw_path": b"/api/gateway/c1/",
        "query_string": b"",
        "headers": [(b"accept", accept.encode())],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8001),
        "scheme": "http",
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(scope, receive)


async def _forward(on_connect):
    """A local port that accepts like slirp's host forward and then runs
    `on_connect(reader, writer)`. Returns (server, port)."""
    server = await asyncio.start_server(on_connect, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


async def _proxy(port: int, accept: str = "application/json"):
    return await iot_gateway._proxy_esp32(
        SimpleNamespace(wifi_hostfwd_port=port), "", _request(accept))


@pytest.mark.asyncio
async def test_nothing_listening_behind_the_forward_is_no_server():
    """The board's stack resets the connection; slirp closes the host side."""
    async def close_at_once(reader, writer):
        writer.close()

    server, port = await _forward(close_at_once)
    async with server:
        resp = await _proxy(port)
    assert resp.status_code == 404
    assert json.loads(resp.body)["error"] == "no_server_on_board"


@pytest.mark.asyncio
async def test_a_reply_cut_short_is_no_server_either():
    async def read_then_close(reader, writer):
        await reader.read(100)
        writer.close()

    server, port = await _forward(read_then_close)
    async with server:
        resp = await _proxy(port)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_a_board_that_does_not_reply_in_time():
    hold = asyncio.Event()

    async def never_reply(reader, writer):
        await hold.wait()
        writer.close()

    # The proxy waits 10 s; this one gives up after 0.3 s to keep the test short.
    real_client = iot_gateway.httpx.AsyncClient

    def client(**kwargs):
        return real_client(**{**kwargs, "timeout": 0.3})

    server, port = await _forward(never_reply)
    try:
        with patch.object(iot_gateway.httpx, "AsyncClient", side_effect=client):
            resp = await _proxy(port, accept="text/html")
    finally:
        hold.set()
        server.close()
        await server.wait_closed()
    assert resp.status_code == 408
    page = resp.body.decode()
    assert "The board did not answer in time" in page
    assert "within 10 seconds" in page
    assert "listening" not in page


def test_the_timeout_answer_carries_the_wait_it_had():
    resp = iot_gateway.board_timeout_response(_request(), 12)
    assert resp.status_code == 408
    body = json.loads(resp.body)
    assert body["error"] == "board_server_timeout"
    assert "within 12 seconds" in body["message"]
    assert "listening" not in body["message"]
