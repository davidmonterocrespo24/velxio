"""WebSocket bridge for one isolated Arduino or MicroPython editor session."""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.config import settings
from app.services.espidf_language_server import ESP_IDF_FQBN, espidf_database
from app.services.language_server import (
    ARDUINO_BOARDS, MAX_SOURCE_BYTES, MICROPYTHON_BOARDS, LanguageServer, Workspace,
    full_edit, stub_path, tools_for,
)

router = APIRouter()
logger = logging.getLogger(__name__)
_slots = asyncio.Semaphore(4)
_methods = {
    "completion", "hover", "signatureHelp", "definition",
}


@router.get("/capabilities")
def capabilities():
    return {
        "arduino": sorted(ARDUINO_BOARDS) if tools_for("arduino") else [],
        "micropython": [board for board in MICROPYTHON_BOARDS if stub_path(board)]
        if tools_for("micropython") else [],
        "espidf": [ESP_IDF_FQBN] if tools_for("espidf") and espidf_database() else [],
    }


def _origin_allowed(socket: WebSocket) -> bool:
    origin = socket.headers.get("origin")
    if not origin or origin in {
        settings.FRONTEND_URL, "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost",
    }:
        return True
    address = urlsplit(origin)
    return address.scheme in {"http", "https"} and (
        address.netloc == socket.headers.get("host") or address.hostname in {"localhost", "127.0.0.1", "::1"}
    )


async def _receive(socket: WebSocket, timeout: int):
    text = await asyncio.wait_for(socket.receive_text(), timeout)
    if len(text.encode("utf-8")) > MAX_SOURCE_BYTES * 3:
        raise ValueError("Language server message is too large")
    message = json.loads(text)
    if not isinstance(message, dict):
        raise ValueError("Invalid language server message")
    return message


async def _reply_to_server(server: LanguageServer, message: dict):
    if "id" not in message:
        return
    method = message["method"]
    if method == "workspace/configuration":
        await server.send(id=message["id"], result=[{} for _ in message.get("params", {}).get("items", [])])
    elif method in {"window/workDoneProgress/create", "client/registerCapability"}:
        await server.send(id=message["id"], result=None)
    else:
        await server.send(id=message["id"], error={"code": -32601, "message": "Unsupported request"})


async def _initialize(server: LanguageServer, workspace: Workspace) -> int:
    root_uri = workspace.root.as_uri()
    await server.send(method="initialize", id=0, params={
        "processId": None,
        "rootUri": root_uri,
        "rootPath": str(workspace.root),
        "workspaceFolders": [{"uri": root_uri, "name": workspace.root.name}],
        "capabilities": {
            "general": {"positionEncodings": ["utf-16"]},
            "textDocument": {
                "publishDiagnostics": {"versionSupport": True},
                "completion": {"completionItem": {"snippetSupport": True, "documentationFormat": ["markdown", "plaintext"]}},
                "signatureHelp": {"signatureInformation": {"parameterInformation": {"labelOffsetSupport": True}}},
                "definition": {"linkSupport": True},
            },
        },
    })
    while True:
        message = await server.read()
        if "method" in message:
            await _reply_to_server(server, message)
        elif message.get("id") == 0:
            if "error" in message:
                raise ValueError("Language server initialization failed")
            sync = message.get("result", {}).get("capabilities", {}).get("textDocumentSync", 1)
            break
    await server.send(method="initialized", params={})
    for document in workspace.documents.values():
        await server.send(method="textDocument/didOpen", params={"textDocument": {
            "uri": document.path.as_uri(), "version": document.version, "text": document.text,
            "languageId": "python" if document.path.suffix in {".py", ".pyi"}
            else "c" if document.path.suffix == ".c" else "cpp",
        }})
    return sync.get("change", 1) if isinstance(sync, dict) else sync


def _position(value) -> dict | None:
    if (
        isinstance(value, dict) and type(value.get("line")) is int
        and type(value.get("character")) is int
        and value["line"] >= 0 and value["character"] >= 0
    ):
        return {"line": value["line"], "character": value["character"]}
    return None


