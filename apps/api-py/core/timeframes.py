"""タイムフレーム表記の正規化。"""
from __future__ import annotations

VALID = {"1m", "5m", "15m", "60m", "1h", "1d"}

# yfinance 用のマッピング (yfinance は "1m", "5m", "15m", "60m", "1d" を受ける)
YF_INTERVAL = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "60m": "60m",
    "1h": "60m",
    "1d": "1d",
}


def normalize(tf: str) -> str:
    tf = tf.strip().lower()
    if tf not in VALID:
        raise ValueError(f"unsupported timeframe: {tf}")
    return tf
