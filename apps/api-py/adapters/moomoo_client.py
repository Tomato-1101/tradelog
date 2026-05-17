"""moomoo (futu-api) ラッパ。

OpenD (127.0.0.1:11111) に常駐接続し、米株 OHLC と取引履歴を返す。
futu-api は同期 API なので、各エントリは `asyncio.to_thread` で別スレッドに逃がす。
context は遅延生成 + シングルトン。落とした際は次回呼び出しで自動再接続。
"""
from __future__ import annotations

import asyncio
import os
import threading
from datetime import date as date_t
from datetime import datetime, timedelta
from typing import Any

from futu import (  # type: ignore[import-not-found]
    AssetCategory,
    AuType,
    Currency,
    KL_FIELD,
    KLType,
    OpenQuoteContext,
    OpenSecTradeContext,
    RET_OK,
    SecurityFirm,
    TrdEnv,
    TrdMarket,
)

OPEND_HOST = os.environ.get("OPEND_HOST", "127.0.0.1")
OPEND_PORT = int(os.environ.get("OPEND_PORT", "11111"))

_quote_ctx: OpenQuoteContext | None = None
_trade_ctx_us: OpenSecTradeContext | None = None
_lock = threading.Lock()


def _get_quote_ctx() -> OpenQuoteContext:
    global _quote_ctx
    with _lock:
        if _quote_ctx is None:
            _quote_ctx = OpenQuoteContext(host=OPEND_HOST, port=OPEND_PORT)
        return _quote_ctx


def _get_trade_ctx_us() -> OpenSecTradeContext:
    """日本の moomoo (FUTUJP) で米株を扱うコンテキスト。
    日本株は SBI 経由なので moomoo 側は US のみ取り扱う。"""
    global _trade_ctx_us
    with _lock:
        if _trade_ctx_us is None:
            _trade_ctx_us = OpenSecTradeContext(
                filter_trdmarket=TrdMarket.NONE,
                host=OPEND_HOST,
                port=OPEND_PORT,
                security_firm=SecurityFirm.FUTUJP,
            )
        return _trade_ctx_us


def close_all() -> None:
    global _quote_ctx, _trade_ctx_us
    with _lock:
        if _quote_ctx is not None:
            try:
                _quote_ctx.close()
            finally:
                _quote_ctx = None
        if _trade_ctx_us is not None:
            try:
                _trade_ctx_us.close()
            finally:
                _trade_ctx_us = None


# ------- 状態確認 -------

def get_global_state_sync() -> dict[str, Any]:
    ctx = _get_quote_ctx()
    ret, data = ctx.get_global_state()
    if ret != RET_OK:
        raise RuntimeError(f"get_global_state failed: {data}")
    return data


async def opend_status() -> dict[str, Any]:
    """OpenD への到達性チェック。{connected: bool, trd_logined, qot_logined, ...}"""
    try:
        data = await asyncio.to_thread(get_global_state_sync)
        return {
            "connected": True,
            "trd_logined": bool(data.get("trd_logined")),
            "qot_logined": bool(data.get("qot_logined")),
            "server_ver": data.get("server_ver"),
            "program_status": data.get("program_status_type"),
        }
    except Exception as e:  # OpenD 未起動・接続失敗など
        return {"connected": False, "error": str(e)}


# ------- OHLC -------

_KTYPE_MAP = {
    "1m": KLType.K_1M,
    "5m": KLType.K_5M,
    "15m": KLType.K_15M,
    "60m": KLType.K_60M,
    "1h": KLType.K_60M,
    "1d": KLType.K_DAY,
}


def _normalize_us_code(symbol: str) -> str:
    # "AAPL" → "US.AAPL"。既にプレフィックス付きならそのまま。
    s = symbol.strip().upper()
    if "." in s:
        return s
    return f"US.{s}"


