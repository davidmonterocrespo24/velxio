from datetime import datetime

from pydantic import BaseModel


class SketchFile(BaseModel):
    name: str
    content: str


class FileGroup(BaseModel):
    """Files belonging to a single board (groupId == 'group-${boardId}')."""
    groupId: str
    files: list[SketchFile]


class ProjectCreateRequest(BaseModel):
    name: str
    description: str | None = None
    is_public: bool = True
    board_type: str = "arduino-uno"
    # Multi-file workspace. Falls back to legacy `code` field if omitted.
    files: list[SketchFile] | None = None
    # Multi-board file groups. When present, takes precedence over `files`.
    file_groups: list[FileGroup] | None = None
    code: str = ""  # legacy single-file fallback
    components_json: str = "[]"
    wires_json: str = "[]"
    boards_json: str | None = None


class ProjectUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    is_public: bool | None = None
    board_type: str | None = None
    files: list[SketchFile] | None = None
    file_groups: list[FileGroup] | None = None
    code: str | None = None  # legacy
    components_json: str | None = None
    wires_json: str | None = None
    boards_json: str | None = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    slug: str
    description: str | None
    is_public: bool
    board_type: str
    # Files of the active board (kept for backwards compat)
    files: list[SketchFile] = []
    # All boards' file groups (multi-board)
    file_groups: list[FileGroup] = []
    # Legacy single-file code (kept for backwards compat)
    code: str
    components_json: str
    wires_json: str
    boards_json: str = "[]"
    owner_username: str
    created_at: datetime
    updated_at: datetime
    # Usage metrics (kept in sync by MetricsService)
    compile_count: int = 0
    compile_error_count: int = 0
    run_count: int = 0
    update_count: int = 0
    last_compiled_at: datetime | None = None
    last_run_at: datetime | None = None

    model_config = {"from_attributes": True}
