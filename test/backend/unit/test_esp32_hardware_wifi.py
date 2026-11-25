"""An ESP32 flashed from Velxio joins the network its sketch names.

The simulated radios beacon a fixed set of open networks, so the simulator's
build of a WiFi sketch has its SSID swapped for one of them, its password
dropped and a channel hint added. The flash dialog wrote that same image to
the real board, which then looked for "Velxio-GUEST" in the user's home and
never joined anything.

A compile request that says `for_hardware` is now built from the sources as
they were written, as a job of its own. It is asked for only where that
changes the image: the result of a simulator build says `wifi_rewritten`,
which the build itself reads off what its normalizers did, and the flash
dialog asks for its own build only then. A sketch without WiFi, one that is
left as written, and a project with its own access points are flashed with
the simulator's image and build nothing.

What such a build leaves behind with the password in it is kept short: its
result is not written to the artifact cache, its sources, objects and images
are removed from the shared build directory before anyone else builds there,
it stores nothing in ccache, and the server log gets its output without the
user's text.

Pure Python: these drive the real _compile_in_dir with cmake and ninja faked
and read the files the build wrote into main/.

Run: python -m pytest test/backend/unit/test_esp32_hardware_wifi.py -v
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "backend"))

from app.api.routes import compile as compile_route  # noqa: E402
from app.services import espidf_compiler as ec  # noqa: E402

ESP32 = "esp32:esp32:esp32"
PICO = "rp2040:rp2040:rpipico"

HOME = (
    '#include <WiFi.h>\n'
    'void setup(){ WiFi.begin("MyHome", "hunter2"); }\n'
    'void loop(){}\n'
)
SECRETS_INO = (
    '#include <WiFi.h>\n'
    '#include "secrets.h"\n'
    'void setup(){ WiFi.begin(SECRET_SSID, SECRET_PASS); }\n'
    'void loop(){}\n'
)
SECRETS_H = '#define SECRET_SSID "MyHome"\n#define SECRET_PASS "hunter2"\n'
BLINK = 'void setup(){ pinMode(2, OUTPUT); }\nvoid loop(){}\n'
# Already what the simulator would make of it: nothing to rewrite.
AS_THE_SIMULATOR_WANTS = (
    '#include <WiFi.h>\n'
    'void setup(){ WiFi.begin("Velxio-GUEST", "", 6); }\n'
    'void loop(){}\n'
)
IDF_HOME = (
    '#include "esp_wifi.h"\n'
    '#define WIFI_SSID "MyHome"\n'
    '#define WIFI_PASS "hunter2"\n'
    'void app_main(void) { wifi_config_t c = { .sta = { .ssid = "MyHome", .password = "hunter2" } }; }\n'
)


def _sketch(code: str, **more: str) -> list[dict]:
    return [{"name": "sketch.ino", "content": code}] + [
        {"name": name.replace("_h", ".h"), "content": text} for name, text in more.items()
    ]


def _virtual(ssid: str) -> str:
    return (
        '#include <WiFi.h>\n'
        f'const char* ssid = "{ssid}";\n'
        'void setup(){ WiFi.begin(ssid, "", 11); }\n'
        'void loop(){}\n'
    )


class _Build:
    """One run of the real _compile_in_dir, the toolchain faked."""

    def __init__(self, tmp_path: Path, monkeypatch, ninja_output: str | None = None):
        self.root = tmp_path
        self.lines: list[str] = []
        self.result: dict = {}
        self._ninja_output = ninja_output
        self.commands: list[str] = []
        self.ccache_readonly: list[str | None] = []
        monkeypatch.setattr(ec, "_run_with_streaming", self._toolchain)

    def _toolchain(self, cmd, cwd=None, env=None, timeout=None, progress_callback=None, nice=None):
        build = Path(cwd)
        self.commands.append(Path(cmd[0]).name)
        self.ccache_readonly.append((env or {}).get("CCACHE_READONLY"))
        if Path(cmd[0]).name == "cmake":
            (build / "CMakeCache.txt").write_text("cache", encoding="utf-8")
            (build / "build.ninja").write_text("rules", encoding="utf-8")
            return ec._RunResult(0, "-- Configuring done", "")
        if self._ninja_output is not None:
            return ec._RunResult(1, self._ninja_output, self._ninja_output)
        for rel in ("bootloader/bootloader.bin", "partition_table/partition-table.bin"):
            (build / rel).parent.mkdir(parents=True, exist_ok=True)
            (build / rel).write_bytes(b"\x01")
        # What the sources say ends up in every object and image, as strings.
        linked = b"".join(
            path.read_bytes() for path in sorted((build.parent / "main").iterdir()) if path.is_file()
        )
        for rel in (
            "esp-idf/main/CMakeFiles/__idf_main.dir/sketch.ino.cpp.obj", "esp-idf/main/libmain.a",
            "esp-idf/arduino/libarduino.a", "velxio-sketch.elf", "velxio-sketch.map", "velxio-sketch.bin",
        ):
            (build / rel).parent.mkdir(parents=True, exist_ok=True)
            (build / rel).write_bytes(b"core" if "arduino" in rel else linked)
        return ec._RunResult(0, "[1/1] Linking", "")

    def run(self, files: list[dict], *, pure_idf: bool = False, warm: bool = False, **kw) -> "_Build":
        """`warm` builds in the directory the last run left, prepared as the
        compiler prepares a variant's between two builds."""
        project = self.root / "p" / "project"
        if warm:
            project = ec._prepare_persistent_project_dir("p", "default")
            (project / "build").mkdir(exist_ok=True)
        else:
            shutil.rmtree(project.parent, ignore_errors=True)
            shutil.copytree(ec._TEMPLATE_DIR, project)
            (project / "build").mkdir()
        self.project = project
        (self.root / "libs").mkdir(exist_ok=True)
        self.lines.clear()
        self.result = asyncio.run(ec.ESPIDFCompiler()._compile_in_dir(
            project, files, "esp32", progress_callback=self.lines.append,
            arduino_mode=not pure_idf, use_idf5=True, pure_idf=pure_idf,
            libraries_dir=self.root / "libs", **kw,
        ))
        self.main = project / "main"
        return self

    def text(self, name: str) -> str:
        return (self.main / name).read_text(encoding="utf-8")

    def notes(self) -> list[str]:
        return [ln for ln in self.lines if "not part of the emulated network" in ln]


