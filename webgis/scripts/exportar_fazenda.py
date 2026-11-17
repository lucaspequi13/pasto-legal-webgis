"""Exporta uma fazenda cadastrada no Pasto Legal (dev, SQLite) para GeoJSON, para testar o WebGIS.

Só LÊ o banco (abre em modo read-only). Não altera nada no Pasto Legal.

Uso:
    python exportar_fazenda.py CAMINHO/agno.db                    # lista as sessões com fazenda
    python exportar_fazenda.py CAMINHO/agno.db 0 saida.geojson    # exporta a sessão [0]
"""
import json
import sqlite3
import sys
from pathlib import Path

if len(sys.argv) < 2:
    sys.exit(__doc__)

db = Path(sys.argv[1]).resolve()
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = conn.execute(
    "SELECT session_id, session_state, updated_at FROM workflow_sessions ORDER BY updated_at DESC"
).fetchall()
conn.close()

sessoes = []
for session_id, state, updated_at in rows:
    state = json.loads(state) if isinstance(state, str) else (state or {})
    features = ((state.get("all_properties") or {}).get("features")) or []
    if features:
        sessoes.append((session_id, updated_at, features))

if not sessoes:
    sys.exit("Nenhuma sessão com fazenda cadastrada. Cadastre uma pelo chat (CAR) e rode de novo.")

if len(sys.argv) < 3:
    for i, (_, quando, feats) in enumerate(sessoes):
        tipos = ", ".join(f"{f['feature_type']}:{f.get('feature_id')} ({f.get('total_area')} ha)" for f in feats)
        print(f"[{i}] {quando}  {len(feats)} feições -> {tipos}")
    sys.exit(0)

_, _, feats = sessoes[int(sys.argv[2])]
colecao = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "geometry": {"type": "MultiPolygon", "coordinates": f["coords"]},
            "properties": {
                "feature_id": f.get("feature_id"),
                "feature_type": f["feature_type"],
                "total_area": f.get("total_area"),
                "region": f.get("region"),
            },
        }
        for f in feats
    ],
}
saida = Path(sys.argv[3] if len(sys.argv) > 3 else "fazenda-teste.geojson")
saida.write_text(json.dumps(colecao, ensure_ascii=False))
print(f"OK: {len(feats)} feições salvas em {saida}")
