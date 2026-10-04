// Yahoo Finance の無料チャート API（v8/finance/chart）から東証銘柄の足を取る。依存追加なしで fetch。
// 制約（実測ベースの既知の仕様）: 1m は 1 リクエスト 7 日以内・約 30 日前までしか遡れない。
// 失敗は YahooFetchError として投げる（呼び出し側が BarFetch にデータ品質として記録する）。

import { jstAt, jstYmd } from '@/lib/time';

export type Timeframe = '1m' | '1d';

export type RawBar = {
  /** UTC。1m は分足の開始時刻、1d は JST 当日 00:00 に正規化 */
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ParsedChart = {
  bars: RawBar[];
  /** OHLC が null だった点の数（売買が無かった分など） */
  nullPoints: number;
  /** 要求範囲外で捨てた点の数（期間指定でも最新の 1 点が末尾に付いてくるため） */
  outOfRange: number;
};

export class YahooFetchError extends Error {
  constructor(message: string, readonly kind: 'http' | 'timeout' | 'network' | 'parse' | 'api') {
    super(message);
    this.name = 'YahooFetchError';
  }
}

export function yahooSymbol(code: string): string {
  return `${code}.T`;
}

type ChartJson = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }> | null;
    error?: { code?: string; description?: string } | null;
  };
};

/** レスポンス JSON を足の配列にする（純粋関数） */
export function parseYahooChart(
  json: unknown,
  timeframe: Timeframe,
  range?: { from: Date; to: Date },
): ParsedChart {
  const chart = (json as ChartJson)?.chart;
  if (!chart) throw new YahooFetchError('chart が無いレスポンス', 'parse');
  if (chart.error) {
    throw new YahooFetchError(
      `Yahoo API エラー: ${chart.error.code ?? '?'} ${chart.error.description ?? ''}`.trim(),
      'api',
    );
  }
  const r = chart.result?.[0];
  if (!r) throw new YahooFetchError('result が空', 'parse');
  const ts = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0];
  if (ts.length > 0 && !q) throw new YahooFetchError('quote が無い', 'parse');

  const bars: RawBar[] = [];
  let nullPoints = 0;
  let outOfRange = 0;
  for (let i = 0; i < ts.length; i++) {
    const o = q!.open?.[i];
    const h = q!.high?.[i];
    const l = q!.low?.[i];
    const c = q!.close?.[i];
    if (o == null || h == null || l == null || c == null) {
      nullPoints++;
      continue;
    }
    const t = new Date(ts[i] * 1000);
    // 実測: period1/period2 を指定しても、最新の 1 点（例: 最終営業日 15:30）が末尾に付いてくる。
    if (range && (t < range.from || t >= range.to)) {
      outOfRange++;
      continue;
    }
    bars.push({
      ts: timeframe === '1d' ? jstAt(jstYmd(t)) : t,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: q!.volume?.[i] ?? 0,
    });
  }
  // 同じ ts が重複して返ることがある（当日の最新足など）。後勝ちで 1 本にする。
  const byTs = new Map<number, RawBar>();
  for (const b of bars) byTs.set(b.ts.getTime(), b);
  return {
    bars: [...byTs.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime()),
    nullPoints,
    outOfRange,
  };
}

export type FetchChartArgs = {
  code: string;
  timeframe: Timeframe;
  /** 取得開始（UTC） */
  from: Date;
  /** 取得終了（UTC、この時刻は含まない） */
  to: Date;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function chartUrl(a: Pick<FetchChartArgs, 'code' | 'timeframe' | 'from' | 'to'>): string {
  const p1 = Math.floor(a.from.getTime() / 1000);
  const p2 = Math.floor(a.to.getTime() / 1000);
  return (
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(a.code))}` +
    `?interval=${a.timeframe}&period1=${p1}&period2=${p2}&includePrePost=false`
  );
}

export async function fetchYahooChart(a: FetchChartArgs): Promise<ParsedChart> {
  const span = a.to.getTime() - a.from.getTime();
  if (a.timeframe === '1m' && span > 7 * 86_400_000) {
    throw new YahooFetchError('1m の取得範囲は 7 日以内', 'api');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), a.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await (a.fetchImpl ?? fetch)(chartUrl(a), {
      signal: ctrl.signal,
      // UA が無いと 429 を返されることがある
      headers: { 'User-Agent': 'Mozilla/5.0 (tradelog)' },
    });
  } catch (e) {
    if (ctrl.signal.aborted) throw new YahooFetchError(`タイムアウト（${a.timeoutMs ?? 15_000}ms）`, 'timeout');
    throw new YahooFetchError(`通信失敗: ${(e as Error).message}`, 'network');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new YahooFetchError(`HTTP ${res.status}: JSON でない応答`, res.ok ? 'parse' : 'http');
  }
  if (!res.ok) {
    const desc = (json as ChartJson)?.chart?.error?.description;
    throw new YahooFetchError(`HTTP ${res.status}${desc ? `: ${desc}` : ''}`, 'http');
  }
  return parseYahooChart(json, a.timeframe, { from: a.from, to: a.to });
}