@pytest.fixture
def build(tmp_path, monkeypatch) -> _Build:
    return _Build(tmp_path, monkeypatch)


class TestTheSourcesOfAHardwareBuild:
    def test_the_simulators_build_swaps_the_network_and_says_so(self, build):
        build.run(_sketch(HOME))
        assert 'WiFi.begin("Velxio-GUEST", "", 6)' in build.text("sketch.ino.cpp")
        assert "hunter2" not in build.text("sketch.ino.cpp")
        assert len(build.notes()) == 1

    def test_a_real_boards_keeps_the_network_and_its_password(self, build):
        build.run(_sketch(HOME), for_hardware=True)
        assert 'WiFi.begin("MyHome", "hunter2");' in build.text("sketch.ino.cpp")
        assert "Velxio-GUEST" not in build.text("sketch.ino.cpp")
        assert build.notes() == []
        assert build.result["success"] is True

    def test_a_secrets_header_reaches_the_board_as_written(self, build):
        build.run(_sketch(SECRETS_INO, secrets_h=SECRETS_H), for_hardware=True)
        assert build.text("secrets.h") == SECRETS_H
        assert "WiFi.begin(SECRET_SSID, SECRET_PASS);" in build.text("sketch.ino.cpp")
        assert build.notes() == []

    @pytest.mark.parametrize("ssid", ["Velxio-GUEST", "Wokwi-GUEST", "PICSimLabWifi", "Espressif"])
    def test_a_simulated_networks_name_is_the_sketchs_to_use(self, build, ssid):
        """Written on purpose: a board whose access point is called that."""
        code = _virtual(ssid)
        build.run(_sketch(code), for_hardware=True)
        built = build.text("sketch.ino.cpp")
        # Line for line (prototypes are declared between them, as always).
        assert [ln for ln in code.splitlines() if ln not in built.splitlines()] == []
        # The simulator's build of the same sketch is another text.
        build.run(_sketch(code))
        assert 'WiFi.begin(ssid, "", 11)' not in build.text("sketch.ino.cpp")

    def test_a_pure_esp_idf_project_too(self, build):
        files = [{"name": "main.c", "content": IDF_HOME}]
        build.run(files, pure_idf=True)
        assert "MyHome" not in build.text("main.c") and "hunter2" not in build.text("main.c")
        assert len(build.notes()) == 1
        build.run(files, pure_idf=True, for_hardware=True)
        assert build.text("main.c") == IDF_HOME
        assert build.notes() == []