def fetch_us_ohlc_sync(symbol: str, timeframe: str, start: str, end: str) -> list[dict[str, Any]]:
    ktype = _KTYPE_MAP.get(timeframe)
    if ktype is None:
        raise ValueError(f"unsupported timeframe: {timeframe}")
    code = _normalize_us_code(symbol)
    ctx = _get_quote_ctx()

    bars: list[dict[str, Any]] = []
    page_req_key = None
    while True:
        ret, data, page_req_key = ctx.request_history_kline(
            code=code,
            start=start,
            end=end,
            ktype=ktype,
            autype=AuType.QFQ,
            fields=[KL_FIELD.ALL],
            max_count=1000,
            page_req_key=page_req_key,
        )
        if ret != RET_OK:
            raise RuntimeError(f"request_history_kline failed: {data}")
        # data は pandas.DataFrame
        for _, row in data.iterrows():
            bars.append({
                "ts": str(row["time_key"]).replace(" ", "T"),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
            })
        if not page_req_key:
            break
    return bars


async def fetch_us_ohlc(symbol: str, timeframe: str, start: str, end: str) -> list[dict[str, Any]]:
    return await asyncio.to_thread(fetch_us_ohlc_sync, symbol, timeframe, start, end)


# ------- オプション OHLC -------

import re as _re

# OPRA 標準 (root が 6 文字スペースパディング) と圧縮形式 (パディング無し) の両対応
# 例: "MSFT  260515C00415000" / "MSFT260515C00415000" / "US.MSFT260515C00415000"
_OCC_RE = _re.compile(r"^(?:US\.)?([A-Z][A-Z0-9.]{0,5}?)\s*(\d{6})([CP])(\d{5,8})$")


def _parse_occ(occ_symbol: str) -> tuple[str, str, str, str]:
    """OCC 形式オプションシンボルを (root, yymmdd, C/P, strike8) にパース。
    パディングスペース・US. プレフィックス・大文字小文字を吸収。
    """
    s = occ_symbol.strip().upper()
    if s.startswith("US."):
        s = s[3:]
    # 内部のスペースを除去
    s_compact = s.replace(" ", "")
    m = _OCC_RE.match(s_compact)
    if not m:
        raise ValueError(f"invalid OCC option symbol: {occ_symbol!r}")
    root, yymmdd, cp, strike = m.group(1), m.group(2), m.group(3), m.group(4)
    return root, yymmdd, cp, strike.zfill(8)


def _normalize_option_code(occ_symbol: str) -> str:
    """moomoo OpenD 用コードに変換。

    moomoo は strike を **左ゼロパディング無し** で受け取る (実機検証 2026-05-17 確認)。
      OK : US.MSFT260515C415000
      NG : US.MSFT260515C00415000 ('Unknown stock' で拒否される)
    """
    root, yymmdd, cp, strike8 = _parse_occ(occ_symbol)
    strike_compact = strike8.lstrip("0") or "0"
    return f"US.{root}{yymmdd}{cp}{strike_compact}"


def _to_yfinance_option_symbol(occ_symbol: str) -> str:
    """yfinance Ticker 用のコンパクト OCC (例: 'MSFT260515C00415000')"""
    root, yymmdd, cp, strike8 = _parse_occ(occ_symbol)
    return f"{root}{yymmdd}{cp}{strike8}"


