"""Simula o chat: cria um link do WebGIS a partir de um GeoJSON de fazenda.

Enquanto a tool `generate_webgis_link` do Pasto Legal não existe, este script
faz o papel do chat: monta o snapshot (fazenda + piquetes + alfinetes) e chama
POST /internal/links. Imprime o link para abrir no navegador.

Uso (com a API rodando em http://localhost:8100):
    python webgis/scripts/criar_link.py webgis/frontend/public/fazenda-teste.geojson
    python webgis/scripts/criar_link.py ARQUIVO.geojson --user 5562999990000 --api http://localhost:8100
A chave vem de WEBGIS_INTERNAL_KEY (a mesma do .env da API).
"""

import argparse
import json
import os
import re
import sys
import urllib.request

PADDOCK_NUM = re.compile(r"_?(\d+)$")


def snapshot_from_geojson(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        fc = json.load(fh)
    farm, paddocks, pins = None, [], []
    for i, f in enumerate(fc["features"]):
        props = f.get("properties") or {}
        kind = props.get("feature_type")
        if kind == "rural_property" and farm is None:
            farm = {"id": props.get("feature_id") or "fazenda-teste",
                    "name": props.get("name"), "geometry": f["geometry"]}
        elif kind == "paddock":
            fid = props.get("feature_id") or f"paddock-{i}"
            m = PADDOCK_NUM.search(fid)
            paddocks.append({"id": fid, "number": int(m.group(1)) if m else len(paddocks) + 1,
                             "name": None, "geometry": f["geometry"]})
        elif kind == "pin":
            lon, lat = f["geometry"]["coordinates"][:2]
            pins.append({"id": props.get("feature_id") or f"pin-{i}", "kind": props.get("pin_type", "bebedouro"),
                         "name": props.get("name"), "lon": lon, "lat": lat})
    if farm is None:
        sys.exit("O GeoJSON não tem uma feição com feature_type = rural_property.")
    return {"farm": farm, "paddocks": paddocks, "pins": pins}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("geojson")
    ap.add_argument("--user", default="5562000000000", help="user_id do chat (telefone de teste)")
    ap.add_argument("--api", default=os.environ.get("WEBGIS_API_URL", "http://localhost:8100"))
    args = ap.parse_args()
    key = os.environ.get("WEBGIS_INTERNAL_KEY")
    if not key:
        sys.exit("Defina WEBGIS_INTERNAL_KEY (a mesma do .env da API).")
    body = json.dumps({"user_id": args.user, "snapshot": snapshot_from_geojson(args.geojson)}).encode()
    req = urllib.request.Request(f"{args.api}/internal/links", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-Internal-Key": key})
    try:
        with urllib.request.urlopen(req) as resp:
            out = json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"Erro {e.code}: {e.read().decode()}")
    except urllib.error.URLError as e:
        sys.exit(f"Não consegui falar com a API em {args.api} ({e.reason}). Ela está rodando?")
    print(out["url"])
    print(f"(abra em até 5 min; vale até {out['expires_at']} para a primeira abertura)")


if __name__ == "__main__":
    main()
