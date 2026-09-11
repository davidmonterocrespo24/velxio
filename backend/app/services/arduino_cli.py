import subprocess
import tempfile
import asyncio
import base64
import hashlib
import shutil
import re
import os
from pathlib import Path

from app.core.hooks import materialize_library_scope, scope_retry_allowed


# A preprocessor "fatal error: Foo.h: No such file or directory" — the signature
# of a missing #include. Used to decide whether a FAILED manifest-scoped compile
# should retry scan-all (the manifest omitted a needed / transitive library) vs
# surface the failure as-is (a genuine source error).
_MISSING_HEADER_RE = re.compile(
    r"fatal error:\s*\S+\.h(?:pp)?:\s*No such file or directory", re.IGNORECASE
)


def _looks_like_missing_header(stderr: str | None) -> bool:
    return bool(stderr and _MISSING_HEADER_RE.search(stderr))


# ── arduino-cli error humanizer ──────────────────────────────────────────────
# arduino-cli reports failures in two shapes: plain text on stderr, or (when
# invoked with --format json) a JSON object {"error": "...", "warnings": [...]}
# on stderr. We used to hand that raw blob straight to the caller, so a fresh
# desktop install with no library index yet — and no way to reach
# downloads.arduino.cc through the user's firewall / proxy — surfaced to the
# in-app agent as "the library server returns a JSON error" (2026-08-17,
# a Maker cancelled 16 minutes after subscribing). Turn the known shapes into
# one actionable sentence and keep the raw text under a separate key.

_INDEX_DOWNLOAD_MARKERS = (
    "error downloading index",
    "library_index.tar.bz2",
    "library_index.json",
    "package_index.json",
    "error updating library index",
    "error initializing instance",
)
_NETWORK_MARKERS = (
    "downloads.arduino.cc",
    "dial tcp",
    "dial udp",
    "network is unreachable",
    "no such host",
    "connection refused",
    "tls handshake",
    "i/o timeout",
    "context deadline exceeded",
    "proxy",
)



# ── Compiler diagnostics that need a Velxio answer, not the IDE's ────────────
# arduino-pico gates its Bluetooth libraries behind a static_assert whose text
# tells the user to flip "Tools->IP/Bluetooth Stack" — a menu that exists in the
# Arduino IDE and not here. Left alone it reads like a setting we forgot to
# expose. The truth is simpler and worth saying plainly: the CYW43439/RM2's
# Bluetooth side is not emulated, only its WiFi side is, so there is nothing to
# enable.
_BT_ASSERT_MARKERS = ("_needsbt.h", "This library needs Bluetooth enabled")

_BT_NOT_EMULATED_NOTE = (
    "\n"
    "Velxio: Bluetooth is not emulated on this board. The CYW43439 (the RM2\n"
    "module on the Pimoroni Pico Plus 2 W, and the same chip on the Pico W)\n"
    "is emulated for WiFi only — association, DHCP, DNS and real HTTP all\n"
    "work — but its Bluetooth controller is not modelled, so there is no\n"
    "'IP/Bluetooth Stack' setting to turn on here. Sketches that use WiFi.h,\n"
    "HTTPClient or WiFiServer compile and run.\n"
)


def annotate_build_stderr(stderr: str | None) -> str | None:
    """Append a Velxio-authored note to compiler output we know is misleading.

    Kept separate from humanize_cli_error: that one rewrites arduino-cli's own
    failures, this one leaves the compiler's diagnostics intact and adds context
    underneath, because the developer still needs the real error text.
    """
    if not stderr:
        return stderr
    if any(marker in stderr for marker in _BT_ASSERT_MARKERS):
        return stderr.rstrip() + "\n" + _BT_NOT_EMULATED_NOTE
    return stderr


def humanize_cli_error(raw: str | None, *, action: str = "run arduino-cli") -> str:
    """One readable sentence for an arduino-cli failure.

    `raw` is whatever arduino-cli wrote (stderr, or stdout+stderr). `action`
    names what we were doing ("search libraries", "install Adafruit GFX") so
    the message reads naturally in the UI and in the agent's tool result.
    """
    text = (raw or "").strip()
    # JSON-shaped error (--format json): {"error": "...", "warnings": [...]}
    if text.startswith("{"):
        try:
            import json as _json
            obj = _json.loads(text)
            if isinstance(obj, dict):
                parts = [str(obj.get("error") or "")]
                warns = obj.get("warnings")
                if isinstance(warns, list):
                    parts.extend(str(w) for w in warns)
                text = "\n".join(p for p in parts if p).strip()
        except ValueError:
            pass
    low = text.lower()

    if any(m in low for m in _INDEX_DOWNLOAD_MARKERS) or (
        "index" in low and any(m in low for m in _NETWORK_MARKERS)
    ):
        return (
            f"Could not {action}: the Arduino library index is not available yet "
            "and arduino-cli could not download it from downloads.arduino.cc. "
            "Check your internet connection, firewall or proxy and try again."
        )
    if "can't download library" in low or (
        "download" in low and any(m in low for m in _NETWORK_MARKERS)
    ):
        return (
            f"Could not {action}: the download from downloads.arduino.cc failed. "
            "Check your internet connection, firewall or proxy and try again."
        )
    if "not found" in low or "no library found" in low:
        first = next((ln.strip() for ln in text.splitlines() if ln.strip()), text)
        return f"Could not {action}: {first[:300]}"
    if not text:
        return f"Could not {action}: arduino-cli returned no output."
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), text)
    return f"Could not {action}: {first[:300]}"


