"""yfinance アダプタ。日本株は ".T" サフィックスを付ける。"""
from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

import yfinance as yf

from core import cache
from core.throttle import RateLimiter
from core.timeframes import YF_INTERVAL, normalize

_limiter = RateLimiter(max_calls=20, per_seconds=10.0)


def _yf_symbol_jp(symbol: str) -> str:
    """SBI のシンボル (例: 7203) を yfinance 形式に。すでに ".T" なら触らない。"""
    s = symbol.strip().upper()
    if "." in s:
        return s
    return f"{s}.T"


def _yf_symbol_us(symbol: str) -> str:
    return symbol.strip().upper()


async def fetch_ohlc(
    *,
    symbol: str,
    market: str,
    timeframe: str,
    start: str | None,
    end: str | None,
) -> dict[str, Any]:
    """OHLC を返す。timeframe は normalize 済み、start/end は ISO8601 (YYYY-MM-DD or full)。

    返値: { source, symbol, timeframe, bars: [{ts, open, high, low, close, volume}] }
    """
    tf = normalize(timeframe)
    yf_tf = YF_INTERVAL[tf]

    yf_symbol = _yf_symbol_jp(symbol) if market == "JP" else _yf_symbol_us(symbol)

    ckey = cache.cache_key({
        "src": "yfinance",
        "sym": yf_symbol,
        "tf": yf_tf,
        "start": start,
        "end": end,
    })
    cached = cache.get(ckey)
    if cached is not None:
        return cached

    await _limiter.acquire()
    loop = asyncio.get_running_loop()
    df = await loop.run_in_executor(
        None,
        lambda: yf.download(
            tickers=yf_symbol,
            interval=yf_tf,
            start=start,
            end=end,
            auto_adjust=False,
            progress=False,
            threads=False,
        ),
    )

    bars: list[dict[str, Any]] = []
    if df is not None and not df.empty:
        # 列名が ("Open", yf_symbol) のように MultiIndex になるケースがあるので片付ける
        if hasattr(df.columns, "nlevels") and df.columns.nlevels > 1:
            df = df.droplevel(1, axis=1)
        for idx, row in df.iterrows():
            ts: datetime = idx.to_pydatetime() if hasattr(idx, "to_pydatetime") else idx
            bars.append({
                "ts": ts.isoformat(),
                "open": float(row.get("Open", 0)),
                "high": float(row.get("High", 0)),
                "low": float(row.get("Low", 0)),
                "close": float(row.get("Close", 0)),
                "volume": float(row.get("Volume", 0)),
            })

    payload = {
        "source": "yfinance",
        "symbol": yf_symbol,
        "timeframe": tf,
        "bars": bars,
    }
    # 日足はキャッシュ TTL 12h、分足は 5min
    ttl = 60 * 60 * 12 if tf == "1d" else 60 * 5
    cache.set(ckey, payload, expire=ttl)
    return payload
