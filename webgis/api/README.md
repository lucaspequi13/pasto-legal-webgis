# API do WebGIS (#171)

Serviço separado do Pasto Legal. Guarda os links e os rascunhos do mapa; o chat continua dono dos piquetes (alternativa C).

| Rota | Quem chama | Para quê |
|---|---|---|
| `POST /internal/links` | Pasto Legal | Cria o link da fazenda com o snapshot; derruba os links anteriores |
| `GET /links/{token}` | Mapa | Abre (5 min para abrir; depois vale até um link novo) |
| `PUT /links/{token}/draft` | Mapa | Salvar automático, com versão (versão velha = 409) |
| `POST /links/{token}/finish` | Mapa | "Terminei" (idempotente; avisa o Pasto Legal se `PASTO_LEGAL_EVENTS_URL`) |
| `GET /internal/drafts?user_id=` | Pasto Legal | Começo do turno: há algo para confirmar? Traz o resumo pronto |
| `POST /internal/drafts/{id}/status?user_id=` | Pasto Legal | `enviado` (mensagem no chat) · `confirmado` · `recusado` |
| `DELETE /internal/owners/{user_id}/farms/{farm_id}` | Pasto Legal | Apagar fazenda (menu do `/new`) |
| `DELETE /internal/owners/{user_id}` | Pasto Legal | Pedido de exclusão (LGPD) |
| `GET /health` | Deploy | Saúde |

Rotas `/internal/*` exigem o header `X-Internal-Key`. Rotas do mapa (`/links/*`) têm limite por IP: 120 pedidos/min e 20 links inválidos/min (→ `429`); o IP fica só na memória, por 1 minuto. O dono é guardado como HMAC do `user_id` (nunca o telefone).
Tarefas de fundo (a cada 60 s): 10 min sem editar → `enviado`; apaga links com mais de 30 dias.

## Rodar sem Docker (desenvolvimento)

```bash
cd webgis/api
uv run --group dev python dev.py      # API em :8100 com Postgres embutido; chave interna = dev
```

## Rodar com Docker

```bash
cd webgis/api
cp .env.example .env            # preencha as chaves
docker compose up -d            # Postgres local na porta 5433
uv run --env-file .env uvicorn app.main:get_app --factory --reload --port 8100
```

## Banco e migrações (Alembic)

As tabelas vêm de `migrations/versions/` (SQL à mão), não do código da API.

```bash
cd webgis/api
uv run --env-file .env alembic upgrade head              # aplica (o container faz isso ao subir)
uv run --env-file .env alembic revision -m "descrição"   # nova migração
```

O `dev.py` e os testes aplicam as migrações sozinhos.

## Testes (Postgres embutido, sem Docker)

```bash
cd webgis/api
uv run --group dev pytest -q
```