def _discard_sketch_build_cache(sketch_dir: Path) -> None:
    """Remove the per-sketch build cache arduino-cli left for this compile.

    arduino-cli keys its sketch build cache on the MD5 of the sketch's
    absolute path, and this service compiles every request in a fresh temp
    dir: the entry is never reused, and arduino-cli 1.5.x never purges it
    either (its purge scans /tmp/arduino, not the real cache dir). Measured
    on velxio.dev: 17,000 directories and 15 GB in 15 days, growing 1 GB a
    day. The core cache next to it (`cores/`, keyed on the FQBN) is what makes
    warm builds fast and is left alone.
    """
    try:
        cache_root = Path.home() / '.cache' / 'arduino' / 'sketches'
        # MD5 because that is arduino-cli's own cache key (not a security use).
        digest = hashlib.md5(str(sketch_dir).encode('utf-8'), usedforsecurity=False).hexdigest().upper()
        target = cache_root / digest
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
    except Exception:
        pass


class ArduinoCLIService:
    # Board manager URLs for cores that aren't built-in
    CORE_URLS: dict[str, str] = {
        "rp2040:rp2040": "https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json",
        "esp32:esp32": "https://espressif.github.io/arduino-esp32/package_esp32_index.json",
        # Spence Konde's ATTinyCore — needed for ATtiny85 FQBNs like
        #   ATTinyCore:avr:attinyx5:chip=85,clock=internal16mhz
        # Without it arduino-cli reports
        #   "Platform 'ATTinyCore:avr' not found: platform not installed".
        "ATTinyCore:avr": "http://drazzy.com/package_drazzy.com_index.json",
    }

    # Cores to auto-install on startup
    REQUIRED_CORES = ["arduino:avr"]

    # Cores to install on-demand when a board FQBN is requested.
    # Match order matters: longer / more-specific prefixes first so we don't
    # mis-route (e.g. an FQBN that mentions both vendors).
    ON_DEMAND_CORES: dict[str, str] = {
        "ATTinyCore:avr": "ATTinyCore:avr",
        "rp2040": "rp2040:rp2040",
        "mbed_rp2040": "arduino:mbed_rp2040",
        "esp32": "esp32:esp32",
    }

    # Version pins for `arduino-cli core install`.  Keyed by core ID; if a core
    # is in this map we pass `<core>@<version>` instead of just `<core>`.
    # ATTinyCore: >=1.5.0 depends on micronucleus hosted at azduino.com, which
    # has been unreachable for extended periods.  1.4.1 is the last release
    # whose micronucleus tool is on github.com (digistump release) AND still
    # supports the FQBN options we use (clock=16pll, etc.). Compile-only —
    # micronucleus itself is never invoked here.
    CORE_INSTALL_VERSIONS: dict[str, str] = {
        "ATTinyCore:avr": "1.4.1",
    }

    def __init__(self, cli_path: str = "arduino-cli"):
        self.cli_path = cli_path
        # Cached `core list` output; see _is_core_installed. Invalidated
        # wherever a core is installed so a fresh install is seen immediately.
        self._installed_cores: str | None = None
        self._ensure_board_urls()
        self._ensure_core_installed()

    def _ensure_board_urls(self):
        """Register additional board-manager URLs in arduino-cli config."""
        try:
            # Ensure config file exists (arduino-cli requires it for config add)
            result = subprocess.run(
                [self.cli_path, "config", "dump", "--format", "json"],
                capture_output=True, text=True
            )
            import json
            try:
                cfg = json.loads(result.stdout)
            except Exception:
                cfg = {}

            # If config is empty/missing, initialize it
            config_dict = cfg.get("config", cfg)
            if not config_dict or config_dict == {}:
                print("[arduino-cli] Initializing config file...")
                subprocess.run(
                    [self.cli_path, "config", "init", "--overwrite"],
                    capture_output=True, text=True
                )

            # Re-read after init
            result = subprocess.run(
                [self.cli_path, "config", "dump", "--format", "json"],
                capture_output=True, text=True
            )
            try:
                cfg = json.loads(result.stdout)
            except Exception:
                cfg = {}

            existing = set()
            # Handle both flat and nested config shapes
            config_dict = cfg.get("config", cfg)
            bm = config_dict.get("board_manager", config_dict)
            urls = bm.get("additional_urls", [])
            if isinstance(urls, str):
                existing.add(urls)
            elif isinstance(urls, list):
                existing.update(urls)

            for url in self.CORE_URLS.values():
                if url not in existing:
                    print(f"[arduino-cli] Adding board manager URL: {url}")
                    subprocess.run(
                        [self.cli_path, "config", "add", "board_manager.additional_urls", url],
                        capture_output=True, text=True
                    )

            # Refresh index so new cores are discoverable
            print("[arduino-cli] Updating core index...")
            subprocess.run(
                [self.cli_path, "core", "update-index"],
                capture_output=True, text=True
            )
        except Exception as e:
            print(f"Warning: Could not configure board URLs: {e}")

    def _ensure_core_installed(self):
        """
        Ensure essential cores (arduino:avr) are installed at startup.
        Other cores (RP2040, ESP32) are installed on-demand.
        """
        try:
            result = subprocess.run(
                [self.cli_path, "core", "list"],
                capture_output=True,
                text=True
            )

            for core_id in self.REQUIRED_CORES:
                if core_id not in result.stdout:
                    print(f"[arduino-cli] Core {core_id} not installed. Installing...")
                    subprocess.run(
                        [self.cli_path, "core", "install", core_id],
                        check=True
                    )
                    print(f"[arduino-cli] Core {core_id} installed successfully")
        except Exception as e:
            print(f"Warning: Could not verify cores: {e}")
            print("Please ensure arduino-cli is installed and in PATH")

    def _core_id_for_fqbn(self, fqbn: str) -> str | None:
        """Extract the core ID needed for a given FQBN."""
        for prefix, core_id in self.ON_DEMAND_CORES.items():
            if prefix in fqbn:
                return core_id
        return None

    def _is_core_installed(self, core_id: str) -> bool:
        """Check whether a core is currently installed.

        Memoized: this shells out to `arduino-cli core list` (~1.5 s measured)
        and it used to run on EVERY compile of a non-AVR board, from inside an
        async handler - so it blocked the event loop for the whole process, not
        just the caller. Cores only appear via install_core() below, which
        refreshes the set, and they are never removed at runtime.
        """
        if self._installed_cores is None:
            try:
                result = subprocess.run(
                    [self.cli_path, "core", "list"],
                    capture_output=True, text=True, timeout=60,
                )
                self._installed_cores = result.stdout
            except (subprocess.SubprocessError, OSError):
                return False  # unknown: let the caller try to install
        return core_id in self._installed_cores

    async def ensure_core_for_board(self, fqbn: str) -> dict:
        """
        Auto-install the core required by a board FQBN if not present.
        Returns status dict with install log.
        """
        core_id = self._core_id_for_fqbn(fqbn)
        if core_id is None:
            # Built-in core (arduino:avr) — should already be there
            return {"needed": False, "installed": True, "core_id": None, "log": ""}

        if self._is_core_installed(core_id):
            return {"needed": False, "installed": True, "core_id": core_id, "log": ""}

        # Install the core (optionally pinned to a specific version)
        version = self.CORE_INSTALL_VERSIONS.get(core_id)
        install_spec = f"{core_id}@{version}" if version else core_id
        print(f"[arduino-cli] Auto-installing core {install_spec} for board {fqbn}...")

        self._installed_cores = None  # a core is about to appear

        def _install():
            return subprocess.run(
                [self.cli_path, "core", "install", install_spec],
                capture_output=True, text=True
            )

        result = await asyncio.to_thread(_install)
        log = result.stdout + "\n" + result.stderr

        if result.returncode == 0:
            print(f"[arduino-cli] Core {core_id} installed successfully")
            return {"needed": True, "installed": True, "core_id": core_id, "log": log.strip()}
        else:
            print(f"[arduino-cli] Failed to install core {core_id}: {result.stderr}")
            return {"needed": True, "installed": False, "core_id": core_id, "log": log.strip()}

    async def get_setup_status(self) -> dict:
        """Return the current state of arduino-cli and installed cores."""
        try:
            version_result = subprocess.run(
                [self.cli_path, "version"],
                capture_output=True, text=True
            )
            version = version_result.stdout.strip() if version_result.returncode == 0 else "unknown"

            list_result = subprocess.run(
                [self.cli_path, "core", "list"],
                capture_output=True, text=True
            )
            cores_raw = list_result.stdout.strip()
        except FileNotFoundError:
            return {
                "cli_available": False,
                "version": None,
                "cores": [],
                "error": "arduino-cli not found in PATH"
            }
        except Exception as e:
            return {
                "cli_available": False,
                "version": None,
                "cores": [],
                "error": str(e)
            }

        # Parse installed cores
        cores = []
        for line in cores_raw.splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 3:
                cores.append({"id": parts[0], "installed": parts[1], "latest": parts[2]})

        return {
            "cli_available": True,
            "version": version,
            "cores": cores,
            "error": None
        }

    def _is_rp2040_board(self, fqbn: str) -> bool:
        """Return True if the FQBN targets an RP2040/RP2350 board."""
        return any(p in fqbn for p in ("rp2040", "rp2350", "mbed_rp2040", "mbed_rp2350"))

    def _is_esp32_board(self, fqbn: str) -> bool:
        """Return True if the FQBN targets an ESP32 family board."""
        return fqbn.startswith("esp32:")

    def _is_stm32_board(self, fqbn: str) -> bool:
        """Return True if the FQBN targets an STM32 (STM32duino) board.

        STM32 boots from an ELF via QEMU's -kernel (libqemu-arm), so the
        emulator wants the .elf artifact, not a flash image."""
        return fqbn.startswith("STMicroelectronics:stm32")

    def _is_esp32c3_board(self, fqbn: str) -> bool:
        """Return True if the FQBN targets an ESP32-C3 (RISC-V) board.

        ESP32-C3 places the bootloader at flash offset 0x0000, unlike Xtensa
        boards (ESP32, ESP32-S3) which use 0x1000.
        """
        return "esp32c3" in fqbn or "xiao-esp32-c3" in fqbn or "aitewinrobot-esp32c3-supermini" in fqbn

    async def compile(
        self,
        files: list[dict],
        board_fqbn: str = "arduino:avr:uno",
        board_options: dict | None = None,
        allowed_libraries: set[str] | None = None,
        owner_id: str | None = None,
    ) -> dict:
        """
        Compile Arduino sketch using arduino-cli.

        `files` is a list of {"name": str, "content": str} dicts.
        arduino-cli requires the sketch directory to contain a .ino file whose
        name matches the directory ("sketch").  If none exists we promote the
        first .ino file to sketch.ino automatically.

        `board_options` is accepted for API symmetry with the ESP-IDF path
        (ESP32 partition/PSRAM/etc selectors live in the UI). It is currently
        ignored — AVR / RP2040 / ATTiny toolchains don't expose those knobs.
        Reserved for future per-board options on those families.

        `allowed_libraries` is the per-board manifest = library resolution SCOPE
        (P2.1f). When set, ONLY those libraries are made visible to arduino-cli
        (a throwaway scratch sketchbook of symlinks materialized by the pro
        overlay from the content-addressed cache / owner store, pointed at via
        ARDUINO_DIRECTORIES_USER), instead of the shared global volume.
        `owner_id` is the project OWNER's id so a shared / embed compile resolves
        that owner's custom libraries. None/empty manifest (or no overlay) ->
        arduino-cli's default sketchbook -> scan-all (legacy parity).

        Returns:
            dict with keys: success, hex_content, stdout, stderr, error
        """
        _ = board_options  # reserved; see docstring
        print(f"\n=== Starting compilation ===")
        print(f"Board: {board_fqbn}")
        print(f"Files: {[f['name'] for f in files]}")

        # Create temporary directory for sketch
        with tempfile.TemporaryDirectory() as temp_dir:
            sketch_dir = Path(temp_dir) / "sketch"
            sketch_dir.mkdir()

            # Determine whether the caller already provides a "sketch.ino"
            has_sketch_ino = any(f["name"] == "sketch.ino" for f in files)
            main_ino_written = False

            for file_entry in files:
                name: str = file_entry["name"]
                content: str = file_entry["content"]

                # Promote the first .ino to sketch.ino if none explicitly named so
                write_name = name
                if not has_sketch_ino and name.endswith(".ino") and not main_ino_written:
                    write_name = "sketch.ino"
                    main_ino_written = True

                # RP2040: redirect Serial → Serial1 in the main sketch file only
                if "rp2040" in board_fqbn and write_name == "sketch.ino":
                    content = "#define Serial Serial1\n" + content

                # Folder support: names may carry '/' paths ("apps/badge/x.py").
                # Resolve inside the sketch dir and REJECT anything that
                # escapes it ('..' segments, absolute paths) — the name comes
                # straight from the request body.
                target = (sketch_dir / write_name).resolve()
                if not str(target).startswith(str(sketch_dir.resolve()) + os.sep):
                    print(f"Skipping unsafe file name: {write_name!r}")
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")

            # Fallback: no .ino files provided at all
            if not any(f["name"].endswith(".ino") for f in files):
                (sketch_dir / "sketch.ino").write_text("void setup(){}\nvoid loop(){}", encoding="utf-8")

            print(f"Sketch directory contents: {[p.name for p in sketch_dir.iterdir()]}")

            build_dir = sketch_dir / "build"
            build_dir.mkdir()
            print(f"Build directory: {build_dir}")

            # P2.1f — manifest-scoped library resolution. Symlink ONLY the
            # declared libraries (resolved owner-store -> content-addressed
            # cache -> legacy global dir) into a throwaway scratch sketchbook and
            # point arduino-cli's USER directory at it, so it scans ONLY those
            # libraries instead of the shared mutable global volume. None/empty
            # manifest (or no pro overlay) -> no override -> arduino-cli's default
            # sketchbook -> legacy global scan-all (parity).
            #
            # Mechanism: ARDUINO_DIRECTORIES_USER (the sketchbook), NOT the
            # --libraries flag. Verified empirically that `--libraries` ADDS to
            # the search path (the global sketchbook is STILL scanned, so it does
            # not isolate), whereas pointing ARDUINO_DIRECTORIES_USER at the
            # scratch root makes <scratch>/libraries the ONLY user-library dir.
            # scope_dir == <scratch>/libraries, so its parent is the sketchbook
            # root. Cores + board-manager URLs live in the DATA dir and are
            # untouched, so RP2040 / ATTinyCore / AVR core resolution stays intact.
            scope_dir = None
            try:
                scope = materialize_library_scope(allowed_libraries, owner_id)
                scope_dir = scope[0] if scope else None
                compile_env = dict(os.environ)
                if scope_dir is not None:
                    compile_env["ARDUINO_DIRECTORIES_USER"] = str(scope_dir.parent)
                else:
                    # P2.1h: NO manifest -> point the default sketchbook at the
                    # content-addressed cache (VELXIO_FALLBACK_SKETCHBOOK, whose
                    # libraries/ is the cache root) instead of the shared global
                    # volume, so a from-scratch / no-manifest compile (and the
                    # scan-all retry, which re-enters here unscoped) resolves user
                    # libraries from the cache. Unset (OSS self-host) -> arduino-
                    # cli's default sketchbook (legacy global volume).
                    _fb = os.environ.get("VELXIO_FALLBACK_SKETCHBOOK")
                    if _fb:
                        compile_env["ARDUINO_DIRECTORIES_USER"] = _fb

                # Run compilation using subprocess.run in a thread (Windows compatible)
                # ESP32 lcgamboa emulator requires DIO flash mode and
                # IRAM-safe interrupt placement to avoid cache errors.
                # Force these at compile time for all ESP32 targets.
                cmd = [self.cli_path, "compile", "--fqbn", board_fqbn]
                if self._is_esp32_board(board_fqbn):
                    # FlashMode=dio: required by esp32-picsimlab QEMU machine
                    # IRAM_ATTR on all interrupt handlers prevents cache crashes
                    # when WiFi emulation disables the SPI flash cache on core 1.
                    fqbn_dio = board_fqbn
                    if 'FlashMode' not in board_fqbn:
                        fqbn_dio = board_fqbn + ':FlashMode=dio'
                    cmd[2] = '--fqbn'
                    cmd.insert(3, fqbn_dio)
                    cmd = cmd[:4]  # trim accidental duplicates
                    cmd = [self.cli_path, "compile", "--fqbn", fqbn_dio,
                           "--build-property",
                           "build.extra_flags=-DARDUINO_ESP32_LCGAMBOA=1",
                           # Adafruit_BusIO 1.17.x dropped BitOrder on ESP32 3.x;
                           # this define restores it as uint8_t (the type it was).
                           "--build-property",
                           "compiler.cpp.extra_flags=-DBitOrder=uint8_t",
                           "--output-dir", str(build_dir),
                           str(sketch_dir)]
                else:
                    cmd = [self.cli_path, "compile", "--fqbn", board_fqbn,
                           "--output-dir", str(build_dir),
                           str(sketch_dir)]
                print(f"Running command: {' '.join(cmd)}")

                # Use subprocess.run in a thread for Windows compatibility
                def run_compile():
                    return subprocess.run(
                        cmd,
                        capture_output=True,
                        text=True,
                        env=compile_env,
                    )

                result = await asyncio.to_thread(run_compile)
                _discard_sketch_build_cache(sketch_dir)

                print(f"Process return code: {result.returncode}")
                print(f"Stdout: {result.stdout}")
                print(f"Stderr: {result.stderr}")

                if result.returncode == 0:
                    print(f"Files in build dir: {list(build_dir.iterdir())}")

                    if self._is_rp2040_board(board_fqbn):
                        # RP2040 / RP2350 builds leave two files: the raw
                        # .bin (the image from 0x10000000, what the browser
                        # emulator loads) and the .uf2 picotool made from
                        # the ELF (what the BOOTSEL drive and `picotool
                        # load` want). Both go back: binary_content stays
                        # the .bin so nothing that loads it changes, and
                        # uf2_content carries the .uf2 for hardware flash.
                        # Sending the .bin under a .uf2 name is what broke
                        # the desktop flash for every Pico: picotool parses
                        # by extension and rejects "UF2 file does not
                        # contain a valid RP2 executable image".
                        bin_file = build_dir / "sketch.ino.bin"
                        uf2_file = build_dir / "sketch.ino.uf2"

                        target_file = bin_file if bin_file.exists() else (uf2_file if uf2_file.exists() else None)

                        if target_file:
                            raw_bytes = target_file.read_bytes()
                            binary_b64 = base64.b64encode(raw_bytes).decode('ascii')
                            uf2_b64 = (
                                base64.b64encode(uf2_file.read_bytes()).decode('ascii')
                                if uf2_file.exists() else None
                            )
                            print(f"[RP2040] Binary file: {target_file.name}, size: {len(raw_bytes)} bytes"
                                  f"{' (+ uf2)' if uf2_b64 else ''}")
                            print("=== RP2040 Compilation successful ===\n")
                            return {
                                "success": True,
                                "hex_content": None,
                                "binary_content": binary_b64,
                                "binary_type": "bin" if target_file == bin_file else "uf2",
                                "uf2_content": uf2_b64,
                                "stdout": result.stdout,
                                "stderr": result.stderr
                            }
                        else:
                            print(f"[RP2040] Binary file not found. Files: {list(build_dir.iterdir())}")
                            print("=== RP2040 Compilation failed: binary not found ===\n")
                            return {
                                "success": False,
                                "error": "RP2040 binary (.bin/.uf2) not found after compilation",
                                "stdout": result.stdout,
                                "stderr": result.stderr
                            }
                    elif self._is_esp32_board(board_fqbn):
                        # ESP32 outputs individual .bin files that must be merged into a
                        # single 4MB flash image for QEMU lcgamboa to boot correctly.
                        bin_file        = build_dir / "sketch.ino.bin"
                        bootloader_file = build_dir / "sketch.ino.bootloader.bin"
                        partitions_file = build_dir / "sketch.ino.partitions.bin"
                        merged_file     = build_dir / "sketch.ino.merged.bin"

                        print(f"[ESP32] Build dir contents: {[f.name for f in build_dir.iterdir()]}")

                        # Merge individual .bin files into a single 4MB flash image in pure Python.
                        # Flash layout differs by chip:
                        #   ESP32 / ESP32-S3 (Xtensa): 0x1000 bootloader | 0x8000 partitions | 0x10000 app
                        #   ESP32-C3 (RISC-V):         0x0000 bootloader | 0x8000 partitions | 0x10000 app
                        # QEMU lcgamboa requires exactly 2/4/8/16 MB flash — raw app binary won't boot.
                        if not merged_file.exists() and bin_file.exists() and bootloader_file.exists() and partitions_file.exists():
                            print("[ESP32] Merging binaries into 4MB flash image (pure Python)...")
                            try:
                                FLASH_SIZE = 4 * 1024 * 1024  # 4 MB
                                flash = bytearray(b'\xff' * FLASH_SIZE)
                                bootloader_offset = 0x0000 if self._is_esp32c3_board(board_fqbn) else 0x1000
                                for offset, path in [
                                    (bootloader_offset, bootloader_file),
                                    (0x8000,            partitions_file),
                                    (0x10000,           bin_file),
                                ]:
                                    data = path.read_bytes()
                                    flash[offset:offset + len(data)] = data
                                merged_file.write_bytes(bytes(flash))
                                print(f"[ESP32] Merged image: {merged_file.stat().st_size} bytes (bootloader @ 0x{bootloader_offset:04X})")
                            except Exception as e:
                                print(f"[ESP32] Merge failed: {e} — falling back to raw app binary")

                        target_file = merged_file if merged_file.exists() else (bin_file if bin_file.exists() else None)

                        if target_file:
                            raw_bytes = target_file.read_bytes()
                            binary_b64 = base64.b64encode(raw_bytes).decode('ascii')
                            print(f"[ESP32] Binary file: {target_file.name}, size: {len(raw_bytes)} bytes")
                            print("=== ESP32 Compilation successful ===\n")
                            return {
                                "success": True,
                                "hex_content": None,
                                "binary_content": binary_b64,
                                "binary_type": "bin",
                                "stdout": result.stdout,
                                "stderr": result.stderr
                            }
                        else:
                            print(f"[ESP32] Binary file not found. Files: {list(build_dir.iterdir())}")
                            print("=== ESP32 Compilation failed: binary not found ===\n")
                            return {
                                "success": False,
                                "error": "ESP32 binary (.bin) not found after compilation",
                                "stdout": result.stdout,
                                "stderr": result.stderr
                            }
                    elif self._is_stm32_board(board_fqbn):
                        # STM32 (STM32duino) boots from an ELF via QEMU -kernel.
                        elf_file = build_dir / "sketch.ino.elf"
                        bin_file = build_dir / "sketch.ino.bin"
                        target_file = elf_file if elf_file.exists() else (bin_file if bin_file.exists() else None)
                        if target_file:
                            raw_bytes = target_file.read_bytes()
                            binary_b64 = base64.b64encode(raw_bytes).decode('ascii')
                            print(f"[STM32] Binary file: {target_file.name}, size: {len(raw_bytes)} bytes")
                            print("=== STM32 Compilation successful ===\n")
                            return {
                                "success": True,
                                "hex_content": None,
                                "binary_content": binary_b64,
                                "binary_type": "elf" if target_file == elf_file else "bin",
                                "stdout": result.stdout,
                                "stderr": result.stderr,
                            }
                        else:
                            print(f"[STM32] ELF/bin not found. Files: {list(build_dir.iterdir())}")
                            return {
                                "success": False,
                                "error": "STM32 firmware (.elf/.bin) not found after compilation",
                                "stdout": result.stdout,
                                "stderr": result.stderr,
                            }
                    else:
                        # AVR outputs a .hex file (Intel HEX format)
                        hex_file = build_dir / "sketch.ino.hex"
                        print(f"Looking for hex file at: {hex_file}")
                        print(f"Hex file exists: {hex_file.exists()}")

                        if hex_file.exists():
                            hex_content = hex_file.read_text()
                            print(f"Hex file size: {len(hex_content)} bytes")
                            print("=== AVR Compilation successful ===\n")
                            return {
                                "success": True,
                                "hex_content": hex_content,
                                "binary_content": None,
                                "stdout": result.stdout,
                                "stderr": result.stderr
                            }
                        else:
                            print(f"Files in build dir: {list(build_dir.iterdir())}")
                            print("=== Compilation failed: hex file not found ===\n")
                            return {
                                "success": False,
                                "error": "Hex file not found after compilation",
                                "stdout": result.stdout,
                                "stderr": result.stderr
                            }
                else:
                    print("=== Compilation failed ===\n")
                    # P2.1f graceful fallback (mirrors the ESP-IDF path): a
                    # manifest-scoped compile points ARDUINO_DIRECTORIES_USER at
                    # a sketchbook holding ONLY the declared libraries, so the
                    # global volume is not scanned. If the manifest omitted a
                    # needed library or a transitive dependency, a header goes
                    # missing and the build hard-fails where the legacy global
                    # scan-all would have found it. So when a scope was applied
                    # and the failure is a missing #include, retry ONCE without
                    # the scope (global scan-all) and flag the manifest as
                    # incomplete. A genuine source error fails both attempts and
                    # returns the original scoped failure below.
                    if (
                        scope_dir is not None
                        and _looks_like_missing_header(result.stderr)
                        and not scope_retry_allowed.get()
                    ):
                        # Closed scope (an unmodified gallery compile): no
                        # scan-all rescue, the miss is the finding.
                        print("=== Closed scope: missing header, retry disabled ===\n")
                        return {
                            "success": False,
                            "error": "Compilation failed",
                            "stdout": result.stdout,
                            "stderr": result.stderr,
                            "gallery_scope_miss": True,
                        }
                    if scope_dir is not None and _looks_like_missing_header(result.stderr):
                        print("=== Incomplete manifest — retrying scan-all ===\n")
                        retry = await self.compile(
                            files, board_fqbn, board_options=board_options,
                        )  # allowed_libraries=None -> no scope -> no further retry
                        if retry.get("success"):
                            retry["manifest_incomplete"] = True
                            return retry
                        # Both attempts failed. The retry ran in the SUPERSET
                        # environment (every installed library visible), so its
                        # error is the sketch's real one; the scoped attempt
                        # stopped at the first undeclared transitive dependency,
                        # which is an artifact of OUR scoping. Returning the
                        # scoped error here reported a phantom missing-library
                        # problem for a sketch whose actual bug was a typo'd
                        # #include (2026-08-24: "Adafruit_I2CDevice.h: No such
                        # file" for a manifest that simply never named BusIO).
                        if (retry.get("stderr") or "").strip():
                            retry["scope_retry_failed"] = True
                            return retry
                    return {
                        "success": False,
                        "error": "Compilation failed",
                        "stdout": result.stdout,
                        "stderr": annotate_build_stderr(result.stderr),
                    }

            except Exception as e:
                print(f"=== Exception during compilation: {e} ===\n")
                import traceback
                traceback.print_exc()
                return {
                    "success": False,
                    "error": str(e),
                    "stdout": "",
                    "stderr": ""
                }
            finally:
                if scope_dir is not None:
                    # rmtree unlinks the symlinks, never their cache / store /
                    # legacy targets.
                    shutil.rmtree(scope_dir.parent, ignore_errors=True)

    async def list_boards(self) -> list:
        """
        List available Arduino boards
        """
        try:
            process = await asyncio.create_subprocess_exec(
                self.cli_path,
                "board",
                "listall",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            stdout, _ = await process.communicate()

            # Parse output (format: "Board Name    FQBN")
            boards = []
            for line in stdout.decode().splitlines()[1:]:  # Skip header
                if line.strip():
                    parts = line.split()
                    if len(parts) >= 2:
                        name = " ".join(parts[:-1])
                        fqbn = parts[-1]
                        boards.append({"name": name, "fqbn": fqbn})

            return boards

        except Exception as e:
            print(f"Error listing boards: {e}")
            return []

    async def search_libraries(self, query: str) -> dict:
        """
        Search for Arduino libraries
        """
        try:
            def _run():
                return subprocess.run(
                    [self.cli_path, "lib", "search", query, "--format", "json"],
                    capture_output=True, text=True, encoding='utf-8', errors='replace'
                )

            result = await asyncio.to_thread(_run)
            stdout, stderr = result.stdout, result.stderr

            if result.returncode != 0:
                print(f"Error searching libraries: {stderr}")
                return {
                    "success": False,
                    "error": humanize_cli_error(stderr or stdout, action="search libraries"),
                    "raw_error": stderr,
                }

            import json
            try:
                results = json.loads(stdout)
                libraries = results.get("libraries", [])

                # arduino-cli search returns each lib with a "releases" dict.
                # Inject a "latest" key with the data of the highest version so the
                # frontend can access lib.latest.version / author / sentence directly.
                def _parse_version(v: str):
                    try:
                        parts = v.split(".")
                        # Reject if any part is not a digit (filters out "1_2_3", "beta", "latest")
                        if any(not p.isdigit() for p in parts):
                            return (0,)
                        return tuple(int(p) for p in parts)
                    except Exception:
                        return (0,)

                for lib in libraries:
                    releases = lib.get("releases") or {}
                    if releases:
                        latest_key = max(releases.keys(), key=_parse_version)
                        lib["latest"] = {**releases[latest_key], "version": latest_key}

                return {"success": True, "libraries": libraries}
            except json.JSONDecodeError:
                # rc was 0 but stdout is not JSON: arduino-cli printed a
                # progress/warning line ahead of (or instead of) the payload.
                return {
                    "success": False,
                    "error": humanize_cli_error(stderr or stdout, action="search libraries"),
                    "raw_error": (stderr or stdout)[:2000],
                }

        except Exception as e:
            print(f"Exception searching libraries: {e}")
            return {"success": False, "error": str(e)}

    async def install_library(self, library_name: str) -> dict:
        """
        Install an Arduino library.
        Handles standard library names as well as Wokwi-hosted entries in
        the form  "LibName@wokwi:projectHash".
        Also handles versioned installs via "LibName@version" syntax
        (e.g. "Adafruit NeoPixel@1.11.0").

        @latest is stripped — arduino-cli does not support it.
        Malformed version strings (non-semver) fall back to plain name install.
        """
        if '@wokwi:' in library_name:
            return await self._install_wokwi_library(library_name)

        # Strip @latest — arduino-cli does not support this token
        if library_name.endswith('@latest'):
            library_name = library_name[:-7]

        try:
            print(f"Installing library: {library_name}")

            # Handle "Name@version" syntax for versioned installs
            # Only quote if the version part is valid semver (major.minor.patch)
            import re
            lib_spec = library_name
            if '@' in library_name:
                parts = library_name.rsplit('@', 1)
                if len(parts) == 2 and parts[1]:
                    version = parts[1]
                    # Validate semver: major.minor.patch (all numeric)
                    if re.fullmatch(r'\d+\.\d+\.\d+', version):
                        lib_spec = library_name  # no quotes needed — subprocess passes args literally
                    else:
                        # Bad/empty version — fall back to plain name
                        library_name = parts[0]
                        lib_spec = library_name

            def _run():
                return subprocess.run(
                    [self.cli_path, "lib", "install", lib_spec],
                    capture_output=True, text=True, encoding='utf-8', errors='replace'
                )

            result = await asyncio.to_thread(_run)

            if result.returncode == 0:
                print(f"Successfully installed {library_name}")
                return {"success": True, "stdout": result.stdout}
            else:
                # If a specific version failed, retry with plain name (latest) in case
                # the version string is valid semver but rejected by arduino-cli for
                # other reasons (e.g. leading zeros, lib index corruption).
                if '@' in library_name:
                    plain_name = library_name.rsplit('@', 1)[0]
                    version = library_name.rsplit('@', 1)[1]
                    print(f"Versioned install failed, retrying with plain name: {plain_name}")
                    def _run_plain():
                        return subprocess.run(
                            [self.cli_path, "lib", "install", plain_name],
                            capture_output=True, text=True, encoding='utf-8', errors='replace'
                        )
                    result = await asyncio.to_thread(_run_plain)
                    if result.returncode == 0:
                        print(f"Successfully installed {plain_name} (fallback to latest)")
                        return {
                            "success": True,
                            "stdout": result.stdout,
                            "fallback": True,
                            "requested_version": version,
                        }
                print(f"Failed to install {library_name}: {result.stderr}")
                return {
                    "success": False,
                    "error": humanize_cli_error(
                        (result.stderr or "") + "\n" + (result.stdout or ""),
                        action=f"install {library_name}",
                    ),
                    "raw_error": result.stderr,
                    "stdout": result.stdout,
                }

        except Exception as e:
            print(f"Exception installing library: {e}")
            return {"success": False, "error": str(e)}

    async def _install_wokwi_library(self, library_spec: str) -> dict:
        """
        Download and install a Wokwi-hosted library.

        Wokwi stores custom libraries as projects.  The spec format is:
            LibName@wokwi:projectHash
        and the project ZIP is available at:
            https://wokwi.com/api/projects/{projectHash}/zip

        The ZIP is extracted into the Arduino user libraries directory so that
        arduino-cli can find the headers during compilation.
        """
        import json as _json
        import urllib.request
        import urllib.error
        import zipfile
        import os
        import shutil

        parts = library_spec.split('@wokwi:', 1)
        lib_name = parts[0].strip()
        project_hash = parts[1].strip()
        print(f"Installing Wokwi library: {lib_name} (project: {project_hash})")

        # ── Locate the Arduino user libraries directory ────────────────────────
        try:
            def _get_config():
                return subprocess.run(
                    [self.cli_path, "config", "dump", "--format", "json"],
                    capture_output=True, text=True, encoding='utf-8', errors='replace'
                )
            cfg_result = await asyncio.to_thread(_get_config)
            cfg = _json.loads(cfg_result.stdout)
            config_dict = cfg.get("config", cfg)
            dirs = config_dict.get("directories", {})
            user_dir = dirs.get("user", "") or dirs.get("sketchbook", "")
            if not user_dir:
                return {"success": False, "error": "Could not determine Arduino user directory from config"}
            lib_dir = Path(user_dir) / "libraries" / lib_name
        except Exception as e:
            return {"success": False, "error": f"Failed to read arduino-cli config: {e}"}

        # ── Download project ZIP ───────────────────────────────────────────────
        url = f"https://wokwi.com/api/projects/{project_hash}/zip"
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as tmp:
                tmp_path = tmp.name

            def _download():
                req = urllib.request.Request(
                    url,
                    headers={"User-Agent": "velxio-arduino-emulator/1.0"},
                )
                try:
                    with urllib.request.urlopen(req, timeout=30) as resp, \
                         open(tmp_path, 'wb') as out:
                        out.write(resp.read())
                except urllib.error.HTTPError as http_err:
                    raise RuntimeError(
                        f"Could not download Wokwi library '{lib_name}' "
                        f"(HTTP {http_err.code}). "
                        f"Wokwi-hosted libraries require the Wokwi platform and "
                        f"cannot be installed automatically in a local environment."
                    ) from http_err

            await asyncio.to_thread(_download)

            # ── Extract into the libraries directory ───────────────────────────
            if lib_dir.exists():
                shutil.rmtree(lib_dir)
            lib_dir.mkdir(parents=True, exist_ok=True)

            with zipfile.ZipFile(tmp_path, 'r') as zf:
                for zi in zf.infolist():
                    # Skip directories and Wokwi-specific files
                    if zi.is_dir():
                        continue
                    fname = zi.filename
                    basename = Path(fname).name
                    if not basename or basename == 'wokwi-project.txt':
                        continue
                    # Flatten any subdirectory structure
                    dest = lib_dir / basename
                    dest.write_bytes(zf.read(fname))

            # Create a minimal library.properties so arduino-cli recognises it
            props = lib_dir / "library.properties"
            if not props.exists():
                props.write_text(
                    f"name={lib_name}\nversion=1.0.0\nauthor=Wokwi\n"
                    f"sentence=Wokwi-hosted library\nparagraph=\ncategory=Other\n"
                    f"url=https://wokwi.com/projects/{project_hash}\n"
                    f"architectures=*\n"
                )

            print(f"Installed Wokwi library {lib_name} to {lib_dir}")
            return {"success": True, "stdout": f"Installed {lib_name} from Wokwi project {project_hash}"}

        except Exception as e:
            print(f"Error installing Wokwi library {lib_name}: {e}")
            return {"success": False, "error": str(e)}
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    async def list_installed_libraries(self) -> dict:
        """
        List all installed Arduino libraries.

        P2.1h: when VELXIO_FALLBACK_SKETCHBOOK is set (pro overlay), list the
        content-addressed cache (its libraries/ is the cache root) instead of the
        shared global volume, so the Library Manager 'Installed' view survives the
        global volume's retirement. Unset (OSS) -> arduino-cli's default sketchbook.
        """
        try:
            list_env = dict(os.environ)
            _fb = os.environ.get("VELXIO_FALLBACK_SKETCHBOOK")
            if _fb:
                list_env["ARDUINO_DIRECTORIES_USER"] = _fb

            def _run():
                return subprocess.run(
                    [self.cli_path, "lib", "list", "--format", "json"],
                    capture_output=True, text=True, encoding='utf-8', errors='replace',
                    env=list_env,
                )

            result = await asyncio.to_thread(_run)
            stdout, stderr = result.stdout, result.stderr

            if result.returncode != 0:
                print(f"Error listing libraries: {stderr}")
                return {"success": False, "error": stderr}
                
            import json
            try:
                if not stdout.strip():
                    return {"success": True, "libraries": []}

                results = json.loads(stdout)

                # arduino-cli lib list --format json wraps results in "installed_libraries"
                if isinstance(results, list):
                    libraries = results
                elif isinstance(results, dict):
                    libraries = (
                        results.get("installed_libraries")
                        or results.get("libraries")
                        or []
                    )
                else:
                    libraries = []

                return {"success": True, "libraries": libraries}

            except json.JSONDecodeError:
                return {"success": False, "error": "Invalid output format from arduino-cli"}

        except Exception as e:
            print(f"Exception listing libraries: {e}")
            return {"success": False, "error": str(e)}

    async def uninstall_library(self, library_name: str) -> dict:
        """
        Uninstall an Arduino library.

        A no-op is reported as a FAILURE. arduino-cli prints "Library X is not
        installed" and exits 0, which read as success and told the agent its
        uninstall had worked; it recompiled, hit the same error, and uninstalled
        the same library again. Three times, in the session that prompted this.

        DELIBERATELY does NOT point at VELXIO_FALLBACK_SKETCHBOOK, even though
        `list_installed_libraries` does. On velxio.dev that sketchbook's
        libraries/ is a symlink to the shared content-addressed cache: every
        library, for every user. Uninstall is a per-user operation and must
        never be able to reach it. Making the two agree looked like a
        consistency fix and was in fact a way to delete a library out from
        under everyone (caught in review before it could be used, 2026-09-01).
        The asymmetry is the safety property: listing is read-only, uninstall
        is not.
        """
        try:
            print(f"Uninstalling library: {library_name}")

            def _run():
                return subprocess.run(
                    [self.cli_path, "lib", "uninstall", library_name],
                    capture_output=True, text=True, encoding='utf-8', errors='replace',
                )

            result = await asyncio.to_thread(_run)

            if result.returncode == 0:
                combined = f"{result.stdout or ''}\n{result.stderr or ''}".lower()
                if "is not installed" in combined:
                    print(f"Nothing to uninstall: {library_name} is not installed")
                    return {
                        "success": False,
                        "error": (
                            f"{library_name} is not installed in this project, so "
                            f"there is nothing to uninstall. If a compile is failing "
                            f"inside it, the library came from the server-wide shared "
                            f"cache: declare the libraries your sketch actually uses "
                            f"in the project manifest instead."
                        ),
                        "stdout": result.stdout,
                    }
                print(f"Successfully uninstalled {library_name}")
                return {"success": True, "stdout": result.stdout}
            else:
                print(f"Failed to uninstall {library_name}: {result.stderr}")
                return {"success": False, "error": result.stderr, "stdout": result.stdout}

        except Exception as e:
            print(f"Exception uninstalling library: {e}")
            return {"success": False, "error": str(e)}
