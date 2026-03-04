import subprocess
import tempfile
import asyncio
import base64
from pathlib import Path


class ArduinoCLIService:
    def __init__(self, cli_path: str = "arduino-cli"):
        self.cli_path = cli_path
        self._ensure_core_installed()

    def _ensure_core_installed(self):
        """
        Ensure Arduino AVR core is installed.
        RP2040 core is optional (installed separately by the user).
        """
        try:
            result = subprocess.run(
                [self.cli_path, "core", "list"],
                capture_output=True,
                text=True
            )

            if "arduino:avr" not in result.stdout:
                print("Arduino AVR core not installed. Installing...")
                subprocess.run(
                    [self.cli_path, "core", "install", "arduino:avr"],
                    check=True
                )
                print("Arduino AVR core installed successfully")
        except Exception as e:
            print(f"Warning: Could not verify arduino:avr core: {e}")
            print("Please ensure arduino-cli is installed and in PATH")

    def _is_rp2040_board(self, fqbn: str) -> bool:
        """Return True if the FQBN targets an RP2040/RP2350 board."""
        return any(p in fqbn for p in ("rp2040", "rp2350", "mbed_rp2040", "mbed_rp2350"))

    async def compile(self, code: str, board_fqbn: str = "arduino:avr:uno") -> dict:
        """
        Compile Arduino sketch using arduino-cli

        Returns:
            dict with keys: success, hex_content, stdout, stderr, error
        """
        print(f"\n=== Starting compilation ===")
        print(f"Board: {board_fqbn}")
        print(f"Code length: {len(code)} chars")
        print(f"Code:\n{code}")

        # Create temporary directory for sketch
        with tempfile.TemporaryDirectory() as temp_dir:
            sketch_dir = Path(temp_dir) / "sketch"
            sketch_dir.mkdir()

            # arduino-cli requires sketch name to match directory name
            sketch_file = sketch_dir / "sketch.ino"
            sketch_file.write_text(code)
            print(f"Created sketch file: {sketch_file}")

            build_dir = sketch_dir / "build"
            build_dir.mkdir()
            print(f"Build directory: {build_dir}")

            try:
                # Run compilation using subprocess.run in a thread (Windows compatible)
                cmd = [
                    self.cli_path,
                    "compile",
                    "--fqbn", board_fqbn,
                    "--output-dir", str(build_dir),
                    str(sketch_dir)
                ]
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
