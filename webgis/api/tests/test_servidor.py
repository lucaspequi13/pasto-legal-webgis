"""Imagem única: o mapa em / e a API em /api, com banco e limite de pedidos funcionando."""

from fastapi.testclient import TestClient

from app.config import Settings
from app.servidor import create_server

from .conftest import KEY


def test_imagem_unica_serve_mapa_e_api(database_url, tmp_path, snapshot):
    (tmp_path / "index.html").write_text("<h1>mapa</h1>")
    settings = Settings(
        database_url=database_url, internal_key=KEY, hmac_key="segredo-hmac-teste",
        public_url="http://mapa.test", events_url="", rate_limit_failures_per_minute=2,
    )
    with TestClient(create_server(settings, mapa=tmp_path)) as c:
        assert "mapa" in c.get("/").text                      # o mapa
        assert c.get("/api/health").json() == {"ok": True}    # a API, com o banco ligado

        r = c.post("/api/internal/links", headers={"X-Internal-Key": KEY},
                   json={"user_id": "5562999990000", "snapshot": snapshot})
        assert r.status_code == 200, r.text
        token = r.json()["url"].split("#t=")[1]
        assert c.get(f"/api/links/{token}").status_code == 200

        # O limite de pedidos continua valendo debaixo de /api.
        codes = [c.get("/api/links/token-que-nao-existe").status_code for _ in range(3)]
        assert codes[-1] == 429
