// sidecar /moomoo/account-summary を叩いて口座サマリーを取得する。
// 自家計算 (Round/Execution 由来) との「答え合わせ」用に broker 集計値を取り出す。
//
// 注意: moomoo OpenAPI の accinfo_query は CASH 口座の realized_pl / unrealized_pl を
// "N/A" 文字列で返す (US 株現物口座は未対応)。number と "N/A" が混在するため、
// numericOrNull() で string|number|"N/A" → number|null に正規化する。

import { sidecarUrl } from '@/lib/sidecar';

export type MoomooAccountInfo = {
  total_assets: number | string;
  securities_assets: number | string;
  cash: number | string;
  market_val: number | string;
  unrealized_pl: number | string;
  realized_pl: number | string;
  currency: string;
  us_cash: number | string;
  usd_assets: number | string;
  jp_cash: number | string;
  jpy_assets: number | string;
  [k: string]: number | string;
};

export type MoomooAccountInfoError = { error: string; tried?: Record<string, string> };

export type MoomooAccountRow = {
  acc_id: number;
  acc_type: 'CASH' | 'MARGIN' | 'DERIVATIVES' | string;
  uni_card_num: string;
  currency: string;
  asset_category: string;
  info: MoomooAccountInfo | MoomooAccountInfoError;
};

function isInfoError(info: MoomooAccountInfo | MoomooAccountInfoError): info is MoomooAccountInfoError {
  return typeof (info as MoomooAccountInfoError).error === 'string';
}

export type MoomooAccountSummary = {
  accounts: MoomooAccountRow[];
};

export type AccountTotalsNormalized = {
  accId: number;
  accType: string;
  uniCardNum: string;
  // 表示用に N/A → null へ正規化済み
  totalAssets: number | null;
  cash: number | null;
  marketVal: number | null;
  unrealizedPl: number | null;
  realizedPl: number | null;
  // 通貨別内訳 (主に CASH 口座向け、USD と JPY のみ)
  usAssets: number | null;
  jpAssets: number | null;
  fetchError?: string;
};

export function numericOrNull(v: number | string | undefined | null): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === 'N/A' || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeAccountRow(row: MoomooAccountRow): AccountTotalsNormalized {
  if (isInfoError(row.info)) {
    return {
      accId: row.acc_id,
      accType: row.acc_type,
      uniCardNum: row.uni_card_num,
      totalAssets: null,
      cash: null,
      marketVal: null,
      unrealizedPl: null,
      realizedPl: null,
      usAssets: null,
      jpAssets: null,
      fetchError: row.info.error,
    };
  }
  const i = row.info;
  return {
    accId: row.acc_id,
    accType: row.acc_type,
    uniCardNum: row.uni_card_num,
    totalAssets: numericOrNull(i.total_assets),
    cash: numericOrNull(i.cash),
    marketVal: numericOrNull(i.market_val),
    unrealizedPl: numericOrNull(i.unrealized_pl),
    realizedPl: numericOrNull(i.realized_pl),
    usAssets: numericOrNull(i.usd_assets),
    jpAssets: numericOrNull(i.jpy_assets),
  };
}

/** sidecar を直接叩いて raw レスポンスを返す。Server Components 用。 */
export async function fetchMoomooAccountSummary(): Promise<{
  ok: true;
  raw: MoomooAccountSummary;
  accounts: AccountTotalsNormalized[];
} | { ok: false; error: string }> {
  try {
    const res = await fetch(sidecarUrl('/moomoo/account-summary'), {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, error: `sidecar ${res.status} ${j.detail ?? ''}`.trim() };
    }
    const raw = (await res.json()) as MoomooAccountSummary;
    return {
      ok: true,
      raw,
      accounts: raw.accounts.map(normalizeAccountRow),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
