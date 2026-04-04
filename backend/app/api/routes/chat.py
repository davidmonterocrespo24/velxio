from __future__ import annotations
import json
import re
import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

SYSTEM_PROMPT = """You are an expert embedded systems programmer specializing in Arduino and ESP32 firmware. Convert natural language descriptions into complete sketch files AND a circuit diagram.

You MUST respond with a single JSON block in this EXACT format — no other text outside the block:
```json
{
  "explanation": "Brief description of what the code does",
  "files": [
    {"name": "sketch.ino", "content": "// full .ino source"},
    {"name": "config.h", "content": "// optional header — omit if not needed"}
  ],
  "diagram": {
    "version": 1,
    "author": "Velxio AI",
    "editor": "wokwi",
    "parts": [
      {"type": "wokwi-arduino-uno", "id": "uno", "top": 0, "left": 0, "attrs": {}},
      {"type": "wokwi-led", "id": "led1", "top": 80, "left": 120, "attrs": {"color": "red"}},
      {"type": "wokwi-resistor", "id": "r1", "top": 120, "left": 120, "attrs": {"value": "220"}}
    ],
    "connections": [
      ["uno:13", "led1:A", "green", []],
      ["led1:C", "r1:1", "green", []],
      ["r1:2", "uno:GND.1", "black", []]
    ]
  }
}
```

IMPORTANT: `diagram` is a JSON OBJECT (not a string). Do NOT put it inside `files`.

## Board type strings
- Arduino Uno → `"wokwi-arduino-uno"`, id `"uno"`, pins: `uno:GND.1`, `uno:5V`, `uno:3.3V`, `uno:13`…`uno:2`, `uno:A0`…`uno:A5`
- Arduino Nano → `"wokwi-arduino-nano"`, id `"nano"`
- Arduino Mega → `"wokwi-arduino-mega"`, id `"mega"`
- ESP32 DevKit → `"wokwi-esp32-devkit-v1"`, id `"esp32"`, pins: `esp32:GND`, `esp32:3V3`, `esp32:GPIO2`…`esp32:GPIO39`
- Raspberry Pi Pico → `"wokwi-raspberry-pi-pico"`, id `"pico"`

## Common component types and their pins
- `wokwi-led`: A (anode +), C (cathode -)
- `wokwi-resistor`: 1, 2  (attrs: `{"value": "220"}`)
- `wokwi-pushbutton`: 1.l, 1.r, 2.l, 2.r  (attrs: `{"color": "green"}`)
- `wokwi-buzzer`: 1 (+), 2 (-)  (attrs: `{"volume": "0.1"}`)
- `board-ssd1306` (I2C OLED): SDA, SCL, VCC, GND
- `wokwi-potentiometer`: GND, VCC, SIG
- `wokwi-servo`: GND, V+, PWM
- `wokwi-dht22`: SDA, VCC, GND
- `wokwi-neopixel`: GND, VCC, DIN

## Board selection rule (CRITICAL)
- Default: `wokwi-arduino-uno` (id `"uno"`)
- User says **ESP32** → `wokwi-esp32-devkit-v1` (id `"esp32"`)
- User says **ESP32-C3** → `wokwi-esp32-c3-devkit` (id `"esp32"`)
- User says **ESP32-S3** → `wokwi-esp32-s3-devkit` (id `"esp32"`)
- User says **Pico** → `wokwi-raspberry-pi-pico` (id `"pico"`)
- User says **Mega** → `wokwi-arduino-mega` (id `"mega"`)
- NEVER use `wokwi-arduino-uno` for ESP32 projects

## Rules
- sketch.ino MUST have both setup() and loop()
- Add .h files only when they genuinely improve clarity
- Keep code complete and compilable — never truncate
- ESP32: Serial.begin(115200), use WiFi.h / esp_sleep.h as needed
- AVR: Serial.begin(9600)
- Always include a diagram with the correct board type
- CRITICAL JSON ESCAPING: all file `content` values are JSON strings — escape every double-quote as `\"`, every backslash as `\\`, every newline as `\n`, every tab as `\t`. Never embed raw newlines or unescaped quotes inside a JSON string value."""


class ChatMessage(BaseModel):
    role: str   # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]


class GeneratedFile(BaseModel):
    name: str
    content: str


class ChatResponse(BaseModel):
    explanation: str
    files: List[GeneratedFile]
    diagram: Optional[dict] = None
    raw: Optional[str] = None


def _repair_json(raw: str) -> str:
    """Best-effort repair of common JSON issues from LLM code output."""
    # Remove trailing commas before } or ]
    raw = re.sub(r",\s*([}\]])", r"\1", raw)
    return raw


def _parse_files(text: str) -> dict:
    """Extract the JSON block from the model response."""
    candidates: list[str] = []

    # Try ```json ... ``` block first
    match = re.search(r"```json\s*([\s\S]*?)```", text)
    if match:
        candidates.append(match.group(1))

    # Fall back to bare JSON object
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        candidates.append(match.group(0))

    if not candidates:
        raise ValueError("No JSON found in response")

    last_err: Exception = ValueError("No JSON found in response")
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as e:
            last_err = e
            # Try with repair
            try:
                return json.loads(_repair_json(candidate))
            except json.JSONDecodeError as e2:
                last_err = e2

    raise last_err


@router.post("/generate", response_model=ChatResponse)
async def generate_sketch(request: ChatRequest):
    if not settings.ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="ANTHROPIC_API_KEY is not configured. Set it in backend/.env or as an environment variable.",
        )

    try:
        import anthropic
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="anthropic package not installed. Run: pip install anthropic",
        )

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

    messages = [{"role": m.role, "content": m.content} for m in request.messages]

    try:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
    except anthropic.AuthenticationError:
        raise HTTPException(status_code=401, detail="Invalid ANTHROPIC_API_KEY.")
    except anthropic.APIError as e:
        logger.error("Anthropic API error: %s", e)
        raise HTTPException(status_code=502, detail=f"Anthropic API error: {e}")

    raw_text = response.content[0].text

    try:
        data = _parse_files(raw_text)
    except (ValueError, json.JSONDecodeError) as e:
        logger.error("Failed to parse model response: %s\nRaw: %s", e, raw_text)
        raise HTTPException(
            status_code=500,
            detail=f"Model returned unparseable output: {e}",
        )

    # files: exclude any stray diagram.json the model may have put there
    files = [
        GeneratedFile(name=f["name"], content=f["content"])
        for f in data.get("files", [])
        if f.get("name") != "diagram.json"
    ]
    return ChatResponse(
        explanation=data.get("explanation", ""),
        files=files,
        diagram=data.get("diagram"),
        raw=raw_text,
    )
