"""
pytest configuration for integration tests.

These tests require external tools (QEMU binary, arduino-cli, ESP-IDF toolchain)
and are NOT run in standard CI.  Run them manually:

    pytest test/backend/integration/ -v

or target a single file:

    pytest test/backend/integration/test_compilation.py -v
"""
import pytest


def pytest_collection_modifyitems(items):
    """Auto-mark every test in this directory as 'integration'."""
    for item in items:
        if 'integration' in str(item.fspath):
            item.add_marker(pytest.mark.integration)
