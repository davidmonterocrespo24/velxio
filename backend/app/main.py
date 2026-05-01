import logging
import sys
import asyncio
from contextlib import asynccontextmanager

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s: %(message)s')

# On Windows, asyncio defaults to SelectorEventLoop which does NOT support
# create_subprocess_exec (raises NotImplementedError). Force ProactorEventLoop.
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api.routes import compile, compile_chip, libraries
from app.api.routes.admin import router as admin_router
from app.api.routes.auth import router as auth_router
from app.api.routes.metrics import router as metrics_router
from app.api.routes.projects import router as projects_router
from app.core.config import settings
from app.database.session import Base, async_engine

# Import models so SQLAlchemy registers them before create_all
import app.models.user  # noqa: F401
import app.models.project  # noqa: F401
import app.models.usage_event  # noqa: F401


logger = logging.getLogger(__name__)


def _asyncio_exception_handler(loop: asyncio.AbstractEventLoop, context: dict) -> None:
    """Prevent unhandled asyncio task exceptions from killing the uvicorn process.

    Normally uvicorn re-raises unhandled task exceptions at the event-loop level,
    which can crash the whole process. The main culprit is a race condition in
    websockets <12.0 (legacy/protocol.py AssertionError during keepalive ping).
    Upgrading websockets>=12.0 is the primary fix; this handler is a safety net.
    """
    exc = context.get("exception")
    msg = context.get("message", "")
    if exc is not None:
        logger.error("Unhandled asyncio task exception (swallowed): %s — %r", msg, exc)
    else:
        # No exception object — let default handler deal with it
        loop.default_exception_handler(context)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    asyncio.get_event_loop().set_exception_handler(_asyncio_exception_handler)
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Lightweight auto-migrations for legacy DBs. Each statement is wrapped
        # in try/except so re-runs after the column already exists are no-ops.
        legacy_migrations = [
            "ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0",
            # Phase: usage metrics
            "ALTER TABLE users ADD COLUMN total_compiles INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN total_compile_errors INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN total_runs INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN last_active_at DATETIME",
            "ALTER TABLE projects ADD COLUMN compile_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE projects ADD COLUMN compile_error_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE projects ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE projects ADD COLUMN update_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE projects ADD COLUMN last_compiled_at DATETIME",
            "ALTER TABLE projects ADD COLUMN last_run_at DATETIME",
            # Country tracking (CF-IPCountry)
            "ALTER TABLE users ADD COLUMN signup_country VARCHAR(2)",
            "ALTER TABLE users ADD COLUMN last_country VARCHAR(2)",
            "ALTER TABLE usage_events ADD COLUMN country VARCHAR(2)",
            # Multi-board persistence (replaces single board_type as the source of truth)
            "ALTER TABLE projects ADD COLUMN boards_json TEXT NOT NULL DEFAULT '[]'",
        ]
        for stmt in legacy_migrations:
            try:
                await conn.execute(text(stmt))
            except Exception:
                pass  # Column already exists
    yield


app = FastAPI(
    title="Arduino Emulator API",
    description="Compilation and project management API",
    version="1.0.0",
    lifespan=lifespan,
    # Moved from /docs to /api/docs so the frontend /docs/* documentation
    # routes are served by the React SPA without any nginx conflict.
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        settings.FRONTEND_URL,
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(compile.router, prefix="/api/compile", tags=["compilation"])
app.include_router(compile_chip.router, prefix="/api/compile-chip", tags=["custom-chips"])
app.include_router(libraries.router, prefix="/api/libraries", tags=["libraries"])
app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(projects_router, prefix="/api", tags=["projects"])
app.include_router(metrics_router, prefix="/api/metrics", tags=["metrics"])
app.include_router(admin_router, prefix="/api/admin", tags=["admin"])

# WebSockets
from app.api.routes import simulation
app.include_router(simulation.router, prefix="/api/simulation", tags=["simulation"])

# IoT Gateway — HTTP proxy for ESP32 web servers
from app.api.routes import iot_gateway
app.include_router(iot_gateway.router, prefix="/api/gateway", tags=["iot-gateway"])

@app.get("/")
def root():
    return {
        "message": "Arduino Emulator API",
        "version": "1.0.0",
        "docs": "/api/docs",
    }


@app.get("/health")
def health_check():
    return {"status": "healthy"}

