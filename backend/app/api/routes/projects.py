import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, require_auth
from app.database.session import get_db
from app.models.project import Project
from app.models.user import User
from app.schemas.project import (
    FileGroup,
    ProjectCreateRequest,
    ProjectResponse,
    ProjectUpdateRequest,
    SketchFile,
)
from app.services.metrics import record_project_open, record_save
from app.services.project_files import (
    LEGACY_GROUP_KEY,
    delete_files,
    read_groups,
    write_groups,
)
from app.utils.slug import slugify

router = APIRouter()


def _active_group_id(project: Project) -> str:
    """Group ID that holds the active board's files. Used to label legacy
    flat-layout files when promoting them into the multi-group response."""
    # Try to extract activeFileGroupId from boards_json; fall back to a derived
    # name based on board_type. This matches the frontend convention
    # `group-${boardId}` (see useSimulatorStore.ts:615).
    try:
        boards = json.loads(project.boards_json or "[]")
        if isinstance(boards, list) and boards:
            first = boards[0]
            if isinstance(first, dict):
                gid = first.get("activeFileGroupId")
                if isinstance(gid, str) and gid:
                    return gid
    except (ValueError, TypeError):
        pass
    return f"group-{project.board_type or 'arduino-uno'}"


def _groups_for_project(project: Project) -> list[FileGroup]:
    """Load files from disk grouped per-board. Promotes legacy flat layouts
    into a single group keyed off the project's active board id."""
    raw = read_groups(project.id)
    if not raw:
        if project.code:
            # No on-disk files but a legacy code field: synthesise a single
            # sketch.ino under the active group.
            return [
                FileGroup(
                    groupId=_active_group_id(project),
                    files=[SketchFile(name="sketch.ino", content=project.code)],
                )
            ]
        return []

    groups: list[FileGroup] = []
    if LEGACY_GROUP_KEY in raw:
        legacy_files = raw.pop(LEGACY_GROUP_KEY)
        groups.append(
            FileGroup(
                groupId=_active_group_id(project),
                files=[SketchFile(**f) for f in legacy_files],
            )
        )
    for gid, files in raw.items():
        groups.append(
            FileGroup(groupId=gid, files=[SketchFile(**f) for f in files])
        )
    return groups


def _files_for_active_board(groups: list[FileGroup], project: Project) -> list[SketchFile]:
    """Pick the SketchFile list of the active board (legacy `files` field)."""
    if not groups:
        return []
    target = _active_group_id(project)
    for g in groups:
        if g.groupId == target:
            return list(g.files)
    return list(groups[0].files)


def _to_response(project: Project, owner_username: str) -> ProjectResponse:
    groups = _groups_for_project(project)
    return ProjectResponse(
        id=project.id,
        name=project.name,
        slug=project.slug,
        description=project.description,
        is_public=project.is_public,
        board_type=project.board_type,
        files=_files_for_active_board(groups, project),
        file_groups=groups,
        code=project.code,
        components_json=project.components_json,
        wires_json=project.wires_json,
        boards_json=project.boards_json or "[]",
        owner_username=owner_username,
        created_at=project.created_at,
        updated_at=project.updated_at,
        compile_count=project.compile_count,
        compile_error_count=project.compile_error_count,
        run_count=project.run_count,
        update_count=project.update_count,
        last_compiled_at=project.last_compiled_at,
        last_run_at=project.last_run_at,
    )


def _persist_files_from_body(
    project: Project,
    body: "ProjectCreateRequest | ProjectUpdateRequest",
) -> None:
    """Write the request body's file representation to disk.

    Priority:
      1. ``body.file_groups`` (full multi-board layout) — full replace.
      2. ``body.files`` (legacy single-board list) — update only the active
         group, preserve other groups on disk.
      3. ``body.code`` (legacy code field, create only) — wrap as sketch.ino
         in the active group.
    """
    if body.file_groups is not None:
        groups = {
            g.groupId: [f.model_dump() for f in g.files] for g in body.file_groups
        }
        write_groups(project.id, groups)
        return

    legacy_files: list[dict] | None = None
    if body.files is not None:
        legacy_files = [f.model_dump() for f in body.files]
    elif getattr(body, "code", None):
        legacy_files = [{"name": "sketch.ino", "content": body.code}]

    if not legacy_files:
        return

    # Update only the active group, leaving any other groups (multi-board
    # projects) intact on disk.
    active_gid = _active_group_id(project)
    existing = read_groups(project.id)
    existing.pop(LEGACY_GROUP_KEY, None)
    existing[active_gid] = legacy_files
    write_groups(project.id, existing)


