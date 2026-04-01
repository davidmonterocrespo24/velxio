from __future__ import annotations
"""
Wokwi diagram.json parse/format utilities (Python port of frontend/src/utils/wokwiZip.ts).
Handles conversion between Wokwi diagram format and the Velxio internal circuit format.
"""


from typing import Any

# ---------------------------------------------------------------------------
# Type aliases / data models (plain dicts for simplicity)
# ---------------------------------------------------------------------------

# Wokwi diagram.json structure:
# {
#   "version": 1,
#   "author": "...",
#   "editor": "wokwi",
#   "parts": [ { "type": "...", "id": "...", "top": 0, "left": 0, "attrs": {} } ],
#   "connections": [ ["partId:pinName", "partId:pinName", "color", []] ]
# }

# ---------------------------------------------------------------------------
# Board type mappings
# ---------------------------------------------------------------------------

WOKWI_TO_VELXIO_BOARD: dict[str, str] = {
    "wokwi-arduino-uno": "arduino:avr:uno",
    "wokwi-arduino-mega": "arduino:avr:mega",
    "wokwi-arduino-nano": "arduino:avr:nano",
    "wokwi-pi-pico": "rp2040:rp2040:rpipico",
    "raspberry-pi-pico": "rp2040:rp2040:rpipico",
    "wokwi-esp32-devkit-v1": "esp32:esp32:esp32",
}

VELXIO_TO_WOKWI_BOARD: dict[str, str] = {v: k for k, v in WOKWI_TO_VELXIO_BOARD.items()}

# Default board FQBN when none can be detected
DEFAULT_BOARD_FQBN = "arduino:avr:uno"

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------

COLOR_NAMES: dict[str, str] = {
    "red": "#ff0000",
    "green": "#00ff00",
    "blue": "#0000ff",
    "yellow": "#ffff00",
    "orange": "#ffa500",
    "purple": "#800080",
    "white": "#ffffff",
    "black": "#000000",
    "cyan": "#00ffff",
    "magenta": "#ff00ff",
    "lime": "#00ff00",
    "pink": "#ffc0cb",
    "gray": "#808080",
    "grey": "#808080",
    "brown": "#a52a2a",
    "gold": "#ffd700",
    "silver": "#c0c0c0",
}

HEX_TO_NAME: dict[str, str] = {v: k for k, v in COLOR_NAMES.items()}


def color_to_hex(color: str) -> str:
    """Normalise a color string to lowercase hex (e.g. 'red' -> '#ff0000')."""
    c = color.strip().lower()
    if c in COLOR_NAMES:
        return COLOR_NAMES[c]
    if c.startswith("#"):
        return c
    return "#" + c


def hex_to_color_name(hex_color: str) -> str:
    """Return a friendly color name if one exists, otherwise return the hex string."""
    normalized = hex_color.strip().lower()
    return HEX_TO_NAME.get(normalized, hex_color)


# ---------------------------------------------------------------------------
# Wokwi → Velxio conversion
# ---------------------------------------------------------------------------

BOARD_PART_TYPES = set(WOKWI_TO_VELXIO_BOARD.keys())


def _detect_board_fqbn(parts: list[dict[str, Any]]) -> str:
    """Return the board FQBN inferred from the parts list."""
    for part in parts:
        part_type = part.get("type", "")
        if part_type in WOKWI_TO_VELXIO_BOARD:
            return WOKWI_TO_VELXIO_BOARD[part_type]
    return DEFAULT_BOARD_FQBN


def parse_wokwi_diagram(diagram: dict[str, Any]) -> dict[str, Any]:
    """
    Convert a Wokwi diagram.json payload into a Velxio circuit object.

    The returned object has the shape:
    {
        "board_fqbn": str,
        "components": [ { "id", "type", "left", "top", "rotate", "attrs" } ],
        "connections": [ { "from_part", "from_pin", "to_part", "to_pin", "color" } ],
        "version": int,
    }
    """
    parts: list[dict[str, Any]] = diagram.get("parts", [])
    raw_connections: list[Any] = diagram.get("connections", [])

    board_fqbn = _detect_board_fqbn(parts)

    # Build component list (skip board parts – they are implicit in board_fqbn)
    components: list[dict[str, Any]] = []
    for part in parts:
        components.append(
            {
                "id": part.get("id", ""),
                "type": part.get("type", ""),
                "left": float(part.get("left", 0)),
                "top": float(part.get("top", 0)),
                "rotate": int(part.get("rotate", 0)),
                "attrs": dict(part.get("attrs", {})),
            }
        )

    # Build connection list
    connections: list[dict[str, Any]] = []
    for conn in raw_connections:
        # Each connection is [from, to, color, segments]
        if not isinstance(conn, (list, tuple)) or len(conn) < 2:
            continue
        from_endpoint: str = conn[0]
        to_endpoint: str = conn[1]
        color_raw: str = conn[2] if len(conn) > 2 else "green"
        color = color_to_hex(color_raw)

        # "partId:pinName" → split at first ':'
        from_parts = from_endpoint.split(":", 1)
        to_parts = to_endpoint.split(":", 1)
        connections.append(
            {
                "from_part": from_parts[0],
                "from_pin": from_parts[1] if len(from_parts) > 1 else "",
                "to_part": to_parts[0],
                "to_pin": to_parts[1] if len(to_parts) > 1 else "",
                "color": color,
            }
        )

    return {
        "board_fqbn": board_fqbn,
        "components": components,
        "connections": connections,
        "version": int(diagram.get("version", 1)),
    }


