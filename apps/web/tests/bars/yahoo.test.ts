import { describe, expect, it } from 'vitest';
import { chartUrl, fetchYahooChart, parseYahooChart, YahooFetchError } from '@/lib/bars/yahoo';
import { chunkDates } from '@/lib/bars/store';
import { jstAt } from '@/lib/time';

const sec = (iso: string) => Date.parse(iso) / 1000;
const chart = (ts: number[], q: Record<string, Array<number | null>>) => ({
  chart: { result: [{ timestamp: ts, indicators: { quote: [q] } }], error: null },
});

describe('parseYahooChart', () => {
  it('null の点を数えて捨て、範囲外の末尾 1 点も捨てる', () => {
    const t = [sec('2026-10-02T09:04:00+09:00'), sec('2026-10-02T09:05:00+09:00'), sec('2026-10-03T15:30:00+09:00')];
    const r = parseYahooChart(
      chart(t, { open: [null, 10, 12], high: [null, 11, 12], low: [null, 9, 12], close: [null, 10.5, 12], volume: [null, 0, 5] }),
      '1m',
      { from: jstAt('2026-10-02'), to: jstAt('2026-10-03') },
    );
    expect(r.nullPoints).toBe(1);
    expect(r.outOfRange).toBe(1);
    expect(r.bars).toEqual([{ ts: new Date('2026-10-02T09:05:00+09:00'), open: 10, high: 11, low: 9, close: 10.5, volume: 0 }]);
  });
  it('同じ ts の重複は後勝ちで 1 本、時刻順に並べる', () => {
    const a = sec('2026-10-02T10:00:00+09:00');
    const b = sec('2026-10-02T09:59:00+09:00');
    const r = parseYahooChart(chart([a, b, a], { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 1, 1] }), '1m');
    expect(r.bars.map((x) => x.close)).toEqual([2, 3]);
  });
  it('1d は JST 当日 00:00 に正規化する', () => {
    const r = parseYahooChart(chart([sec('2026-10-02T09:00:00+09:00')], { open: [1], high: [2], low: [0.5], close: [1.5], volume: [9] }), '1d');
    expect(r.bars[0].ts).toEqual(jstAt('2026-10-02'));
  });
  it('API エラー・形の崩れは YahooFetchError', () => {
    expect(() => parseYahooChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data' } } }, '1m')).toThrow(YahooFetchError);
    expect(() => parseYahooChart({}, '1m')).toThrow(/chart が無い/);
    expect(() => parseYahooChart({ chart: { result: [], error: null } }, '1m')).toThrow(/result が空/);
  });
});

describe('fetchYahooChart', () => {
  const args = { code: '7203', timeframe: '1m' as const, from: jstAt('2026-10-01'), to: jstAt('2026-10-03') };
  it('URL は .T 付き・期間指定・プレ/ポストなし', () => {
    expect(chartUrl(args)).toBe(
      `https://query1.finance.yahoo.com/v8/finance/chart/7203.T?interval=1m&period1=${sec('2026-10-01T00:00:00+09:00')}&period2=${sec('2026-10-03T00:00:00+09:00')}&includePrePost=false`,
    );
  });
  it('1m で 7 日を超える範囲は通信せずに失敗', async () => {
    let called = false;
    const fetchImpl = (async () => ((called = true), new Response('{}'))) as typeof fetch;
    await expect(fetchYahooChart({ ...args, to: jstAt('2026-10-09'), fetchImpl })).rejects.toThrow(/7 日以内/);
    expect(called).toBe(false);
  });
  it('応答が来なければタイムアウト', async () => {
    const fetchImpl = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch;
    await expect(fetchYahooChart({ ...args, fetchImpl, timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('HTTP エラーは本文の説明付きで http', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ chart: { result: null, error: { description: 'Too Many Requests' } } }), { status: 429 })) as typeof fetch;
    await expect(fetchYahooChart({ ...args, fetchImpl })).rejects.toMatchObject({ kind: 'http', message: 'HTTP 429: Too Many Requests' });
  });
});

describe('chunkDates', () => {
  it('1m は先頭日から 7 日未満ごとに区切る（1 リクエスト 7 日以内）', () => {
    expect(chunkDates(['2026-10-08', '2026-10-01', '2026-10-07', '2026-10-02'], '1m')).toEqual([
      ['2026-10-01', '2026-10-02', '2026-10-07'],
      ['2026-10-08'],
    ]);
  });
  it('1d はまとめて 1 回、空なら 0 回', () => {
    expect(chunkDates(['2026-10-02', '2026-09-01'], '1d')).toEqual([['2026-09-01', '2026-10-02']]);
    expect(chunkDates([], '1m')).toEqual([]);
  });
});
