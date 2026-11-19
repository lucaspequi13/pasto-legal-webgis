"""Acesso ao Postgres (schema próprio "webgis").

As geometrias ficam em JSON (GeoJSON) e as regras rodam em Python (shapely);
o PostGIS fica para quando o WebGIS virar dono dos piquetes (alternativa B).
"""

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

SCHEMA = """
CREATE SCHEMA IF NOT EXISTS webgis;

CREATE TABLE IF NOT EXISTS webgis.links (
    id          BIGSERIAL PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    owner       TEXT NOT NULL,              -- HMAC do user_id, nunca o telefone
    farm_id     TEXT NOT NULL,
    snapshot    JSONB NOT NULL,             -- fazenda + piquetes + alfinetes do chat
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,       -- prazo para abrir (5 min)
    opened_at   TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ                 -- link novo derruba este
);
CREATE INDEX IF NOT EXISTS links_owner_idx ON webgis.links (owner);

CREATE TABLE IF NOT EXISTS webgis.link_accesses (
    id          BIGSERIAL PRIMARY KEY,
    link_id     BIGINT NOT NULL REFERENCES webgis.links(id) ON DELETE CASCADE,
    accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()   -- só data e hora, sem IP
);

CREATE TABLE IF NOT EXISTS webgis.drafts (
    id          BIGSERIAL PRIMARY KEY,
    link_id     BIGINT NOT NULL UNIQUE REFERENCES webgis.links(id) ON DELETE CASCADE,
    owner       TEXT NOT NULL,
    farm_id     TEXT NOT NULL,
    content     JSONB NOT NULL,             -- piquetes + alfinetes editados
    version     INTEGER NOT NULL DEFAULT 0, -- cada salvamento soma 1
    edited      BOOLEAN NOT NULL DEFAULT FALSE,
    -- rascunho -> enviado -> confirmado | recusado ; descartado (link novo)
    status      TEXT NOT NULL DEFAULT 'rascunho',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS drafts_owner_idx ON webgis.drafts (owner, status);
"""


class Database:
    def __init__(self, url: str):
        self.pool = ConnectionPool(url, kwargs={"row_factory": dict_row}, open=False)

    def open(self) -> None:
        self.pool.open(wait=True)
        with self.pool.connection() as conn:
            conn.execute(SCHEMA)

    def close(self) -> None:
        self.pool.close()

    def connection(self):
        return self.pool.connection()