# ---------------------------------------------------------------------------
# Velxio → Wokwi conversion
# ---------------------------------------------------------------------------


def format_wokwi_diagram(
    circuit: dict[str, Any],
    author: str = "velxio",
) -> dict[str, Any]:
    """
    Convert a Velxio circuit object back into a Wokwi diagram.json payload.
    """
    board_fqbn: str = circuit.get("board_fqbn", DEFAULT_BOARD_FQBN)
    wokwi_board_type: str = VELXIO_TO_WOKWI_BOARD.get(board_fqbn, "wokwi-arduino-uno")

    # Build parts list; inject board part first if not already present
    raw_components: list[dict[str, Any]] = circuit.get("components", [])

    board_present = any(c.get("type") == wokwi_board_type for c in raw_components)
    parts: list[dict[str, Any]] = []

    if not board_present:
        parts.append(
            {
                "type": wokwi_board_type,
                "id": "uno",
                "top": 0,
                "left": 0,
                "attrs": {},
            }
        )

    for comp in raw_components:
        parts.append(
            {
                "type": comp.get("type", ""),
                "id": comp.get("id", ""),
                "top": comp.get("top", 0),
                "left": comp.get("left", 0),
                "rotate": comp.get("rotate", 0),
                "attrs": comp.get("attrs", {}),
            }
        )

    # Build connections list  [ [from, to, color, []] ]
    raw_connections: list[dict[str, Any]] = circuit.get("connections", [])
    connections: list[list[Any]] = []
    for conn in raw_connections:
        from_endpoint = f"{conn.get('from_part', '')}:{conn.get('from_pin', '')}"
        to_endpoint = f"{conn.get('to_part', '')}:{conn.get('to_pin', '')}"
        color = hex_to_color_name(conn.get("color", "green"))
        connections.append([from_endpoint, to_endpoint, color, []])

    return {
        "version": int(circuit.get("version", 1)),
        "author": author,
        "editor": "velxio",
        "parts": parts,
        "connections": connections,
    }


# ---------------------------------------------------------------------------
# Code template generation
# ---------------------------------------------------------------------------

COMPONENT_PIN_TEMPLATES: dict[str, str] = {
    "wokwi-led": "pinMode({pin}, OUTPUT); // LED",
    "wokwi-pushbutton": "pinMode({pin}, INPUT_PULLUP); // Button",
    "wokwi-buzzer": "pinMode({pin}, OUTPUT); // Buzzer",
    "wokwi-servo": "// Servo on pin {pin}: use Servo library",
}


def generate_arduino_sketch(circuit: dict[str, Any], sketch_name: str = "sketch") -> str:
    """
    Generate a minimal Arduino sketch (.ino) from a Velxio circuit definition.

    Returns the .ino file content as a string.
    """
    components = circuit.get("components", [])
    connections = circuit.get("connections", [])

    # Determine unique pins referenced by connections that involve the board
    board_pin_map: dict[str, list[str]] = {}  # component_id -> [pin_names]
    board_part_ids = {
        c["id"] for c in components if c.get("type", "") in BOARD_PART_TYPES
    }

    for conn in connections:
        for side in ("from", "to"):
            part = conn.get(f"{side}_part", "")
            pin = conn.get(f"{side}_pin", "")
            if part in board_part_ids and pin:
                other_side = "to" if side == "from" else "from"
                other_part = conn.get(f"{other_side}_part", "")
                board_pin_map.setdefault(other_part, []).append(pin)

    # Build setup/loop
    includes: list[str] = []
    setup_lines: list[str] = ["void setup() {", "  Serial.begin(9600);"]
    loop_lines: list[str] = ["void loop() {", "  // TODO: add your logic here"]

    for comp in components:
        comp_id = comp.get("id", "")
        comp_type = comp.get("type", "")
        if comp_id in board_pin_map:
            for pin in board_pin_map[comp_id]:
                template = COMPONENT_PIN_TEMPLATES.get(comp_type)
                if template:
                    setup_lines.append(f"  {template.format(pin=pin)}")

    setup_lines.append("}")
    loop_lines.append("}")

    lines = includes + [""] + setup_lines + [""] + loop_lines + [""]
    return "\n".join(lines)
