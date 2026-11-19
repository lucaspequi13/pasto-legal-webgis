"""API do WebGIS do Pasto Legal (#171).

Rotas públicas (/links/*) são usadas pelo mapa com o token do link.
Rotas /internal/* são usadas pelo Pasto Legal, com o header X-Internal-Key.

Fluxo (alternativa C, proativo leve):
  chat cria o link com o snapshot → mapa abre e salva sozinho → "Terminei",
  10 min sem editar ou mensagem no chat → status "enviado" (uma vez só) →
  o chat lê o rascunho e pergunta "confirma?".
"""

import asyncio
import contextlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .config import Settings
from .db import Database
from .ratelimit import RateLimiter
from .rules import RuleError, check_draft, summarize
from .security import new_token, owner_of, same_key, token_hash

log = logging.getLogger("webgis")

# Mensagens que vão para a tela do mapa (pt-BR).
MSG_EXPIRED = "Tempo expirado. Peça um novo link no WhatsApp."
MSG_REPLACED = "Este link foi substituído por um mais novo. Use o último link do WhatsApp."
MSG_NOT_FOUND = "Link inválido. Peça um novo link no WhatsApp."
MSG_READ_ONLY = "Você já enviou as alterações. Peça um novo link no WhatsApp para continuar."
MSG_STALE = "Este mapa foi alterado em outro lugar. Recarregue a página."
MSG_TOO_MANY = "Muitas tentativas. Espere um minuto e tente de novo."


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------- modelos ----------

class Geometry(BaseModel):
    type: str
    coordinates: list


class FarmIn(BaseModel):
    id: str
    name: Optional[str] = None
    geometry: Geometry


class PaddockIn(BaseModel):
    id: Optional[str] = None          # None = piquete novo
    number: int = Field(ge=1)
    name: Optional[str] = None        # nome próprio (sem nome = "Piquete n")
    geometry: Geometry


class PinIn(BaseModel):
    id: Optional[str] = None
    kind: Literal["bebedouro", "outro"]
    name: Optional[str] = None
    lon: float
    lat: float


class Snapshot(BaseModel):
    farm: FarmIn
    paddocks: list[PaddockIn] = []
    pins: list[PinIn] = []


class LinkCreate(BaseModel):
    user_id: str
    snapshot: Snapshot


class DraftSave(BaseModel):
    version: int
    paddocks: list[PaddockIn] = []
    pins: list[PinIn] = []


class StatusChange(BaseModel):
    status: Literal["enviado", "confirmado", "recusado"]


# ---------- app ----------

