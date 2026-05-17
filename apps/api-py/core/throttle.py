"""簡易レート制限。"""
from __future__ import annotations

import asyncio
import time
from collections import deque


class RateLimiter:
    """N 件 / T 秒の単純なスライディングウィンドウ。"""

    def __init__(self, max_calls: int, per_seconds: float):
        self.max_calls = max_calls
        self.per_seconds = per_seconds
        self._times: deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            while self._times and now - self._times[0] > self.per_seconds:
                self._times.popleft()
            if len(self._times) >= self.max_calls:
                wait = self.per_seconds - (now - self._times[0])
                if wait > 0:
                    await asyncio.sleep(wait)
            self._times.append(time.monotonic())