def fetch_us_option_ohlc_sync(
    occ_symbol: str, timeframe: str, start: str, end: str
) -> tuple[list[dict[str, Any]], str]:
    """OCC 形式オプションシンボルで本体の OHLC を取得。

    戦略:
      1. moomoo OpenD で取得を試みる
      2. 0 件 or 失敗時は yfinance で取得を試みる
      3. それでも 0 件なら例外を上げる (UI はエラー表示)
    underlying へのフォールバックは行わない。

    Returns: (bars, source) where source ∈ {'moomoo-option', 'yfinance-option'}
    """
    ktype = _KTYPE_MAP.get(timeframe)
    if ktype is None:
        raise ValueError(f"unsupported timeframe: {timeframe}")
    code = _normalize_option_code(occ_symbol)

    # 1) moomoo OpenD
    try:
        ctx = _get_quote_ctx()
        ret, data, _page = ctx.request_history_kline(
            code=code,
            start=start,
            end=end,
            ktype=ktype,
            autype=AuType.QFQ,
            fields=[KL_FIELD.ALL],
            max_count=1000,
            page_req_key=None,
        )
        if ret == RET_OK and not data.empty:
            bars: list[dict[str, Any]] = []
            for _, row in data.iterrows():
                bars.append({
                    "ts": str(row["time_key"]).replace(" ", "T"),
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "volume": float(row["volume"]),
                })
            return bars, "moomoo-option"
    except Exception:
        # OpenD 未対応など。yfinance にフォールスルー
        pass

    # 2) yfinance (オプション本体の過去 OHLC)
    try:
        bars = _fetch_option_via_yfinance(occ_symbol, timeframe, start, end)
        if bars:
            return bars, "yfinance-option"
    except Exception:
        pass

    # 3) いずれも取れない場合は明示エラー (underlying fallback 禁止)
    raise RuntimeError(
        "オプション本体の OHLC を取得できません。OpenD 未対応かつ yfinance も無応答です。"
    )


def _fetch_option_via_yfinance(
    occ_symbol: str, timeframe: str, start: str, end: str
) -> list[dict[str, Any]]:
    """yfinance でオプション本体の OHLC を取得 (日足のみ実用)。
    分足は yfinance では 60 日制限 + オプション本体未対応のケースが多いので空を返すことあり。
    """
    import yfinance as yf  # type: ignore[import-not-found]

    ticker_symbol = _to_yfinance_option_symbol(occ_symbol)
    interval_map = {"1d": "1d", "60m": "60m", "1h": "60m", "5m": "5m", "1m": "1m"}
    interval = interval_map.get(timeframe, "1d")

    tk = yf.Ticker(ticker_symbol)
    hist = tk.history(start=start, end=end, interval=interval, auto_adjust=False)
    bars: list[dict[str, Any]] = []
    if hist is None or hist.empty:
        return bars
    for ts, row in hist.iterrows():
        # ts: pandas.Timestamp (tz-aware)
        bars.append({
            "ts": ts.isoformat().replace("+00:00", "Z"),
            "open": float(row["Open"]),
            "high": float(row["High"]),
            "low": float(row["Low"]),
            "close": float(row["Close"]),
            "volume": float(row["Volume"]),
        })
    return bars


async def fetch_us_option_ohlc(
    occ_symbol: str, timeframe: str, start: str, end: str
) -> tuple[list[dict[str, Any]], str]:
    return await asyncio.to_thread(fetch_us_option_ohlc_sync, occ_symbol, timeframe, start, end)


# ------- アカウント -------

def list_accounts_sync() -> list[dict[str, Any]]:
    """本番口座一覧を返す。uni_card_num (16桁) と内部 acc_id (整数) のマッピング付き。"""
    ctx = _get_trade_ctx_us()
    ret, data = ctx.get_acc_list()
    if ret != RET_OK:
        raise RuntimeError(f"get_acc_list failed: {data}")
    out: list[dict[str, Any]] = []
    for _, row in data.iterrows():
        out.append({
            "acc_id": int(row["acc_id"]),
            "trd_env": str(row["trd_env"]),
            "acc_type": str(row["acc_type"]),
            "uni_card_num": str(row.get("uni_card_num") or ""),
            "card_num": str(row.get("card_num") or ""),
            "security_firm": str(row.get("security_firm") or ""),
            "trdmarket_auth": [str(x) for x in (row.get("trdmarket_auth") or [])],
        })
    return out


async def list_accounts() -> list[dict[str, Any]]:
    return await asyncio.to_thread(list_accounts_sync)