async def _unique_slug(db: AsyncSession, user_id: str, base_slug: str) -> str:
    slug = base_slug or "project"
    counter = 1
    while True:
        result = await db.execute(
            select(Project).where(Project.user_id == user_id, Project.slug == slug)
        )
        if not result.scalar_one_or_none():
            return slug
        slug = f"{base_slug}-{counter}"
        counter += 1


# ── My projects (literal route — must be before /{project_id}) ───────────────

@router.get("/projects/me", response_model=list[ProjectResponse])
async def my_projects(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    result = await db.execute(
        select(Project).where(Project.user_id == user.id).order_by(Project.updated_at.desc())
    )
    projects = result.scalars().all()
    return [_to_response(p, user.username) for p in projects]


# ── GET by ID ────────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}", response_model=ProjectResponse)
async def get_project_by_id(
    project_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")

    is_own = current_user and current_user.id == project.user_id
    is_admin = current_user and current_user.is_admin
    if not project.is_public and not is_own and not is_admin:
        raise HTTPException(status_code=403, detail="This project is private.")

    owner_result = await db.execute(select(User).where(User.id == project.user_id))
    owner = owner_result.scalar_one_or_none()

    # Record open events from non-owners (views), not owner edits.
    if not is_own:
        await record_project_open(db, user=current_user, project_id=project.id, request=request)

    return _to_response(project, owner.username if owner else "")


# ── Create ───────────────────────────────────────────────────────────────────

@router.post("/projects/", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    base_slug = slugify(body.name) or "project"
    slug = await _unique_slug(db, user.id, base_slug)

    project = Project(
        user_id=user.id,
        name=body.name,
        slug=slug,
        description=body.description,
        is_public=body.is_public,
        board_type=body.board_type,
        code=body.code,
        components_json=body.components_json,
        wires_json=body.wires_json,
        boards_json=body.boards_json or "[]",
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)

    # Write sketch files to volume (multi-group layout under {pid}/{gid}/...)
    _persist_files_from_body(project, body)

    await record_save(db, user=user, project=project, is_create=True, request=request)
    return _to_response(project, user.username)


# ── Update ───────────────────────────────────────────────────────────────────

@router.put("/projects/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    body: ProjectUpdateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    if project.user_id != user.id:
        raise HTTPException(status_code=403, detail="Forbidden.")

    if body.name is not None:
        project.name = body.name
        new_base = slugify(body.name)
        if new_base != project.slug:
            project.slug = await _unique_slug(db, user.id, new_base)
    if body.description is not None:
        project.description = body.description
    if body.is_public is not None:
        project.is_public = body.is_public
    if body.board_type is not None:
        project.board_type = body.board_type
    if body.code is not None:
        project.code = body.code
    if body.components_json is not None:
        project.components_json = body.components_json
    if body.wires_json is not None:
        project.wires_json = body.wires_json
    if body.boards_json is not None:
        project.boards_json = body.boards_json

    project.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(project)

    # Write updated files to volume (multi-group; legacy `files` only updates
    # the active group, leaving other boards intact).
    _persist_files_from_body(project, body)

    await record_save(db, user=user, project=project, is_create=False, request=request)
    return _to_response(project, user.username)


# ── Delete ───────────────────────────────────────────────────────────────────

@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    if project.user_id != user.id:
        raise HTTPException(status_code=403, detail="Forbidden.")
    await db.delete(project)
    await db.commit()
    delete_files(project_id)


# ── User public projects ─────────────────────────────────────────────────────

@router.get("/user/{username}", response_model=list[ProjectResponse])
async def user_projects(
    username: str,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    result = await db.execute(select(User).where(User.username == username))
    owner = result.scalar_one_or_none()
    if not owner:
        raise HTTPException(status_code=404, detail="User not found.")

    is_own = current_user and current_user.id == owner.id
    query = select(Project).where(Project.user_id == owner.id)
    if not is_own:
        query = query.where(Project.is_public == True)  # noqa: E712
    query = query.order_by(Project.updated_at.desc())

    projects = (await db.execute(query)).scalars().all()
    return [_to_response(p, owner.username) for p in projects]


# ── Get by username/slug ─────────────────────────────────────────────────────

@router.get("/user/{username}/{slug}", response_model=ProjectResponse)
async def get_project_by_slug(
    username: str,
    slug: str,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    result = await db.execute(select(User).where(User.username == username))
    owner = result.scalar_one_or_none()
    if not owner:
        raise HTTPException(status_code=404, detail="User not found.")

    result2 = await db.execute(
        select(Project).where(Project.user_id == owner.id, Project.slug == slug)
    )
    project = result2.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")

    is_own = current_user and current_user.id == owner.id
    if not project.is_public and not is_own:
        raise HTTPException(status_code=403, detail="This project is private.")

    return _to_response(project, owner.username)
