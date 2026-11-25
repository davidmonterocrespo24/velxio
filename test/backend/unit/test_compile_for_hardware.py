"""A compile for a real board is not the simulator's (`for_hardware`).

The RP2040 / RP2350 emulators show UART0 in the serial monitor, and
arduino-pico's `Serial` is the USB port, so the simulator's build of a sketch
gets `#define Serial Serial1` on top. A board flashed with that image prints
nothing over USB, which is where its user looks. The flash dialog asks for a
build without the line; every other compile keeps it, and the two never share
an artifact.

Pure Python: the process launcher the service calls is replaced by a fake
that records the sketch it was handed and drops the files a real build leaves.

Run: python -m pytest test/backend/unit/test_compile_for_hardware.py -v
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "backend"))

from app.api.routes import compile as compile_route  # noqa: E402
from app.core import hooks  # noqa: E402
from app.services.arduino_cli import ArduinoCLIService  # noqa: E402

REDIRECT = "#define Serial Serial1\n"
CODE = "void setup(){ Serial.begin(115200); }\nvoid loop(){}\n"
SKETCH = [{"name": "sketch.ino", "content": CODE}]
PICO = "rp2040:rp2040:rpipico"
XIAO = "rp2040:rp2040:seeed_xiao_rp2040"
PICO2W_RISCV = "rp2040:rp2040:rpipico2w:arch=riscv"
UNO = "arduino:avr:uno"


def _service() -> ArduinoCLIService:
    svc = object.__new__(ArduinoCLIService)
    svc.cli_path = "arduino-cli"
    svc._installed_cores = ""
    return svc


@pytest.fixture
def built(monkeypatch):
    """The sketch.ino text of every build, in order."""
    seen: list[str] = []

    def run(cmd, **_kw):
        seen.append((Path(cmd[-1]) / "sketch.ino").read_text(encoding="utf-8"))
        out = Path(cmd[cmd.index("--output-dir") + 1])
        out.mkdir(parents=True, exist_ok=True)
        for name in ("sketch.ino.bin", "sketch.ino.uf2", "sketch.ino.hex"):
            (out / name).write_bytes(b":00000001FF\n")
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr(subprocess, "run", run)
    return seen


@pytest.mark.parametrize("fqbn", [PICO, XIAO, PICO2W_RISCV])
class TestTheSketchOfAnRp2Build:
    def test_the_simulators_redirects_serial_and_is_the_default(self, built, fqbn):
        assert asyncio.run(_service().compile(SKETCH, fqbn))["success"] is True
        assert asyncio.run(_service().compile(SKETCH, fqbn, for_hardware=False))["success"] is True
        assert built == [REDIRECT + CODE, REDIRECT + CODE]

    def test_a_real_boards_is_the_users_sketch(self, built, fqbn):
        result = asyncio.run(_service().compile(SKETCH, fqbn, for_hardware=True))
        assert result["success"] is True and result["uf2_content"]
        assert built == [CODE]

    def test_the_build_differs(self, built, fqbn):
        assert _service().hardware_build_differs(fqbn) is True


@pytest.mark.parametrize("fqbn", [UNO, "ATTinyCore:avr:attinyx5:chip=85"])
def test_another_board_builds_the_same_either_way(built, fqbn):
    svc = _service()
    assert svc.hardware_build_differs(fqbn) is False
    asyncio.run(svc.compile(SKETCH, fqbn))
    asyncio.run(svc.compile(SKETCH, fqbn, for_hardware=True))
    assert built == [CODE, CODE]


def test_the_retry_without_the_manifest_is_for_the_same_target(monkeypatch, tmp_path):
    """A scoped build that missed a header runs again with every library in
    sight: still the build that was asked for."""
    scope = tmp_path / "sketchbook" / "libraries"
    scope.mkdir(parents=True)
    monkeypatch.setattr(
        hooks, "_materialize_library_scope_hook",
        lambda allowed, owner: (scope, "tok") if allowed else None,
    )
    seen: list[str] = []

    def run(cmd, **_kw):
        seen.append((Path(cmd[-1]) / "sketch.ino").read_text(encoding="utf-8"))
        if len(seen) == 1:
            return subprocess.CompletedProcess(
                cmd, 1, stdout="", stderr="sketch.ino:1:10: fatal error: X.h: No such file or directory\n")
        out = Path(cmd[cmd.index("--output-dir") + 1])
        out.mkdir(parents=True, exist_ok=True)
        (out / "sketch.ino.uf2").write_bytes(b"UF2\n")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", run)
    result = asyncio.run(_service().compile(
        SKETCH, PICO, allowed_libraries={"X"}, for_hardware=True))
    assert result["success"] is True and result["manifest_incomplete"] is True
    assert seen == [CODE, CODE]


class TestTheJobKey:
    """The artifact cache and the in-flight dedup are keyed by it."""

    def test_a_board_is_never_handed_the_simulators_build(self):
        key = compile_route._job_key
        assert key(SKETCH, PICO, for_hardware=True) != key(SKETCH, PICO)

    def test_a_simulator_build_keeps_its_key(self):
        key = compile_route._job_key
        assert key(SKETCH, PICO, for_hardware=False) == key(SKETCH, PICO)


class TestTheRequest:
    def test_it_is_off_unless_asked_for(self):
        assert compile_route.CompileRequest(files=SKETCH, board_fqbn=PICO).for_hardware is False

    @pytest.mark.parametrize("asked", [True, False])
    def test_it_reaches_the_compiler(self, monkeypatch, asked):
        got: dict = {}

        async def _compile(files, fqbn, **kw):
            got.update(kw)
            return {"success": True, "binary_content": "AA==", "uf2_content": "AA=="}

        async def _core(_fqbn):
            return {"needed": False}

        monkeypatch.setattr(compile_route.arduino_cli, "compile", _compile)
        monkeypatch.setattr(compile_route.arduino_cli, "ensure_core_for_board", _core)
        req = compile_route.CompileRequest(files=SKETCH, board_fqbn=PICO, for_hardware=asked)
        out = asyncio.run(compile_route._run_compile(req, SKETCH, scope=(None, None)))
        assert out.success is True and got["for_hardware"] is asked

    @pytest.mark.parametrize(
        "fqbn,own_job", [(PICO, True), (PICO2W_RISCV, True), (UNO, False), ("esp32:esp32:esp32", False)],
    )
    def test_start_keys_the_job_on_it_only_where_the_build_differs(self, monkeypatch, fqbn, own_job):
        """Through /compile/start, where the key is made: on a board whose
        real firmware is the simulator's, a flash is served the same job."""
        keys: list[str] = []
        real_key = compile_route._job_key

        def _key(*a, **kw):
            keys.append(real_key(*a, **kw))
            return keys[-1]

        async def _job(*_a, **_kw):
            return None

        monkeypatch.setattr(compile_route, "_job_key", _key)
        monkeypatch.setattr(compile_route, "_compile_job", _job)
        monkeypatch.setattr(compile_route, "_artifact_load", lambda _key: None)
        monkeypatch.setattr(compile_route, "COMPILE_JOBS", {})
        monkeypatch.setattr(compile_route, "JOB_BY_KEY", {})

        async def _start(for_hardware: bool):
            req = compile_route.CompileRequest(files=SKETCH, board_fqbn=fqbn, for_hardware=for_hardware)
            await compile_route.compile_start(req, SimpleNamespace(headers={}), None)

        asyncio.run(_start(False))
        asyncio.run(_start(True))
        assert (keys[0] != keys[1]) is own_job


def test_the_mcp_tool_passes_it_on(monkeypatch):
    server = pytest.importorskip("app.mcp.server")
    got: list[bool] = []

    async def _compile(_files, _board, for_hardware=False):
        got.append(for_hardware)
        return {"success": True}

    monkeypatch.setattr(server._arduino, "compile", _compile)
    asyncio.run(server.compile_project(files=SKETCH, board=PICO))
    asyncio.run(server.compile_project(files=SKETCH, board=PICO, for_hardware=True))
    asyncio.run(server.run_project(files=SKETCH, board=PICO))
    assert got == [False, True, False]
