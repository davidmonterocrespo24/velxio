from __future__ import annotations
from datetime import datetime

from pydantic import BaseModel


class SketchFile(BaseModel):
    name: str
    content: str


class ProjectCreateRequest(BaseModel):
    name: str
    description: str | None = None
    is_public: bool = True
    board_type: str = "arduino-uno"
    # Multi-file workspace. Falls back to legacy `code` field if omitted.
    files: list[SketchFile] | None = None
    code: str = ""  # legacy single-file fallback
    components_json: str = "[]"
    wires_json: str = "[]"


class ProjectUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    is_public: bool | None = None
    board_type: str | None = None
    files: list[SketchFile] | None = None
    code: str | None = None  # legacy
    components_json: str | None = None
    wires_json: str | None = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    slug: str
    description: str | None
    is_public: bool
    board_type: str
    # Files loaded from disk volume
    files: list[SketchFile] = []
    # Legacy single-file code (kept for backwards compat)
    code: str
    components_json: str
    wires_json: str
    owner_username: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
