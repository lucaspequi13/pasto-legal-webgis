"""Aplica as migrações (Alembic) do banco do WebGIS.

Produção: o container roda `alembic upgrade head` antes de subir a API.
Desenvolvimento e testes: `dev.py` e o conftest chamam `upgrade()`.
"""

import os
from pathlib import Path

from alembic import command
from alembic.config import Config

HERE = Path(__file__).resolve().parents[1]


def sqlalchemy_url(url: str | None = None) -> str:
    url = url or os.environ.get("WEBGIS_DATABASE_URL", "postgresql://webgis:webgis@localhost:5433/webgis")
    # Usa o driver psycopg 3 (o mesmo da API), não o psycopg2.
    return url.replace("postgresql://", "postgresql+psycopg://", 1) if url.startswith("postgresql://") else url


def upgrade(url: str | None = None) -> None:
    cfg = Config(str(HERE / "alembic.ini"))
    cfg.attributes["url"] = sqlalchemy_url(url)
    command.upgrade(cfg, "head")
