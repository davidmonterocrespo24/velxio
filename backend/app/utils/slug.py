from __future__ import annotations
import re

RESERVED_USERNAMES = {"login", "register", "api", "admin", "examples", "logout", "me", "google"}


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-")


def is_valid_username(name: str) -> bool:
    if name.lower() in RESERVED_USERNAMES:
        return False
    return bool(re.match(r"^[a-z0-9_-]{3,30}$", name))
