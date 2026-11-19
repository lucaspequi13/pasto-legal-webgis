# Contrato WebGIS ↔ Pasto Legal (#171)

O WebGIS e o Pasto Legal são **duas aplicações separadas**. Uma não depende da outra para funcionar: cada uma funciona desde que receba os dados no formato abaixo. Se o Pasto Legal cair, o mapa continua abrindo e salvando; se o WebGIS cair, o chat segue normal (só não oferece o mapa).

Enquanto o Pasto Legal não tem a integração, o **mock** faz o papel dele: `webgis/scripts/mock_pasto_legal.py`.

## Quem é dono do quê

| Dado | Dono | O outro lado |
|---|---|---|
| Fazendas, piquetes e alfinetes **confirmados** | Pasto Legal (`all_properties`) | WebGIS recebe uma cópia (snapshot) a cada link |
| Rascunho do mapa (o que o produtor está desenhando) | WebGIS | Pasto Legal lê e confirma ou recusa |
| Telefone do produtor | Pasto Legal | WebGIS recebe o `user_id` e guarda só um HMAC dele |
| Envio de mensagens no WhatsApp | Pasto Legal | WebGIS só pede o aviso |

## Autenticação

Toda rota `/internal/*` (dos dois lados) usa o header `X-Internal-Key` com uma chave compartilhada (`WEBGIS_INTERNAL_KEY`). As rotas `/links/*` são do mapa e usam o token do link.

## Formatos

Coordenadas em **WGS84 (EPSG:4326)**, GeoJSON. Geometria de fazenda e piquete: `Polygon` ou `MultiPolygon`.

```json
{
  "farm":     { "id": "a3f9c21b7e04", "name": "Boa Vista", "geometry": { "type": "MultiPolygon", "coordinates": [] } },
  "paddocks": [ { "id": "a3f9c21b7e04_paddock_1", "number": 1, "name": null, "geometry": { "type": "Polygon", "coordinates": [] } } ],
  "pins":     [ { "id": "pin-1", "kind": "bebedouro", "name": "Bebedouro 1", "lon": -49.29, "lat": -16.69 } ]
}
```

| Campo | Regra |
|---|---|
| `farm.id` | O `feature_id` da fazenda no Pasto Legal (estável, nunca muda) |
| `paddocks[].id` | O `feature_id` do piquete; **`null` = piquete novo** desenhado no mapa |
| `paddocks[].number` | Número do "Piquete n" (≥ 1, único na fazenda). Novo = maior número + 1 |
| `paddocks[].name` | Nome próprio; `null` = mostrar "Piquete {number}" |
| `pins[].kind` | `bebedouro` ou `outro` (área de interesse, ex.: "Nascente", é um alfinete `outro`) |
| `pins[].id` | `null` = alfinete novo |

## 1. Pasto Legal → WebGIS: pedir o link

`POST /internal/links`

```json
{ "user_id": "5562999990000", "snapshot": { "farm": {}, "paddocks": [], "pins": [] } }
```

Resposta `200`:

```json
{ "url": "https://webgis.../#t=TOKEN", "expires_at": "2026-11-19T19:13:02Z", "replaced_previous": true }
```

- O link abre em até 5 min; depois de aberto, vale até um link novo.
- Link novo derruba o anterior e descarta o rascunho dele (`replaced_previous: true` → o chat avisa o produtor).
- `422` = snapshot inválido (ex.: piquetes sobrepostos, alfinete fora da fazenda), com `detail` em pt-BR.

## 2. WebGIS → Pasto Legal: aviso do "Terminei" (opcional)

Quando o produtor aperta "Terminei" ou fica 10 min sem editar, o WebGIS chama a rota do Pasto Legal configurada em `PASTO_LEGAL_EVENTS_URL` (vazio = não chama, e o produtor confirma na próxima mensagem).

`POST {PASTO_LEGAL_EVENTS_URL}` (no Pasto Legal: `/internal/webgis-events`)

```json
{ "owner": "<hmac>", "draft_id": 12, "farm_id": "a3f9c21b7e04",
  "summary": { "texto": "2 piquetes novos e 1 piquete apagado", "piquetes_novos": 2, "piquetes_alterados": 0,
               "piquetes_apagados": 1, "alfinetes_novos": 0, "alfinetes_alterados": 0, "alfinetes_apagados": 0,
               "tem_mudancas": true } }
```

O Pasto Legal só manda o aviso no WhatsApp ("Recebi suas mudanças no mapa: … Posso salvar?"). Não grava nada nessa hora. Falha nessa chamada não afeta o WebGIS.

## 3. Pasto Legal → WebGIS: há algo para confirmar?

No começo do turno (só se houver link aberto; timeout 1–2 s; se falhar, segue o turno normal).

`GET /internal/drafts?user_id=5562999990000`

```json
{ "draft": { "id": 12, "farm_id": "a3f9c21b7e04", "status": "enviado", "version": 7,
             "snapshot": { "farm": {}, "paddocks": [], "pins": [] },
             "content":  { "paddocks": [], "pins": [] },
             "summary":  { "texto": "2 piquetes novos e 1 piquete apagado" } } }
```

`draft: null` = nada para confirmar. `status: "rascunho"` = o produtor mexeu e voltou ao chat sem "Terminei": a mensagem dele conta como "Terminei" (passo 4 com `enviado`).

Os números vêm prontos em `summary`: o chat **não conta** nada (BUG-015).

## 4. Pasto Legal → WebGIS: mudar o status

`POST /internal/drafts/{id}/status?user_id=...` com `{"status": "enviado" | "confirmado" | "recusado"}`

| De | Para | Quando |
|---|---|---|
| `rascunho` | `enviado` | Produtor mandou mensagem no chat (o mapa vira só leitura) |
| `enviado` | `confirmado` | Produtor disse "sim" (o Pasto Legal grava `content` em `all_properties`) |
| `enviado` | `recusado` | Produtor disse "não" |

Idempotente: repetir a mesma mudança devolve `{"changed": false}` (webhook duplicado não confirma duas vezes). Mudança inválida = `409`.

Ao confirmar, o Pasto Legal grava a partir de `content`: piquete com `id` = atualiza; sem `id` = cria `{farm.id}_paddock_{number}`; id do snapshot que sumiu de `content` = apagado. Mesmo para alfinetes.

## 5. Pasto Legal → WebGIS: apagar

| Rota | Quando |
|---|---|
| `DELETE /internal/owners/{user_id}/farms/{farm_id}` | Produtor apagou a fazenda no chat |
| `DELETE /internal/owners/{user_id}` | Pedido de exclusão dos dados (LGPD) |

## Testar sem o Pasto Legal (mock)

Com a API rodando (`cd webgis/api && uv run --group dev python dev.py`):

```bash
python3 webgis/scripts/mock_pasto_legal.py escutar     # terminal à parte: recebe o aviso do "Terminei"
python3 webgis/scripts/mock_pasto_legal.py link        # 1. envia a fazenda de referência, imprime o link
#   ... abre o link, desenha, aperta "Terminei" (o 'escutar' mostra o aviso) ...
python3 webgis/scripts/mock_pasto_legal.py rascunho    # 3. o que o chat leria
python3 webgis/scripts/mock_pasto_legal.py confirmar   # 4. "sim" no chat
python3 webgis/scripts/mock_pasto_legal.py apagar      # 5. LGPD
```

Documentação interativa das rotas: `http://localhost:8100/docs`.
