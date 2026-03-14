.0from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api.routes import compile, libraries
from app.api.routes.admin import router as admin_router
from app.api.routes.auth import router as auth_router
from app.api.routes.projects import router as projects_router
from app.core.config import settings
from app.database.session import Base, async_engine

# Import models so SQLAlchemy registers them before create_all
import app.models.user  # noqa: F401
import app.models.project  # noqa: F401


@asynccontextmanager
async def lifespan(_app: FastAPI):
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Add is_admin column to existing databases that predate this feature
        try:
            await conn.execute(text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0"))
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
app.include_router(libraries.router, prefix="/api/libraries", tags=["libraries"])
app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(projects_router, prefix="/api", tags=["projects"])
app.include_router(admin_router, prefix="/api/admin", tags=["admin"])

# WebSockets
from app.api.routes import simulation
app.include_router(simulation.router, prefix="/api/simulation", tags=["simulation"])

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
