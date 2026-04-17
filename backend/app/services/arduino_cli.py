import subprocess
import tempfile
import asyncio
import base64
from pathlib import Path


class ArduinoCLIService:
    # Board manager URLs for cores that aren't built-in
    CORE_URLS: dict[str, str] = {
        "rp2040:rp2040": "https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json",
        "esp32:esp32": "https://espressif.github.io/arduino-esp32/package_esp32_index.json",
    }

    # Cores to auto-install on startup
    REQUIRED_CORES = ["arduino:avr"]

    # Cores to install on-demand when a board FQBN is requested
    ON_DEMAND_CORES: dict[str, str] = {
        "rp2040": "rp2040:rp2040",
        "mbed_rp2040": "arduino:mbed_rp2040",
        "esp32": "esp32:esp32",
    }

    def __init__(self, cli_path: str = "arduino-cli"):
        self.cli_path = cli_path
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
        """Check whether a core is currently installed."""
        result = subprocess.run(
            [self.cli_path, "core", "list"],
            capture_output=True, text=True
        )
        return core_id in result.stdout

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

        # Install the core
        print(f"[arduino-cli] Auto-installing core {core_id} for board {fqbn}...")

        def _install():
            return subprocess.run(
                [self.cli_path, "core", "install", core_id],
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

    def _is_esp32c3_board(self, fqbn: str) -> bool:
        """Return True if the FQBN targets an ESP32-C3 (RISC-V) board.

        ESP32-C3 places the bootloader at flash offset 0x0000, unlike Xtensa
        boards (ESP32, ESP32-S3) which use 0x1000.
        """
        return "esp32c3" in fqbn or "xiao-esp32-c3" in fqbn or "aitewinrobot-esp32c3-supermini" in fqbn

    async def compile(self, files: list[dict], board_fqbn: str = "arduino:avr:uno") -> dict:
        """
        Compile Arduino sketch using arduino-cli.

        `files` is a list of {"name": str, "content": str} dicts.
        arduino-cli requires the sketch directory to contain a .ino file whose
        name matches the directory ("sketch").  If none exists we promote the
        first .ino file to sketch.ino automatically.

        Returns:
            dict with keys: success, hex_content, stdout, stderr, error
        """
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

                (sketch_dir / write_name).write_text(content, encoding="utf-8")

            # Fallback: no .ino files provided at all
            if not any(f["name"].endswith(".ino") for f in files):
                (sketch_dir / "sketch.ino").write_text("void setup(){}\nvoid loop(){}", encoding="utf-8")

            print(f"Sketch directory contents: {[p.name for p in sketch_dir.iterdir()]}")

            build_dir = sketch_dir / "build"
            build_dir.mkdir()
            print(f"Build directory: {build_dir}")

            try:
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
                        text=True
                    )

                result = await asyncio.to_thread(run_compile)

                print(f"Process return code: {result.returncode}")
                print(f"Stdout: {result.stdout}")
                print(f"Stderr: {result.stderr}")

                if result.returncode == 0:
                    print(f"Files in build dir: {list(build_dir.iterdir())}")

                    if self._is_rp2040_board(board_fqbn):
                        # RP2040 outputs a .bin file (and optionally .uf2)
                        # Try .bin first (raw binary, simplest to load into emulator)
                        bin_file = build_dir / "sketch.ino.bin"
                        uf2_file = build_dir / "sketch.ino.uf2"

                        target_file = bin_file if bin_file.exists() else (uf2_file if uf2_file.exists() else None)

                        if target_file:
                            raw_bytes = target_file.read_bytes()
                            binary_b64 = base64.b64encode(raw_bytes).decode('ascii')
                            print(f"[RP2040] Binary file: {target_file.name}, size: {len(raw_bytes)} bytes")
                            print("=== RP2040 Compilation successful ===\n")
                            return {
                                "success": True,
                                "hex_content": None,
                                "binary_content": binary_b64,
                                "binary_type": "bin" if target_file == bin_file else "uf2",
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
                    return {
                        "success": False,
                        "error": "Compilation failed",
                        "stdout": result.stdout,
                        "stderr": result.stderr
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
                return {"success": False, "error": stderr}
                
            import json
            try:
                results = json.loads(stdout)
                libraries = results.get("libraries", [])

                # arduino-cli search returns each lib with a "releases" dict.
                # Inject a "latest" key with the data of the highest version so the
                # frontend can access lib.latest.version / author / sentence directly.
                def _parse_version(v: str):
                    try:
                        return tuple(int(x) for x in v.split("."))
                    except Exception:
                        return (0,)

                for lib in libraries:
                    releases = lib.get("releases") or {}
                    if releases:
                        latest_key = max(releases.keys(), key=_parse_version)
                        lib["latest"] = {**releases[latest_key], "version": latest_key}

                return {"success": True, "libraries": libraries}
            except json.JSONDecodeError:
                return {"success": False, "error": "Invalid output format from arduino-cli"}

        except Exception as e:
            print(f"Exception searching libraries: {e}")
            return {"success": False, "error": str(e)}

    async def install_library(self, library_name: str) -> dict:
        """
        Install an Arduino library.
        Handles standard library names as well as Wokwi-hosted entries in
        the form  "LibName@wokwi:projectHash".
        """
        if '@wokwi:' in library_name:
            return await self._install_wokwi_library(library_name)

        try:
            print(f"Installing library: {library_name}")

            def _run():
                return subprocess.run(
                    [self.cli_path, "lib", "install", library_name],
                    capture_output=True, text=True, encoding='utf-8', errors='replace'
                )

            result = await asyncio.to_thread(_run)

            if result.returncode == 0:
                print(f"Successfully installed {library_name}")
                return {"success": True, "stdout": result.stdout}
            else:
                print(f"Failed to install {library_name}: {result.stderr}")
                return {"success": False, "error": result.stderr, "stdout": result.stdout}

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
        List all installed Arduino libraries
        """
        try:
            def _run():
                return subprocess.run(
                    [self.cli_path, "lib", "list", "--format", "json"],
                    capture_output=True, text=True, encoding='utf-8', errors='replace'
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
