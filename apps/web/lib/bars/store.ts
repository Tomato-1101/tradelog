// 足の永続化と、不足分（取りこぼし日を含む）の計画・取得。取得の成否は BarFetch にデータ品質として残す。
// 対象はペーパー・リプレイの建玉が存在した日（MAE/MFE・約定確定・AI 書き出しに使う）。SBI は時刻が無いので取らない。
// リプレイの日付は ts（録画上の実時刻）の JST 日付 = 録画の日。

import type { PrismaClient } from '@/generated/prisma/client';
import { addDays, isWeekend, jstAt, jstYmd } from '@/lib/time';
import type { BarLite } from '@/lib/paper/resolve';
import { fetchYahooChart, YahooFetchError, type Timeframe } from './yahoo';

/** 1m は約 30 日前までしか遡れない（実測と Yahoo の既知の制限）。それより古い日は UNAVAILABLE として記録する */
export const MINUTE_LOOKBACK_DAYS = 29;
/** この時刻（JST 16:00）以降に取得した足は、その日の分が出揃っているとみなす */
const COMPLETE_AFTER_MIN = 16 * 60;

export type FetchNeed = { instrumentId: number; symbol: string; timeframe: Timeframe; dates: string[] };

export type FetchReport = {
  requests: number;
  stored: number;
  failures: Array<{ symbol: string; timeframe: Timeframe; dates: string[]; error: string }>;
  unavailable: number;
};

function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeekend(d)) out.push(d);
  return out;
}

/**
 * どの銘柄のどの日の足が要るか。建玉ごとに「最初の発注日〜最後の発注/約定マーク日（未決済なら今日）」の平日。
 * 取得済みで出揃っている日（OK / EMPTY かつ complete）は除く。古すぎる 1m は UNAVAILABLE を記録して除く。
 * opts.recorded: 録画に映っていた銘柄 × 録画の日。発注が無くても 1 分足だけ取る（1m は約 30 日で取れなくなり、後からリプレイで練習した時に足が無いため）。
 * 建玉の日と重なる分は 1 回にまとめる。
 */
export async function planBarFetches(
  db: PrismaClient,
  now: Date,
  opts: { recorded?: Array<{ symbol: string; date: string }> } = {},
): Promise<{ needs: FetchNeed[]; unavailable: number }> {
  const today = jstYmd(now);
  const orders = await db.paperOrder.findMany({
    select: { instrumentId: true, positionId: true, placedAt: true, fillMarkedAt: true, instrument: { select: { symbol: true } } },
  });
  // 未決済を今日まで延ばすのはペーパーだけ。リプレイの未決済は録画の中で止まっている（今日の値動きとは関係ない）ので、
  // 発注・約定マークのあった日（録画の日）だけ取る。リプレイの注文も orders に入っているので日付は下で拾われる
  const openPositions = new Set(
    (await db.round.findMany({ where: { source: 'PAPER', status: 'OPEN' }, select: { id: true } })).map((r) => r.id.split('#')[0]),
  );

  const span = new Map<string, { instrumentId: number; symbol: string; from: string; to: string }>();
  for (const o of orders) {
    const ds = [jstYmd(o.placedAt), ...(o.fillMarkedAt ? [jstYmd(o.fillMarkedAt)] : [])];
    const s = span.get(o.positionId);
    const from = ds.reduce((a, b) => (a < b ? a : b));
    const to = ds.reduce((a, b) => (a > b ? a : b));
    if (!s) span.set(o.positionId, { instrumentId: o.instrumentId, symbol: o.instrument.symbol, from, to });
    else {
      if (from < s.from) s.from = from;
      if (to > s.to) s.to = to;
    }
  }
  const wanted = new Map<number, { symbol: string; dates: Set<string> }>();
  for (const [pos, s] of span) {
    const to = openPositions.has(pos) ? today : s.to;
    const w = wanted.get(s.instrumentId) ?? { symbol: s.symbol, dates: new Set<string>() };
    for (const d of weekdaysBetween(s.from, to > today ? today : to)) w.dates.add(d);
    wanted.set(s.instrumentId, w);
  }

  // 録画の銘柄（1m だけ）。銘柄がまだ無ければ登録する（取り込みと同じ TSE）
  const minuteOnly = new Map<number, { symbol: string; dates: Set<string> }>();
  for (const t of opts.recorded ?? []) {
    if (t.date > today || isWeekend(t.date)) continue;
    const inst = await db.instrument.upsert({
      where: { market_symbol: { market: 'TSE', symbol: t.symbol } },
      create: { symbol: t.symbol, market: 'TSE' },
      update: {},
      select: { id: true },
    });
    const m = minuteOnly.get(inst.id) ?? { symbol: t.symbol, dates: new Set<string>() };
    m.dates.add(t.date);
    minuteOnly.set(inst.id, m);
  }
  for (const [instrumentId, m] of minuteOnly) if (!wanted.has(instrumentId)) wanted.set(instrumentId, { symbol: m.symbol, dates: new Set<string>() });

  const existing = await db.barFetch.findMany({ where: { instrumentId: { in: [...wanted.keys()] } } });
  const done = new Map(existing.map((f) => [`${f.instrumentId}|${f.timeframe}|${f.date}`, f]));
  const cutoff = addDays(today, -MINUTE_LOOKBACK_DAYS);

  const needs: FetchNeed[] = [];
  let unavailable = 0;
  for (const [instrumentId, w] of wanted) {
    for (const timeframe of ['1m', '1d'] as const) {
      const dates: string[] = [];
      const all = timeframe === '1m' ? new Set([...w.dates, ...(minuteOnly.get(instrumentId)?.dates ?? [])]) : w.dates;
      for (const date of [...all].sort()) {
        const f = done.get(`${instrumentId}|${timeframe}|${date}`);
        if (f && f.complete && (f.status === 'OK' || f.status === 'EMPTY')) continue;
        if (timeframe === '1m' && date < cutoff) {
          if (f?.status !== 'UNAVAILABLE') {
            await db.barFetch.upsert({
              where: { instrumentId_timeframe_date: { instrumentId, timeframe, date } },
              create: { instrumentId, timeframe, date, status: 'UNAVAILABLE', complete: false, barCount: 0, error: `1m は約 ${MINUTE_LOOKBACK_DAYS + 1} 日前までしか取れない` },
              update: { status: 'UNAVAILABLE', complete: false, error: `1m は約 ${MINUTE_LOOKBACK_DAYS + 1} 日前までしか取れない`, fetchedAt: now },
            });
          }
          unavailable++;
          continue;
        }
        dates.push(date);
      }
      if (dates.length) needs.push({ instrumentId, symbol: w.symbol, timeframe, dates });
    }
  }
  return { needs, unavailable };
}

