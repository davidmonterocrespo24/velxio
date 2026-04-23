import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from app.services.arduino_cli import ArduinoCLIService
from app.services.espidf_compiler import espidf_compiler
from app.services.library_validation import (
    LibraryFileSpec,
    LibrarySpec,
    LibraryValidationError,
    validate_libraries,
)

logger = logging.getLogger(__name__)

router = APIRouter()
arduino_cli = ArduinoCLIService()


class SketchFile(BaseModel):
    name: str
    content: str


class CompileLibraryFile(BaseModel):
    path: str
    content: str


class CompileLibrary(BaseModel):
    """A vendored Arduino library shipped by a plugin.

    Mirrors ``LibraryDefinition`` from ``@velxio/sdk`` but only the fields the
    backend needs to materialize the library on disk. ``version`` is logged
    so build output identifies what was compiled (arduino-cli does not
    resolve from a registry — these libraries are vendored, not searched).
    """

    id: str = Field(..., min_length=1, max_length=128)
    version: str = Field(..., min_length=1, max_length=32)
    files: list[CompileLibraryFile] = Field(..., min_length=1, max_length=512)


class CompileRequest(BaseModel):
    files: list[SketchFile] | None = None
    code: str | None = None
    board_fqbn: str = "arduino:avr:uno"
    libraries: list[CompileLibrary] | None = None


class CompileResponse(BaseModel):
    success: bool
    hex_content: str | None = None
    binary_content: str | None = None  # base64-encoded .bin for RP2040
    binary_type: str | None = None     # 'bin' or 'uf2'
    has_wifi: bool = False             # True when sketch uses WiFi (ESP32 only)
    stdout: str
    stderr: str
    error: str | None = None
    core_install_log: str | None = None


def _validated_libraries(libraries: list[CompileLibrary] | None) -> list[dict]:
    """Run server-side validation and convert to the dict shape the
    arduino-cli wrapper consumes. Validation runs even when the request
    looks well-formed at the Pydantic layer because Pydantic enforces
    structural caps but not the byte/path/preprocessor rules from the SDK.
    """
    if not libraries:
        return []
    specs = [
        LibrarySpec(
            id=lib.id,
            version=lib.version,
            files=tuple(LibraryFileSpec(path=f.path, content=f.content) for f in lib.files),
        )
        for lib in libraries
    ]
    try:
        validated = validate_libraries(specs)
    except LibraryValidationError as exc:
        raise HTTPException(status_code=exc.http_status, detail=str(exc)) from exc
    return [
        {
            "id": spec.id,
            "version": spec.version,
            "files": [{"path": f.path, "content": f.content} for f in spec.files],
        }
        for spec in validated
    ]


@router.post("/", response_model=CompileResponse)
async def compile_sketch(request: CompileRequest):
    """
    Compile Arduino sketch and return hex/binary.
    Accepts either `files` (multi-file) or legacy `code` (single file).
    Auto-installs the required board core if not present.
    """
    if request.files:
        files = [{"name": f.name, "content": f.content} for f in request.files]
    elif request.code is not None:
        files = [{"name": "sketch.ino", "content": request.code}]
    else:
        raise HTTPException(
            status_code=422,
            detail="Provide either 'files' or 'code' in the request body.",
        )

    libraries = _validated_libraries(request.libraries)

    try:
        # ESP32 targets: use ESP-IDF compiler for QEMU-compatible output
        if request.board_fqbn.startswith("esp32:") and espidf_compiler.available:
            logger.info(f"[compile] Using ESP-IDF for {request.board_fqbn}")
            if libraries:
                # ESP-IDF compiler does not consume vendored libraries today;
                # silently ignoring would be a foot-gun. Log so a missing
                # symbol error in the build output ties back to this branch.
                logger.warning(
                    "[compile] ESP-IDF path ignores %d plugin-supplied librar%s",
                    len(libraries),
                    "y" if len(libraries) == 1 else "ies",
                )
            result = await espidf_compiler.compile(files, request.board_fqbn)
            return CompileResponse(
                success=result["success"],
                hex_content=result.get("hex_content"),
                binary_content=result.get("binary_content"),
                binary_type=result.get("binary_type"),
                has_wifi=result.get("has_wifi", False),
                stdout=result.get("stdout", ""),
                stderr=result.get("stderr", ""),
                error=result.get("error"),
            )

        # AVR, RP2040, and ESP32 fallback: use arduino-cli
        core_status = await arduino_cli.ensure_core_for_board(request.board_fqbn)
        core_log = core_status.get("log", "")

        if core_status.get("needed") and not core_status.get("installed"):
            return CompileResponse(
                success=False,
                stdout="",
                stderr=core_log,
                error=f"Failed to install required core: {core_status.get('core_id')}",
            )

        result = await arduino_cli.compile(
            files,
            request.board_fqbn,
            libraries=libraries,
        )
        return CompileResponse(
            success=result["success"],
            hex_content=result.get("hex_content"),
            binary_content=result.get("binary_content"),
            binary_type=result.get("binary_type"),
            stdout=result.get("stdout", ""),
            stderr=result.get("stderr", ""),
            error=result.get("error"),
            core_install_log=core_log if core_log else None,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/setup-status")
async def setup_status():
    return await arduino_cli.get_setup_status()


@router.post("/ensure-core")
async def ensure_core(request: CompileRequest):
    fqbn = request.board_fqbn
    result = await arduino_cli.ensure_core_for_board(fqbn)
    return result


@router.get("/boards")
async def list_boards():
    boards = await arduino_cli.list_boards()
    return {"boards": boards}
