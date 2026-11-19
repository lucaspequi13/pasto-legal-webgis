"""Tabelas iniciais: links, link_accesses, drafts.

"IF NOT EXISTS" para adotar bancos criados antes das migrações (versões de 19/11).

Revision ID: 0001
Revises:
Create Date: 2026-11-19
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
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
    """)


def downgrade() -> None:
    op.execute("""
    DROP TABLE webgis.drafts;
    DROP TABLE webgis.link_accesses;
    DROP TABLE webgis.links;
    """)
