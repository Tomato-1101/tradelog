// 純粋な統計計算。入力は決済済み・未決済を含む Round の一覧。
// 勝敗は手数料込み netPnl > 0 で判定し、netPnl=null（価格未確定）は件数だけ数えて外す。

import Decimal from 'decimal.js';
import { jstMinuteOfDay } from '@/lib/time';
import type { Bucket, Stats, StatsRound } from './types';

type Counted = StatsRound & { closedAt: Date; pnl: Decimal };

function bucketOf(rows: Counted[]): Bucket {
  const wins = rows.filter((x) => x.pnl.gt(0)).length;
  return {
    count: rows.length,
    wins,
    winRate: wins / rows.length,
    netPnl: rows.reduce((a, x) => a.plus(x.pnl), new Decimal(0)).toString(),
  };
}

function groupBy<K>(rows: Counted[], key: (x: Counted) => K): Map<K, Counted[]> {
  const m = new Map<K, Counted[]>();
  for (const x of rows) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export function computeStats(rounds: StatsRound[]): Stats {
  const openCount = rounds.filter((x) => x.status === 'OPEN').length;
  const closed = rounds.filter((x) => x.status === 'CLOSED' && x.closedAt);
  const excludedNoPnl = closed.filter((x) => x.netPnl == null).length;
  const rows: Counted[] = closed
    .filter((x) => x.netPnl != null)
    .map((x) => ({ ...x, closedAt: x.closedAt!, pnl: new Decimal(x.netPnl!) }))
    .sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const winsR = rows.filter((x) => x.pnl.gt(0));
  const lossR = rows.filter((x) => x.pnl.lt(0));
  const sum = (xs: Counted[]) => xs.reduce((a, x) => a.plus(x.pnl), new Decimal(0));
  const total = sum(rows);
  const grossProfit = sum(winsR);
  const grossLoss = sum(lossR).abs();
  const avgWin = winsR.length ? grossProfit.div(winsR.length) : null;
  const avgLoss = lossR.length ? sum(lossR).div(lossR.length) : null;

  // エクイティカーブと最大 DD（0 起点）
  let cum = new Decimal(0);
  let peak = new Decimal(0);
  let maxDd = new Decimal(0);
  const equityCurve: Stats['equityCurve'] = [];
  for (const x of rows) {
    cum = cum.plus(x.pnl);
    if (cum.gt(peak)) peak = cum;
    const dd = peak.minus(cum);
    if (dd.gt(maxDd)) maxDd = dd;
    equityCurve.push({ at: x.closedAt, roundId: x.id, netPnl: x.pnl.toString(), cumulative: cum.toString() });
  }

  // 連勝・連敗（引き分けでリセット）
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let cur: Stats['currentStreak'] = { kind: null, count: 0 };
  for (const x of rows) {
    const kind = x.pnl.gt(0) ? 'WIN' : x.pnl.lt(0) ? 'LOSS' : null;
    cur = kind && cur.kind === kind ? { kind, count: cur.count + 1 } : { kind, count: kind ? 1 : 0 };
    if (kind === 'WIN') maxWinStreak = Math.max(maxWinStreak, cur.count);
    if (kind === 'LOSS') maxLossStreak = Math.max(maxLossStreak, cur.count);
  }

  const timed = rows.filter((x) => x.timePrecision !== 'day');
  const holds = timed.filter((x) => x.holdSeconds != null).map((x) => x.holdSeconds!);

  const byHalfHour = [...groupBy(timed, (x) => Math.floor(jstMinuteOfDay(x.openedAt) / 30) * 30)]
    .sort((a, b) => a[0] - b[0])
    .map(([m, xs]) => ({
      slot: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
      ...bucketOf(xs),
    }));

  const bySymbol = [...groupBy(rows, (x) => x.symbol)]
    .map(([symbol, xs]) => ({ symbol, ...bucketOf(xs) }))
    .sort((a, b) => b.count - a.count || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  return {
    counted: rows.length,
    excludedNoPnl,
    openCount,
    wins: winsR.length,
    losses: lossR.length,
    draws: rows.length - winsR.length - lossR.length,
    winRate: rows.length ? winsR.length / rows.length : null,
    totalNetPnl: total.toString(),
    grossProfit: grossProfit.toString(),
    grossLoss: grossLoss.toString(),
    avgWin: avgWin?.toString() ?? null,
    avgLoss: avgLoss?.toString() ?? null,
    payoffRatio: avgWin && avgLoss ? avgWin.div(avgLoss.abs()).toNumber() : null,
    profitFactor: rows.length && grossLoss.gt(0) ? grossProfit.div(grossLoss).toNumber() : null,
    expectancy: rows.length ? total.div(rows.length).toString() : null,
    maxDrawdown: maxDd.toString(),
    avgHoldSeconds: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    maxWinStreak,
    maxLossStreak,
    currentStreak: cur,
    byHalfHour,
    bySymbol,
    equityCurve,
  };
}