# (files, pure_idf, custom_wifi_ssids) -> does the simulator's build differ?
CASES = {
    "a home network": (_sketch(HOME), False, None, True),
    "a home network in a header": (_sketch(SECRETS_INO, secrets_h=SECRETS_H), False, None, True),
    "a simulated network with a password": (_sketch(_virtual("Velxio-GUEST")), False, None, True),
    "a sketch the simulator leaves as written": (_sketch(AS_THE_SIMULATOR_WANTS), False, None, False),
    "no WiFi": (_sketch(BLINK), False, None, False),
    "a project with its own access points": (_sketch(HOME), False, ["MyHome"], False),
    "a pure ESP-IDF project": ([{"name": "main.c", "content": IDF_HOME}], True, None, True),
    "a pure ESP-IDF project without WiFi": (
        [{"name": "main.c", "content": 'void app_main(void) {}\n#define X_SSID "MyHome"\n'}], True, None, False),
}


@pytest.mark.parametrize("case", CASES)
class TestWhetherTheBuildsDiffer:
    def test_the_simulators_build_says_whether_it_was_rewritten(self, build, case):
        files, pure_idf, custom, differs = CASES[case]
        build.run(files, pure_idf=pure_idf, custom_wifi_ssids=custom)
        assert build.result["success"] is True
        assert build.result["wifi_rewritten"] is differs

    def test_a_hardware_build_never_is(self, build, case):
        files, pure_idf, custom, _differs = CASES[case]
        build.run(files, pure_idf=pure_idf, custom_wifi_ssids=custom, for_hardware=True)
        assert build.result["wifi_rewritten"] is False

    def test_what_the_build_says_is_what_its_normalizers_did(self, build, monkeypatch, case):
        """An overlay wraps the normalizers and may hold a rewrite back: the
        sources are then built as written, and the result must say so. Only
        the build knows; nothing outside it asks the normalizers."""
        files, pure_idf, custom, _differs = CASES[case]
        monkeypatch.setattr(
            ec.ESPIDFCompiler, "_normalize_wifi_sources", lambda self, sources, replaced=None: list(sources))
        monkeypatch.setattr(
            ec.ESPIDFCompiler, "_normalize_wifi_for_qemu_idf", lambda self, code, replaced=None: code)
        build.run(files, pure_idf=pure_idf, custom_wifi_ssids=custom)
        assert build.result["success"] is True and build.result["wifi_rewritten"] is False


def test_the_rewrites_are_named_only_where_the_request_is_known():
    """An overlay holds every _normalize_wifi* the compiler refers to, and
    knows the request's files only while _compile_in_dir runs. A reference
    from anywhere else would run them with no request to check against."""
    import ast
    import inspect
    import re

    family = re.compile(r"_normalize_wifi\w*")
    allowed = {"_compile_in_dir", "_normalize_wifi_for_qemu", "_normalize_wifi_for_qemu_idf",
               "_normalize_wifi_sources"}
    functions = (ast.FunctionDef, ast.AsyncFunctionDef)
    elsewhere: set[str] = set()
    for stmt in ast.parse(inspect.getsource(ec)).body:
        if isinstance(stmt, ast.ClassDef) and stmt.name == "ESPIDFCompiler":
            parts = [(i.name if isinstance(i, functions) else "ESPIDFCompiler", i) for i in stmt.body]
        else:
            parts = [(getattr(stmt, "name", "<module>"), stmt)]
        for where, node in parts:
            for n in ast.walk(node):
                name = (
                    n.attr if isinstance(n, ast.Attribute)
                    else n.id if isinstance(n, ast.Name)
                    else n.value if isinstance(n, ast.Constant) and isinstance(n.value, str)
                    else None
                )
                if name and family.fullmatch(name) and where not in allowed:
                    elsewhere.add(where)
    assert elsewhere == set()


