# Velxio MCP Server

Velxio exposes a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that allows AI agents (e.g. Claude, Cursor) to:

- **Create and update circuits** using a structured JSON format
- **Import and export** circuits in the Wokwi `diagram.json` format
- **Generate Arduino code** from circuit definitions
- **Compile projects** and receive structured results (hex/binary, logs)

---

## Tools

| Tool | Description |
|------|-------------|
| `compile_project` | Compile Arduino sketch files → Intel HEX / binary |
| `run_project` | Compile and mark artifact as simulation-ready |
| `import_wokwi_json` | Parse a Wokwi `diagram.json` → Velxio circuit |
| `export_wokwi_json` | Serialise a Velxio circuit → Wokwi `diagram.json` |
| `create_circuit` | Create a new circuit definition |
| `update_circuit` | Merge changes into an existing circuit |
| `generate_code_files` | Generate starter `.ino` code from a circuit |

---

## Transport Options

### 1. stdio (Claude Desktop / CLI agents)

Run the MCP server as a child process:

```bash
cd backend
python mcp_server.py
```

**Claude Desktop config** (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "velxio": {
      "command": "python",
      "args": ["/absolute/path/to/velxio/backend/mcp_server.py"]
    }
  }
}
```

### 2. SSE / HTTP (web agents, Cursor IDE)

Run the MCP SSE server on a separate port (default: **8002**):

```bash
cd backend
python mcp_sse_server.py --port 8002
```

**MCP client config (SSE transport)**:

```json
{
  "mcpServers": {
    "velxio": {
      "url": "http://localhost:8002/sse"
    }
  }
}
```

> **Note**: The SSE server runs separately from the main FastAPI backend (port 8001) to avoid Starlette version conflicts. Both can run simultaneously.

---

## Setup

1. **Install dependencies**:

   ```bash
   cd backend
   pip install -r requirements.txt
   ```

2. **Ensure arduino-cli is installed** (required for `compile_project` / `run_project`):

   ```bash
   arduino-cli version
   arduino-cli core update-index
   arduino-cli core install arduino:avr
   ```

---

## Example Walkthroughs

### Example 1 — Blink LED (from scratch)

**Step 1** — Create a circuit:

```json
{
  "tool": "create_circuit",
  "arguments": {
    "board_fqbn": "arduino:avr:uno",
    "components": [
      { "id": "led1", "type": "wokwi-led", "left": 150, "top": 100, "attrs": { "color": "red" } },
      { "id": "r1", "type": "wokwi-resistor", "left": 150, "top": 180, "attrs": { "value": "220" } }
    ],
    "connections": [
      { "from_part": "uno", "from_pin": "13", "to_part": "led1", "to_pin": "A", "color": "green" },
      { "from_part": "led1", "from_pin": "C", "to_part": "r1", "to_pin": "1", "color": "black" },
      { "from_part": "r1", "from_pin": "2", "to_part": "uno", "to_pin": "GND.1", "color": "black" }
    ]
  }
}
```

**Step 2** — Generate code:

```json
{
  "tool": "generate_code_files",
  "arguments": {
    "circuit": "<result from Step 1>",
    "sketch_name": "blink",
    "extra_instructions": "Blink the red LED every 500ms"
  }
}
```

**Step 3** — Compile the generated code (edit the sketch content as needed):

```json
{
  "tool": "compile_project",
  "arguments": {
    "files": [
      {
        "name": "blink.ino",
        "content": "void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(500); digitalWrite(13, LOW); delay(500); }"
      }
    ],
    "board": "arduino:avr:uno"
  }
}
```

**Response**:

```json
{
  "success": true,
  "hex_content": ":100000000C9434000C943E000C943E000C943E...",
  "binary_content": null,
  "binary_type": null,
  "stdout": "",
  "stderr": ""
}
```

---

### Example 2 — Import a Wokwi Circuit

**Import**:

```json
{
  "tool": "import_wokwi_json",
  "arguments": {
    "diagram_json": "{\"version\":1,\"author\":\"example\",\"editor\":\"wokwi\",\"parts\":[{\"type\":\"wokwi-arduino-uno\",\"id\":\"uno\",\"top\":0,\"left\":0,\"attrs\":{}},{\"type\":\"wokwi-led\",\"id\":\"led1\",\"top\":100,\"left\":200,\"attrs\":{\"color\":\"green\"}}],\"connections\":[[\"uno:13\",\"led1:A\",\"green\",[]]]}"
  }
}
```

**Response**:

```json
{
  "board_fqbn": "arduino:avr:uno",
  "components": [
    { "id": "uno", "type": "wokwi-arduino-uno", "left": 0, "top": 0, "rotate": 0, "attrs": {} },
    { "id": "led1", "type": "wokwi-led", "left": 200, "top": 100, "rotate": 0, "attrs": { "color": "green" } }
  ],
  "connections": [
    { "from_part": "uno", "from_pin": "13", "to_part": "led1", "to_pin": "A", "color": "#00ff00" }
  ],
  "version": 1
}
```

---

### Example 3 — Export to Wokwi Format

```json
{
  "tool": "export_wokwi_json",
  "arguments": {
    "circuit": {
      "board_fqbn": "arduino:avr:uno",
      "components": [
        { "id": "led1", "type": "wokwi-led", "left": 200, "top": 100, "rotate": 0, "attrs": {} }
      ],
      "connections": [
        { "from_part": "uno", "from_pin": "13", "to_part": "led1", "to_pin": "A", "color": "green" }
      ],
      "version": 1
    },
    "author": "my-agent"
  }
}
```

**Response** (Wokwi diagram.json format):

```json
{
  "version": 1,
  "author": "my-agent",
  "editor": "velxio",
  "parts": [
    { "type": "wokwi-arduino-uno", "id": "uno", "top": 0, "left": 0, "attrs": {} },
    { "type": "wokwi-led", "id": "led1", "top": 100, "left": 200, "rotate": 0, "attrs": {} }
  ],
  "connections": [
    ["uno:13", "led1:A", "green", []]
  ]
}
```

---

## Circuit Data Format

Velxio circuits are plain JSON objects:

```json
{
  "board_fqbn": "arduino:avr:uno",
  "version": 1,
  "components": [
    {
      "id": "led1",
      "type": "wokwi-led",
      "left": 200,
      "top": 100,
      "rotate": 0,
      "attrs": { "color": "red" }
    }
  ],
  "connections": [
    {
      "from_part": "uno",
      "from_pin": "13",
      "to_part": "led1",
      "to_pin": "A",
      "color": "green"
    }
  ]
}
```

### Supported Board FQBNs

| Board | FQBN |
|-------|------|
| Arduino Uno | `arduino:avr:uno` |
| Arduino Mega | `arduino:avr:mega` |
| Arduino Nano | `arduino:avr:nano` |
| Raspberry Pi Pico | `rp2040:rp2040:rpipico` |
| ESP32 DevKit | `esp32:esp32:esp32` |

### Common Component Types (Wokwi element names)

- `wokwi-led` — LED (attrs: `color`)
- `wokwi-resistor` — Resistor (attrs: `value` in Ω)
- `wokwi-pushbutton` — Push button
- `wokwi-buzzer` — Passive buzzer
- `wokwi-servo` — Servo motor
- `wokwi-lcd1602` — 16×2 LCD display
- `wokwi-neopixel` — NeoPixel RGB LED

---

## Sandboxing & Limits

- Compilation runs in a **temporary directory** cleaned up after each call.
- arduino-cli is invoked as a **subprocess** with no elevated privileges.
- There is no explicit CPU/memory timeout in the default configuration. For production deployments, set `COMPILATION_TIMEOUT_SECONDS` in the environment and enforce it at the process level.

---

## Running Tests

```bash
cd backend
pip install pytest pytest-asyncio
python -m pytest tests/test_mcp_tools.py -v
```
