"""Sobe a API em modo desenvolvimento, com um Postgres embutido (sem Docker).

    cd webgis/api
    uv run --group dev python dev.py

Também atende na rede local (Wi-Fi), para testar o mapa no celular: os links
saem com o IP do Mac (http://192.168.x.x:4200/#t=...).

Chaves de teste: WEBGIS_INTERNAL_KEY=dev (use a mesma no criar_link.py).
Os dados ficam em webgis/api/.devdb (ignorado pelo git).
"""

import os
import socket
from pathlib import Path

import pgserver
import uvicorn

data = Path(__file__).parent / ".devdb"
server = pgserver.get_server(data, cleanup_mode="stop")
os.environ.setdefault("WEBGIS_DATABASE_URL", server.get_uri())
os.environ.setdefault("WEBGIS_INTERNAL_KEY", "dev")
os.environ.setdefault("WEBGIS_HMAC_KEY", "dev-hmac")


def ip_local() -> str:
    """IP do Mac na rede Wi-Fi (o celular abre o mapa por ele)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.168.0.1", 80))  # não envia nada; só descobre a interface
            return s.getsockname()[0]
    except OSError:
        return "localhost"


ip = ip_local()
os.environ.setdefault("WEBGIS_PUBLIC_URL", f"http://{ip}:4200")
# Aviso do "Terminei" vai para o mock do Pasto Legal (webgis/scripts/mock_pasto_legal.py escutar).
os.environ.setdefault("PASTO_LEGAL_EVENTS_URL", "http://localhost:8200/internal/webgis-events")
os.environ.setdefault(
    "WEBGIS_CORS_ORIGIN_REGEX",
    r"http://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.\d+\.\d+\.\d+):4200",
)

from app.main import get_app  # noqa: E402  (depois das variáveis)
from app.migrate import upgrade  # noqa: E402

upgrade()  # cria/atualiza as tabelas (migrações)

print(f"API em http://{ip}:8100 · chave interna: dev · links abrem em {os.environ['WEBGIS_PUBLIC_URL']}")
uvicorn.run(get_app(), host="0.0.0.0", port=8100)