class TestNothingNewTellsTheCredentials:
    DIAGNOSTIC = (
        'FAILED: esp-idf/main/sketch.ino.cpp.obj\n'
        'sketch.ino:2:15: error: too many arguments\n'
        '    2 | void setup(){ WiFi.begin("MyHome", "hunter2", 1, 2, 3, 4, 5); }\n'
    )

    def test_the_server_log_of_a_failed_hardware_build_has_no_string(self, tmp_path, monkeypatch, caplog):
        failing = _Build(tmp_path, monkeypatch, ninja_output=self.DIAGNOSTIC)
        with caplog.at_level(logging.DEBUG):
            failing.run(_sketch(HOME), for_hardware=True)
        assert failing.result["success"] is False
        assert "too many arguments" in caplog.text
        assert "hunter2" not in caplog.text and "MyHome" not in caplog.text
        # The user is shown their own build's output whole.
        assert "hunter2" in failing.result["stderr"]

    def test_the_log_of_a_good_one_neither(self, build, caplog):
        with caplog.at_level(logging.DEBUG):
            build.run(_sketch(HOME), for_hardware=True)
        assert build.result["success"] is True
        assert "hunter2" not in caplog.text and "MyHome" not in caplog.text

    # The reviewer's probe: a line that begins inside a string. Pairing its
    # quotes masks the code and prints the strings.
    PROBE = 'ecret"; const char* a = "x"; b("y")'

    def test_a_line_is_cut_from_its_first_quote(self):
        said = ec._without_user_text('a.cpp:1: error: f("p\\"w", "x") in "a.cpp"\nnote: ok\n')
        assert said == 'a.cpp:1: error: f("...\nnote: ok\n'

    def test_an_odd_number_of_quotes_does_not_turn_it_inside_out(self):
        said = ec._without_user_text('x.cpp:3: warning: missing terminating " character: "MyHome\n')
        assert "MyHome" not in said and said.startswith("x.cpp:3: warning: missing terminating")

    def test_the_line_the_tail_was_cut_in_is_dropped(self):
        after = "\nsketch.ino:2: error: after\n"
        output = "x" * 50 + 'char p[] = "s' + self.PROBE + after
        assert ec._log_tail(output, len(self.PROBE) + len(after), user_text=False) == after[1:]
        # A simulator build's tail is what it always was.
        assert ec._log_tail(output, 30) == output[-30:]

    def test_a_tail_that_was_not_cut_keeps_its_first_line(self):
        assert ec._log_tail("FAILED: a.obj\nerror: x\n", 4000, user_text=False) == "FAILED: a.obj\nerror: x\n"

    def test_a_source_line_gcc_quotes_keeps_its_gutter_only(self):
        """It is shown alone: the second line of a continued string has no
        opening quote, and nothing on it says it is one."""
        said = ec._without_user_text(
            "sketch.ino:3:1: error: stray\n"
            "    3 | " + self.PROBE + "\n"
            "      | ^~~~~\n"
            "   12 | hunter2 and the rest of the password\n"
        )
        assert "ecret" not in said and "hunter2" not in said
        assert said.splitlines()[:2] == ["sketch.ino:3:1: error: stray", "    3 | ..."]

    def test_the_line_after_a_backslash_continues_the_string(self):
        said = ec._without_user_text('#define PASS "hun\\\n' + self.PROBE + "\nerror: next\n")
        assert said == '#define PASS "...\n...\nerror: next\n'

    def test_a_tail_cut_in_a_continued_line_drops_what_continues_it(self):
        rest = "\\\n" + self.PROBE + "\nerror: next\n"
        output = "x" * 50 + '"hun' + rest
        assert ec._log_tail(output, len(rest) + 2, user_text=False) == "...\nerror: next\n"

    def test_a_raw_string_goes_to_its_end_on_whichever_line(self):
        said = ec._without_user_text(
            'const char* page = R"html(<p>\n' + self.PROBE + '\nhunter2 )html";\nerror: next\n'
            'auto one = R"(here)"; int ok;\nerror: last\n'
        )
        assert said == (
            'const char* page = R"...\n...\n...\nerror: next\n'
            'auto one = R"...\nerror: last\n'
        )

    def test_the_failed_build_log_goes_through_it(self, tmp_path, monkeypatch, caplog):
        """Past the 4000 characters the log keeps, on lines of every kind."""
        output = (
            'char first[] = "' + "p" * 4000 + self.PROBE + "\n"
            "sketch.ino:9:1: error: expected\n"
            "    9 | hunter2 continued\n"
            'const char* q = R"x(MyHome\n'
            'hunter2 )x";\n'
        )
        failing = _Build(tmp_path, monkeypatch, ninja_output=output)
        with caplog.at_level(logging.DEBUG):
            failing.run(_sketch(HOME), for_hardware=True)
        assert "error: expected" in caplog.text
        for secret in ("ecret", "hunter2", "MyHome", "ppp"):
            assert secret not in caplog.text, secret
        caplog.clear()
        with caplog.at_level(logging.DEBUG):
            failing.run(_sketch(HOME))
        assert "ecret" in caplog.text  # the simulator's log is as it was

    def test_the_result_names_no_network(self, build):
        build.run(_sketch(HOME))
        said = {k: v for k, v in build.result.items() if k not in ("binary_content",)}
        assert "MyHome" not in repr(said) and "hunter2" not in repr(said)
        build.run(_sketch(HOME), for_hardware=True)
        said = {k: v for k, v in build.result.items() if k not in ("binary_content",)}
        assert "MyHome" not in repr(said) and "hunter2" not in repr(said)


