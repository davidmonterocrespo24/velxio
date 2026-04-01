from __future__ import annotations
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from app.api.routes.compile import arduino_cli

router = APIRouter()

class InstallLibraryRequest(BaseModel):
    name: str

class SearchResponse(BaseModel):
    success: bool
    libraries: list = []
    error: str | None = None

class InstallResponse(BaseModel):
    success: bool
    stdout: str | None = None
    error: str | None = None

@router.get("/search", response_model=SearchResponse)
async def search_libraries(q: str = Query(..., description="Search query for library")):
    """
    Search for Arduino libraries by name or topic.
    """
    try:
        result = await arduino_cli.search_libraries(q)
        if not result["success"]:
            raise HTTPException(status_code=500, detail=result.get("error", "Failed to search libraries"))
        return SearchResponse(success=True, libraries=result.get("libraries", []))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/install", response_model=InstallResponse)
async def install_library(request: InstallLibraryRequest):
    """
    Install a specific Arduino library by name.
    """
    try:
        result = await arduino_cli.install_library(request.name)
        if not result["success"]:
             return InstallResponse(success=False, error=result.get("error"), stdout=result.get("stdout"))
        return InstallResponse(success=True, stdout=result.get("stdout"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/list", response_model=SearchResponse)
async def list_libraries():
    """
    List all installed Arduino libraries.
    """
    try:
        result = await arduino_cli.list_installed_libraries()
        if not result["success"]:
            raise HTTPException(status_code=500, detail=result.get("error", "Failed to list libraries"))
        return SearchResponse(success=True, libraries=result.get("libraries", []))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
