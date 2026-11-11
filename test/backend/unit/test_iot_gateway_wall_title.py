"""The IoT gateway's 402 page takes its heading from the overlay's block detail.

The OSS route renders the upgrade page an overlay's gate asks for. Its heading
was fixed text, "IoT gateway is a Maker feature", so an overlay whose cheapest
unlocking plan is not Maker could change the paragraph (the detail's message)
but not the heading above it (velxio/velxio-prod#176). The detail may now carry
a `title`; without one the page reads as before.
"""

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend"))

from app.api.routes.iot_gateway import router  # noqa: E402
from app.core import hooks  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    def install(detail):
        async def gate(_request):
            return detail

        monkeypatch.setattr(hooks, "_iot_gateway_gate_hook", gate)

    app = FastAPI()
    app.include_router(router, prefix="/api/gateway")
    return TestClient(app), install


def wall(c):
    return c.get("/api/gateway/sess-1::esp32/", headers={"accept": "text/html"})


def test_the_heading_comes_from_the_detail(client):
    c, install = client
    install({"message": "Every paid plan has it.", "title": "IoT gateway needs a paid plan"})
    r = wall(c)
    assert r.status_code == 402
    assert "<h1>IoT gateway needs a paid plan</h1>" in r.text
    assert "Maker" not in r.text


def test_without_a_title_the_page_reads_as_before(client):
    c, install = client
    install({"message": "Every paid plan has it."})
    r = wall(c)
    assert r.status_code == 402
    assert "<h1>IoT gateway is a Maker feature</h1>" in r.text