class TestCompilePassesItDown:
    @pytest.mark.parametrize("persistent", [False, True])
    def test_to_the_build_in_the_directory(self, monkeypatch, tmp_path, persistent):
        """Whichever directory it builds in: a throwaway one, or the warm
        one its variant shares with the simulator's builds."""
        got: list[bool] = []

        async def _in_dir(self, *_a, **kw):
            got.append(kw["for_hardware"])
            return {"success": True}

        monkeypatch.setattr(ec, "_USE_PERSISTENT_DIR", persistent)
        monkeypatch.setattr(ec, "_BUILD_ROOT", tmp_path)
        monkeypatch.setattr(ec, "_prepare_persistent_project_dir", lambda *_a: tmp_path / "v" / "project")
        monkeypatch.setattr(ec.ESPIDFCompiler, "available", property(lambda self: True))
        monkeypatch.setattr(ec.ESPIDFCompiler, "_compile_in_dir", _in_dir)
        compiler = ec.ESPIDFCompiler()
        asyncio.run(compiler.compile(_sketch(HOME), ESP32))
        asyncio.run(compiler.compile(_sketch(HOME), ESP32, for_hardware=True))
        assert got == [False, True]

    @pytest.mark.parametrize("for_hardware,warmed_times", [(False, 1), (True, 0)])
    def test_a_replica_is_never_warmed_with_a_hardware_build(
        self, monkeypatch, tmp_path, for_hardware, warmed_times,
    ):
        """A second copy of a busy variant is built in the background and
        its result thrown away: not from sources with a password in them."""
        warmed: list[dict] = []

        async def _in_dir(self, *_a, **_kw):
            return {"success": True}

        monkeypatch.setattr(ec, "_USE_PERSISTENT_DIR", True)
        monkeypatch.setattr(ec, "_prepare_persistent_project_dir", lambda *_a: tmp_path / "v" / "project")
        monkeypatch.setattr(ec.ESPIDFCompiler, "available", property(lambda self: True))
        monkeypatch.setattr(ec.ESPIDFCompiler, "_compile_in_dir", _in_dir)
        monkeypatch.setattr(ec.ESPIDFCompiler, "_pick_replica", staticmethod(lambda *_a: (0, 1)))
        monkeypatch.setattr(
            ec.ESPIDFCompiler, "_warm_replica_in_background",
            lambda self, *_a, **kw: warmed.append(kw),
        )
        asyncio.run(ec.ESPIDFCompiler().compile(_sketch(HOME), ESP32, for_hardware=for_hardware))
        assert len(warmed) == warmed_times
        assert all("for_hardware" not in kw for kw in warmed)


def _holding(root: Path, *words: str) -> list[str]:
    """The files under `root` that hold any of `words`."""
    found = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and any(w.encode() in path.read_bytes() for w in words):
            found.append(path.relative_to(root).as_posix())
    return found


