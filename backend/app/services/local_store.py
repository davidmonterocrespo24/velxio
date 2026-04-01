from __future__ import annotations
"""
Local file-based project storage in ~/velxio/projects/.

Each project is a directory:
  ~/velxio/projects/{project_id}/
    meta.json       — project metadata
    sketch.ino      — sketch files (any name)
    ...
"""

import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path


VELXIO_DIR = Path.home() / "velxio"
PROJECTS_DIR = VELXIO_DIR / "projects"


def _project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


def _read_meta(project_id: str) -> dict | None:
    meta_path = _project_dir(project_id) / "meta.json"
    if not meta_path.exists():
        return None
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_meta(project_id: str, meta: dict) -> None:
    d = _project_dir(project_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(meta, default=str, indent=2), encoding="utf-8")


def _unique_slug(base_slug: str, exclude_id: str | None = None) -> str:
    existing_slugs: set[str] = set()
    if PROJECTS_DIR.exists():
        for d in PROJECTS_DIR.iterdir():
            if d.is_dir() and d.name != exclude_id:
                meta_path = d / "meta.json"
                if meta_path.exists():
                    try:
                        m = json.loads(meta_path.read_text(encoding="utf-8"))
                        existing_slugs.add(m.get("slug", ""))
                    except Exception:
                        pass

    slug = base_slug or "project"
    counter = 1
    candidate = slug
    while candidate in existing_slugs:
        candidate = f"{slug}-{counter}"
        counter += 1
    return candidate


def list_projects() -> list[dict]:
    if not PROJECTS_DIR.exists():
        return []
    result = []
    for d in PROJECTS_DIR.iterdir():
        if d.is_dir():
            meta = _read_meta(d.name)
            if meta:
                result.append(meta)
    result.sort(key=lambda m: m.get("updated_at", ""), reverse=True)
    return result


def get_project(project_id: str) -> dict | None:
    return _read_meta(project_id)


def create_project(data: dict) -> dict:
    from app.utils.slug import slugify
    project_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    base_slug = slugify(data.get("name", "")) or "project"
    slug = _unique_slug(base_slug)

    meta = {
        "id": project_id,
        "name": data.get("name", ""),
        "slug": slug,
        "description": data.get("description"),
        "is_public": data.get("is_public", True),
        "board_type": data.get("board_type", "arduino-uno"),
        "code": data.get("code", ""),
        "components_json": data.get("components_json", "[]"),
        "wires_json": data.get("wires_json", "[]"),
        "created_at": now,
        "updated_at": now,
    }
    _write_meta(project_id, meta)

    files = data.get("files") or (
        [{"name": "sketch.ino", "content": data["code"]}] if data.get("code") else []
    )
    if files:
        write_files(project_id, files)

    return meta


def update_project(project_id: str, data: dict) -> dict | None:
    from app.utils.slug import slugify
    meta = _read_meta(project_id)
    if not meta:
        return None

    if "name" in data and data["name"] is not None:
        meta["name"] = data["name"]
        new_slug = slugify(data["name"]) or "project"
        if new_slug != meta.get("slug"):
            meta["slug"] = _unique_slug(new_slug, exclude_id=project_id)

    for field in ("description", "is_public", "board_type", "code", "components_json", "wires_json"):
        if field in data and data[field] is not None:
            meta[field] = data[field]

    meta["updated_at"] = datetime.now(timezone.utc).isoformat()
    _write_meta(project_id, meta)

    # Always write files — overwrite whatever is on disk
    if data.get("files") is not None:
        write_files(project_id, data["files"])
    elif data.get("code") is not None:
        write_files(project_id, [{"name": "sketch.ino", "content": data["code"]}])

    return meta


def delete_project(project_id: str) -> bool:
    d = _project_dir(project_id)
    if not d.exists():
        return False
    shutil.rmtree(d)
    return True


def write_files(project_id: str, files: list[dict]) -> None:
    d = _project_dir(project_id)
    d.mkdir(parents=True, exist_ok=True)
    names = {f["name"] for f in files}
    for existing in d.iterdir():
        if existing.is_file() and existing.name != "meta.json" and existing.name not in names:
            existing.unlink()
    for f in files:
        (d / f["name"]).write_text(f["content"], encoding="utf-8")


def read_files(project_id: str) -> list[dict]:
    d = _project_dir(project_id)
    if not d.exists():
        return []
    return [
        {"name": p.name, "content": p.read_text(encoding="utf-8")}
        for p in sorted(d.iterdir())
        if p.is_file() and p.name != "meta.json"
    ]
