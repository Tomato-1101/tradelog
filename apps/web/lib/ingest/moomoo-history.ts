// moomoo OpenAPI 由来の取引履歴を NormalizedExecution[] に変換する。
//
// sidecar /moomoo/deals の deal は概ね以下の形:
//   { code: "US.AAPL" | "US.MSFT260515C415000", stock_name, deal_id, order_id,
//     qty, price, trd_side: "BUY"|"SELL", create_time: "YYYY-MM-DD HH:MM:SS.fff",
//     jp_acc_type: "JP_GENERAL"|"JP_TOKUTEI"|"JP_DERIVATIVE_LONG"|... }
//
// オプションの code は OCC 風: US.{UND}{YYMMDD}{C|P}{STRIKE*1000}
// 例: US.MSFT260515C415000 → underlying=MSFT, expiry=2026-05-15, right=CALL, strike=415.0

import { sidecarUrl } from '@/lib/sidecar';
import type {
  MarginType,
  NormalizedExecution,
  NormalizedInstrument,
  OptionRight,
  ParseResult,
  ParseWarning,
  Side,
} from './types';

export type MoomooDeal = {
  code: string;
  stock_name?: string;
  deal_id: number | string;
  order_id?: string;
  qty: number | string;
  price: number | string;
  trd_side: 'BUY' | 'SELL';
  create_time: string;        // "YYYY-MM-DD HH:MM:SS.fff"
  jp_acc_type?: string;       // "JP_GENERAL" | "JP_TOKUTEI" | "JP_DERIVATIVE_LONG" | etc.
  deal_market?: string;       // "US" | ...
  status?: string;
};

// "US.MSFT260515C415000" を OCC 風メタに分解。米株 EQUITY なら null を返す。
function parseUsCode(code: string): {
  underlying: string;
  expiry: Date;
  right: OptionRight;
  strike: string; // Decimal 文字列
  occSymbol: string;
} | null {
  // moomoo の strike は 1000 倍した整数を最小桁で表す (例: 415000 = $415.00, 1235 = $1.235)。
  // OCC 規格は 8 桁ゼロパディングだが moomoo は可変長で来るため 5-8 桁を許容する。
  const m = /^US\.([A-Z][A-Z0-9.]*?)(\d{6})([CP])(\d{5,8})$/.exec(code);
  if (!m) return null;
  const [, und, yymmdd, cp, strikeStr] = m;
  const yy = Number(yymmdd.slice(0, 2));
  const year = 2000 + yy;
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  const expiry = new Date(Date.UTC(year, month - 1, day));
  const strikeNum = Number(strikeStr) / 1000;
  const right: OptionRight = cp === 'C' ? 'CALL' : 'PUT';
  const occSymbol = `${und.padEnd(6, ' ')}${yymmdd}${cp}${strikeStr.padStart(8, '0')}`;
  return { underlying: und, expiry, right, strike: String(strikeNum), occSymbol };
}

// number | string を受けて IEEE 754 由来の末尾ノイズを除去した文字列を返す。
// 整数なら整数表記、小数なら最大 `maxFraction` 桁で丸めて末尾の 0 を落とす。
function normalizeNumeric(v: number | string, maxFraction: number): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Number.isInteger(n)) return n.toString();
  return Number(n.toFixed(maxFraction)).toString();
}

function classifyMarginType(jpAccType: string | undefined, isOption: boolean): MarginType {
  // オプションは現状すべて CASH 扱い (Round 集計には方向性のみで十分)
  if (isOption) return 'CASH';
  switch (jpAccType) {
    case 'JP_GENERAL_SHORT':
    case 'JP_TOKUTEI_SHORT':
      return 'MARGIN_SHORT';
    case 'JP_GENERAL':
    case 'JP_TOKUTEI':
    case 'JP_GAIKOKU_GENERAL':
    case 'JP_GAIKOKU_TOKUTEI':
      return 'CASH';
    default:
      return 'CASH';
  }
}

function parseCreateTime(s: string): Date {
  // moomoo は JST 表示。"YYYY-MM-DD HH:MM:SS.fff" → JST と仮定し UTC に変換。
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return new Date(s);
  const [, y, mo, d, hh, mm, ss, ms] = m;
  // JST = UTC+9
  return new Date(Date.UTC(+y, +mo - 1, +d, +hh - 9, +mm, +ss, ms ? +ms : 0));
}

/** sidecar deal を NormalizedExecution に変換 */
export function dealsToNormalized(
  uniCardNum: string,
  deals: MoomooDeal[],
): ParseResult {
  const executions: NormalizedExecution[] = [];
  const warnings: ParseWarning[] = [];

  for (let i = 0; i < deals.length; i++) {
    const d = deals[i];
    if (d.status && d.status !== 'OK') {
      warnings.push({ line: i, code: 'deal-not-ok', message: `status=${d.status} deal_id=${d.deal_id}` });
      continue;
    }
    const opt = parseUsCode(d.code);
    let instrument: NormalizedInstrument;
    if (opt) {
      instrument = {
        kind: 'OPTION_US',
        symbol: opt.underlying,
        underlying: opt.underlying,
        expiry: opt.expiry,
        strike: opt.strike,
        right: opt.right,
        multiplier: 100,
        occSymbol: opt.occSymbol,
        ccy: 'USD',
        name: d.stock_name,
      };
    } else if (d.code.startsWith('US.')) {
      const sym = d.code.slice(3);
      instrument = {
        kind: 'EQUITY_US',
        symbol: sym,
        exchange: d.deal_market,
        name: d.stock_name,
        ccy: 'USD',
      };
    } else {
      warnings.push({ line: i, code: 'unsupported-code', message: `unrecognised code: ${d.code}` });
      continue;
    }

    executions.push({
      broker: 'MOOMOO',
      accountExternalId: uniCardNum,
      instrument,
      executedAt: parseCreateTime(d.create_time),
      side: d.trd_side as Side,
      marginType: classifyMarginType(d.jp_acc_type, instrument.kind === 'OPTION_US'),
      qty: normalizeNumeric(d.qty, 8),
      price: normalizeNumeric(d.price, 6),
      fee: '0',
      tax: '0',
      externalOrderId: d.order_id,
      externalFillId: String(d.deal_id),
      raw: d as unknown as Record<string, unknown>,
    });
  }

  return { executions, warnings };
}

export type MoomooFetchOptions = {
  uniCardNum: string;
  start?: string; // yyyy-mm-dd
  end?: string;
};

/** sidecar /moomoo/deals を叩いて生 deal を取得 */
export async function fetchMoomooDeals(opts: MoomooFetchOptions): Promise<MoomooDeal[]> {
  const url = new URL(sidecarUrl('/moomoo/deals'));
  url.searchParams.set('uni_card_num', opts.uniCardNum);
  if (opts.start) url.searchParams.set('start', opts.start);
  if (opts.end) url.searchParams.set('end', opts.end);
  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`/moomoo/deals failed: ${res.status} ${j.detail ?? ''}`);
  }
  const j: { deals: MoomooDeal[] } = await res.json();
  return j.deals;
}
