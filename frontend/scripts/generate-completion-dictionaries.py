"""
Generate the symbol dictionaries bundled for offline editor autocomplete.

Run this maintenance script to refresh the dictionaries from upstream reference
indexes.

Pass four downloaded files in this order.

1. The Python Sphinx v2 inventory (objects.inv).
2. The MicroPython Sphinx v2 inventory (objects.inv).
3. The cppreference-doc C index (index-functions-c.xml).
4. The cppreference-doc C++ index (index-functions-cpp.xml).

This overwrites python.symbols, micropython.symbols, and cpp.symbols under
frontend/src/data/completions/. Each dictionary contains qualified identifiers
and symbol kinds. Refreshing an existing dictionary preserves its header
comments. The frontend bundles these generated files directly from the
repository.

---

DOWNLOAD:

$inputs = Join-Path $env:TEMP 'velxio-completion-inputs'
New-Item -ItemType Directory -Force -Path $inputs | Out-Null

Invoke-WebRequest 'https://docs.python.org/release/3.13.7/objects.inv' -OutFile "$inputs\python.inv"
Invoke-WebRequest 'https://docs.micropython.org/en/v1.20.0/objects.inv' -OutFile "$inputs\micropython.inv"

$cppSource = 'https://raw.githubusercontent.com/PeterFeicht/cppreference-doc/4f773b792fdee3de1b04aa57f8315249c0a7c74b'
Invoke-WebRequest "$cppSource/index-functions-c.xml" -OutFile "$inputs\index-functions-c.xml"
Invoke-WebRequest "$cppSource/index-functions-cpp.xml" -OutFile "$inputs\index-functions-cpp.xml"

---

RUN:

.\backend\venv\Scripts\python.exe .\frontend\scripts\generate-completion-dictionaries.py `
  "$inputs\python.inv" `
  "$inputs\micropython.inv" `
  "$inputs\index-functions-c.xml" `
  "$inputs\index-functions-cpp.xml"

"""

from collections import defaultdict
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
import zlib

OUTPUT = Path(__file__).resolve().parents[1] / "src/data/completions"
PY_KINDS = {
    "module": "Module", "class": "Class", "exception": "Class", "function": "Function",
    "method": "Method", "attribute": "Property", "data": "Constant",
}
CPP_KINDS = {
    "class": "Class", "typedef": "Class", "enum": "Class", "function": "Function",
    "overload": "Function", "const": "Constant", "variable": "Variable",
}


def write_dictionary(name, symbols):
    groups = defaultdict(list)
    for (owner, label), kind in sorted(symbols.items()):
        groups[owner, kind].append(label)
    destination = OUTPUT / (name + ".symbols")
    rows = []
    if destination.is_file():
        rows = [line for line in destination.read_text(encoding="utf-8").splitlines() if line.startswith("#")]
    rows += ["\t".join([owner, kind, " ".join(labels)]) for (owner, kind), labels in sorted(groups.items())]
    OUTPUT.mkdir(parents=True, exist_ok=True)
    destination.write_text("\n".join(rows) + "\n", encoding="utf-8", newline="\n")


def python_inventory(path):
    payload = path.read_bytes().split(b"\n", 4)
    if payload[0] != b"# Sphinx inventory version 2":
        raise ValueError("Expected a Sphinx v2 inventory")
    symbols = {}
    for row in zlib.decompress(payload[-1]).decode().splitlines():
        name, role, *_ = row.split(" ", 2)
        kind = PY_KINDS.get(role.removeprefix("py:")) if role.startswith("py:") else None
        if kind and all(part.isidentifier() for part in name.split(".")):
            owner, _, label = name.rpartition(".")
            symbols[owner, label] = kind
    return symbols


def cpp_inventory(paths):
    symbols, bases = {}, defaultdict(list)

    def collect(node, parent=""):
        name = node.get("name", "")
        if node.tag == "inherits":
            bases[parent].append(name)
            return
        kind = CPP_KINDS.get(node.tag)
        if not kind or not re.fullmatch(r"\w+(?:::\w+)*", name):
            return
        full = name if "::" in name or not parent else parent + "::" + name
        owner, _, label = full.rpartition("::")
        outer, _, owner_name = owner.rpartition("::")
        if symbols.get((outer, owner_name)) == "Class" and kind == "Function":
            kind = "Method"
        symbols[owner, label] = kind
        if node.get("alias"):
            bases[full].append(node.get("alias"))
        for child in node:
            collect(child, full)

    for path in paths:
        for item in ET.parse(path).getroot():
            collect(item)
    members = defaultdict(dict)
    for (owner, label), kind in list(symbols.items()):
        members[owner][label] = kind
        while owner:
            owner, _, name = owner.rpartition("::")
            symbols.setdefault((owner, name), "Module")
    for owner, parents in bases.items():
        pending, seen = list(parents), set()
        while pending:
            base = pending.pop()
            if base in seen:
                continue
            seen.add(base)
            for label, kind in members[base].items():
                symbols.setdefault((owner, label), kind)
            pending.extend(bases.get(base, []))
    return symbols


if __name__ == "__main__":
    py, micro, c, cpp = map(Path, sys.argv[1:])
    write_dictionary("python", python_inventory(py))
    write_dictionary("micropython", python_inventory(micro))
    write_dictionary("cpp", cpp_inventory([c, cpp]))
