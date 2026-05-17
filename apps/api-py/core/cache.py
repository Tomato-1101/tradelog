"""ディスクキャッシュ。yfinance / moomoo の OHLC 取得結果を共通でキャッシュする。"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from diskcache import Cache

CACHE_DIR = Path(
    os.environ.get(
        "OHLC_CACHE_DIR",
        Path(__file__).resolve().parents[2] / ".." / "data" / "ohlc-cache",
    )
).resolve()
CACHE_DIR.mkdir(parents=True, exist_ok=True)

_cache = Cache(str(CACHE_DIR), size_limit=int(2e9))  # 2GB 上限


def cache_key(parts: dict[str, Any]) -> str:
    s = json.dumps(parts, sort_keys=True, default=str)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def get(key: str) -> Any:
    return _cache.get(key)


def set(key: str, value: Any, expire: int | None = None) -> None:
    _cache.set(key, value, expire=expire)
