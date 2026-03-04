from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.arduino_cli import ArduinoCLIService

router = APIRouter()
arduino_cli = ArduinoCLIService()


class CompileRequest(BaseModel):
    code: str
    board_fqbn: str = "arduino:avr:uno"


class CompileResponse(BaseModel):
    success: bool
    hex_content: str | None = None
    binary_content: str | None = None  # base64-encoded .bin for RP2040
    binary_type: str | None = None     # 'bin' or 'uf2'
    stdout: str
    stderr: str
    error: str | None = None


@router.post("/", response_model=CompileResponse)
async def compile_sketch(request: CompileRequest):
    """
    Compile Arduino sketch and return hex file
    """
    try:
        result = await arduino_cli.compile(request.code, request.board_fqbn)
        return CompileResponse(
            success=result["success"],
            hex_content=result.get("hex_content"),
            binary_content=result.get("binary_content"),
            binary_type=result.get("binary_type"),
            stdout=result.get("stdout", ""),
            stderr=result.get("stderr", ""),
            error=result.get("error")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/boards")
async def list_boards():
    """
    List available Arduino boards
    """
    boards = await arduino_cli.list_boards()
    return {"boards": boards}
