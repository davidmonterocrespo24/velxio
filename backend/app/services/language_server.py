"""Process and workspace adapters for the editor's optional language servers."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
from urllib.request import url2pathname

from app.core.hooks import materialize_library_scope
from app.services.espidf_language_server import ESP_IDF_FQBN, espidf_database, prepare_espidf

ARDUINO_BOARDS = frozenset({
    "arduino:avr:uno", "arduino:avr:mega", "arduino:avr:nano:cpu=atmega328",
})
MICROPYTHON_BOARDS = {
    "raspberry-pi-pico": "rp2-pico",
    "pi-pico-w": "rp2-pico-w",
    "esp32": "esp32",
}
CPP_EXTENSIONS = {".ino", ".c", ".cpp", ".cc", ".cxx", ".h", ".hh", ".hpp", ".hxx"}
PYTHON_EXTENSIONS = {".py", ".pyi"}
MAX_FILES = 128
MAX_SOURCE_BYTES = 2 * 1024 * 1024


def tools_for(engine: str) -> list[str] | None:
    if os.environ.get("VELXIO_ENABLE_LANGUAGE_SERVERS") != "1":
        return None
    if engine == "arduino":
        programs = [
            ("VELXIO_ARDUINO_LANGUAGE_SERVER", "arduino-language-server"),
            ("VELXIO_CLANGD", "clangd"),
            ("VELXIO_INTELLISENSE_ARDUINO_CLI", "arduino-cli"),
        ]
    elif engine == "micropython":
        programs = [("VELXIO_PYRIGHT_LANGSERVER", "pyright-langserver")]
    elif engine == "espidf":
        programs = [("VELXIO_CLANGD", "clangd")]
    else:
        return None
    paths = [shutil.which(os.environ.get(env, program)) for env, program in programs]
    return [str(Path(path).resolve()) for path in paths if path] if all(paths) else None


def stub_path(board: str) -> Path | None:
    root = os.environ.get("VELXIO_MICROPYTHON_STUBS")
    name = MICROPYTHON_BOARDS.get(board)
    if not root or not name:
        return None
    path = Path(root).resolve() / name
    return path if path.is_dir() else None


def _valid_name(name: str, extensions: set[str]) -> bool:
    path = PurePosixPath(name)
    return (
        len(name) <= 240 and not path.is_absolute()
        and name == path.as_posix() and path.suffix.lower() in extensions
        and all(
            part not in (".", "..") and not part.endswith((".", " "))
            and re.fullmatch(r"[\w. -]+", part) is not None
            and not re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])", part.split(".")[0], re.I)
            for part in path.parts
        )
    )


def _cli_directory(program: str, name: str, env: dict[str, str], config: str | None) -> Path | None:
    command = [program, "config", "get", f"directories.{name}"]
    if config:
        command += ["--config-file", config]
    result = subprocess.run(
        command, capture_output=True,
        text=True, timeout=5, env=env,
    )
    path = result.stdout.strip().strip('"')
    return Path(path).resolve() if result.returncode == 0 and path else None


def _source_path(uri: str) -> Path | None:
    parts = urlsplit(uri)
    if parts.scheme != "file" or parts.netloc or parts.query or parts.fragment:
        return None
    path = parts.path
    if os.name == "nt":
        # Some LSP servers encode the Windows drive colon; url2pathname
        # needs it in literal form to recognize the drive letter.
        path = re.sub(r"^/([a-zA-Z])%3[aA]", r"/\1:", path)
    return Path(url2pathname(path)).resolve()


@dataclass
class Document:
    path: Path
    text: str
    version: int = 1


class Workspace:
    def __init__(self, root: Path, request: dict):
        engine, board, files = request.get("engine"), request.get("board"), request.get("files")
        if not isinstance(engine, str) or not isinstance(board, str) or not isinstance(files, list):
            raise ValueError("Invalid language server context")
        if not 0 < len(files) <= MAX_FILES:
            raise ValueError("Invalid workspace file count")
        tools = tools_for(engine)
        if not tools:
            raise ValueError("Language server is unavailable")
        stubs = stub_path(board) if engine == "micropython" else None
        database = espidf_database() if engine == "espidf" and board == ESP_IDF_FQBN else None
        if not (stubs or database or (engine == "arduino" and board in ARDUINO_BOARDS)):
            raise ValueError("Board is not supported by this language server")

        self.engine = engine
        self.root = root / ("sketch" if engine == "arduino" else "workspace")
        self.root.mkdir()
        self.env = dict(os.environ)
        self.documents: dict[str, Document] = {}
        self.external_roots: list[Path] = []
        self.scope_root: Path | None = None
        extensions = PYTHON_EXTENSIONS if stubs else CPP_EXTENSIONS - {".ino"} if database else CPP_EXTENSIONS
        sources = self._read_sources(files, extensions)
        main = next((name for name in sources if name.endswith(".ino")), None)
        for name, content in sources.items():
            relative = "sketch.ino" if engine == "arduino" and name == main and "sketch.ino" not in sources else name
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="")
            self.documents[name] = Document(path, content)
        if engine == "arduino" and not (self.root / "sketch.ino").exists():
            (self.root / "sketch.ino").write_text("void setup() {}\nvoid loop() {}\n", encoding="utf-8")
        self.names = {doc.path.resolve(): name for name, doc in self.documents.items()}
        if stubs:
            self.external_roots.append(stubs.resolve())
            (self.root / "pyrightconfig.json").write_text(json.dumps({
                "stubPath": str(stubs), "extraPaths": [str(stubs)], "typeCheckingMode": "basic",
                "useLibraryCodeForTypes": False,
            }), encoding="utf-8")
            self.command = [tools[0], "--stdio"]
        elif database:
            self.command, self.external_roots = prepare_espidf(
                tools[0], self.root, list(self.names), database,
            )
        else:
            self.command = self._arduino_command(tools, board, request.get("libraries"))

    @staticmethod
    def _read_sources(files: list, extensions: set[str]) -> dict[str, str]:
        sources = {}
        seen = set()
        size = 0
        for item in files:
            if not isinstance(item, dict):
                raise ValueError("Invalid workspace file")
            name, content = item.get("name"), item.get("content")
            if not isinstance(name, str) or not _valid_name(name, extensions) or name.casefold() in seen:
                raise ValueError("Invalid workspace filename")
            if not isinstance(content, str) or "\x00" in content:
                raise ValueError("Invalid workspace source")
            size += len(content.encode("utf-8"))
            if size > MAX_SOURCE_BYTES:
                raise ValueError("Workspace is too large")
            sources[name] = content
            seen.add(name.casefold())
        return sources

    def _arduino_command(self, tools: list[str], board: str, libraries: list[str] | None):
        server, clangd, cli = tools
        if libraries is not None and (
            not isinstance(libraries, list) or len(libraries) > 100
            or any(not isinstance(spec, str) or not 0 < len(spec) <= 160 for spec in libraries)
        ):
            raise ValueError("Invalid library manifest")
        config = os.environ.get("VELXIO_INTELLISENSE_CLI_CONFIG")
        data = _cli_directory(cli, "data", self.env, config)
        user = _cli_directory(cli, "user", self.env, config)
        if data:
            self.external_roots.append(data / "packages")
        if user:
            self.external_roots.append(user / "libraries")

        command = [server, "-clangd", clangd, "-cli", cli, "-fqbn", board, "-jobs", "1"]
        if config:
            command += ["-cli-config", config]
        elif data and (data / "arduino-cli.yaml").is_file():
            command += ["-cli-config", str(data / "arduino-cli.yaml")]
        scope = materialize_library_scope(set(libraries), None) if libraries else None
        if scope:
            self.scope_root = scope[0].parent
            self.env["ARDUINO_DIRECTORIES_USER"] = str(self.scope_root)
            self.external_roots.extend(path.resolve() for path in scope[0].iterdir() if path.is_dir())
        elif fallback := self.env.get("VELXIO_FALLBACK_SKETCHBOOK"):
            self.env["ARDUINO_DIRECTORIES_USER"] = fallback
            self.external_roots.append(Path(fallback) / "libraries")
        return command

    def name_for(self, uri: str) -> str | None:
        return self.names.get(_source_path(uri))

    def definition(self, location: dict) -> dict | None:
        path = _source_path(location.get("targetUri", location.get("uri", "")))
        span = location.get("targetSelectionRange", location.get("range"))
        if not path or not span:
            return None
        if name := self.names.get(path):
            return {"name": name, "range": span}
        if path.suffix.lower() not in CPP_EXTENSIONS | PYTHON_EXTENSIONS:
            return None
        if not any(path.is_relative_to(root.resolve()) for root in self.external_roots):
            return None
        try:
            if path.stat().st_size > 256 * 1024:
                return None
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
        key = hashlib.sha256(os.fsencode(path)).hexdigest()[:24]
        return {"name": path.name, "range": span, "dependency": {"id": key, "content": content}}


class LanguageServer:
    def __init__(self, workspace: Workspace):
        command = workspace.command
        # npm supplies a trusted .cmd shim on Windows. Invoke the installed
        # JS entry point with Node so arguments never pass through cmd.exe.
        launcher = Path(command[0])
        if launcher.suffix.lower() == ".cmd" and launcher.stem == "pyright-langserver":
            entries = (
                launcher.parent / "node_modules" / "pyright" / "langserver.index.js",
                launcher.parent.parent / "pyright" / "langserver.index.js",
            )
            entry = next((path for path in entries if path.is_file()), None)
            if entry is None:
                raise ValueError("Pyright’s npm entry point is missing")
            command = [shutil.which("node") or "node", str(entry), *command[1:]]
        self.process = subprocess.Popen(
            command, env=workspace.env, stdin=subprocess.PIPE, start_new_session=os.name != "nt",
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        self.messages: asyncio.Queue = asyncio.Queue(maxsize=128)
        self.reader = asyncio.create_task(self._pump())

    def _read(self):
        stream = self.process.stdout
        length = 0
        while line := stream.readline(4096):
            if line in (b"\r\n", b"\n"):
                break
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":", 1)[1])
        if not 0 < length <= 16 * 1024 * 1024:
            raise EOFError("Language server closed its message stream")
        return json.loads(stream.read(length))

    def _write(self, message):
        payload = json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False).encode("utf-8")
        self.process.stdin.write(f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii") + payload)
        self.process.stdin.flush()

    async def _pump(self):
        try:
            while True:
                await self.messages.put(await asyncio.to_thread(self._read))
        except (OSError, EOFError, ValueError) as exc:
            await self.messages.put(exc)

    async def read(self):
        message = await self.messages.get()
        if isinstance(message, Exception):
            raise message
        return message

    async def send(self, **message):
        await asyncio.to_thread(self._write, message)

    async def close(self):
        async def wait_for_shutdown():
            while (await self.read()).get("id") != 2147483647:
                pass

        if self.process.poll() is None:
            try:
                await self.send(method="shutdown", id=2147483647)
                await asyncio.wait_for(wait_for_shutdown(), 2)
            except (OSError, EOFError, ValueError, TimeoutError):
                pass
            try:
                await self.send(method="exit")
            except OSError:
                pass
            self.process.stdin.close()
            try:
                await asyncio.to_thread(self.process.wait, 3)
            except subprocess.TimeoutExpired:
                await asyncio.to_thread(self._kill_tree)
                await asyncio.to_thread(self.process.wait)
        if os.name != "nt":
            # The wrapper may already have exited while clangd was still up.
            await asyncio.to_thread(self._kill_tree)
        self.reader.cancel()
        await asyncio.gather(self.reader, return_exceptions=True)
        self.process.stdin.close()
        await asyncio.to_thread(self.process.stdout.close)

    def _kill_tree(self):
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(self.process.pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
            )
            if self.process.poll() is None:
                self.process.kill()
        else:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def full_edit(old: str, new: str) -> dict:
    """Send the changed range so Arduino LS can update its sketch line map."""
    start = 0
    while start < min(len(old), len(new)) and old[start] == new[start]:
        start += 1
    old_end, new_end = len(old), len(new)
    while old_end > start and new_end > start and old[old_end - 1] == new[new_end - 1]:
        old_end -= 1
        new_end -= 1

    def position(offset: int) -> dict:
        prefix = old[:offset]
        column = prefix.rsplit("\n", 1)[-1].removesuffix("\r")
        return {"line": prefix.count("\n"), "character": len(column.encode("utf-16-le")) // 2}

    return {"text": new[start:new_end], "range": {
        "start": position(start),
        "end": position(old_end),
    }}
