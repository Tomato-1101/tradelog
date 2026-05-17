"""moomoo 取引履歴エンドポイント。OpenD 経由で history_deal_list_query を叩く。

履歴の保管・dedupe は Next.js 側 (Node + Prisma) の責務。ここは生データを返すだけ。
"""
from __future__ import annotations

from datetime import date as date_t
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Query

from adapters import moomoo_client

router = APIRouter()


@router.get("/moomoo/accounts")
async def get_moomoo_accounts():
    try:
        accs = await moomoo_client.list_accounts()
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"accounts": accs}


def _resolve_acc_id(uni_card_num: str, accs: list) -> int | None:
    for a in accs:
        if a.get("uni_card_num") == uni_card_num and a.get("trd_env") == "REAL":
            return int(a["acc_id"])
    return None


@router.get("/moomoo/deals")
async def get_moomoo_deals(
    uni_card_num: str = Query(..., description="moomoo 口座番号 (16 桁)"),
    start: str | None = Query(None, description="yyyy-mm-dd 開始 (省略時: 90日前)"),
    end: str | None = Query(None, description="yyyy-mm-dd 終了 (省略時: 今日)"),
):
    """指定口座の約定履歴を返す。日付未指定なら過去 90 日。"""
    today = date_t.today()
    end_d = today.isoformat() if not end else end
    start_d = (today - timedelta(days=90)).isoformat() if not start else start

    try:
        accs = await moomoo_client.list_accounts()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"OpenD 接続失敗: {e}")

    acc_id = _resolve_acc_id(uni_card_num, accs)
    if acc_id is None:
        raise HTTPException(
            status_code=404,
            detail=f"uni_card_num={uni_card_num} の本番口座が見つかりません",
        )

    try:
        deals = await moomoo_client.fetch_us_history_deals(acc_id, start_d, end_d)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"history_deal_list_query 失敗: {e}")

    return {
        "uni_card_num": uni_card_num,
        "acc_id": acc_id,
        "start": start_d,
        "end": end_d,
        "deals": deals,
    }


@router.get("/moomoo/orders")
async def get_moomoo_orders(
    uni_card_num: str = Query(...),
    start: str | None = Query(None),
    end: str | None = Query(None),
):
    today = date_t.today()
    end_d = today.isoformat() if not end else end
    start_d = (today - timedelta(days=90)).isoformat() if not start else start

    accs = await moomoo_client.list_accounts()
    acc_id = _resolve_acc_id(uni_card_num, accs)
    if acc_id is None:
        raise HTTPException(status_code=404, detail="account not found")

    try:
        orders = await moomoo_client.fetch_us_history_orders(acc_id, start_d, end_d)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"uni_card_num": uni_card_num, "acc_id": acc_id, "orders": orders}


@router.get("/moomoo/account-summary")
async def get_moomoo_account_summary():
    """全口座 (REAL) の accinfo_query を集計して返す。
    deal/order 単位の broker pnl は OpenAPI に存在しないため、口座全体の累計を表示する用途。
    口座種別ごとに currency / trd_market を切り替える:
      - CASH (現物 US):    currency=USD, market=US
      - MARGIN (信用 JP): currency=JPY, market=JP
      - DERIVATIVES (US opt): currency=USD, market=US
    """
    try:
        accs = await moomoo_client.list_accounts()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"OpenD 接続失敗: {e}")

    summaries: list[dict] = []
    for a in accs:
        if a.get("trd_env") != "REAL":
            continue
        acc_type = a["acc_type"]
        # 口座種別から currency / asset_category を推定
        if acc_type == "MARGIN" and "JP" in a.get("trdmarket_auth", []):
            currency, category = "JPY", "JP"
        else:
            currency, category = "USD", "US"
        try:
            info = await moomoo_client.get_acc_info(a["acc_id"], currency, category)
        except Exception as e:
            info = {"error": str(e), "tried": {"currency": currency, "category": category}}
        summaries.append({
            "acc_id": a["acc_id"],
            "acc_type": acc_type,
            "uni_card_num": a["uni_card_num"],
            "currency": currency,
            "asset_category": category,
            "info": info,
        })
    return {"accounts": summaries}
