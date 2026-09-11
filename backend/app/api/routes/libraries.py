from fastapi.responses import JSONResponse
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from app.api.routes.compile import arduino_cli
from app.core.hooks import uninstall_library as overlay_uninstall_library, get_current_user_id, warm_library

router = APIRouter()

class InstallLibraryRequest(BaseModel):
    name: str
    version: str | None = None

class SearchResponse(BaseModel):
    success: bool
    libraries: list = []
    error: str | None = None

class InstallResponse(BaseModel):
    success: bool
    stdout: str | None = None
    error: str | None = None
    fallback: bool | None = None
    requested_version: str | None = None

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
async def install_library(
    request: InstallLibraryRequest,
    requester_id: str | None = Depends(get_current_user_id),
):
    """
    Install a specific Arduino library by name.

    On velxio.dev this WARMS the shared content-addressed cache (the global
    mutable libraries volume is being retired) rather than mutating that volume;
    the overlay also enforces the anonymous policy. With no overlay (OSS
    self-host) it falls back to the legacy arduino-cli global install.
    """
    try:
        # P2.1 — prefer warming the content-addressed cache (no global write).
        warmed = await warm_library(request.name, request.version, requester_id)
        if warmed is not None:
            body = InstallResponse(
                success=bool(warmed.get("success")),
                error=warmed.get("error"),
                stdout=warmed.get("stdout"),
                fallback=warmed.get("fallback"),
                requested_version=warmed.get("requested_version"),
            )
            # The overlay may refuse with a status the client can tell apart
            # (507: the shared cache is at its disk floor). Same body shape,
            # so a client that reads res.json() without res.ok still works.
            status = warmed.get("http_status")
            if isinstance(status, int) and status != 200:
                return JSONResponse(status_code=status, content=body.model_dump())
            return body
        # OSS / no overlay: legacy global install (self-host parity).
        spec = f"{request.name}@{request.version}" if request.version else request.name
        result = await arduino_cli.install_library(spec)
        if not result["success"]:
             return InstallResponse(success=False, error=result.get("error"), stdout=result.get("stdout"))
        return InstallResponse(success=True, stdout=result.get("stdout"), fallback=result.get("fallback"), requested_version=result.get("requested_version"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def _uninstall_allowed(requester_id: str | None) -> bool:
    """Anonymous uninstall is refused wherever accounts exist.

    The hook returns None both for "OSS self-host, no accounts" and for
    "velxio.dev, not signed in". They are told apart by whether the overlay
    installed a hook at all: with one present, None means anonymous.
    """
    from app.core import hooks

    if getattr(hooks, "_get_current_user_id_hook", None) is None:
        return True  # OSS single-user
    return requester_id is not None


class UninstallLibraryRequest(BaseModel):
    name: str

class UninstallResponse(BaseModel):
    success: bool
    stdout: str | None = None
    error: str | None = None

@router.delete("/uninstall", response_model=UninstallResponse)
async def uninstall_library(
    request: UninstallLibraryRequest,
    requester_id: str | None = Depends(get_current_user_id),
):
    """
    Uninstall a specific Arduino library by name.

    Gated like /install: a mutating endpoint that took no identity at all was
    reachable unauthenticated from the public internet. It was harmless only
    because it aimed at a sketchbook that does not exist on the deployment,
    which is not a security property anyone should rely on. OSS self-hosters
    are single-user and the hook returns None for them, so `require_identity`
    stays a deployment decision made by the overlay, not a hard 401 here.
    """
    try:
        if not _uninstall_allowed(requester_id):
            return UninstallResponse(
                success=False,
                error="Sign in to manage this project's libraries.",
            )
        # On a deployment whose libraries live in a shared cache plus per-user
        # stores, uninstall is the overlay's call (a shared library is nobody's
        # to remove; an upload is removed and refunded). None -> OSS sketchbook.
        overlay = await overlay_uninstall_library(request.name, requester_id)
        if overlay is not None:
            return UninstallResponse(
                success=bool(overlay.get("success")),
                error=overlay.get("error"),
                stdout=overlay.get("stdout"),
            )
        result = await arduino_cli.uninstall_library(request.name)
        if not result["success"]:
            return UninstallResponse(success=False, error=result.get("error"), stdout=result.get("stdout"))
        return UninstallResponse(success=True, stdout=result.get("stdout"))
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
