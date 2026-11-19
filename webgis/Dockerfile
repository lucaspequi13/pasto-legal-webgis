# Imagem única do WebGIS: o mapa (Angular) pronto em / e a API em /api.
# Construir a partir da pasta webgis/:  docker build -t webgis -f webgis/Dockerfile webgis

# 1) Mapa: build de produção (apiUrl = '/api').
FROM node:24-slim AS mapa
WORKDIR /front
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npx ng build --configuration production

# 2) API servindo o mapa.
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv
WORKDIR /app
COPY api/pyproject.toml ./
RUN uv pip install --system --no-cache -r pyproject.toml
COPY api/app ./app
COPY api/alembic.ini ./
COPY api/migrations ./migrations
COPY --from=mapa /front/dist/webgis/browser ./static
ENV WEBGIS_STATIC_DIR=/app/static
# Arquivos copiados do computador podem vir só com permissão do dono (600): libera leitura para o usuário webgis.
RUN chmod -R a+rX /app && useradd -u 10001 webgis
USER webgis
EXPOSE 8100
# Aplica as migrações e sobe. --proxy-headers: atrás do proxy do LAPIG, o limite de pedidos usa o IP real
# (a porta 8100 não deve ficar aberta direto para a internet).
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.servidor:get_app --factory --host 0.0.0.0 --port 8100 --proxy-headers --forwarded-allow-ips='*'"]