/** 1m は 1 リクエスト 7 日以内なので、日付を 7 日幅の塊に分ける */
export function chunkDates(dates: string[], timeframe: Timeframe): string[][] {
  const sorted = [...dates].sort();
  if (timeframe === '1d') return sorted.length ? [sorted] : [];
  const out: string[][] = [];
  for (const d of sorted) {
    const cur = out[out.length - 1];
    if (cur && d < addDays(cur[0], 7)) cur.push(d);
    else out.push([d]);
  }
  return out;
}

export async function fetchAndStoreBars(
  db: PrismaClient,
  needs: FetchNeed[],
  opts: { now: Date; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<FetchReport> {
  const report: FetchReport = { requests: 0, stored: 0, failures: [], unavailable: 0 };
  for (const need of needs) {
    for (const chunk of chunkDates(need.dates, need.timeframe)) {
      const from = jstAt(chunk[0]);
      const to = jstAt(addDays(chunk[chunk.length - 1], 1));
      report.requests++;
      try {
        const parsed = await fetchYahooChart({
          code: need.symbol,
          timeframe: need.timeframe,
          from,
          to,
          fetchImpl: opts.fetchImpl,
          timeoutMs: opts.timeoutMs,
        });
        const byDate = new Map<string, typeof parsed.bars>();
        for (const b of parsed.bars) {
          const d = jstYmd(b.ts);
          const arr = byDate.get(d);
          if (arr) arr.push(b);
          else byDate.set(d, [b]);
        }
        for (const date of chunk) {
          const bars = byDate.get(date) ?? [];
          const complete = opts.now.getTime() >= jstAt(date, COMPLETE_AFTER_MIN).getTime();
          await db.$transaction([
            ...bars.map((b) =>
              db.bar.upsert({
                where: { instrumentId_timeframe_ts: { instrumentId: need.instrumentId, timeframe: need.timeframe, ts: b.ts } },
                create: { instrumentId: need.instrumentId, timeframe: need.timeframe, ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, source: 'yahoo', fetchedAt: opts.now },
                update: { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, fetchedAt: opts.now },
              }),
            ),
            db.barFetch.upsert({
              where: { instrumentId_timeframe_date: { instrumentId: need.instrumentId, timeframe: need.timeframe, date } },
              create: { instrumentId: need.instrumentId, timeframe: need.timeframe, date, status: bars.length ? 'OK' : 'EMPTY', complete, barCount: bars.length, fetchedAt: opts.now },
              update: { status: bars.length ? 'OK' : 'EMPTY', complete, barCount: bars.length, error: null, fetchedAt: opts.now },
            }),
          ]);
          report.stored += bars.length;
        }
      } catch (e) {
        const msg = e instanceof YahooFetchError ? `${e.kind}: ${e.message}` : String(e);
        report.failures.push({ symbol: need.symbol, timeframe: need.timeframe, dates: chunk, error: msg });
        for (const date of chunk) {
          await db.barFetch.upsert({
            where: { instrumentId_timeframe_date: { instrumentId: need.instrumentId, timeframe: need.timeframe, date } },
            create: { instrumentId: need.instrumentId, timeframe: need.timeframe, date, status: 'ERROR', complete: false, barCount: 0, error: msg, fetchedAt: opts.now },
            update: { status: 'ERROR', complete: false, error: msg, fetchedAt: opts.now },
          });
        }
      }
    }
  }
  return report;
}

const toLite = (b: { ts: Date; open: number; high: number; low: number; close: number }): BarLite => ({
  ts: b.ts,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
});

/** [from, to] の 1 分足（両端含む、開始時刻基準） */
export async function loadMinuteBars(db: PrismaClient, instrumentId: number, from: Date, to: Date): Promise<BarLite[]> {
  const rows = await db.bar.findMany({
    where: { instrumentId, timeframe: '1m', ts: { gte: from, lte: to } },
    orderBy: { ts: 'asc' },
  });
  return rows.map(toLite);
}

export async function loadMinuteBarsWithVolume(db: PrismaClient, instrumentId: number, from: Date, to: Date) {
  return db.bar.findMany({
    where: { instrumentId, timeframe: '1m', ts: { gte: from, lte: to } },
    orderBy: { ts: 'asc' },
    select: { ts: true, open: true, high: true, low: true, close: true, volume: true },
  });
}

export async function loadDailyBar(db: PrismaClient, instrumentId: number, ymd: string): Promise<BarLite | null> {
  const b = await db.bar.findUnique({
    where: { instrumentId_timeframe_ts: { instrumentId, timeframe: '1d', ts: jstAt(ymd) } },
  });
  return b ? toLite(b) : null;
}
