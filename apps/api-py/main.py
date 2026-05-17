"""FastAPI サイドカー。

Next.js から HTTP で叩かれる。OpenD (moomoo) と yfinance への薄いラッパ。
書き込みは Node 側に一本化しているので、ここは stateless な fetch API に徹する。
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import fx, ohlc_jp, ohlc_us, moomoo_history  # type: ignore[no-redef]
from adapters import moomoo_client

app = FastAPI(title="tradelog sidecar", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(ohlc_jp.router)
app.include_router(ohlc_us.router)
app.include_router(fx.router)
app.include_router(moomoo_history.router)


@app.get("/healthz")
async def healthz() -> dict:
    od = await moomoo_client.opend_status()
    return {
        "ok": True,
        "opend": "connected" if od.get("connected") else "disconnected",
        "opend_detail": od,
        "yfinance": "ok",
        "version": app.version,
        "python": os.sys.version.split()[0],
    }


@app.on_event("shutdown")
def _shutdown() -> None:
    moomoo_client.close_all()
