# WebGIS do Pasto Legal (#171)

Mapa onde o produtor **desenha e divide a fazenda** em piquetes, aberto pelo link que o Pasto Legal manda no WhatsApp.
É uma **aplicação separada** do Pasto Legal: as duas conversam só pelo [contrato](CONTRATO.md) e cada uma funciona sem a outra.

**Demo (modo demonstração, sem salvar):** https://lucaspequi13.github.io/pasto-legal-webgis/

## Peças

| Pasta | O quê |
|---|---|
| `frontend/` | Angular + OpenLayers + Turf.js. Desenho no celular ("segura e arrasta") e no computador (cantos) |
| `api/` | FastAPI + Postgres (schema `webgis`): links, rascunho com salvar automático, regras no servidor. Ver `api/README.md` |
| `CONTRATO.md` | O que o Pasto Legal manda e recebe (formatos, rotas, erros) |
| `scripts/mock_pasto_legal.py` | Faz o papel do Pasto Legal enquanto a integração não existe |

## Como funciona

```
Pasto Legal ──link com a fazenda──▶ WebGIS ──▶ produtor desenha no celular (salva sozinho)
     ▲                                              │ "Terminei" / 10 min / mensagem no chat
     └── aviso + "confirma?" no WhatsApp ◀──────────┘ (o chat é quem grava os piquetes)
```

## Regras do mapa

| Regra | Comportamento |
|---|---|
| Cerca | Menos de 10% fora: corta no limite. 10% ou mais: recusa |
| Sobreposição | **O piquete que já existia manda**: a parte em comum continua dele; o desenho novo fica com o resto. Desenho **inteiro dentro** de um piquete = divide esse piquete. Lasca < ~0,05 ha nunca vira piquete |
| Traço que cruza a si mesmo | Desfeito nas partes reais antes das regras |
| 🧲 Grudar | Liga/desliga o ímã na cerca e nos vizinhos (desligado = dá para deixar corredor). Avisa "Grudou no Piquete n" |
| Nomes | "Piquete n" pela ordem; próximo = maior número + 1; nome próprio opcional |
| Alfinetes | Bebedouro ou outro (área de interesse, ex.: "Nascente"), sempre dentro da fazenda |
| Salvar | Automático ~1 s após cada edição; versão velha (outra aba) é recusada com "Recarregar" |

As regras ficam em `frontend/src/app/mapa/regras.ts` (testes em `regras.spec.ts`) e são refeitas no servidor (`api/app/rules.py`).

## Rodar local (4 terminais, sem Docker)

```bash
cd webgis/api && uv run --group dev python dev.py                      # 1 · API (porta 8100)
cd webgis/frontend && npx ng serve --host 0.0.0.0                      # 2 · mapa (porta 4200)
python3 webgis/scripts/mock_pasto_legal.py escutar                     # 3 · "Pasto Legal" recebendo o aviso
python3 webgis/scripts/mock_pasto_legal.py link                        # 4 · "Pasto Legal" gera o link → abra no navegador/celular
```

Depois: `mock_pasto_legal.py rascunho` (o que o chat leria) e `confirmar` / `recusar`.
No celular: mesmo Wi-Fi do computador e o IP dele liberado na chave do MapTiler.

## Testes

```bash
cd webgis/frontend && npx ng test --watch=false     # regras do mapa
cd webgis/api && uv run --group dev pytest -q       # API (Postgres embutido)
```

## Publicar a demo (GitHub Pages)

```bash
cd webgis/frontend && npm run deploy:pages
```

## Próximos passos

Integração no Pasto Legal seguindo o contrato · deploy no servidor do LAPIG (compose com API + front + `/api`, migrações, domínio na chave do MapTiler).
