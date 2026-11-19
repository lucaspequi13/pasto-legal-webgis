"""Token do link e identidade do dono.

- O token vai só no fragmento da URL (#t=...) e no banco fica apenas o hash.
- O dono é um HMAC do user_id (o user_id do Pasto Legal é o telefone em claro);
  um hash simples seria quebrável testando todos os números.
"""

import hashlib
import hmac
import secrets


def new_token() -> str:
    return secrets.token_urlsafe(24)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def owner_of(user_id: str, key: str) -> str:
    return hmac.new(key.encode(), user_id.encode(), hashlib.sha256).hexdigest()


def same_key(given: str | None, expected: str) -> bool:
    return bool(expected) and given is not None and hmac.compare_digest(given, expected)
