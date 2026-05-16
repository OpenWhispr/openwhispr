from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import Base, engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create all tables on startup (dev convenience — use Alembic for prod)
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title=settings.APP_TITLE,
    version=settings.APP_VERSION,
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── routers ──────────────────────────────────────────────────────────────────
from app.api.auth import router as auth_router
from app.api.v1.audit import router as audit_router
from app.api.v1.batches import router as batches_router
from app.api.v1.dashboard import router as dashboard_router
from app.api.v1.materials import router as materials_router
from app.api.v1.reports import router as reports_router
from app.api.v1.transactions import router as transactions_router
from app.api.v1.users import router as users_router

app.include_router(auth_router)
app.include_router(materials_router, prefix="/api/v1")
app.include_router(batches_router, prefix="/api/v1")
app.include_router(transactions_router, prefix="/api/v1")
app.include_router(dashboard_router, prefix="/api/v1")
app.include_router(reports_router, prefix="/api/v1")
app.include_router(audit_router, prefix="/api/v1")
app.include_router(users_router, prefix="/api/v1")


@app.get("/health")
def health():
    return {"status": "ok", "version": settings.APP_VERSION}
