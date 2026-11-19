"""Ambiente do Alembic: só SQL à mão (sem ORM). A tabela de versões fica no schema "webgis"."""

from alembic import context
from sqlalchemy import create_engine, text

from app.migrate import sqlalchemy_url

url = context.config.attributes.get("url") or sqlalchemy_url()
engine = create_engine(url)

with engine.begin() as conn:
    conn.execute(text("CREATE SCHEMA IF NOT EXISTS webgis"))

with engine.connect() as conn:
    context.configure(connection=conn, version_table_schema="webgis")
    with context.begin_transaction():
        context.run_migrations()
