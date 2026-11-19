# WebGIS do Pasto Legal — protótipo (issue #171)

Protótipo do mapa onde o produtor **desenha e divide a fazenda** em piquetes, abrindo pelo link que o Pasto Legal manda no WhatsApp.
Nesta fase roda **só no navegador**: a fazenda vem de um arquivo de exemplo, no lugar do link do chat.

**Demo online:** https://lucaspequi13.github.io/pasto-legal-webgis/

## O que dá para testar

1. **Novo piquete** — clique nos cantos; duplo clique fecha. O ponto **gruda** na cerca e nos piquetes vizinhos.
2. **Fora da cerca** — menos de 10% fora: o traço volta para o limite. 10% ou mais: o desenho é recusado.
3. **Sobreposição** — desenhe cruzando outro piquete: as partes viram piquetes menores (o maior pedaço mantém o número; a parte em comum ganha um número novo).
4. **Selecionar** — clique num piquete: fica laranja e por cima; o cartão mostra nome e área. Arraste os pontos para ajustar, renomeie ou apague.
5. **Alfinete** — bebedouro ou outro, com nome, sempre dentro da fazenda.
6. **Terminei** — mostra o resumo (novos, alterados, apagados, alfinetes) e o GeoJSON final, que é o que vai para o chat confirmar.

Regras de nome: **"Piquete n"** pela ordem de inserção, contado por fazenda; o número nunca é reaproveitado; o produtor pode dar um nome próprio.

## Como funciona (resumo)

| Peça | O quê |
|---|---|
| Front | Angular + OpenLayers (mapa e desenho) + Turf.js (regras) |
| Mapa base | MapTiler Satellite (plano gratuito; chave restrita por origem) |
| Regras | `frontend/src/app/mapa/regras.ts` — funções puras, para levar depois para a API |
| Fazenda de exemplo | `frontend/public/fazenda-teste.geojson` (fictícia, 32 ha) |

Fluxo previsto com o chat (alternativa C): o Pasto Legal manda a fazenda e os piquetes atuais no link → o produtor edita aqui → **Terminei** → o chat pergunta "confirma?" → só então grava.

## Rodar localmente

```bash
cd webgis/frontend
npm install
npx ng serve        # abre em http://localhost:4200
```

## Publicar a demo (GitHub Pages)

```bash
cd webgis/frontend
npm run deploy:pages
```

Gera o build e publica na branch `gh-pages`. A chave do MapTiler precisa ter `lucaspequi13.github.io` nas origens permitidas.

## Trocar a fazenda de exemplo

`scripts/exportar_fazenda.py` lê o banco SQLite de desenvolvimento do Pasto Legal (**só leitura**) e gera o GeoJSON:

```bash
python webgis/scripts/exportar_fazenda.py CAMINHO/pasto-legal/tmp/agno.db               # lista as sessões
python webgis/scripts/exportar_fazenda.py CAMINHO/pasto-legal/tmp/agno.db 2 \
  webgis/frontend/public/fazenda-teste.geojson --so-fazenda --nome "Fazenda teste"
```

## Contrato com o Pasto Legal

O WebGIS é uma aplicação separada do Pasto Legal. O que cada lado manda e recebe está em [`CONTRATO.md`](CONTRATO.md); enquanto o Pasto Legal não tem a integração, `scripts/mock_pasto_legal.py` faz o papel dele.

## Próximos passos

Celular (segura e arrasta) · integração no Pasto Legal seguindo o contrato · deploy no servidor do LAPIG.
