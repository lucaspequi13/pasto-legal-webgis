"""Acesso ao Postgres (schema próprio "webgis").

As geometrias ficam em JSON (GeoJSON) e as regras rodam em Python (shapely);
o PostGIS fica para quando o WebGIS virar dono dos piquetes (alternativa B).
As tabelas são criadas pelas migrações (migrations/, Alembic), não aqui.
"""

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

class Database:
    def __init__(self, url: str):
        self.pool = ConnectionPool(url, kwargs={"row_factory": dict_row}, open=False)

    def open(self) -> None:
        self.pool.open(wait=True)

    def close(self) -> None:
        self.pool.close()

    def connection(self):
        return self.pool.connection()
