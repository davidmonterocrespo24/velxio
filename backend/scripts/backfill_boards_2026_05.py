"""
One-time backfill: populate ``projects.boards_json`` and reorganise on-disk
files into per-board subdirs for projects created before the multi-board
persistence change.

Pre-existing schema only stored ``board_type`` (a single string) plus flat
``components_json`` / ``wires_json`` columns. The frontend, however, has been
multi-board-capable for a while — wire endpoints reference board IDs literally
(e.g. ``componentId='esp32-cam'``). On reload, ``setBoardType`` mutated the
sole default board's ``boardKind`` but kept its ``id`` fixed at
``'arduino-uno'`` (the legacy ``INITIAL_BOARD_ID``), so any wire that pointed
to a non-Uno board id was orphaned and visually anchored to (0, 0).

Heuristic per project (idempotent — projects whose ``boards_json`` already
holds a non-empty array are skipped):

  Case A — single-board legacy
    Wires reference only ``'arduino-uno'`` AND ``board_type != 'arduino-uno'``.
    The user really had ONE board of kind ``board_type``; the id is residual
    from the ``INITIAL_BOARD_ID`` quirk. Rename the wire endpoints
    ``'arduino-uno'`` -> ``board_type`` and create one board with
    ``id == board_type``.

  Case B — single-board normal
    Wires reference at most one board id, and that id matches ``board_type``
    (or there are no wires). Create one board verbatim.

  Case C — multi-board
    Wires reference more than one distinct board id. Create one BoardInstance
    per distinct id, in order of first appearance, laid out left-to-right at
    (50 + i*350, 50). The active board is the one matching ``board_type`` if
    present, otherwise the first.

Refs whose kind cannot be inferred (e.g. typos like ``'esp'``) are left alone:
the wires stay orphaned and are reported in the summary for manual review.

Usage::

    # Dry-run (default) — prints the plan, touches nothing
    python -m backend.scripts.backfill_boards_2026_05

    # Apply changes to DB and disk
    python -m backend.scripts.backfill_boards_2026_05 --apply

    # Run for a single project
    python -m backend.scripts.backfill_boards_2026_05 --apply --project-id <uuid>

    # Custom DB / data path (defaults to backend/.env's values)
    python -m backend.scripts.backfill_boards_2026_05 --db data/velxio.db --data-dir data
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

# ── Canonical board kinds (mirrors frontend/src/types/board.ts) ────────────────
BOARD_KINDS: set[str] = {
    "arduino-uno",
    "arduino-nano",
    "arduino-mega",
    "attiny85",
    "raspberry-pi-pico",
    "pi-pico-w",
    "raspberry-pi-3",
    "esp32",
    "esp32-devkit-c-v4",
    "esp32-cam",
    "wemos-lolin32-lite",
    "esp32-s3",
    "xiao-esp32-s3",
    "arduino-nano-esp32",
    "esp32-c3",
    "xiao-esp32-c3",
    "aitewinrobot-esp32c3-supermini",
}

# Suffix added by addBoard for additional instances of the same kind
INSTANCE_SUFFIX_RE = re.compile(r"^(?P<kind>.+?)-(?P<n>\d+)$")

DEFAULT_X = 50
DEFAULT_Y = 50
BOARD_X_STEP = 350


def infer_kind(ref: str) -> str | None:
    """Map a wire endpoint componentId to a BoardKind, or None if unknown.

    'esp32' -> 'esp32', 'esp32-cam' -> 'esp32-cam', 'esp32-2' -> 'esp32',
    'arduino-uno-3' -> 'arduino-uno', 'esp' -> None.
    """
    if ref in BOARD_KINDS:
        return ref
    m = INSTANCE_SUFFIX_RE.match(ref)
    if m and m.group("kind") in BOARD_KINDS:
        return m.group("kind")
    return None


def make_board(board_id: str, board_kind: str, x: int, y: int) -> dict:
    """A serialisable BoardInstance matching frontend/src/types/board.ts."""
    return {
        "id": board_id,
        "boardKind": board_kind,
        "x": x,
        "y": y,
        "running": False,
        "compiledProgram": None,
        "serialOutput": "",
        "serialBaudRate": 0,
        "serialMonitorOpen": False,
        "activeFileGroupId": f"group-{board_id}",
        "languageMode": "arduino",
    }


@dataclasses.dataclass
class PlanItem:
    project_id: str
    name: str
    case: str  # 'A' | 'B' | 'C' | 'skip-already-migrated' | 'skip-empty'
    board_type: str
    new_boards: list[dict]
    wires_renamed: int
    new_wires_json: str | None
    new_disk_layout: dict | None  # {"target_group": str, "files": list[dict]} or None
    orphan_refs: list[str]


def plan_for_project(
    project_id: str,
    name: str,
    board_type: str,
    components_json: str,
    wires_json: str,
    boards_json: str,
    project_files_dir: Path,
) -> PlanItem:
    # Idempotent skip: already migrated.
    try:
        existing = json.loads(boards_json or "[]")
    except (ValueError, TypeError):
        existing = []
    if isinstance(existing, list) and existing:
        return PlanItem(
            project_id=project_id,
            name=name,
            case="skip-already-migrated",
            board_type=board_type,
            new_boards=[],
            wires_renamed=0,
            new_wires_json=None,
            new_disk_layout=None,
            orphan_refs=[],
        )

    try:
        components = json.loads(components_json or "[]")
    except (ValueError, TypeError):
        components = []
    try:
        wires = json.loads(wires_json or "[]")
    except (ValueError, TypeError):
        wires = []

    comp_ids: set[str] = set()
    for c in components:
        if isinstance(c, dict):
            cid = c.get("id")
            if isinstance(cid, str) and cid:
                comp_ids.add(cid)

    # Collect unique wire-endpoint refs that are NOT components — these are
    # board ids. Preserve order of first appearance.
    seen: list[str] = []
    seen_set: set[str] = set()
    for w in wires:
        if not isinstance(w, dict):
            continue
        for ep_key in ("start", "end"):
            ep = w.get(ep_key)
            if not isinstance(ep, dict):
                continue
            cid = ep.get("componentId")
            if isinstance(cid, str) and cid and cid not in comp_ids and cid not in seen_set:
                seen.append(cid)
                seen_set.add(cid)

    bt = board_type or "arduino-uno"

    # ── Case selection ────────────────────────────────────────────────────────
    new_boards: list[dict] = []
    new_wires_json: str | None = None
    wires_renamed = 0
    orphans: list[str] = []
    case: str

    if not seen:
        # No wires, or wires only reference components. Single board from board_type.
        case = "B"
        new_boards = [make_board(bt, bt, DEFAULT_X, DEFAULT_Y)]
    elif seen == ["arduino-uno"] and bt != "arduino-uno":
        # Case A: legacy id residue. Rename to board_type.
        case = "A"
        new_boards = [make_board(bt, bt, DEFAULT_X, DEFAULT_Y)]
        # Rewrite wires
        new_wires = []
        for w in wires:
            if not isinstance(w, dict):
                new_wires.append(w)
                continue
            new_w = dict(w)
            for ep_key in ("start", "end"):
                ep = new_w.get(ep_key)
                if isinstance(ep, dict) and ep.get("componentId") == "arduino-uno":
                    new_w[ep_key] = {**ep, "componentId": bt}
                    wires_renamed += 1
            new_wires.append(new_w)
        new_wires_json = json.dumps(new_wires)
    elif len(seen) == 1:
        # Case B: single-board, wire ids match (or board_type is arduino-uno
        # and wires use 'arduino-uno', which is consistent).
        case = "B"
        only = seen[0]
        kind = infer_kind(only)
        if kind is None:
            # Truly unknown ref — fall back to board_type, log orphan
            orphans.append(only)
            new_boards = [make_board(bt, bt, DEFAULT_X, DEFAULT_Y)]
        else:
            # If the single ref's kind matches board_type, board_id == ref.
            # Otherwise the ref is some other id (rare, but possible) — keep
            # the ref as the board id since wires reference it literally.
            new_boards = [make_board(only, kind, DEFAULT_X, DEFAULT_Y)]
    else:
        # Case C: multi-board.
        case = "C"
        for i, ref in enumerate(seen):
            kind = infer_kind(ref)
            if kind is None:
                orphans.append(ref)
                continue
            new_boards.append(
                make_board(ref, kind, DEFAULT_X + i * BOARD_X_STEP, DEFAULT_Y)
            )

    # Active board sorting: ensure the board matching board_type sits first
    # (the frontend treats boards[0] as the default visible board).
    if new_boards:
        for i, b in enumerate(new_boards):
            if b["id"] == bt or b["boardKind"] == bt:
                if i > 0:
                    new_boards.insert(0, new_boards.pop(i))
                break

    # ── Disk layout: promote flat files into a group dir ──────────────────────
    new_disk_layout: dict | None = None
    if new_boards and project_files_dir.exists():
        # Collect any flat files at the project root (skip subdirs).
        flat_files = []
        for entry in project_files_dir.iterdir():
            if entry.is_file():
                try:
                    flat_files.append(
                        {
                            "name": entry.name,
                            "content": entry.read_text(encoding="utf-8"),
                        }
                    )
                except (OSError, UnicodeDecodeError):
                    # Binary or unreadable file — skip but keep on disk
                    pass
        if flat_files:
            target_group = new_boards[0]["activeFileGroupId"]
            new_disk_layout = {"target_group": target_group, "files": flat_files}

    return PlanItem(
        project_id=project_id,
        name=name,
        case=case,
        board_type=bt,
        new_boards=new_boards,
        wires_renamed=wires_renamed,
        new_wires_json=new_wires_json,
        new_disk_layout=new_disk_layout,
        orphan_refs=orphans,
    )


def apply_plan(plan: PlanItem, conn: sqlite3.Connection, data_dir: Path) -> None:
    """Persist plan to DB and disk. Idempotent per row."""
    if plan.case in ("skip-already-migrated", "skip-empty"):
        return

    boards_json = json.dumps(plan.new_boards)
    if plan.new_wires_json is not None:
        conn.execute(
            "UPDATE projects SET boards_json = ?, wires_json = ?, "
            "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (boards_json, plan.new_wires_json, plan.project_id),
        )
    else:
        conn.execute(
            "UPDATE projects SET boards_json = ?, "
            "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (boards_json, plan.project_id),
        )

    # Disk layout: move flat files into the active group's subdir.
    if plan.new_disk_layout:
        proj_dir = data_dir / "projects" / plan.project_id
        target_dir = proj_dir / plan.new_disk_layout["target_group"]
        target_dir.mkdir(parents=True, exist_ok=True)
        for f in plan.new_disk_layout["files"]:
            (target_dir / f["name"]).write_text(f["content"], encoding="utf-8")
            # Remove the flat copy
            flat = proj_dir / f["name"]
            if flat.is_file():
                try:
                    flat.unlink()
                except OSError:
                    pass


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description=(__doc__ or "").split("\n\n", 1)[0]
    )
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Persist changes (default is dry-run).",
    )
    ap.add_argument(
        "--db",
        default=None,
        help="Path to velxio.db (default: derived from DATABASE_URL or "
        "data/velxio.db).",
    )
    ap.add_argument(
        "--data-dir",
        default=None,
        help="Path to data directory containing 'projects/' (default: "
        "DATA_DIR env var or 'data').",
    )
    ap.add_argument(
        "--project-id",
        default=None,
        help="Run for a single project id (UUID).",
    )
    ap.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Stop after N projects (for spot-checking).",
    )
    return ap.parse_args()


def resolve_paths(args: argparse.Namespace) -> tuple[Path, Path]:
    db_path = args.db
    if not db_path:
        # Try DATABASE_URL of the form sqlite+aiosqlite:///<path>
        url = os.environ.get("DATABASE_URL", "")
        if url.startswith("sqlite"):
            after = url.split(":///", 1)[-1]
            if after:
                db_path = after
    if not db_path:
        # Fall back to the canonical local restored path
        for candidate in ("data/velxio.db", "../data/velxio.db", "velxio.db"):
            if Path(candidate).exists():
                db_path = candidate
                break
    if not db_path:
        raise SystemExit("Could not locate velxio.db. Pass --db <path>.")

    data_dir = args.data_dir or os.environ.get("DATA_DIR")
    if not data_dir:
        # Same parent as the DB, sibling to the file
        data_dir = str(Path(db_path).parent)

    return Path(db_path), Path(data_dir)


def main() -> int:
    args = parse_args()
    db_path, data_dir = resolve_paths(args)

    if not db_path.exists():
        print(f"DB not found: {db_path}", file=sys.stderr)
        return 1

    print(f"DB:       {db_path}")
    print(f"DATA_DIR: {data_dir}")
    print(f"Mode:     {'APPLY' if args.apply else 'DRY-RUN'}")
    print()

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # Schema check: boards_json must exist (added by lifespan auto-migration).
    cols = {r[1] for r in conn.execute("PRAGMA table_info(projects)").fetchall()}
    if "boards_json" not in cols:
        print(
            "FATAL: projects.boards_json column does not exist. Start the "
            "backend at least once so the lifespan auto-migration runs, or "
            "execute manually:\n"
            "  ALTER TABLE projects ADD COLUMN boards_json TEXT NOT NULL "
            "DEFAULT '[]';",
            file=sys.stderr,
        )
        return 2

    if args.project_id:
        rows = conn.execute(
            "SELECT id, name, board_type, components_json, wires_json, boards_json "
            "FROM projects WHERE id = ?",
            (args.project_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, name, board_type, components_json, wires_json, boards_json "
            "FROM projects ORDER BY created_at"
        ).fetchall()
    if args.limit:
        rows = rows[: args.limit]

    case_counts: Counter[str] = Counter()
    plans: list[PlanItem] = []
    total_wires_renamed = 0
    all_orphans: list[tuple[str, str, str]] = []  # (project_id, name, ref)

    for r in rows:
        proj_dir = data_dir / "projects" / r["id"]
        plan = plan_for_project(
            project_id=r["id"],
            name=r["name"] or "",
            board_type=r["board_type"] or "arduino-uno",
            components_json=r["components_json"] or "[]",
            wires_json=r["wires_json"] or "[]",
            boards_json=r["boards_json"] or "[]",
            project_files_dir=proj_dir,
        )
        plans.append(plan)
        case_counts[plan.case] += 1
        total_wires_renamed += plan.wires_renamed
        for ref in plan.orphan_refs:
            all_orphans.append((plan.project_id, plan.name, ref))

    # ── Print per-project plan ────────────────────────────────────────────────
    for p in plans:
        if p.case == "skip-already-migrated":
            continue
        ids = [b["id"] for b in p.new_boards]
        extras = []
        if p.wires_renamed:
            extras.append(f"renamed {p.wires_renamed} wire endpoints")
        if p.new_disk_layout:
            extras.append(
                f"move {len(p.new_disk_layout['files'])} flat file(s) -> "
                f"{p.new_disk_layout['target_group']}/"
            )
        if p.orphan_refs:
            extras.append(f"orphan refs={p.orphan_refs}")
        suffix = (" | " + "; ".join(extras)) if extras else ""
        name_repr = (p.name[:35] + "...") if len(p.name) > 38 else p.name
        try:
            print(
                f"[{p.case}] {p.project_id[:8]} {name_repr!r:40s} "
                f"board_type={p.board_type!r:25s} -> boards={ids}{suffix}"
            )
        except UnicodeEncodeError:
            # Windows cp1252 console can't render some emojis/glyphs
            safe = name_repr.encode("ascii", "replace").decode("ascii")
            print(
                f"[{p.case}] {p.project_id[:8]} {safe!r:40s} "
                f"board_type={p.board_type!r:25s} -> boards={ids}{suffix}"
            )

    # ── Summary ───────────────────────────────────────────────────────────────
    print()
    print("=" * 70)
    print(f"Total projects considered: {len(plans)}")
    for case in ("A", "B", "C", "skip-already-migrated"):
        n = case_counts.get(case, 0)
        if n:
            label = {
                "A": "Case A — legacy id rename (single-board)",
                "B": "Case B — single-board normal (no wire rename)",
                "C": "Case C — multi-board recovered",
                "skip-already-migrated": "Skipped (boards_json already populated)",
            }[case]
            print(f"  {label}: {n}")
    print(f"Wire endpoints renamed: {total_wires_renamed}")
    if all_orphans:
        print()
        print(f"WARNING: {len(all_orphans)} orphan board refs (kind unknown):")
        for pid, name, ref in all_orphans[:30]:
            print(f"  {pid[:8]} {name!r:30s} ref={ref!r}")
        if len(all_orphans) > 30:
            print(f"  ... and {len(all_orphans) - 30} more")
    print()

    if args.apply:
        for p in plans:
            apply_plan(p, conn, data_dir)
        conn.commit()
        print("Changes committed.")
    else:
        print("Dry-run only. Re-run with --apply to commit.")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
