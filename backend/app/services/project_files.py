from __future__ import annotations
"""
Reads and writes per-project sketch files to the data volume.

Files are stored at:
  {DATA_DIR}/projects/{project_id}/{filename}

DATA_DIR defaults to /app/data (the bind-mounted volume).
"""

import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))


def _project_dir(project_id: str) -> Path:
    return DATA_DIR / "projects" / project_id


def write_files(project_id: str, files: list[dict]) -> None:
    """Persist a list of {name, content} dicts to disk."""
    d = _project_dir(project_id)
    d.mkdir(parents=True, exist_ok=True)
    # Remove files that are no longer in the list
    names = {f["name"] for f in files}
    for existing in d.iterdir():
        if existing.is_file() and existing.name not in names:
            existing.unlink()
    for f in files:
        (d / f["name"]).write_text(f["content"], encoding="utf-8")


def read_files(project_id: str) -> list[dict]:
    """Return [{name, content}] sorted by name. Empty list if directory absent."""
    d = _project_dir(project_id)
    if not d.exists():
        return []
    return [
        {"name": p.name, "content": p.read_text(encoding="utf-8")}
        for p in sorted(d.iterdir())
        if p.is_file()
    ]


def delete_files(project_id: str) -> None:
    """Remove all files for a project from disk."""
    import shutil
    d = _project_dir(project_id)
    if d.exists():
        shutil.rmtree(d)
