"""米株 OHLC エンドポイント。moomoo OpenD 経由。
occ_symbol が指定された場合はオプション本体の OHLC を取得する (moomoo → yfinance の順で試行)。
underlying へのフォールバックは行わない。両方失敗時は 404 を返す。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from adapters import moomoo_client

router = APIRouter()


@router.get("/ohlc/us")
async def get_ohlc_us(
    symbol: str = Query(..., description="銘柄シンボル (例: AAPL, TSLA)。先頭 US. は省略可"),
    occ_symbol: str | None = Query(
        None,
        description="OCC 形式オプションシンボル (例: 'MSFT  260515C00415000' / 'US.MSFT260515C00415000')。指定時はオプション本体の OHLC のみ取得 (underlying へは絶対にフォールバックしない)。",
    ),
    timeframe: str = Query("1d", description="1m|5m|15m|60m|1h|1d"),
    start: str = Query(..., description="yyyy-mm-dd 開始日 (inclusive)"),
    end: str = Query(..., description="yyyy-mm-dd 終了日 (inclusive)"),
):
    try:
        if occ_symbol:
            try:
                bars, source = await moomoo_client.fetch_us_option_ohlc(
                    occ_symbol, timeframe, start, end
                )
            except RuntimeError as e:
                # オプション本体取得失敗 → underlying fallback はせず 404 で返す (UI でエラー表示)
                raise HTTPException(status_code=404, detail=str(e))
        else:
            bars = await moomoo_client.fetch_us_ohlc(symbol, timeframe, start, end)
            source = "moomoo"
    except HTTPException:
        raise
    except Exception as e:
        # OpenD 未起動 / API エラーは 503 で返し、Next.js 側はキャッシュフォールバック
        raise HTTPException(status_code=503, detail=str(e))
    return {"symbol": symbol, "source": source, "bars": bars}
