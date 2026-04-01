from __future__ import annotations
from datetime import datetime

from pydantic import BaseModel, EmailStr


class AdminSetupRequest(BaseModel):
    username: str
    email: EmailStr
    password: str


class AdminUserResponse(BaseModel):
    id: str
    username: str
    email: str
    avatar_url: str | None
    is_active: bool
    is_admin: bool
    created_at: datetime
    project_count: int = 0

    model_config = {"from_attributes": True}


class AdminUserUpdateRequest(BaseModel):
    username: str | None = None
    email: EmailStr | None = None
    password: str | None = None
    is_active: bool | None = None
    is_admin: bool | None = None


class AdminProjectResponse(BaseModel):
    id: str
    name: str
    slug: str
    description: str | None
    is_public: bool
    board_type: str
    owner_username: str
    owner_id: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