class TestWhatAHardwareBuildLeavesInTheSharedDirectory:
    """A variant's directory is the next user's too."""

    @pytest.fixture
    def variant(self, tmp_path, monkeypatch) -> _Build:
        """Builds in the directory the compiler itself makes and resets."""
        monkeypatch.setattr(ec, "_BUILD_ROOT", tmp_path)
        monkeypatch.setattr(ec, "_idf_version_signature", lambda: "test")
        return _Build(tmp_path, monkeypatch)

    def test_the_build_itself_leaves_the_network_everywhere(self, variant):
        variant.run(_sketch(SECRETS_INO, secrets_h=SECRETS_H), warm=True, for_hardware=True)
        assert _holding(variant.project, "hunter2") == [
            "build/esp-idf/main/CMakeFiles/__idf_main.dir/sketch.ino.cpp.obj",
            "build/esp-idf/main/libmain.a",
            "build/merged_flash.bin",
            "build/velxio-sketch.bin",
            "build/velxio-sketch.elf",
            "build/velxio-sketch.map",
            "main/secrets.h",
        ]

    def test_forgetting_it_leaves_none_of_it(self, variant):
        variant.run(_sketch(SECRETS_INO, secrets_h=SECRETS_H), warm=True, for_hardware=True)
        ec._forget_hardware_build(variant.project)
        assert _holding(variant.project, "hunter2", "MyHome") == []
        record = (variant.project / ec._INPUT_DIGESTS).read_text(encoding="utf-8")
        assert "secrets.h" not in record and "sketch.ino.cpp" not in record

    def test_what_keeps_the_directory_warm_stays(self, variant):
        variant.run(_sketch(SECRETS_INO, secrets_h=SECRETS_H), warm=True, for_hardware=True)
        cmake = (variant.project / "main" / "CMakeLists.txt").read_bytes()
        ec._forget_hardware_build(variant.project)
        assert (variant.project / "main" / "CMakeLists.txt").read_bytes() == cmake
        assert "main/CMakeLists.txt" in (variant.project / ec._INPUT_DIGESTS).read_text(encoding="utf-8")
        for rel in ("build.ninja", "CMakeCache.txt", "esp-idf/arduino/libarduino.a", "bootloader/bootloader.bin"):
            assert (variant.project / "build" / rel).is_file(), rel

    @pytest.mark.parametrize("forgotten", [False, True])
    def test_the_next_build_there_is_as_fast_and_is_the_simulators(self, variant, forgotten):
        """With or without the forgetting: one configure for the two builds,
        and the second is the next user's own image."""
        variant.run(_sketch(HOME), warm=True, for_hardware=True)
        if forgotten:
            ec._forget_hardware_build(variant.project)
        variant.run(_sketch(HOME.replace("MyHome", "Theirs").replace("hunter2", "other")), warm=True)
        assert variant.commands == ["cmake", "ninja", "ninja"]
        assert variant.result["success"] is True and variant.result["wifi_rewritten"] is True
        assert 'WiFi.begin("Velxio-GUEST", "", 6)' in variant.text("sketch.ino.cpp")
        assert (variant.project / "build" / "merged_flash.bin").is_file()
        assert _holding(variant.project, "hunter2", "MyHome") == []

    def test_it_never_fails_on_a_directory_that_is_not_there(self, tmp_path):
        ec._forget_hardware_build(tmp_path / "gone")

    @pytest.mark.parametrize("outcome", ["built", "failed"])
    def test_compile_forgets_before_it_lets_go_of_the_directory(self, monkeypatch, tmp_path, outcome):
        """After a build for hardware, good or bad, and only after one; while
        the variant is still locked."""
        seen: list[tuple[str, bool]] = []
        project = tmp_path / "v" / "project"
        locked: list[bool] = []
        real_lock = ec._variant_lock

        def _lock(key):
            lock = real_lock(key)
            locked.append(lock)
            return lock

        async def _in_dir(self, *_a, **kw):
            seen.append(("build", kw["for_hardware"]))
            if outcome == "failed":
                raise RuntimeError("ninja blew up")
            return {"success": True}

        def _forget(project_dir):
            assert project_dir == project
            seen.append(("forget", locked[-1].locked()))

        monkeypatch.setattr(ec, "_USE_PERSISTENT_DIR", True)
        monkeypatch.setattr(ec, "_variant_lock", _lock)
        monkeypatch.setattr(ec, "_prepare_persistent_project_dir", lambda *_a: project)
        monkeypatch.setattr(ec, "_forget_hardware_build", _forget)
        monkeypatch.setattr(ec.ESPIDFCompiler, "available", property(lambda self: True))
        monkeypatch.setattr(ec.ESPIDFCompiler, "_compile_in_dir", _in_dir)

        def _compile(**kw):
            try:
                asyncio.run(ec.ESPIDFCompiler().compile(_sketch(HOME), ESP32, **kw))
            except RuntimeError:
                assert outcome == "failed"

        _compile()
        assert seen == [("build", False)]
        _compile(for_hardware=True)
        assert seen[1:] == [("build", True), ("forget", True)]

    def test_it_stores_no_object_in_ccache(self, build):
        build.run(_sketch(HOME))
        assert set(build.ccache_readonly) == {None}
        build.ccache_readonly.clear()
        build.run(_sketch(HOME), for_hardware=True)
        assert set(build.ccache_readonly) == {"1"}


