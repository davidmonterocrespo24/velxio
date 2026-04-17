"""
Tests for the Velxio MCP server tools.

These tests exercise the tool functions directly (without a running MCP transport)
and mock the ArduinoCLIService to avoid requiring arduino-cli to be installed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

# Ensure backend/ is importable (for direct execution; pytest uses conftest.py)
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))


# ---------------------------------------------------------------------------
# Wokwi utility tests
# ---------------------------------------------------------------------------

from app.mcp.wokwi import (
    color_to_hex,
    format_wokwi_diagram,
    generate_arduino_sketch,
    hex_to_color_name,
    parse_wokwi_diagram,
)


class TestColorHelpers:
    def test_named_color_to_hex(self):
        assert color_to_hex("red") == "#ff0000"
        assert color_to_hex("GREEN") == "#00ff00"

    def test_hex_passthrough(self):
        assert color_to_hex("#1a2b3c") == "#1a2b3c"

    def test_hex_to_name(self):
        assert hex_to_color_name("#ff0000") == "red"
        assert hex_to_color_name("#unknown") == "#unknown"


SAMPLE_DIAGRAM = {
    "version": 1,
    "author": "test",
    "editor": "wokwi",
    "parts": [
        {"type": "wokwi-arduino-uno", "id": "uno", "top": 0, "left": 0, "attrs": {}},
        {
            "type": "wokwi-led",
            "id": "led1",
            "top": 100,
            "left": 200,
            "rotate": 0,
            "attrs": {"color": "red"},
        },
        {
            "type": "wokwi-resistor",
            "id": "r1",
            "top": 150,
            "left": 200,
            "attrs": {"value": "220"},
        },
    ],
    "connections": [
        ["uno:13", "led1:A", "green", []],
        ["led1:C", "r1:1", "black", []],
        ["r1:2", "uno:GND.1", "black", []],
    ],
}


class TestParseWokwiDiagram:
    def test_detects_board_fqbn(self):
        result = parse_wokwi_diagram(SAMPLE_DIAGRAM)
        assert result["board_fqbn"] == "arduino:avr:uno"

    def test_components_parsed(self):
        result = parse_wokwi_diagram(SAMPLE_DIAGRAM)
        ids = [c["id"] for c in result["components"]]
        assert "uno" in ids
        assert "led1" in ids
        assert "r1" in ids

    def test_connections_parsed(self):
        result = parse_wokwi_diagram(SAMPLE_DIAGRAM)
        conns = result["connections"]
        assert len(conns) == 3
        first = conns[0]
        assert first["from_part"] == "uno"
        assert first["from_pin"] == "13"
        assert first["to_part"] == "led1"
        assert first["to_pin"] == "A"
        assert first["color"] == "#00ff00"  # 'green' -> hex

    def test_version(self):
        result = parse_wokwi_diagram(SAMPLE_DIAGRAM)
        assert result["version"] == 1

    def test_empty_diagram(self):
        result = parse_wokwi_diagram({})
        assert result["board_fqbn"] == "arduino:avr:uno"
        assert result["components"] == []
        assert result["connections"] == []

    def test_unknown_board_defaults(self):
        diagram = {"parts": [{"type": "unknown-board", "id": "b1", "attrs": {}}]}
        result = parse_wokwi_diagram(diagram)
        assert result["board_fqbn"] == "arduino:avr:uno"


class TestFormatWokwiDiagram:
    def test_round_trip(self):
        """parse → format should preserve the essential structure."""
        circuit = parse_wokwi_diagram(SAMPLE_DIAGRAM)
        wokwi = format_wokwi_diagram(circuit)

        part_ids = [p["id"] for p in wokwi["parts"]]
        assert "led1" in part_ids
        assert "r1" in part_ids

    def test_board_injected(self):
        circuit = {
            "board_fqbn": "arduino:avr:uno",
            "components": [],
            "connections": [],
            "version": 1,
        }
        wokwi = format_wokwi_diagram(circuit)
        types = [p["type"] for p in wokwi["parts"]]
        assert "wokwi-arduino-uno" in types

    def test_author_embedded(self):
        circuit = parse_wokwi_diagram(SAMPLE_DIAGRAM)
        wokwi = format_wokwi_diagram(circuit, author="alice")
        assert wokwi["author"] == "alice"

    def test_connections_formatted(self):
        circuit = parse_wokwi_diagram(SAMPLE_DIAGRAM)
        wokwi = format_wokwi_diagram(circuit)
        assert len(wokwi["connections"]) == 3
        # Each connection should be [from, to, color, []]
        for conn in wokwi["connections"]:
            assert isinstance(conn, list)
            assert len(conn) == 4


class TestGenerateArduinoSketch:
    def test_generates_setup_and_loop(self):
        circuit = parse_wokwi_diagram(SAMPLE_DIAGRAM)
        sketch = generate_arduino_sketch(circuit)
        assert "void setup()" in sketch
        assert "void loop()" in sketch

    def test_contains_serial_begin(self):
        circuit = parse_wokwi_diagram(SAMPLE_DIAGRAM)
        sketch = generate_arduino_sketch(circuit)
        assert "Serial.begin" in sketch


# ---------------------------------------------------------------------------
# MCP tool function tests
# ---------------------------------------------------------------------------

from app.mcp.server import (
    compile_project,
    create_circuit,
    export_wokwi_json,
    generate_code_files,
    import_wokwi_json,
    run_project,
    update_circuit,
)


class TestImportWokwiJson:
    @pytest.mark.asyncio
    async def test_valid_diagram(self):
        result = await import_wokwi_json(json.dumps(SAMPLE_DIAGRAM))
        assert "board_fqbn" in result
        assert "components" in result
        assert "connections" in result

    @pytest.mark.asyncio
    async def test_invalid_json(self):
        result = await import_wokwi_json("not-json{")
        assert "error" in result

    @pytest.mark.asyncio
    async def test_not_object(self):
        result = await import_wokwi_json("[1, 2, 3]")
        assert "error" in result


class TestExportWokwiJson:
    @pytest.mark.asyncio
    async def test_valid_circuit(self):
        circuit = parse_wokwi_diagram(SAMPLE_DIAGRAM)
        result = await export_wokwi_json(circuit)
        assert "parts" in result
        assert "connections" in result
        assert result["editor"] == "velxio"

    @pytest.mark.asyncio
    async def test_invalid_input(self):
        result = await export_wokwi_json("not a dict")  # type: ignore[arg-type]
        assert "error" in result


class TestCreateCircuit:
    @pytest.mark.asyncio
    async def test_defaults(self):
        result = await create_circuit()
        assert result["board_fqbn"] == "arduino:avr:uno"
        assert result["components"] == []
        assert result["connections"] == []

    @pytest.mark.asyncio
    async def test_with_components(self):
        result = await create_circuit(
            board_fqbn="arduino:avr:uno",
            components=[{"id": "led1", "type": "wokwi-led", "left": 100, "top": 50}],
            connections=[
                {
                    "from_part": "uno",
                    "from_pin": "13",
                    "to_part": "led1",
                    "to_pin": "A",
                    "color": "green",
                }
            ],
        )
        assert len(result["components"]) == 1
        assert result["components"][0]["id"] == "led1"
        assert len(result["connections"]) == 1


class TestUpdateCircuit:
    @pytest.mark.asyncio
    async def test_add_component(self):
        circuit = await create_circuit(
            components=[{"id": "led1", "type": "wokwi-led"}]
        )
        updated = await update_circuit(
            circuit=circuit,
            add_components=[{"id": "btn1", "type": "wokwi-pushbutton"}],
        )
        ids = [c["id"] for c in updated["components"]]
        assert "led1" in ids
        assert "btn1" in ids

    @pytest.mark.asyncio
    async def test_remove_component(self):
        circuit = await create_circuit(
            components=[
                {"id": "led1", "type": "wokwi-led"},
                {"id": "r1", "type": "wokwi-resistor"},
            ]
        )
        updated = await update_circuit(
            circuit=circuit,
            remove_component_ids=["r1"],
        )
        ids = [c["id"] for c in updated["components"]]
        assert "led1" in ids
        assert "r1" not in ids

    @pytest.mark.asyncio
    async def test_change_board(self):
        circuit = await create_circuit()
        updated = await update_circuit(
            circuit=circuit,
            board_fqbn="rp2040:rp2040:rpipico",
        )
        assert updated["board_fqbn"] == "rp2040:rp2040:rpipico"

    @pytest.mark.asyncio
    async def test_add_and_remove_connections(self):
        circuit = await create_circuit(
            connections=[
                {
                    "from_part": "uno",
                    "from_pin": "13",
                    "to_part": "led1",
                    "to_pin": "A",
                }
            ]
        )
        updated = await update_circuit(
            circuit=circuit,
            add_connections=[
                {
                    "from_part": "uno",
                    "from_pin": "12",
                    "to_part": "led2",
                    "to_pin": "A",
                }
            ],
            remove_connections=[
                {
                    "from_part": "uno",
                    "from_pin": "13",
                    "to_part": "led1",
                    "to_pin": "A",
                }
            ],
        )
        assert len(updated["connections"]) == 1
        assert updated["connections"][0]["from_pin"] == "12"

    @pytest.mark.asyncio
    async def test_invalid_circuit(self):
        result = await update_circuit(circuit="bad")  # type: ignore[arg-type]
        assert "error" in result


class TestGenerateCodeFiles:
    @pytest.mark.asyncio
    async def test_generates_ino_file(self):
        circuit = await create_circuit()
        result = await generate_code_files(circuit=circuit)
        assert len(result["files"]) == 1
        assert result["files"][0]["name"] == "sketch.ino"

    @pytest.mark.asyncio
    async def test_custom_sketch_name(self):
        circuit = await create_circuit()
        result = await generate_code_files(circuit=circuit, sketch_name="blink")
        assert result["files"][0]["name"] == "blink.ino"

    @pytest.mark.asyncio
    async def test_extra_instructions(self):
        circuit = await create_circuit()
        result = await generate_code_files(
            circuit=circuit,
            extra_instructions="Generated by agent",
        )
        assert "Generated by agent" in result["files"][0]["content"]

    @pytest.mark.asyncio
    async def test_invalid_circuit(self):
        result = await generate_code_files(circuit="bad")  # type: ignore[arg-type]
        assert "error" in result


class TestCompileProject:
    @pytest.mark.asyncio
    async def test_missing_keys(self):
        result = await compile_project(files=[{"name": "sketch.ino"}])
        assert result["success"] is False
        assert "content" in result["error"]

    @pytest.mark.asyncio
    async def test_calls_arduino_cli(self):
        mock_result = {
            "success": True,
            "hex_content": ":00000001FF",
            "binary_content": None,
            "binary_type": None,
            "stdout": "",
            "stderr": "",
        }
        with patch(
            "app.mcp.server._arduino.compile",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await compile_project(
                files=[{"name": "sketch.ino", "content": "void setup(){} void loop(){}"}]
            )
        assert result["success"] is True
        assert result["hex_content"] is not None


class TestRunProject:
    @pytest.mark.asyncio
    async def test_simulation_ready_flag_on_success(self):
        mock_result = {
            "success": True,
            "hex_content": ":00000001FF",
            "binary_content": None,
            "binary_type": None,
            "stdout": "",
            "stderr": "",
        }
        with patch(
            "app.mcp.server._arduino.compile",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_project(
                files=[{"name": "sketch.ino", "content": "void setup(){} void loop(){}"}]
            )
        assert result["simulation_ready"] is True

    @pytest.mark.asyncio
    async def test_simulation_ready_flag_on_failure(self):
        mock_result = {
            "success": False,
            "hex_content": None,
            "binary_content": None,
            "binary_type": None,
            "stdout": "",
            "stderr": "error",
            "error": "Compilation failed",
        }
        with patch(
            "app.mcp.server._arduino.compile",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_project(
                files=[{"name": "sketch.ino", "content": "bad code{{{"}]
            )
        assert result["simulation_ready"] is False
