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

SYSTEM_PROMPT = """You are an expert Arduino programmer. Convert natural language descriptions into Arduino sketch files.

You MUST respond with a JSON block in this exact format:
```json
{
  "explanation": "Brief description of what the code does",
  "files": [
    {"name": "sketch.ino", "content": "// full .ino content"},
    {"name": "constants.h", "content": "// optional header"}
  ]
}
```

Rules:
- sketch.ino MUST contain both setup() and loop() functions
- Add .h files for constants, structs, or reusable helpers when it improves clarity
- Target Arduino Uno (ATmega328P) by default unless the user specifies a different board
- Use only standard Arduino built-in libraries unless the user explicitly requests others
- Write clean, well-commented code
- Always include Serial.begin(9600) in setup() when the sketch produces output
- Never include markdown outside the JSON block — only the ```json block"""


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
    raw: Optional[str] = None


def _parse_files(text: str) -> dict:
    """Extract the JSON block from the model response."""
    # Try ```json ... ``` block first
    match = re.search(r"```json\s*([\s\S]*?)```", text)
    if match:
        return json.loads(match.group(1))
    # Fall back to bare JSON object
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        return json.loads(match.group(0))
    raise ValueError("No JSON found in response")


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
            max_tokens=4096,
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

    files = [GeneratedFile(name=f["name"], content=f["content"]) for f in data.get("files", [])]
    return ChatResponse(
        explanation=data.get("explanation", ""),
        files=files,
        raw=raw_text,
    )