def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    settings.check()
    db = Database(settings.database_url)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        db.open()
        task = asyncio.create_task(_housekeeping_loop())
        yield
        task.cancel()
        db.close()

    app = FastAPI(title="WebGIS Pasto Legal", lifespan=lifespan)
    app.state.db = db
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_origin_regex=settings.cors_origin_regex or None,
        allow_methods=["GET", "PUT", "POST"],
        allow_headers=["Content-Type"],
    )

    limiter = RateLimiter(settings.rate_limit_per_minute, settings.rate_limit_failures_per_minute)
    app.state.limiter = limiter

    @app.middleware("http")
    async def rate_limit(request: Request, call_next):
        """Limite por IP só nas rotas do mapa (/links/*); /internal/* usa a chave."""
        # Na imagem única a API fica em /api: compara o caminho sem esse prefixo.
        path = request.url.path.removeprefix(request.scope.get("root_path", ""))
        if not path.startswith("/links/") or request.method == "OPTIONS":
            return await call_next(request)
        key = request.client.host if request.client else "?"
        if not limiter.allow(key):
            return JSONResponse({"detail": MSG_TOO_MANY}, status_code=429)
        response = await call_next(request)
        if response.status_code in (404, 410):
            limiter.failed(key)
        return response

    @app.middleware("http")
    async def referrer_policy(request, call_next):
        response = await call_next(request)
        response.headers["Referrer-Policy"] = "strict-origin"
        return response

    def internal(x_internal_key: str | None = Header(default=None)) -> None:
        if not same_key(x_internal_key, settings.internal_key):
            raise HTTPException(status_code=401, detail="Chave interna inválida.")

    def owner(user_id: str) -> str:
        return owner_of(user_id, settings.hmac_key)

    # ----- tarefas de fundo -----

    def finish_idle() -> list[dict]:
        """10 min sem editar → enviado (só rascunhos que tiveram edição)."""
        limit = _now() - timedelta(minutes=settings.idle_finish_minutes)
        with db.connection() as conn:
            return conn.execute(
                """UPDATE webgis.drafts SET status = 'enviado', finished_at = now()
                   WHERE status = 'rascunho' AND edited AND updated_at < %s
                   RETURNING id, owner, link_id""",
                (limit,),
            ).fetchall()

    def cleanup() -> None:
        limit = _now() - timedelta(days=settings.retention_days)
        with db.connection() as conn:
            conn.execute("DELETE FROM webgis.links WHERE created_at < %s", (limit,))

    async def _housekeeping_loop():
        while True:
            try:
                for row in await asyncio.to_thread(finish_idle):
                    await _notify(row["id"])
                await asyncio.to_thread(cleanup)
                limiter.cleanup()
            except Exception as e:  # noqa: BLE001 - o loop não pode morrer
                log.warning("housekeeping falhou: %s", e)
            await asyncio.sleep(60)

    async def _notify(draft_id: int) -> None:
        """Pede ao Pasto Legal o aviso no WhatsApp (proativo leve). Sem URL, não faz nada."""
        if not settings.events_url:
            return
        with db.connection() as conn:
            row = conn.execute(
                """SELECT d.id, d.owner, d.farm_id, d.content, l.snapshot
                   FROM webgis.drafts d JOIN webgis.links l ON l.id = d.link_id WHERE d.id = %s""",
                (draft_id,),
            ).fetchone()
        if not row:
            return
        summary = summarize(row["snapshot"], row["content"])
        if not summary["tem_mudancas"]:
            return  # "Terminei" sem mexer em nada: não incomoda o produtor no WhatsApp
        body = {
            "owner": row["owner"],
            "draft_id": row["id"],
            "farm_id": row["farm_id"],
            "summary": summary,
        }
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(settings.events_url, json=body,
                                  headers={"X-Internal-Key": settings.internal_key})
        except httpx.HTTPError as e:
            log.warning("aviso ao Pasto Legal falhou (draft %s): %s", draft_id, e)

    # ----- helpers -----

    def load_link(token: str) -> dict:
        with db.connection() as conn:
            row = conn.execute(
                """SELECT l.*, d.id AS draft_id, d.content, d.version, d.status
                   FROM webgis.links l JOIN webgis.drafts d ON d.link_id = l.id
                   WHERE l.token_hash = %s""",
                (token_hash(token),),
            ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=MSG_NOT_FOUND)
        if row["revoked_at"] is not None:
            raise HTTPException(status_code=410, detail=MSG_REPLACED)
        if row["opened_at"] is None and _now() > row["expires_at"]:
            raise HTTPException(status_code=410, detail=MSG_EXPIRED)
        return row

    def link_view(row: dict) -> dict:
        read_only = row["status"] != "rascunho"
        snap = row["snapshot"]
        return {
            "farm": snap["farm"],
            "paddocks": row["content"]["paddocks"],
            "pins": row["content"]["pins"],
            "version": row["version"],
            "status": row["status"],
            "read_only": read_only,
            "message": MSG_READ_ONLY if read_only else None,
        }

    # ----- rotas -----

    @app.get("/health")
    def health():
        with db.connection() as conn:
            conn.execute("SELECT 1")
        return {"ok": True}

    @app.post("/internal/links", dependencies=[Depends(internal)])
    def create_link(body: LinkCreate):
        """O chat pede o link: guarda o snapshot e derruba os links anteriores do dono."""
        snap = body.snapshot.model_dump()
        try:
            check_draft(snap["farm"]["geometry"], snap, settings.max_paddocks)
        except RuleError as e:
            raise HTTPException(status_code=422, detail=str(e))
        own = owner(body.user_id)
        token = new_token()
        expires = _now() + timedelta(minutes=settings.link_open_minutes)
        content = {"paddocks": snap["paddocks"], "pins": snap["pins"]}
        with db.connection() as conn:
            revoked = conn.execute(
                """UPDATE webgis.links SET revoked_at = now()
                   WHERE owner = %s AND revoked_at IS NULL RETURNING id""",
                (own,),
            ).fetchall()
            conn.execute(
                """UPDATE webgis.drafts SET status = 'descartado', updated_at = now()
                   WHERE owner = %s AND status IN ('rascunho', 'enviado')""",
                (own,),
            )
            link = conn.execute(
                """INSERT INTO webgis.links (token_hash, owner, farm_id, snapshot, expires_at)
                   VALUES (%s, %s, %s, %s, %s) RETURNING id""",
                (token_hash(token), own, snap["farm"]["id"], Jsonb(snap), expires),
            ).fetchone()
            conn.execute(
                """INSERT INTO webgis.drafts (link_id, owner, farm_id, content)
                   VALUES (%s, %s, %s, %s)""",
                (link["id"], own, snap["farm"]["id"], Jsonb(content)),
            )
        return {
            "url": f"{settings.public_url.rstrip('/')}/#t={token}",
            "expires_at": expires.isoformat(),
            "replaced_previous": bool(revoked),
        }

    @app.get("/links/{token}")
    def open_link(token: str):
        row = load_link(token)
        with db.connection() as conn:
            if row["opened_at"] is None:
                conn.execute("UPDATE webgis.links SET opened_at = now() WHERE id = %s", (row["id"],))
            conn.execute("INSERT INTO webgis.link_accesses (link_id) VALUES (%s)", (row["id"],))
        return link_view(row)

    @app.put("/links/{token}/draft")
    def save_draft(token: str, body: DraftSave):
        """Salvar automático: valida, corrige e grava com a versão."""
        row = load_link(token)
        if row["status"] != "rascunho":
            raise HTTPException(status_code=409, detail=MSG_READ_ONLY)
        try:
            checked = check_draft(
                row["snapshot"]["farm"]["geometry"],
                {"paddocks": [p.model_dump() for p in body.paddocks],
                 "pins": [p.model_dump() for p in body.pins]},
                settings.max_paddocks,
            )
        except RuleError as e:
            raise HTTPException(status_code=422, detail=str(e))
        with db.connection() as conn:
            saved = conn.execute(
                """UPDATE webgis.drafts
                   SET content = %s, version = version + 1, edited = TRUE, updated_at = now()
                   WHERE id = %s AND version = %s AND status = 'rascunho'
                   RETURNING version""",
                (Jsonb(checked.content), row["draft_id"], body.version),
            ).fetchone()
        if not saved:
            raise HTTPException(status_code=409, detail=MSG_STALE)
        return {"version": saved["version"], "paddocks": checked.content["paddocks"],
                "pins": checked.content["pins"]}

    @app.post("/links/{token}/finish")
    async def finish(token: str):
        """Botão "Terminei". Idempotente: só a primeira vez muda o status e avisa."""
        row = load_link(token)
        with db.connection() as conn:
            changed = conn.execute(
                """UPDATE webgis.drafts SET status = 'enviado', finished_at = now()
                   WHERE id = %s AND status = 'rascunho' RETURNING id""",
                (row["draft_id"],),
            ).fetchone()
        if changed:
            await _notify(row["draft_id"])
        return {"status": "enviado", "notified": bool(changed and settings.events_url)}

    @app.get("/internal/drafts", dependencies=[Depends(internal)])
    def pending_draft(user_id: str):
        """O chat pergunta, no começo do turno, se há algo para confirmar.

        Devolve o rascunho mais recente em "enviado" ou em "rascunho" com edição
        (o produtor mandou mensagem sem apertar "Terminei")."""
        with db.connection() as conn:
            row = conn.execute(
                """SELECT d.id, d.farm_id, d.content, d.status, d.version, l.snapshot
                   FROM webgis.drafts d JOIN webgis.links l ON l.id = d.link_id
                   WHERE d.owner = %s AND (d.status = 'enviado' OR (d.status = 'rascunho' AND d.edited))
                   ORDER BY d.updated_at DESC LIMIT 1""",
                (owner(user_id),),
            ).fetchone()
        if not row:
            return {"draft": None}
        summary = summarize(row["snapshot"], row["content"])
        if not summary["tem_mudancas"]:
            return {"draft": None}  # nada mudou: nada para confirmar
        return {"draft": {
            "id": row["id"],
            "farm_id": row["farm_id"],
            "status": row["status"],
            "version": row["version"],
            "snapshot": row["snapshot"],
            "content": row["content"],
            "summary": summary,
        }}

    @app.post("/internal/drafts/{draft_id}/status", dependencies=[Depends(internal)])
    def change_status(draft_id: int, body: StatusChange, user_id: str):
        """Transições permitidas (idempotentes):
        rascunho → enviado (mensagem no chat) · enviado → confirmado | recusado."""
        allowed_from = {"enviado": ("rascunho",), "confirmado": ("enviado",), "recusado": ("enviado",)}
        with db.connection() as conn:
            row = conn.execute(
                "SELECT status FROM webgis.drafts WHERE id = %s AND owner = %s",
                (draft_id, owner(user_id)),
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Rascunho não encontrado.")
            if row["status"] == body.status:
                return {"status": row["status"], "changed": False}
            if row["status"] not in allowed_from[body.status]:
                raise HTTPException(status_code=409,
                                    detail=f"Rascunho está '{row['status']}', não dá para ir para '{body.status}'.")
            conn.execute(
                """UPDATE webgis.drafts SET status = %s, updated_at = now(),
                   finished_at = COALESCE(finished_at, now()) WHERE id = %s""",
                (body.status, draft_id),
            )
        return {"status": body.status, "changed": True}

    @app.delete("/internal/owners/{user_id}/farms/{farm_id}", dependencies=[Depends(internal)])
    def delete_farm(user_id: str, farm_id: str):
        """Apagar fazenda no chat (menu do /new): some rascunho, link e acessos dela."""
        with db.connection() as conn:
            n = conn.execute("DELETE FROM webgis.links WHERE owner = %s AND farm_id = %s",
                             (owner(user_id), farm_id)).rowcount
        return {"deleted_links": n}

    @app.delete("/internal/owners/{user_id}", dependencies=[Depends(internal)])
    def delete_owner(user_id: str):
        """Pedido de exclusão (LGPD): apaga tudo do produtor no WebGIS."""
        with db.connection() as conn:
            n = conn.execute("DELETE FROM webgis.links WHERE owner = %s", (owner(user_id),)).rowcount
        return {"deleted_links": n}

    app.state.finish_idle = finish_idle
    return app



def get_app() -> FastAPI:
    """Ponto de entrada do uvicorn: `uvicorn app.main:get_app --factory`."""
    return create_app()
