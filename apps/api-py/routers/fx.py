"""FX レート。"""
from __future__ import annotations

from datetime import date as date_t
from datetime import timedelta

from fastapi import APIRouter, Query

from adapters import yfinance_client

router = APIRouter()


@router.get("/fx/usdjpy")
async def get_usdjpy(
    start: str | None = Query(None),
    end: str | None = Query(None),
):
    """USDJPY 日足。yfinance "JPY=X"。"""
    data = await yfinance_client.fetch_ohlc(
        symbol="JPY=X",
        market="US",  # シンボル変換しない
        timeframe="1d",
        start=start,
        end=end,
    )
    return {
        "pair": "USDJPY",
        "source": "yfinance",
        "bars": data["bars"],
    }


@router.get("/fx/usdjpy/{day}")
async def get_usdjpy_for_day(day: str):
    """単日 (yyyy-mm-dd) の USDJPY 中値。前 7 日を取り指定日以前で一番新しい close を返す。"""
    target = date_t.fromisoformat(day)
    start = (target - timedelta(days=7)).isoformat()
    # yfinance の end は排他なので翌日を入れる
    end = (target + timedelta(days=1)).isoformat()
    bars = (
        await yfinance_client.fetch_ohlc(
            symbol="JPY=X",
            market="US",
            timeframe="1d",
            start=start,
            end=end,
        )
    )["bars"]
    candidates = [b for b in bars if b["ts"].split("T")[0] <= day]
    if not candidates:
        return {"date": day, "rate": None}
    last = candidates[-1]
    return {"date": day, "rate": last["close"]}
