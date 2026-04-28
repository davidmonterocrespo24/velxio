"""
pytest config for test_100_days

Adds the per-suite folder and the backend folder to ``sys.path`` so the
generated tests can import shared helpers without each one re-doing the
``sys.path.insert`` dance.
"""

import sys
from pathlib import Path

THIS_DIR  = Path(__file__).resolve().parent
REPO_ROOT = THIS_DIR.parents[1]

for p in (THIS_DIR, REPO_ROOT / "backend"):
    s = str(p)
    if s not in sys.path:
        sys.path.insert(0, s)
