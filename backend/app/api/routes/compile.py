import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.arduino_cli import ArduinoCLIService
from app.services.espidf_compiler import espidf_compiler

logger = logging.getLogger(__name__)

router = APIRouter()
arduino_cli = ArduinoCLIService()


class SketchFile(BaseModel):
    name: str
    content: str


class CompileRequest(BaseModel):
    # New multi-file API
    files: list[SketchFile] | None = None
    # Legacy single-file API (kept for backward compat)
    code: str | None = None
    board_fqbn: str = "arduino:avr:uno"


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


@router.post("/", response_model=CompileResponse)
async def compile_sketch(request: CompileRequest):
    """
    Compile Arduino sketch and return hex/binary.
    Accepts either `files` (multi-file) or legacy `code` (single file).
    Auto-installs the required board core if not present.
    """
    # Resolve files list
    if request.files:
        files = [{"name": f.name, "content": f.content} for f in request.files]
    elif request.code is not None:
        files = [{"name": "sketch.ino", "content": request.code}]
    else:
        raise HTTPException(
            status_code=422,
            detail="Provide either 'files' or 'code' in the request body.",
        )

    try:
        # ESP32 targets: use ESP-IDF compiler for QEMU-compatible output
        if request.board_fqbn.startswith("esp32:") and espidf_compiler.available:
            logger.info(f"[compile] Using ESP-IDF for {request.board_fqbn}")
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

        result = await arduino_cli.compile(files, request.board_fqbn)
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
