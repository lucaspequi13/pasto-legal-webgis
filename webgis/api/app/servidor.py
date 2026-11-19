"""Imagem única: o mapa pronto em / e a API em /api — um container só, no padrão do caretaker do LAPIG.

Rodar: `uvicorn app.servidor:get_app --factory` (a pasta do mapa vem de WEBGIS_STATIC_DIR).
"""

import contextlib
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import Settings
from app.main import create_app


def static_dir() -> Path:
    return Path(os.environ.get("WEBGIS_STATIC_DIR", "/app/static"))


def create_server(settings: Settings | None = None, mapa: Path | None = None) -> FastAPI:
    api = create_app(settings)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        # O Starlette não roda o lifespan de um app montado: liga o banco e a limpeza da API por aqui.
        async with api.router.lifespan_context(api):
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.mount("/api", api)
    app.mount("/", StaticFiles(directory=mapa or static_dir(), html=True), name="mapa")
    return app


def get_app() -> FastAPI:
    return create_server()
