"""Mock do Pasto Legal: faz os dois lados da conversa com o WebGIS (webgis/CONTRATO.md).

O WebGIS é uma aplicação separada. Enquanto o Pasto Legal não tem a integração,
este script faz o papel dele, com uma propriedade de referência:

  ENVIAR   link       cria o link de uma fazenda (POST /internal/links)
  RECEBER  rascunho   o que o chat leria no começo do turno (GET /internal/drafts)
           terminou   o produtor mandou mensagem no chat → conta como "Terminei"
           confirmar  o produtor respondeu "sim" no chat
           recusar    o produtor respondeu "não" no chat
           escutar    sobe a rota que recebe o aviso do "Terminei" (POST /internal/webgis-events)
  LGPD     apagar     apaga tudo do produtor no WebGIS

Exemplos (API em http://localhost:8100, chave "dev" do dev.py):
    python webgis/scripts/mock_pasto_legal.py link
    python webgis/scripts/mock_pasto_legal.py link --geojson outra_fazenda.geojson
    python webgis/scripts/mock_pasto_legal.py rascunho
    python webgis/scripts/mock_pasto_legal.py confirmar
    python webgis/scripts/mock_pasto_legal.py escutar        # deixe rodando num terminal
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from criar_link import snapshot_from_geojson  # noqa: E402

FAZENDA_REFERENCIA = Path(__file__).parents[1] / "frontend" / "public" / "fazenda-teste.geojson"
USUARIO_TESTE = "5562000000000"


def chamar(api: str, key: str, metodo: str, caminho: str, corpo: dict | None = None) -> dict:
    dados = json.dumps(corpo).encode() if corpo is not None else None
    req = urllib.request.Request(f"{api}{caminho}", data=dados, method=metodo,
                                 headers={"Content-Type": "application/json", "X-Internal-Key": key})
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"WebGIS respondeu {e.code}: {e.read().decode()}")
    except urllib.error.URLError as e:
        sys.exit(f"Não consegui falar com o WebGIS em {api} ({e.reason}). Ele está rodando?")


def mostrar_rascunho(d: dict | None) -> None:
    if not d:
        print("Nada para confirmar (o chat seguiria o turno normal).")
        return
    s = d["summary"]
    print(f"Rascunho #{d['id']} · fazenda {d['farm_id']} · status {d['status']}")
    print(f"O chat diria: \"Recebemos suas alterações no mapa: {s['texto']}. Confirma?\"")
    print(json.dumps({k: v for k, v in s.items() if k != "texto"}, ensure_ascii=False))


def escutar(porta: int, key: str) -> None:
    class Receptor(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            if self.path != "/internal/webgis-events":
                self.send_error(404)
                return
            if self.headers.get("X-Internal-Key") != key:
                self.send_error(401, "Chave interna inválida")
                return
            corpo = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            print("\n[aviso do WebGIS] o produtor apertou Terminei (ou 10 min sem editar)")
            print(f"  O Pasto Legal mandaria no WhatsApp: \"Recebi suas mudanças no mapa "
                  f"({corpo['summary']['texto']}). Posso salvar?\"")
            print(f"  draft_id={corpo['draft_id']} farm_id={corpo['farm_id']}")
            self.send_response(204)
            self.end_headers()

        def log_message(self, *args):
            pass

    print(f"Mock do Pasto Legal escutando em http://localhost:{porta}/internal/webgis-events (Ctrl+C sai)")
    HTTPServer(("127.0.0.1", porta), Receptor).serve_forever()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=["link", "rascunho", "terminou", "confirmar", "recusar", "escutar", "apagar"])
    ap.add_argument("--geojson", default=str(FAZENDA_REFERENCIA), help="fazenda de referência")
    ap.add_argument("--user", default=USUARIO_TESTE, help="user_id do chat (telefone de teste)")
    ap.add_argument("--api", default=os.environ.get("WEBGIS_API_URL", "http://localhost:8100"))
    ap.add_argument("--porta", type=int, default=8200, help="porta do 'escutar'")
    args = ap.parse_args()
    key = os.environ.get("WEBGIS_INTERNAL_KEY", "dev")

    if args.acao == "escutar":
        escutar(args.porta, key)
        return
    if args.acao == "link":
        out = chamar(args.api, key, "POST", "/internal/links",
                     {"user_id": args.user, "snapshot": snapshot_from_geojson(args.geojson)})
        print(out["url"])
        if out["replaced_previous"]:
            print("(o link anterior deste usuário parou de funcionar)")
        return
    if args.acao == "apagar":
        print(chamar(args.api, key, "DELETE", f"/internal/owners/{args.user}"))
        return

    d = chamar(args.api, key, "GET", f"/internal/drafts?user_id={args.user}")["draft"]
    if args.acao == "rascunho":
        mostrar_rascunho(d)
        return
    if not d:
        sys.exit("Nada para confirmar.")
    status = {"terminou": "enviado", "confirmar": "confirmado", "recusar": "recusado"}[args.acao]
    if status != "enviado" and d["status"] == "rascunho":
        # Como o chat faz: a mensagem do produtor já conta como "Terminei".
        chamar(args.api, key, "POST", f"/internal/drafts/{d['id']}/status?user_id={args.user}",
               {"status": "enviado"})
    r = chamar(args.api, key, "POST", f"/internal/drafts/{d['id']}/status?user_id={args.user}",
               {"status": status})
    print(f"Rascunho #{d['id']}: {r['status']}" + ("" if r["changed"] else " (já estava assim)"))
    if status == "confirmado":
        print("O Pasto Legal agora gravaria estes piquetes/alfinetes em all_properties:")
        print(json.dumps({"paddocks": [{k: p[k] for k in ("id", "number", "name")} for p in d["content"]["paddocks"]],
                          "pins": d["content"]["pins"]}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
