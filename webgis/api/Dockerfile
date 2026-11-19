FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml ./
RUN uv pip install --system --no-cache -r pyproject.toml
COPY app ./app
COPY alembic.ini ./
COPY migrations ./migrations
RUN useradd -u 10001 webgis
USER webgis
EXPOSE 8100
# Aplica as migrações e sobe a API.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:get_app --factory --host 0.0.0.0 --port 8100"]
