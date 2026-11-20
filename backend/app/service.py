from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.database import DatabaseConfig, connect


def create_service(
    title: str,
    prefix: str,
    config: DatabaseConfig | None = None,
    startup: Callable[[DatabaseConfig], None] | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        app.state.database = config or DatabaseConfig.from_env()
        if startup is not None:
            startup(app.state.database)
        yield

    app = FastAPI(
        title=title, version="2.0.0", lifespan=lifespan,
        docs_url=f"{prefix}/docs", redoc_url=None,
        openapi_url=f"{prefix}/openapi.json",
    )

    @app.middleware("http")
    async def headers_and_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.method not in {"GET", "HEAD", "OPTIONS"} and origin:
            source = urlsplit(origin)
            if source.scheme not in {"http", "https"} or source.netloc.lower() != request.headers.get("host", "").lower():
                return JSONResponse(status_code=403, content={"detail": "Cross-origin changes are not allowed."})
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get(f"{prefix}/health")
    def health() -> dict[str, str]:
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
        return {"status": "ok"}

    return app

