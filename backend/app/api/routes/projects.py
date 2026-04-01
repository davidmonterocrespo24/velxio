from __future__ import annotations
from datetime import datetime

from fastapi import APIRouter, HTTPException, status

from app.schemas.project import ProjectCreateRequest, ProjectResponse, ProjectUpdateRequest, SketchFile
from app.services import local_store

router = APIRouter()


def _meta_to_response(meta: dict) -> ProjectResponse:
    raw_files = local_store.read_files(meta["id"])
    files = [SketchFile(name=f["name"], content=f["content"]) for f in raw_files]
    if not files and meta.get("code"):
        files = [SketchFile(name="sketch.ino", content=meta["code"])]
    return ProjectResponse(
        id=meta["id"],
        name=meta["name"],
        slug=meta["slug"],
        description=meta.get("description"),
        is_public=meta.get("is_public", True),
        board_type=meta.get("board_type", "arduino-uno"),
        files=files,
        code=meta.get("code", ""),
        components_json=meta.get("components_json", "[]"),
        wires_json=meta.get("wires_json", "[]"),
        owner_username="local",
        created_at=datetime.fromisoformat(meta["created_at"]),
        updated_at=datetime.fromisoformat(meta["updated_at"]),
    )


# ── All my projects ──────────────────────────────────────────────────────────

@router.get("/projects/me", response_model=list[ProjectResponse])
async def my_projects():
    return [_meta_to_response(m) for m in local_store.list_projects()]


# ── GET by ID ────────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}", response_model=ProjectResponse)
async def get_project_by_id(project_id: str):
    meta = local_store.get_project(project_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Project not found.")
    return _meta_to_response(meta)


# ── Create ───────────────────────────────────────────────────────────────────

@router.post("/projects/", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(body: ProjectCreateRequest):
    meta = local_store.create_project(body.model_dump())
    return _meta_to_response(meta)


# ── Update ───────────────────────────────────────────────────────────────────

@router.put("/projects/{project_id}", response_model=ProjectResponse)
async def update_project(project_id: str, body: ProjectUpdateRequest):
    meta = local_store.update_project(project_id, body.model_dump(exclude_none=True))
    if not meta:
        raise HTTPException(status_code=404, detail="Project not found.")
    return _meta_to_response(meta)


# ── Delete ───────────────────────────────────────────────────────────────────

@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: str):
    if not local_store.delete_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found.")


# ── User projects (no-op username — all projects are local) ──────────────────

@router.get("/user/{username}", response_model=list[ProjectResponse])
async def user_projects(username: str):
    return [_meta_to_response(m) for m in local_store.list_projects()]


# ── Get by username/slug ─────────────────────────────────────────────────────

@router.get("/user/{username}/{slug}", response_model=ProjectResponse)
async def get_project_by_slug(username: str, slug: str):
    for meta in local_store.list_projects():
        if meta.get("slug") == slug:
            return _meta_to_response(meta)
    raise HTTPException(status_code=404, detail="Project not found.")