def _serialize_row(row: Any, columns: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for col in columns:
        v = row[col]
        if hasattr(v, "isoformat"):
            out[col] = v.isoformat()
        elif hasattr(v, "item"):
            try:
                out[col] = v.item()
            except Exception:
                out[col] = str(v)
        else:
            out[col] = v
    return out


def get_acc_info_sync(
    acc_id: int,
    currency: str = "USD",
    asset_category: str = "US",
) -> dict[str, Any]:
    """口座サマリー (実現損益・未実現損益・評価額など) を返す。
    日本 moomoo の accinfo_query は currency + asset_category を必須にする。
    asset_category: AssetCategory.US (米株/オプション) / AssetCategory.JP (日本株)
    """
    ctx = _get_trade_ctx_us()
    cur = getattr(Currency, currency.upper(), Currency.USD)
    cat = getattr(AssetCategory, asset_category.upper(), AssetCategory.US)
    ret, data = ctx.accinfo_query(
        trd_env=TrdEnv.REAL,
        acc_id=acc_id,
        currency=cur,
        asset_category=cat,
    )
    if ret != RET_OK:
        raise RuntimeError(f"accinfo_query failed: {data}")
    if data is None or data.empty:
        return {}
    return _serialize_row(data.iloc[0], data.columns)


async def get_acc_info(
    acc_id: int, currency: str = "USD", asset_category: str = "US"
) -> dict[str, Any]:
    return await asyncio.to_thread(get_acc_info_sync, acc_id, currency, asset_category)


# ------- 取引履歴 -------

def _to_iso8601(d: str | datetime | date_t) -> str:
    if isinstance(d, datetime):
        return d.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(d, date_t):
        return d.strftime("%Y-%m-%d") + " 00:00:00"
    # already string; ensure has time component
    if len(d) == 10:
        return d + " 00:00:00"
    return d


def fetch_us_history_deals_sync(acc_id: int, start: str, end: str) -> list[dict[str, Any]]:
    """米株口座の約定履歴。最大 90 日 / 一度に取得可能。"""
    ctx = _get_trade_ctx_us()
    ret, data = ctx.history_deal_list_query(
        code="",
        trd_env=TrdEnv.REAL,
        acc_id=acc_id,
        start=_to_iso8601(start),
        end=_to_iso8601(end),
    )
    if ret != RET_OK:
        raise RuntimeError(f"history_deal_list_query failed: {data}")
    out: list[dict[str, Any]] = []
    for _, row in data.iterrows():
        out.append({k: (str(v) if hasattr(v, "isoformat") else v) for k, v in row.items()})
    return out


async def fetch_us_history_deals(acc_id: int, start: str, end: str) -> list[dict[str, Any]]:
    return await asyncio.to_thread(fetch_us_history_deals_sync, acc_id, start, end)


def fetch_us_history_orders_sync(acc_id: int, start: str, end: str) -> list[dict[str, Any]]:
    ctx = _get_trade_ctx_us()
    ret, data = ctx.history_order_list_query(
        status_filter_list=[],
        code="",
        trd_env=TrdEnv.REAL,
        acc_id=acc_id,
        start=_to_iso8601(start),
        end=_to_iso8601(end),
    )
    if ret != RET_OK:
        raise RuntimeError(f"history_order_list_query failed: {data}")
    out: list[dict[str, Any]] = []
    for _, row in data.iterrows():
        out.append({k: (str(v) if hasattr(v, "isoformat") else v) for k, v in row.items()})
    return out


async def fetch_us_history_orders(acc_id: int, start: str, end: str) -> list[dict[str, Any]]:
    return await asyncio.to_thread(fetch_us_history_orders_sync, acc_id, start, end)


# ------- ヘルパ -------

def default_lookback(days: int = 90) -> tuple[str, str]:
    today = date_t.today()
    start = today - timedelta(days=days)
    return start.isoformat(), today.isoformat()
