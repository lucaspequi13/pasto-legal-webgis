"""Limite de pedidos nas rotas do mapa (/links/*), por IP e em memória.

- Pedidos demais por minuto (ex.: link vazado sendo martelado) → 429.
- Muitas tentativas com link inválido/expirado (alguém tentando adivinhar
  tokens) → 429 por um minuto.

O IP só vive na memória deste processo por 1 minuto: não vai para o banco nem
para log (o mesmo cuidado de link_accesses).
"""

import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self, per_minute: int, failures_per_minute: int):
        self.per_minute = per_minute
        self.failures_per_minute = failures_per_minute
        self._hits: dict[str, deque] = defaultdict(deque)
        self._fails: dict[str, deque] = defaultdict(deque)

    @staticmethod
    def _prune(q: deque, now: float) -> None:
        while q and now - q[0] > 60:
            q.popleft()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        hits, fails = self._hits[key], self._fails[key]
        self._prune(hits, now)
        self._prune(fails, now)
        if len(fails) >= self.failures_per_minute or len(hits) >= self.per_minute:
            return False
        hits.append(now)
        return True

    def failed(self, key: str) -> None:
        self._fails[key].append(time.monotonic())

    def cleanup(self) -> None:
        now = time.monotonic()
        for store in (self._hits, self._fails):
            for key in list(store):
                self._prune(store[key], now)
                if not store[key]:
                    del store[key]