@pytest.fixture
def idf_service(monkeypatch):
    """The route believes an ESP-IDF toolchain is installed."""
    monkeypatch.setattr(ec.ESPIDFCompiler, "available", property(lambda self: True))


@pytest.fixture
def started(monkeypatch):
    """compile_start with the job faked: [(job key, request the job got)]."""
    seen: list[tuple[str, compile_route.CompileRequest]] = []
    real_key = compile_route._job_key
    keys: list[str] = []

    def _key(*a, **kw):
        keys.append(real_key(*a, **kw))
        return keys[-1]

    async def _job(*_a, request, **_kw):
        seen.append((keys[-1], request))

    monkeypatch.setattr(compile_route, "_job_key", _key)
    monkeypatch.setattr(compile_route, "_compile_job", _job)
    monkeypatch.setattr(compile_route, "_artifact_load", lambda _key: None)
    monkeypatch.setattr(compile_route, "COMPILE_JOBS", {})
    monkeypatch.setattr(compile_route, "JOB_BY_KEY", {})

    def start(files, fqbn=ESP32, **fields):
        async def _go():
            req = compile_route.CompileRequest(files=files, board_fqbn=fqbn, **fields)
            await compile_route.compile_start(req, SimpleNamespace(headers={}), None)
            await asyncio.sleep(0)  # let the job task run

        asyncio.run(_go())
        return seen[-1]

    return start


class TestTheJobOfAnEsp32:
    """The in-flight dedup and the artifact cache are keyed by the job key."""

    def test_a_rewritten_sketch_has_a_job_for_each_target(self, idf_service, started):
        sim_key, sim_req = started(_sketch(HOME))
        hw_key, hw_req = started(_sketch(HOME), for_hardware=True)
        assert sim_key != hw_key
        assert (sim_req.for_hardware, hw_req.for_hardware) == (False, True)

    @pytest.mark.parametrize("files,fields", [
        (_sketch(BLINK), {}),
        (_sketch(AS_THE_SIMULATOR_WANTS), {}),
        (_sketch(HOME), {"custom_wifi_ssids": ["MyHome"]}),
    ])
    def test_an_esp32_is_taken_at_its_word(self, idf_service, started, files, fields):
        """Whatever the sources: only the build knows whether it rewrites
        them, so a request for hardware is a job for hardware. The dialog
        asks for one only after a simulator build said it was rewritten."""
        sim_key, _ = started(files, **fields)
        hw_key, hw_req = started(files, for_hardware=True, **fields)
        assert sim_key != hw_key
        assert hw_req.for_hardware is True

    def test_the_route_does_not_run_the_rewrites_to_decide(self, idf_service, started, monkeypatch):
        """They are the build's (an overlay holds them to the request, which
        it knows only there), and they cost seconds on a large project,
        before admission."""
        def _never(self, *_a, **_kw):
            raise AssertionError("a WiFi rewrite ran outside the build")

        for name in ("_normalize_wifi_sources", "_normalize_wifi_for_qemu", "_normalize_wifi_for_qemu_idf"):
            monkeypatch.setattr(ec.ESPIDFCompiler, name, _never)
        _, hw_req = started(_sketch(HOME), for_hardware=True)
        assert hw_req.for_hardware is True
        assert not hasattr(ec.ESPIDFCompiler, "simulator_rewrites_wifi")

    def test_a_pure_esp_idf_project_is_asked_as_one(self, idf_service, started):
        files = [{"name": "main.c", "content": IDF_HOME}]
        sim_key, _ = started(files, language="espidf")
        hw_key, hw_req = started(files, language="espidf", for_hardware=True)
        assert sim_key != hw_key and hw_req.for_hardware is True

    def test_without_the_esp_idf_service_arduino_cli_builds_it_unchanged(self, monkeypatch, started):
        """arduino-cli rewrites nothing on an ESP32: one build for both."""
        monkeypatch.setattr(ec.ESPIDFCompiler, "available", property(lambda self: False))
        sim_key, _ = started(_sketch(HOME))
        hw_key, hw_req = started(_sketch(HOME), for_hardware=True)
        assert sim_key == hw_key and hw_req.for_hardware is False

    def test_an_rp2040_keeps_its_own_job(self, idf_service, started):
        sim_key, _ = started(_sketch(BLINK), fqbn=PICO)
        hw_key, hw_req = started(_sketch(BLINK), fqbn=PICO, for_hardware=True)
        assert sim_key != hw_key and hw_req.for_hardware is True

    def test_two_people_share_a_hardware_job_only_with_the_same_sources(self, idf_service, started):
        """The image is a function of what the requester sent: whoever lands
        on this key already holds the password that is in it."""
        mine, _ = started(_sketch(HOME), for_hardware=True)
        same, _ = started(_sketch(HOME), for_hardware=True)
        other, _ = started(_sketch(HOME.replace("hunter2", "hunter3")), for_hardware=True)
        assert mine == same and mine != other


