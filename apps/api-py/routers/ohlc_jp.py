"""日本株 OHLC エンドポイント (yfinance 経由)。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from adapters import yfinance_client

router = APIRouter()


@router.get("/ohlc/jp")
async def get_jp_ohlc(
    symbol: str = Query(..., description="銘柄コード (例: 7203)"),
    timeframe: str = Query("1d", description="1m / 5m / 15m / 60m / 1h / 1d"),
    start: str | None = Query(None, description="ISO8601 yyyy-mm-dd"),
    end: str | None = Query(None, description="ISO8601 yyyy-mm-dd (排他的)"),
):
    try:
        data = await yfinance_client.fetch_ohlc(
            symbol=symbol, market="JP", timeframe=timeframe, start=start, end=end,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return data


# /ohlc/us は routers/ohlc_us.py (moomoo OpenD 経由) に移管済み。
