"""An ESP32 Arduino sketch built by Velxio runs loop() where the Arduino IDE does.

The template wrapper (esp-idf-template/main/main.cpp) called setup() and
loop() from app_main, which ESP-IDF runs on core 0, so "Arduino runs on core"
in Board Options never moved them and a sketch that pinned its own task to
core 0 (the core the Arduino IDE leaves to the sketch) shared it with loop():
the Skythread handheld ran at 18.8 fps on the board where it makes 26
("loop on core 0, panel push task on core 0", 2026-11-27). The wrapper now
runs them in a task on ARDUINO_RUNNING_CORE, as the Arduino core does.

It also slept a tick after every pass of loop(), which the simulator needs
(a sketch polling in a tight loop lets the emulator idle) and a board does
not: loop() was capped at about 1000 passes a second. A build for a real
board (for_hardware) runs loop() back to back; the simulator's keeps the
sleep. The flash dialog asks for that build for every ESP32 Arduino sketch.

Pure Python: the template read as text, and the real _compile_in_dir with
cmake and ninja faked (the harness of test_esp32_hardware_wifi.py).

Run: python -m pytest test/backend/unit/test_esp32_loop_task.py -v
"""
from __future__ import annotations

import logging
import re
import time

import pytest

from .test_esp32_hardware_wifi import BLINK, IDF_HOME, _Build, _sketch, ec  # noqa: F401

TEMPLATE_MAIN = ec._TEMPLATE_DIR / "main" / "main.cpp"


def _app_main_body(text: str) -> str:
    start = text.index('extern "C" void app_main(void)')
    return text[start:text.index("\n}\n", start)]


@pytest.fixture
def build(tmp_path, monkeypatch) -> _Build:
    return _Build(tmp_path, monkeypatch)


class TestTheTemplateWrapper:
    def test_setup_and_loop_run_in_a_task_on_the_running_core(self):
        text = TEMPLATE_MAIN.read_text(encoding="utf-8")
        body = _app_main_body(text)
        assert "loop();" not in body and "setup();" not in body
        assert re.search(r"xTaskCreateUniversal\(velxioLoopTask,[^;]*VELXIO_LOOP_CORE\);", body)
        assert re.search(r"#define VELXIO_LOOP_CORE ARDUINO_RUNNING_CORE\n", text)

    def test_the_task_is_the_arduino_cores_loop_task(self):
        """Its handle (enableLoopWDT reads it) and the stack a sketch can set
        with SET_LOOP_TASK_STACK_SIZE, as in the core's own main.cpp."""
        text = TEMPLATE_MAIN.read_text(encoding="utf-8")
        assert "extern TaskHandle_t loopTaskHandle;" in text
        assert "&loopTaskHandle" in _app_main_body(text)
        assert "__attribute__((weak)) size_t getArduinoLoopTaskStackSize(void)" in text
        assert "getArduinoLoopTaskStackSize()" in _app_main_body(text)

    def test_it_carries_the_line_a_build_for_a_board_rewrites(self):
        assert TEMPLATE_MAIN.read_text(encoding="utf-8").count(ec._LOOP_YIELD_SIM_LINE) == 1


class TestTheLoopOfEachBuild:
    def test_the_simulators_build_sleeps_a_tick_after_every_loop(self, build):
        build.run(_sketch(BLINK))
        assert build.result["success"] is True
        assert ec._LOOP_YIELD_SIM_LINE in build.text("main.cpp")

    def test_a_real_boards_runs_loop_back_to_back(self, build):
        build.run(_sketch(BLINK), for_hardware=True)
        assert build.result["success"] is True
        text = build.text("main.cpp")
        assert ec._LOOP_YIELD_BOARD_LINE in text and ec._LOOP_YIELD_SIM_LINE not in text
        # Only that line: the rest of the wrapper is the template's.
        assert text.replace(ec._LOOP_YIELD_BOARD_LINE, ec._LOOP_YIELD_SIM_LINE) == (
            TEMPLATE_MAIN.read_text(encoding="utf-8")
        )

    def test_the_next_simulator_build_compiles_the_sleep_again(self, build, tmp_path, monkeypatch):
        """The shared variant dir: the board's wrapper was compiled there, and
        the template's comes back with the template's old mtime. Even with the
        hardware build's leftovers still in place (as if _forget_hardware_build
        had failed), the wrapper gets a new mtime, so ninja compiles it again
        instead of linking the board's object into a simulator build."""
        monkeypatch.setattr(ec, "_BUILD_ROOT", tmp_path / "variants")
        monkeypatch.setattr(ec, "_idf_version_signature", lambda: "test")
        build.run(_sketch(BLINK), warm=True)
        build.run(_sketch(BLINK), warm=True, for_hardware=True)
        assert ec._LOOP_YIELD_BOARD_LINE in build.text("main.cpp")
        before = time.time_ns()
        build.run(_sketch(BLINK), warm=True)
        assert ec._LOOP_YIELD_SIM_LINE in build.text("main.cpp")
        assert (build.main / "main.cpp").stat().st_mtime_ns >= before

    def test_a_sketch_with_its_own_app_main_is_built_as_ever(self, build):
        files = _sketch(BLINK) + [{"name": "entry.cpp", "content": 'extern "C" void app_main(void) {}\n'}]
        build.run(files, for_hardware=True)
        assert build.result["success"] is True
        assert not (build.main / "main.cpp").exists()

    def test_a_pure_esp_idf_project_has_no_wrapper_to_touch(self, build):
        build.run([{"name": "main.c", "content": IDF_HOME}], pure_idf=True, for_hardware=True)
        assert build.result["success"] is True
        assert not (build.main / "main.cpp").exists()


class TestTheRewrite:
    def test_a_wrapper_without_the_line_is_left_alone_and_logged(self, tmp_path, caplog):
        main_cpp = tmp_path / "main.cpp"
        main_cpp.write_text('extern "C" void app_main(void) {}\n', encoding="utf-8")
        with caplog.at_level(logging.WARNING):
            assert ec._wrapper_for_hardware(main_cpp) is False
        assert main_cpp.read_text(encoding="utf-8") == 'extern "C" void app_main(void) {}\n'
        assert "VELXIO_LOOP_YIELD" in caplog.text

    def test_no_wrapper_at_all(self, tmp_path):
        assert ec._wrapper_for_hardware(tmp_path / "main.cpp") is False