class TestWhatIsKeptOnDisk:
    """The artifact cache is for the simulator's images. One with the user's
    own network in it is not kept."""

    @pytest.mark.parametrize("fqbn,for_hardware,kept", [
        (ESP32, False, True),
        (ESP32, True, False),
        (PICO, True, True),
    ])
    def test_an_image_with_the_users_password_is_not(self, monkeypatch, fqbn, for_hardware, kept):
        stored: list[str] = []

        async def _run(*_a, **_kw):
            return compile_route.CompileResponse(success=True, binary_content="AA==", stdout="", stderr="")

        async def _store(key, _result):
            stored.append(key)

        async def _nothing(*_a, **_kw):
            return None

        monkeypatch.setattr(compile_route, "_run_compile", _run)
        monkeypatch.setattr(compile_route, "_artifact_store", _store)
        monkeypatch.setattr(compile_route, "_record_async_metric", _nothing)
        monkeypatch.setattr(compile_route, "JOB_BY_KEY", {"k": "j"})
        monkeypatch.setattr(compile_route, "COMPILE_JOBS", {"j": {"started_at": 0.0, "key": "k"}})
        req = compile_route.CompileRequest(files=_sketch(HOME), board_fqbn=fqbn, for_hardware=for_hardware)
        asyncio.run(compile_route._compile_job("j", req, _sketch(HOME), None, (None, None)))
        assert compile_route.COMPILE_JOBS["j"]["state"] == "done"
        assert stored == (["k"] if kept else [])


class TestTheRoute:
    @pytest.mark.parametrize("asked", [True, False])
    def test_the_esp_idf_compiler_is_told(self, idf_service, monkeypatch, asked):
        got: dict = {}

        async def _compile(files, fqbn, **kw):
            got.update(kw)
            return {"success": True, "binary_content": "AA==", "has_wifi": True,
                    "wifi_rewritten": not asked}

        monkeypatch.setattr(compile_route.espidf_compiler, "compile", _compile)
        req = compile_route.CompileRequest(files=_sketch(HOME), board_fqbn=ESP32, for_hardware=asked)
        out = asyncio.run(compile_route._run_compile(req, _sketch(HOME), scope=(None, None)))
        assert got["for_hardware"] is asked
        assert out.wifi_rewritten is (not asked)

    def test_the_response_says_nothing_was_rewritten_unless_told(self):
        assert compile_route.CompileResponse(success=True, stdout="", stderr="").wifi_rewritten is False

    @pytest.mark.parametrize("service,built_for_hardware", [(True, True), (False, False)])
    def test_the_synchronous_route_decides_the_same_way(self, monkeypatch, service, built_for_hardware):
        asked: list[bool] = []

        async def _run(request, *_a, **_kw):
            asked.append(request.for_hardware)
            return compile_route.CompileResponse(success=True, stdout="", stderr="")

        monkeypatch.setattr(ec.ESPIDFCompiler, "available", property(lambda self: service))
        monkeypatch.setattr(compile_route, "_run_compile", _run)

        async def _post():
            req = compile_route.CompileRequest(files=_sketch(HOME), board_fqbn=ESP32, for_hardware=True)
            await compile_route.compile_sketch(req, SimpleNamespace(headers={}, client=None), None)

        asyncio.run(_post())
        assert asked == [built_for_hardware]
