"""
Reads and writes per-project sketch files to the data volume.

Storage layout (current — multi-board):
  {DATA_DIR}/projects/{project_id}/{group_id}/{filename}

Legacy layout (pre multi-board):
  {DATA_DIR}/projects/{project_id}/{filename}

`read_groups` transparently handles both: if the project dir contains files
directly (no subdirs), they are returned under a single legacy key.

DATA_DIR defaults to /app/data (the bind-mounted volume).
"""

import os
import shutil
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))

LEGACY_GROUP_KEY = "__legacy_flat__"


def _project_dir(project_id: str) -> Path:
    return DATA_DIR / "projects" / project_id


# ── Multi-board API ──────────────────────────────────────────────────────────


def write_groups(project_id: str, groups: dict[str, list[dict]]) -> None:
    """Persist {groupId: [{name, content}, ...]} to disk under per-group subdirs.

    Removes any group/file no longer present. Each call fully replaces the
    on-disk layout for the project.
    """
    root = _project_dir(project_id)
    root.mkdir(parents=True, exist_ok=True)

    keep_dirs = set(groups.keys())
    # Remove old subdirs that are no longer in the payload, and any legacy flat files.
    for entry in list(root.iterdir()):
        if entry.is_dir():
            if entry.name not in keep_dirs:
                shutil.rmtree(entry, ignore_errors=True)
        else:
            # Legacy flat file — remove now that we own the layout
            try:
                entry.unlink()
            except OSError:
                pass

    for group_id, files in groups.items():
        gdir = root / group_id
        gdir.mkdir(parents=True, exist_ok=True)
        keep_files = {f["name"] for f in files}
        for existing in list(gdir.iterdir()):
            if existing.is_file() and existing.name not in keep_files:
                try:
                    existing.unlink()
                except OSError:
                    pass
        for f in files:
            (gdir / f["name"]).write_text(f["content"], encoding="utf-8")


def read_groups(project_id: str) -> dict[str, list[dict]]:
    """Return {groupId: [{name, content}, ...]} from disk.

    If the project dir contains files directly (legacy flat layout), they are
    returned under the key LEGACY_GROUP_KEY so the caller can decide how to
    label them. Returns empty dict if the directory does not exist.
    """
    root = _project_dir(project_id)
    if not root.exists():
        return {}

    groups: dict[str, list[dict]] = {}
    legacy_files: list[dict] = []
    for entry in sorted(root.iterdir()):
        if entry.is_dir():
            files = [
                {"name": p.name, "content": p.read_text(encoding="utf-8")}
                for p in sorted(entry.iterdir())
                if p.is_file()
            ]
            if files:
                groups[entry.name] = files
        elif entry.is_file():
            legacy_files.append(
                {"name": entry.name, "content": entry.read_text(encoding="utf-8")}
            )

    if legacy_files:
        groups[LEGACY_GROUP_KEY] = legacy_files
    return groups


# ── Legacy single-board API ──────────────────────────────────────────────────


def write_files(project_id: str, files: list[dict]) -> None:
    """Persist a list of {name, content} dicts to disk (legacy flat layout).

    Kept for callers that don't yet pass file groups. Writes directly under
    {pid}/, mirroring the original behaviour.
    """
    d = _project_dir(project_id)
    d.mkdir(parents=True, exist_ok=True)
    names = {f["name"] for f in files}
    for existing in list(d.iterdir()):
        if existing.is_file() and existing.name not in names:
            try:
                existing.unlink()
            except OSError:
                pass
    for f in files:
        (d / f["name"]).write_text(f["content"], encoding="utf-8")


def read_files(project_id: str) -> list[dict]:
    """Return [{name, content}] for the legacy flat layout, or the first group
    if files are stored under per-group subdirs. Empty list if absent."""
    groups = read_groups(project_id)
    if not groups:
        return []
    if LEGACY_GROUP_KEY in groups:
        return groups[LEGACY_GROUP_KEY]
    # Multi-group: pick the first group deterministically (sorted by groupId)
    first = sorted(groups.keys())[0]
    return groups[first]


def delete_files(project_id: str) -> None:
    """Remove all files for a project from disk."""
    d = _project_dir(project_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
