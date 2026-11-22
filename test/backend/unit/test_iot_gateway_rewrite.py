"""The IoT gateway serves a board's root-relative page under a path prefix.

A sketch's page owns its whole origin on real hardware, so it asks for
"/led?state=1". Served from /api/gateway/<client_id>/ that resolves against
the site root, misses the proxy, and hits the SPA — which answers 200 with
its own index.html, so the page's .catch() never fires and nothing reaches
the board (velxio#274). These tests pin the shim that fixes it.
"""

import json
import sys
from pathlib import Path

import pytest
from fastapi import Response

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend"))

from app.api.routes.iot_gateway import (  # noqa: E402
    _gateway_prefix,
    _rewrite_html,
)

PREFIX = "/api/gateway/sess-1::esp32/"


class FakeUrl:
    def __init__(self, path):
        self.path = path


class FakeRequest:
    def __init__(self, path):
        self.url = FakeUrl(path)


def html(body: str, status: int = 200) -> Response:
    return Response(content=body, status_code=status, media_type="text/html")


def shimmed(body: str) -> str:
    return _rewrite_html(html(body), PREFIX).body.decode()


# ── prefix derivation ──────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "req_path,path,expected",
    [
        ("/api/gateway/sess-1::esp32/", "", "/api/gateway/sess-1::esp32/"),
        ("/api/gateway/sess-1::esp32/led", "led", "/api/gateway/sess-1::esp32/"),
        ("/api/gateway/sess-1::esp32/a/b.css", "a/b.css", "/api/gateway/sess-1::esp32/"),
        # A path that also appears inside the client id must not confuse it:
        # the suffix is stripped by length, not by searching.
        ("/api/gateway/led::led/led", "led", "/api/gateway/led::led/"),
    ],
)
def test_prefix_comes_from_the_request(req_path, path, expected):
    assert _gateway_prefix(FakeRequest(req_path), path) == expected


def test_prefix_always_ends_in_a_slash():
    assert _gateway_prefix(FakeRequest("/api/gateway/x"), "").endswith("/")


# ── what gets the shim ─────────────────────────────────────────────────────

def test_shim_lands_after_head_so_it_beats_the_page_script():
    out = shimmed("<html><head><title>x</title></head><body>hi</body></html>")
    assert out.index("__velxioGatewayShim") < out.index("<title>")


def test_a_fragment_without_head_still_gets_it():
    assert "__velxioGatewayShim" in shimmed("<div>hello</div>")


def test_the_prefix_is_embedded_as_a_json_string():
    assert json.dumps(PREFIX) in shimmed("<html><head></head></html>")


def test_non_html_is_never_touched():
    for ctype in ("application/json", "text/plain", "image/png", "text/css"):
        r = Response(content=b'{"a":1}', status_code=200, media_type=ctype)
        assert _rewrite_html(r, PREFIX).body == b'{"a":1}'


def test_an_empty_body_is_passed_through():
    r = Response(content=b"", status_code=204, media_type="text/html")
    assert _rewrite_html(r, PREFIX).body == b""


def test_status_and_headers_survive():
    # The headers a page is given (see test_iot_gateway_headers.py for the
    # ones it is not) come through the injection with the status.
    r = Response(
        content="<html><head></head></html>",
        status_code=418,
        media_type="text/html",
        headers={"cache-control": "no-cache", "etag": '"v1"'},
    )
    out = _rewrite_html(r, PREFIX)
    assert out.status_code == 418
    assert out.headers["cache-control"] == "no-cache"
    assert out.headers["etag"] == '"v1"'


def test_content_length_is_recomputed_not_inherited():
    # Inheriting the upstream length truncates the page at exactly the byte
    # where the original ended, which renders as a blank or half-drawn UI.
    body = "<html><head></head><body>x</body></html>"
    out = _rewrite_html(html(body), PREFIX)
    assert int(out.headers["content-length"]) == len(out.body)
    assert len(out.body) > len(body)


def test_utf8_page_survives_the_injection():
    body = "<html><head><meta charset='utf-8'></head><body>Helligkeit ändern °C</body></html>"
    out = shimmed(body)
    assert "Helligkeit ändern °C" in out


# ── the shim's own logic, exercised as the browser would ───────────────────

def _rw(url: str, page: str = PREFIX) -> str:
    """Run the injected rewrite() through a JS engine if one is available."""
    import shutil
    import subprocess
    import textwrap

    node = shutil.which("node")
    if node is None:  # pragma: no cover - CI always has node
        pytest.skip("node not available")
    script = _rewrite_html(html("<html><head></head></html>"), PREFIX).body.decode()
    start = script.index("<script>") + len("<script>")
    body = script[start : script.index("</script>", start)]
    harness = textwrap.dedent(
        f"""
        globalThis.window = globalThis;
        globalThis.location = new URL("https://velxio.dev{page}");
        globalThis.document = {{
          readyState: "complete",
          addEventListener() {{}},
          querySelectorAll: () => [],
          documentElement: {{}},
        }};
        globalThis.XMLHttpRequest = function () {{}};
        globalThis.XMLHttpRequest.prototype = {{ open() {{}} }};
        {body}
        process.stdout.write(String(window.__velxioGatewayRewrite({json.dumps(url)})));
        """
    )
    return subprocess.run(
        [node, "-e", harness], capture_output=True, text=True, timeout=30, check=True
    ).stdout


@pytest.mark.parametrize(
    "given,expected",
    [
        # The reported case.
        ("/led?state=1", PREFIX + "led?state=1"),
        ("/slider?value=128", PREFIX + "slider?value=128"),
        ("/", PREFIX),
        # Already correct, must not be doubled.
        ("led", "led"),
        ("./led", "./led"),
        (PREFIX + "led", PREFIX + "led"),
        # Not navigation at all.
        ("#section", "#section"),
        ("data:text/plain,hi", "data:text/plain,hi"),
        ("javascript:void(0)", "javascript:void(0)"),
        ("mailto:a@b.c", "mailto:a@b.c"),
        # Someone else's server stays someone else's server.
        ("https://api.example.com/v1", "https://api.example.com/v1"),
        # A sketch that printed its own emulated IP into the page.
        ("http://192.168.4.15/led?state=1", PREFIX + "led?state=1"),
        ("http://10.13.37.2/api/on", PREFIX + "api/on"),
    ],
)
def test_rewrite_rules(given, expected):
    assert _rw(given) == expected
