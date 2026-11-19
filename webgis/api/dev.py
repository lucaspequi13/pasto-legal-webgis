"""Sobe a API em modo desenvolvimento, com um Postgres embutido (sem Docker).

    cd webgis/api
    uv run --group dev python dev.py

Chaves de teste: WEBGIS_INTERNAL_KEY=dev (use a mesma no criar_link.py).
Os dados ficam em webgis/api/.devdb (ignorado pelo git).
"""

import os
from pathlib import Path

import pgserver
import uvicorn

data = Path(__file__).parent / ".devdb"
server = pgserver.get_server(data, cleanup_mode="stop")
os.environ.setdefault("WEBGIS_DATABASE_URL", server.get_uri())
os.environ.setdefault("WEBGIS_INTERNAL_KEY", "dev")
os.environ.setdefault("WEBGIS_HMAC_KEY", "dev-hmac")
os.environ.setdefault("WEBGIS_PUBLIC_URL", "http://localhost:4200")

from app.main import get_app  # noqa: E402  (depois das variáveis)

print("API em http://localhost:8100 · chave interna: dev")
uvicorn.run(get_app(), host="127.0.0.1", port=8100)
