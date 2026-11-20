"""Dependency-free C++ header symbol scanner for the intellisense endpoint.

Scans an Arduino library tree (as laid out in the content-addressed library
cache: library.properties + headers in the root and src/) and extracts a small,
editor-friendly symbol table: classes, their PUBLIC methods, object-like
#define constants and enum values. Regex/state-machine based on purpose — no
tree-sitter, no libclang, no new pip dependency. Robustness beats
completeness: any construct that cannot be parsed confidently is skipped.

This module also mirrors (reimplements — it must NOT import) the pro overlay's
library-cache naming rules from pro/backend/app/pro/services/library_cache.py:
cache entries are directories named `<norm_name>@<norm_version>-<sha12>`, where
norm_name keeps lowercase alphanumerics only and norm_version collapses the
untrusted library.properties version into a safe path token. The OSS image
must resolve those entries without the overlay being importable, so the
normalization and newest-version-first ordering are duplicated here verbatim.
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# Hard cap on symbols per library: keeps responses and the on-disk symbol
# cache bounded even for pathological headers.
MAX_SYMBOLS = 400

_HEADER_SUFFIXES = frozenset({".h", ".hpp"})
# Directories never scanned for symbols (case-insensitive match on the name).
_SKIP_DIRS = frozenset({"examples", "example", "test", "tests", "docs", "doc", "extras"})

_CACHE_META = ".velxio-cache-meta.json"


# ---------------------------------------------------------------------------
# Library-cache naming (mirrors pro library_cache.py — do not import it)
# ---------------------------------------------------------------------------

def norm_name(name: str) -> str:
    """Lowercase alphanumerics only — matches the pro cache's norm_name so a
    request spec, a folder name and a cache key all compare equal."""
    return "".join(ch for ch in (name or "").lower() if ch.isalnum())


def norm_version(version: str) -> str:
    """Collapse an untrusted version string into a single safe, traversal-free
    path token (mirrors the pro cache's norm_version)."""
    v = re.sub(r"[^A-Za-z0-9._-]", "-", (version or "").strip())
    v = v.lstrip(".")  # never a leading dot (no '.'/'..' dir tokens)
    return v or "0"


def parse_spec(spec: str) -> tuple[str, Optional[str]]:
    """Split a `Name@Version` request spec into (name, version). A bare `Name`
    yields (name, None). Whitespace around either part is ignored."""
    name, sep, version = (spec or "").partition("@")
    return name.strip(), (version.strip() if sep else None)


def _entry_version_key(entry: Path) -> tuple:
    """Rank cache entries for the SAME name: newest version first when the
    sort is reversed (mirrors the pro cache's _entry_version_key). Parses the
    version token out of '<name>@<version>-<sha12>' into numeric release
    tokens + pre-release tag so '3.10.1' > '3.6.0' compares numerically, and
    '1.2.3' > '1.2.3-rc1'. Ties break on the sidecar's populated_at."""
    ver = entry.name.rsplit("-", 1)[0].partition("@")[2]
    tokens = re.split(r"[.\-_]", ver)
    release: list[int] = []
    for tok in tokens:
        if not tok.isdigit():
            break
        release.append(int(tok))
    pre = tuple(tokens[len(release):])
    populated = 0
    try:
        meta = json.loads((entry / _CACHE_META).read_text(encoding="utf-8"))
        populated = int(meta.get("populated_at") or 0)
    except (OSError, ValueError, TypeError):
        pass
    return (release, 0 if pre else 1, pre, populated)


def find_cache_entry(cache_root: Path, name: str, version: Optional[str] = None) -> Optional[Path]:
    """Resolve a cache entry dir under `cache_root` for a library name and
    optional version. With a version -> first `<norm>@<norm_version>-*` match
    in key order (mirrors the pro cache's lookup). Without one -> the NEWEST
    version for the bare name (mirrors lookup_by_name). Returns None when the
    root is missing, the name normalizes to empty, or nothing matches —
    callers degrade gracefully (OSS self-host may have no cache at all)."""
    n = norm_name(name)
    if not n or not cache_root.is_dir():
        return None
    if version is not None:
        prefix = f"{n}@{norm_version(version)}-"
        for d in sorted(cache_root.iterdir()):
            if d.is_dir() and not d.name.startswith(".") and d.name.startswith(prefix):
                return d
        return None
    prefix = f"{n}@"
    matches = [
        d for d in sorted(cache_root.iterdir())
        if d.is_dir() and not d.name.startswith(".") and d.name.startswith(prefix)
    ]
    if not matches:
        return None
    matches.sort(key=_entry_version_key, reverse=True)
    return matches[0]


# ---------------------------------------------------------------------------
# C++ header scanning
# ---------------------------------------------------------------------------

def _strip_comments(text: str) -> str:
    """Remove // and /* */ comments, respecting string and char literals so a
    quoted "//" never truncates a line. Newlines inside block comments are
    preserved so directive lines keep their own line."""
    out: list[str] = []
    i, n = 0, len(text)
    state = "code"  # code | line | block | dq | sq
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if state == "code":
            if c == "/" and nxt == "/":
                state = "line"
                i += 2
                continue
            if c == "/" and nxt == "*":
                state = "block"
                i += 2
                continue
            if c == '"':
                state = "dq"
            elif c == "'":
                state = "sq"
            out.append(c)
            i += 1
        elif state == "line":
            if c == "\n":
                out.append(c)
                state = "code"
            i += 1
        elif state == "block":
            if c == "*" and nxt == "/":
                state = "code"
                i += 2
                continue
            if c == "\n":
                out.append(c)
            i += 1
        else:  # inside a string/char literal
            if c == "\\" and nxt:
                out.append(c)
                out.append(nxt)
                i += 2
                continue
            if (state == "dq" and c == '"') or (state == "sq" and c == "'"):
                state = "code"
            out.append(c)
            i += 1
    return "".join(out)


# Object-like #define with an UPPERCASE name and a value. The mandatory space
# after the name rejects function-like macros (`#define NAME(x)` has no space
# before the paren); the mandatory value rejects bare include guards.
_DEFINE_RE = re.compile(r"^\s*#\s*define\s+([A-Z][A-Z0-9_]*)\s+\S")


def _extract_directives(text: str) -> tuple[str, list[str]]:
    """Drop every preprocessor directive line (conservative #if/#ifdef
    handling: the guarded content is KEPT, only the directive lines go),
    collecting object-like uppercase #define names on the way. Backslash
    continuations are swallowed with their directive."""
    kept: list[str] = []
    defines: list[str] = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.lstrip().startswith("#"):
            m = _DEFINE_RE.match(line)
            if m:
                defines.append(m.group(1))
            kept.append("")
            while line.rstrip().endswith("\\") and i + 1 < len(lines):
                i += 1
                line = lines[i]
                kept.append("")
            i += 1
            continue
        kept.append(line)
        i += 1
    return "\n".join(kept), defines


# Statement ends with a class/struct definition head: optional single ALL-CAPS
# export macro between the keyword and the name, optional `final`, optional
# base-clause. Anchored at the end so `typedef struct` (anonymous) never hits.
_CLASS_RE = re.compile(
    r"\b(class|struct)\s+(?:[A-Z][A-Z0-9_]*\s+)?([A-Za-z_]\w*)\s*(?:final\s*)?(?::([^{;]*))?$"
)
# One base in a base-clause: `public Adafruit_GFX`, `virtual private Print`,
# `Adafruit_GrayOLED`, `Print<T>` (template args dropped), `ns::Base`.
_BASE_RE = re.compile(r"(?:\b(?:public|protected|private|virtual)\s+)*([A-Za-z_][\w:]*)")


def _parse_bases(clause: Optional[str]) -> list[str]:
    """Base class names from the text after the `:` of a class head. Access
    and virtual keywords are dropped, `ns::Base` keeps its last segment,
    template arguments are cut. Order preserved (first base first)."""
    if not clause:
        return []
    out: list[str] = []
    for part in clause.split(","):
        m = _BASE_RE.search(part.strip())
        if not m:
            continue
        name = m.group(1).split("<", 1)[0].rsplit("::", 1)[-1]
        if name and name not in out:
            out.append(name)
    return out
_ENUM_RE = re.compile(
    r"\benum(?:\s+(class|struct))?(?:\s+([A-Za-z_]\w*))?\s*(?::\s*[\w:\s]+)?$"
)
_ACCESS_RE = re.compile(r"\b(public|private|protected)\s*:(?!:)")
_TRAILER_RE = re.compile(
    r"^(?:(?:const|override|final|noexcept(?:\([^)]*\))?|=\s*0|=\s*default)\s*)*(?::.*)?$"
)
_HEAD_QUALIFIERS = ("virtual", "static", "inline", "explicit", "constexpr")
_RET_OK_RE = re.compile(r"^[\w:<>,\s*&\[\]]+$")
_NAME_TAIL_RE = re.compile(r"([A-Za-z_]\w*)\s*$")
_KEYWORDS = frozenset({"if", "for", "while", "switch", "return", "sizeof", "new", "delete", "throw"})


def _split_args(args: str) -> list[str]:
    """Split an argument list on top-level commas (nested <>, () and []
    stay intact). '(void)' and '()' both yield no arguments."""
    args = args.strip()
    if not args or args == "void":
        return []
    parts: list[str] = []
    cur: list[str] = []
    depth = 0
    for ch in args:
        if ch in "<([":
            depth += 1
        elif ch in ">)]":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    tail = "".join(cur).strip()
    if tail:
        parts.append(tail)
    return [p for p in parts if p]


def _param_hint(arg: str) -> str:
    """Snippet placeholder text for one argument: the declared parameter name
    when it can be found, else the whole trimmed argument. Snippet-breaking
    characters are removed."""
    decl = arg.split("=", 1)[0].rstrip()
    m = _NAME_TAIL_RE.search(re.sub(r"\[\s*\]\s*$", "", decl))
    hint = m.group(1) if m else arg
    return re.sub(r"[{}$]", "", hint).strip() or "arg"


def _build_call(name: str, parts: list[str]) -> tuple[str, str]:
    """(signature-args, insertText) for a callable with the given split args."""
    required = [p for p in parts if "=" not in p]
    if not required:
        insert = f"{name}()"
    else:
        placeholders = ", ".join(
            f"${{{k}:{_param_hint(p)}}}" for k, p in enumerate(required, 1)
        )
        insert = f"{name}({placeholders})$0"
    return ", ".join(parts), insert


def _split_comma_declarators(candidate: str) -> list[str]:
    """`void a(int), b(), c(char x);` declares three methods sharing a return
    type (TFT_eSPI declares setTextColor/setTextSize and setCursor/... this
    way). Split on top-level commas that sit OUTSIDE parentheses and after a
    complete `name(args)` group, and prepend the shared head to each tail.
    Anything else -- a single declarator, or commas only inside argument
    lists -- comes back as a one-element list."""
    depth = 0
    cuts: list[int] = []
    seen_group = False
    for k, ch in enumerate(candidate):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                seen_group = True
        elif ch == "," and depth == 0 and seen_group:
            cuts.append(k)
    if not cuts:
        return [candidate]
    first = candidate[: cuts[0]]
    p = first.find("(")
    nm = _NAME_TAIL_RE.search(first[:p]) if p > 0 else None
    if not nm:
        return [candidate]
    head = first[: nm.start()]
    out = [first]
    prev = cuts[0] + 1
    for cut in cuts[1:] + [len(candidate)]:
        out.append(head + candidate[prev:cut].strip())
        prev = cut + 1
    # the trailing `;`-less tail keeps whatever trailer it had (const, = 0)
    return out


def _try_method(candidate: str, scope: dict, add: Callable[[dict], Optional[dict]], detail: str) -> None:
    """Attempt to parse `candidate` (a statement inside a public class/struct
    section, stripped of access labels) as a method declaration. Emits a
    method symbol, or fills the owning class symbol's insertText/params from
    its first public constructor. Anything unconfident is skipped."""
    candidate = re.sub(r"\s+", " ", candidate).strip()
    if not candidate or "operator" in candidate or "~" in candidate or "template" in candidate:
        return
    parts_ = _split_comma_declarators(candidate)
    if len(parts_) > 1:
        for one in parts_:
            _try_method(one, scope, add, detail)
        return
    p = candidate.find("(")
    if p <= 0:
        return
    depth = 0
    q = -1
    for k in range(p, len(candidate)):
        if candidate[k] == "(":
            depth += 1
        elif candidate[k] == ")":
            depth -= 1
            if depth == 0:
                q = k
                break
    if q < 0:
        return
    head = candidate[:p].strip()
    args_raw = candidate[p + 1:q].strip()
    trailer = candidate[q + 1:].strip()
    if "delete" in trailer or not _TRAILER_RE.match(trailer):
        return
    if head.startswith("friend"):
        return
    nm = _NAME_TAIL_RE.search(head)
    if not nm:
        return
    name = nm.group(1)
    if name in _KEYWORDS:
        return
    ret = head[: nm.start()].strip()
    for qual in _HEAD_QUALIFIERS:
        ret = re.sub(rf"\b{qual}\b", " ", ret)
    ret = re.sub(r"\s+", " ", ret).strip()
    parts = _split_args(args_raw)
    if not ret:
        # No return type: a constructor when the name matches the class;
        # anything else (macro invocation, unparsable) is skipped.
        if name == scope["name"]:
            sym = scope.get("sym")
            if sym is not None and "insertText" not in sym:
                sig_args, insert = _build_call(name, parts)
                sym["signature"] = f"{name}({sig_args})"
                sym["insertText"] = insert
                if parts:
                    sym["params"] = parts
        return
    if not _RET_OK_RE.match(ret):
        return
    sig_args, insert = _build_call(name, parts)
    method = {
        "name": name,
        "kind": "method",
        "owner": scope["name"],
        "signature": f"{ret} {name}({sig_args})",
        "detail": detail,
        "insertText": insert,
    }
    if parts:
        method["params"] = parts
    add(method)


def _capture_braces(text: str, i: int) -> tuple[str, int]:
    """Given `i` at a '{', return (body, index-just-past-matching-'}')."""
    depth = 0
    for k in range(i, len(text)):
        if text[k] == "{":
            depth += 1
        elif text[k] == "}":
            depth -= 1
            if depth == 0:
                return text[i + 1:k], k + 1
    return text[i + 1:], len(text)


def _emit_enum(scoped: bool, ename: Optional[str], body: str, add: Callable[[dict], Optional[dict]], detail: str) -> None:
    for piece in _split_args(body):
        m = re.match(r"^([A-Za-z_]\w*)", piece.strip())
        if not m:
            continue
        sym = {"name": m.group(1), "kind": "constant", "detail": detail}
        if scoped and ename:
            sym["owner"] = ename
        add(sym)


def _scan_text(text: str, add: Callable[[dict], Optional[dict]], detail: str) -> None:
    """Statement-oriented walk of comment/directive-free source: track brace
    depth and a scope stack; classify each statement when it terminates at
    '{', '}' or ';'. Multi-line declarations fall out naturally."""
    buf: list[str] = []
    stack: list[dict] = []
    i, n = 0, len(text)

    def apply_access(stmt: str) -> str:
        """Consume `public:` / `private:` / `protected:` labels at the head of
        a statement, updating the enclosing class scope, and return the rest.
        Must run for EVERY statement inside a class, including the ones that
        open a nested enum/struct/brace: `public:\n typedef enum {` used to
        take the enum branch without ever seeing its `public:`, leaving the
        class in its default private access and dropping every method that
        followed (AccelStepper lost its whole API that way)."""
        if not stack or stack[-1]["kind"] != "classlike":
            return stmt
        scope = stack[-1]
        candidate = stmt
        for m in _ACCESS_RE.finditer(stmt):
            scope["access"] = m.group(1)
            candidate = stmt[m.end():]
        return candidate

    def handle_statement(stmt: str) -> None:
        candidate = apply_access(stmt)
        if not stack or stack[-1]["kind"] != "classlike":
            return
        if stack[-1]["access"] != "public":
            return
        _try_method(candidate.strip(), stack[-1], add, detail)

    while i < n:
        c = text[i]
        if c == "{":
            stmt = "".join(buf).strip()
            buf = []
            # Access labels apply whichever branch the statement takes below.
            stmt = apply_access(stmt)
            if "template" not in stmt:
                em = _ENUM_RE.search(stmt)
                if em and re.search(r"\benum\b", stmt):
                    body, j = _capture_braces(text, i)
                    _emit_enum(em.group(1) is not None, em.group(2), body, add, detail)
                    i = j
                    continue
                cm = _CLASS_RE.search(stmt)
                if cm:
                    cname = cm.group(2)
                    sym = {"name": cname, "kind": "class", "detail": detail}
                    bases = _parse_bases(cm.group(3))
                    if bases:
                        # Lets the /type/ endpoint (and the editor) follow
                        # inheritance: Adafruit_SH1106G -> Adafruit_SH110X ->
                        # Adafruit_GrayOLED -> Adafruit_GFX, where the drawing
                        # API actually lives.
                        sym["bases"] = bases
                    stored = add(sym)
                    stack.append({
                        "kind": "classlike",
                        "name": cname,
                        "access": "public" if cm.group(1) == "struct" else "private",
                        "sym": stored,
                    })
                    i += 1
                    continue
            # Inline method definition (`ret name(args) {`), namespace,
            # function body, brace initializer, ... — try the method parse,
            # then descend as an opaque scope.
            handle_statement(stmt)
            stack.append({"kind": "other"})
            i += 1
            continue
        if c == "}":
            if stack:
                stack.pop()
            buf = []
            i += 1
            continue
        if c == ";":
            stmt = "".join(buf).strip()
            buf = []
            if stmt:
                handle_statement(stmt)
            i += 1
            continue
        buf.append(c)
        i += 1


def _read_props(lib_dir: Path) -> dict[str, str]:
    props: dict[str, str] = {}
    try:
        text = (lib_dir / "library.properties").read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return props
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            props[k.strip().lower()] = v.strip()
    return props


def _iter_headers(lib_dir: Path):
    """Yield every *.h/*.hpp under the library tree, pruning examples/test/
    docs style directories, in a deterministic order."""
    for dirpath, dirnames, filenames in os.walk(lib_dir):
        dirnames[:] = sorted(
            d for d in dirnames
            if d.lower() not in _SKIP_DIRS and not d.startswith(".")
        )
        for fn in sorted(filenames):
            if Path(fn).suffix.lower() in _HEADER_SUFFIXES:
                yield Path(dirpath) / fn


def library_headers(lib_dir: Path) -> list[str]:
    """Public include candidates, without parsing the library's source."""
    triggers: list[str] = []
    for root in (lib_dir, lib_dir / "src"):
        if not root.is_dir():
            continue
        try:
            children = sorted(root.iterdir())
        except OSError:
            continue
        for child in children:
            if child.is_file() and child.suffix.lower() in _HEADER_SUFFIXES:
                if child.name not in triggers:
                    triggers.append(child.name)
    return triggers


def scan_library(lib_dir: Path) -> dict:
    """Scan public headers and symbols for IntelliSense."""
    props = _read_props(lib_dir)
    display = props.get("name") or lib_dir.name
    triggers = library_headers(lib_dir)

    symbols: list[dict] = []
    seen: set[tuple[str, str, str]] = set()

    def add(sym: dict) -> Optional[dict]:
        if len(symbols) >= MAX_SYMBOLS:
            return None
        key = (sym["name"], sym["kind"], sym.get("owner", ""))
        if key in seen:
            return None
        seen.add(key)
        symbols.append(sym)
        return sym

    for hdr in _iter_headers(lib_dir):
        if len(symbols) >= MAX_SYMBOLS:
            break
        try:
            raw = hdr.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        try:
            text = _strip_comments(raw)
            text, defines = _extract_directives(text)
            for dname in defines:
                add({"name": dname, "kind": "constant", "detail": display})
            _scan_text(text, add, display)
        except Exception:
            # A single hostile/bizarre header must never take the payload down.
            logger.warning("[symbol_extract] failed scanning %s", hdr, exc_info=True)
            continue

    return {"id": display, "triggers": triggers, "symbols": symbols}
