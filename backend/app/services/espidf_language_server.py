"""Use a host-configured ESP-IDF CMake build for pure ESP-IDF sketches."""
from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

ESP_IDF_FQBN = "esp32:esp32:esp32c3"
_CPP = {".cpp", ".cc", ".cxx"}


def espidf_database() -> Path | None:
    configured = os.environ.get("VELXIO_ESPIDF_INTELLISENSE_DB")
    if not configured:
        return None
    path = Path(configured).resolve()
    return path if path.is_file() else None


def _arguments(entry: dict) -> list[str]:
    arguments = entry.get("arguments")
    if isinstance(arguments, list):
        return arguments
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        split = ctypes.windll.shell32.CommandLineToArgvW
        split.argtypes = (wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int))
        split.restype = ctypes.POINTER(wintypes.LPWSTR)
        free = ctypes.windll.kernel32.LocalFree
        free.argtypes = (wintypes.HLOCAL,)
        free.restype = wintypes.HLOCAL
        count = ctypes.c_int()
        values = split(entry["command"], ctypes.byref(count))
        if not values:
            raise ValueError("Invalid ESP-IDF compile command")
        try:
            return [values[i] for i in range(count.value)]
        finally:
            free(ctypes.cast(values, wintypes.HLOCAL))
    return shlex.split(entry["command"])


def _compile_flags(entry: dict, workspace: Path, source: Path) -> tuple[list[str], list[Path]]:
    original = Path(entry["directory"]) / entry["file"]
    directory = Path(entry["directory"])
    args = iter(_arguments(entry))
    compiler = next(args)
    # Include the current project before SDK and component roots from CMake.
    flags = [compiler, "-I" + str(workspace)]
    include_roots = []
    for arg in args:
        if arg in {"-o", "-MF", "-MT", "-MQ"}:
            next(args, None)
            continue
        if arg in {"-c", "-MD", "-MMD", "-MP"}:
            continue
        if arg.startswith(("-I", "-isystem", "-iquote")):
            option = next(prefix for prefix in ("-isystem", "-iquote", "-I") if arg.startswith(prefix))
            include = (directory / (arg[len(option):] or next(args, ""))).resolve()
            # The original main component's source is replaced by our draft.
            if include.is_relative_to(original.parent.resolve()):
                continue
            include_roots.append(include)
            flags.extend([option, str(include)])
        elif arg.startswith("-") or (directory / arg).resolve() != original.resolve():
            flags.append(arg)
    return flags + ["-c", str(source)], include_roots


def prepare_espidf(
    clangd: str, root: Path, sources: list[Path], database: Path,
) -> tuple[list[str], list[Path]]:
    # CMake's main component holds the user's source. Bootloader and SDK
    # component commands have different definitions and include paths.
    entries = json.loads(database.read_text(encoding="utf-8"))
    templates = {}
    for entry in entries:
        source = Path(entry["file"])
        if source.parent.name == "main" and source.suffix in _CPP | {".c"}:
            language = "cpp" if source.suffix in _CPP else "c"
            templates.setdefault(language, entry)
    commands = []
    includes = set()
    drivers = set()
    for source in sources:
        language = "cpp" if source.suffix in _CPP else "c" if source.suffix == ".c" else None
        template = templates.get(language)
        if not template:
            continue
        flags, roots = _compile_flags(template, root, source)
        includes.update(roots)
        if Path(flags[0]).is_absolute():
            drivers.add(flags[0])
        commands.append({"directory": template["directory"], "file": str(source), "arguments": flags})
    if not commands:
        raise ValueError("No ESP-IDF compile command for the workspace's source language")
    (root / "compile_commands.json").write_text(json.dumps(commands), encoding="utf-8")
    command = [clangd, f"--compile-commands-dir={root}", "--background-index=false", "--enable-config=false", "-j=1"]
    if drivers:
        command.append("--query-driver=" + ",".join(sorted(drivers)))
    return command, list(includes)