async def _bridge(socket: WebSocket, server: LanguageServer, workspace: Workspace, changes: int):
    pending: dict[int, str] = {}
    # Serialize frames from the browser reader and the language-server reader.
    socket_lock = asyncio.Lock()
    server_lock = asyncio.Lock()

    async def send_to_editor(message):
        async with socket_lock:
            await socket.send_json(message)

    async def from_editor():
        while True:
            message = await _receive(socket, 600)
            name, kind = message.get("name"), message.get("type")
            if kind == "cancel":
                request_id = message.get("id")
                if type(request_id) is int and pending.pop(request_id, None):
                    async with server_lock:
                        await server.send(method="$/cancelRequest", params={"id": request_id})
                continue
            if not isinstance(name, str) or name not in workspace.documents:
                continue
            document = workspace.documents[name]
            text_document = {"uri": document.path.as_uri()}
            if kind == "change":
                content, version = message.get("text"), message.get("version")
                if not isinstance(content, str) or type(version) is not int or version <= document.version:
                    continue
                size = sum(len(d.text.encode("utf-8")) for key, d in workspace.documents.items() if key != name)
                if size + len(content.encode("utf-8")) > MAX_SOURCE_BYTES or "\x00" in content:
                    raise ValueError("Workspace source is too large or invalid")
                edit = full_edit(document.text, content) if changes == 2 else {"text": content}
                # Headers must reach the compiler's filesystem even when
                # another tab requests completion. Arduino LS overlays .ino
                # drafts itself when rebuilding its generated translation unit.
                if workspace.engine != "arduino" or document.path.suffix != ".ino":
                    await asyncio.to_thread(document.path.write_text, content, encoding="utf-8", newline="")
                document.version = version
                document.text = content
                async with server_lock:
                    await server.send(method="textDocument/didChange", params={
                        "textDocument": {**text_document, "version": version}, "contentChanges": [edit],
                    })
                continue
            method, request_id = message.get("method"), message.get("id")
            position = _position(message.get("position"))
            if kind != "request" or not isinstance(method, str) or method not in _methods or not position:
                continue
            if type(request_id) is not int or not 0 < request_id < 2**31 or request_id in pending:
                continue
            if len(pending) >= 64:
                await send_to_editor({"type": "result", "id": request_id, "result": None})
                continue
            pending[request_id] = method
            params = {"textDocument": text_document, "position": position}
            context = message.get("context")
            if method == "completion" and isinstance(context, dict):
                trigger = context.get("triggerKind")
                if type(trigger) is int and trigger in {1, 2, 3}:
                    params["context"] = {"triggerKind": trigger}
                    character = context.get("triggerCharacter")
                    if isinstance(character, str) and len(character) == 1:
                        params["context"]["triggerCharacter"] = character
            async with server_lock:
                await server.send(method=f"textDocument/{method}", id=request_id, params=params)

    async def from_server():
        while True:
            message = await server.read()
            method = message.get("method")
            if method == "textDocument/publishDiagnostics":
                params = message.get("params", {})
                name = workspace.name_for(params.get("uri", ""))
                if name is not None:
                    await send_to_editor({
                        "type": "diagnostics", "name": name, "version": params.get("version"),
                        "items": [
                            {key: item[key] for key in ("message", "range", "severity") if key in item}
                            for item in params.get("diagnostics", [])[:200]
                        ],
                    })
            elif method:
                async with server_lock:
                    await _reply_to_server(server, message)
            elif (request_id := message.get("id")) in pending:
                result = message.get("result")
                if pending.pop(request_id) == "definition" and result:
                    locations = result if isinstance(result, list) else [result]
                    mapped = await asyncio.to_thread(
                        lambda: [workspace.definition(location) for location in locations[:8]],
                    )
                    result = [location for location in mapped if location]
                await send_to_editor({"type": "result", "id": request_id, "result": result})

    tasks = [asyncio.create_task(from_editor()), asyncio.create_task(from_server())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@router.websocket("/ws")
async def semantic_session(socket: WebSocket):
    if not _origin_allowed(socket) or _slots.locked():
        await socket.close(code=1008)
        return
    async with _slots:
        await socket.accept()
        folder = Path(tempfile.mkdtemp(prefix="velxio-lsp-"))
        workspace = server = None
        try:
            context = await _receive(socket, 10)
            workspace = await asyncio.to_thread(Workspace, folder, context)
            server = LanguageServer(workspace)
            changes = await asyncio.wait_for(_initialize(server, workspace), 90)
            await socket.send_json({"type": "ready"})
            await _bridge(socket, server, workspace, changes)
        except WebSocketDisconnect:
            return
        except (OSError, EOFError, asyncio.TimeoutError, ValueError, subprocess.SubprocessError) as exc:
            logger.info("Editor language server unavailable: %s", exc)
            await socket.close(code=1011)
        finally:
            try:
                if server:
                    await server.close()
            finally:
                if workspace and workspace.scope_root:
                    await asyncio.to_thread(shutil.rmtree, workspace.scope_root, ignore_errors=True)
                # Windows can briefly retain a directory handle after the
                # compiler process exits.
                for delay in (0, 0.1, 0.3, 0.8):
                    if delay:
                        await asyncio.sleep(delay)
                    await asyncio.to_thread(shutil.rmtree, folder, ignore_errors=True)
                    if not folder.exists():
                        break
