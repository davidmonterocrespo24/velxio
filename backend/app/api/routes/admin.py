from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import require_admin
from app.core.security import hash_password
from app.database.session import get_db
from app.models.project import Project
from app.models.user import User
from app.schemas.admin import (
    AdminProjectResponse,
    AdminSetupRequest,
    AdminUserResponse,
    AdminUserUpdateRequest,
)
from app.utils.slug import is_valid_username

router = APIRouter()


# ── Setup ─────────────────────────────────────────────────────────────────────

@router.get("/setup/status")
async def setup_status(db: AsyncSession = Depends(get_db)):
    """Check whether any admin user exists."""
    result = await db.execute(select(User).where(User.is_admin == True))  # noqa: E712
    has_admin = result.scalar_one_or_none() is not None
    return {"has_admin": has_admin}


@router.post("/setup", response_model=AdminUserResponse, status_code=status.HTTP_201_CREATED)
async def setup_admin(body: AdminSetupRequest, db: AsyncSession = Depends(get_db)):
    """Create the first admin user. Fails if an admin already exists."""
    existing_admin = await db.execute(select(User).where(User.is_admin == True))  # noqa: E712
    if existing_admin.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Admin already configured.")

    username = body.username.lower().strip()
    if not is_valid_username(username):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3-30 chars, only lowercase letters/numbers/underscores/hyphens.",
        )
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")

    # Check uniqueness
    conflict = await db.execute(
        select(User).where((User.username == username) | (User.email == body.email))
    )
    if conflict.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username or email already taken.")

    user = User(
        username=username,
        email=body.email,
        hashed_password=hash_password(body.password),
        is_admin=True,
        is_active=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    count_result = await db.execute(
        select(func.count()).where(Project.user_id == user.id)
    )
    project_count = count_result.scalar() or 0

    return AdminUserResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        avatar_url=user.avatar_url,
        is_active=user.is_active,
        is_admin=user.is_admin,
        created_at=user.created_at,
        project_count=project_count,
    )


# ── Users ─────────────────────────────────────────────────────────────────────

async def _user_with_count(db: AsyncSession, user: User) -> AdminUserResponse:
    count_result = await db.execute(
        select(func.count()).where(Project.user_id == user.id)
    )
    project_count = count_result.scalar() or 0
    return AdminUserResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        avatar_url=user.avatar_url,
        is_active=user.is_active,
        is_admin=user.is_admin,
        created_at=user.created_at,
        project_count=project_count,
    )


@router.get("/users", response_model=list[AdminUserResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    users = result.scalars().all()
    return [await _user_with_count(db, u) for u in users]


@router.get("/users/{user_id}", response_model=AdminUserResponse)
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    return await _user_with_count(db, user)


@router.put("/users/{user_id}", response_model=AdminUserResponse)
async def update_user(
    user_id: str,
    body: AdminUserUpdateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    if body.username is not None:
        new_username = body.username.lower().strip()
        if not is_valid_username(new_username):
            raise HTTPException(status_code=400, detail="Invalid username format.")
        if new_username != user.username:
            conflict = await db.execute(select(User).where(User.username == new_username))
            if conflict.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="Username already taken.")
        user.username = new_username

    if body.email is not None:
        if body.email != user.email:
            conflict = await db.execute(select(User).where(User.email == body.email))
            if conflict.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="Email already in use.")
        user.email = body.email

    if body.password is not None:
        if len(body.password) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
        user.hashed_password = hash_password(body.password)

    if body.is_active is not None:
        user.is_active = body.is_active

    if body.is_admin is not None:
        # Prevent removing admin from yourself
        if user.id == admin.id and not body.is_admin:
            raise HTTPException(status_code=400, detail="Cannot remove your own admin privileges.")
        user.is_admin = body.is_admin

    await db.commit()
    await db.refresh(user)
    return await _user_with_count(db, user)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account.")

    # Delete all user's projects first
    projects_result = await db.execute(select(Project).where(Project.user_id == user_id))
    for project in projects_result.scalars().all():
        await db.delete(project)

    await db.delete(user)
    await db.commit()


# ── Projects ──────────────────────────────────────────────────────────────────

@router.get("/projects", response_model=list[AdminProjectResponse])
async def list_all_projects(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    result = await db.execute(
        select(Project, User.username)
        .join(User, User.id == Project.user_id)
        .order_by(Project.created_at.desc())
    )
    rows = result.all()
    return [
        AdminProjectResponse(
            id=project.id,
            name=project.name,
            slug=project.slug,
            description=project.description,
            is_public=project.is_public,
            board_type=project.board_type,
            owner_username=username,
            owner_id=project.user_id,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )
        for project, username in rows
    ]


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    await db.delete(project)
    await db.commit()
