"""
Shared pytest configuration for all backend tests.

Adds backend/ to sys.path so tests can import from `app.*` without
needing individual sys.path hacks in each file.
"""
import sys
from pathlib import Path

# Project root / backend/
BACKEND_DIR = Path(__file__).parent.parent.parent / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
