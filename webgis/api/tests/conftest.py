"""Testes com um Postgres de verdade, embutido (pgserver): sem Docker."""

import shutil
import tempfile

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

KEY = "chave-interna-teste"


@pytest.fixture(scope="session")
def database_url():
    pgserver = pytest.importorskip("pgserver")
    folder = tempfile.mkdtemp(prefix="webgis-pg-")
    server = pgserver.get_server(folder, cleanup_mode="stop")
    yield server.get_uri()
    server.cleanup()
    shutil.rmtree(folder, ignore_errors=True)


@pytest.fixture
def client(database_url):
    settings = Settings(
        database_url=database_url,
        internal_key=KEY,
        hmac_key="segredo-hmac-teste",
        public_url="http://mapa.test",
        events_url="",
    )
    app = create_app(settings)
    with TestClient(app) as c:
        with app.state.db.connection() as conn:
            conn.execute("TRUNCATE webgis.links CASCADE")
        c.app_state = app.state
        yield c


# Fazenda de ~1,2 km x 1,1 km perto de Goiânia.
FENCE = {"type": "MultiPolygon", "coordinates": [[[
    [-49.30, -16.70], [-49.29, -16.70], [-49.29, -16.69], [-49.30, -16.69], [-49.30, -16.70]
]]]}


def square(x0, y0, x1, y1):
    return {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


@pytest.fixture
def snapshot():
    return {
        "farm": {"id": "farm1", "name": "Boa Vista", "geometry": FENCE},
        "paddocks": [
            {"id": "farm1_paddock_1", "number": 1, "name": None,
             "geometry": square(-49.300, -16.700, -49.295, -16.695)},
        ],
        "pins": [],
    }
