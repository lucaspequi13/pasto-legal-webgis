"""Configuração da API do WebGIS, lida do ambiente."""

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


@dataclass(frozen=True)
class Settings:
    # Postgres do time (schema próprio "webgis").
    database_url: str = field(
        default_factory=lambda: os.environ.get(
            "WEBGIS_DATABASE_URL", "postgresql://webgis:webgis@localhost:5433/webgis"
        )
    )
    # Chave compartilhada com o Pasto Legal para as rotas /internal/*.
    internal_key: str = field(default_factory=lambda: os.environ.get("WEBGIS_INTERNAL_KEY", ""))
    # Chave do HMAC que transforma o user_id (telefone) no dono guardado no banco.
    hmac_key: str = field(default_factory=lambda: os.environ.get("WEBGIS_HMAC_KEY", ""))
    # Endereço público do front; o link vai como {public_url}/#t={token}.
    public_url: str = field(
        default_factory=lambda: os.environ.get("WEBGIS_PUBLIC_URL", "http://localhost:4200")
    )
    # Rota do Pasto Legal que manda o aviso no WhatsApp (vazio = sem aviso, não proativo).
    events_url: str = field(default_factory=lambda: os.environ.get("PASTO_LEGAL_EVENTS_URL", ""))
    cors_origins: tuple = field(
        default_factory=lambda: tuple(
            o.strip()
            for o in os.environ.get("WEBGIS_CORS_ORIGINS", "http://localhost:4200").split(",")
            if o.strip()
        )
    )
    link_open_minutes: int = field(default_factory=lambda: _int("WEBGIS_LINK_OPEN_MINUTES", 5))
    idle_finish_minutes: int = field(default_factory=lambda: _int("WEBGIS_IDLE_FINISH_MINUTES", 10))
    retention_days: int = field(default_factory=lambda: _int("WEBGIS_RETENTION_DAYS", 30))
    max_paddocks: int = field(default_factory=lambda: _int("WEBGIS_MAX_PADDOCKS", 200))

    def check(self) -> None:
        missing = [n for n, v in (("WEBGIS_INTERNAL_KEY", self.internal_key),
                                  ("WEBGIS_HMAC_KEY", self.hmac_key)) if not v]
        if missing:
            raise RuntimeError(f"Variáveis obrigatórias ausentes: {', '.join(missing)}")
