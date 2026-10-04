// 統計指標の計算層。
// 入力: StatsRound[]。closedAt が null のオープン中ラウンドは集計から除外する。
// JPY ベースで集計。手数料は通貨が混在しうるが、簡易のため数値合算にとどめる
// (S15 で fees を JPY 換算保存する設計に拡張する余地あり)。

import type {
  DailyPnl,
  Kpis,
  EquityPoint,
  MonthlyPnl,
  StatsRound,
  Stats,
  SymbolPnl,
} from './types';

function num(s: string): number {
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function kpiOf(rounds: StatsRound[]): Kpis {
  const closed = rounds.filter((r) => r.closedAt);
  const pnls = closed.map((r) => num(r.realizedPnlJpy));
  const feesJpy = closed.map((r) => num(r.feesTotalJpy));
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const flats = pnls.filter((p) => p === 0);
  const totalPnl = pnls.reduce((s, p) => s + p, 0);
  const totalFees = feesJpy.reduce((s, p) => s + p, 0);

  const avgWin = wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;
  const maxWin = wins.length ? Math.max(...wins) : 0;
  const maxLoss = losses.length ? Math.min(...losses) : 0;
  const sumWin = wins.reduce((s, p) => s + p, 0);
  const sumLoss = losses.reduce((s, p) => s + p, 0);
  const winRate = closed.length ? wins.length / closed.length : 0;
  const lossRate = closed.length ? losses.length / closed.length : 0;
  const expectancy = winRate * avgWin + lossRate * avgLoss;
  const payoff = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : Infinity;
  const profitFactor = sumLoss !== 0 ? sumWin / Math.abs(sumLoss) : Infinity;

  // 最大DD: closedAt 昇順で累積PnL → ピークとの差の最小値
  const ordered = [...closed].sort(
    (a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime(),
  );
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const r of ordered) {
    cum += num(r.realizedPnlJpy);
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < maxDd) {
      maxDd = dd;
      maxDdPct = peak !== 0 ? Math.abs(dd) / peak : 0;
    }
  }

  // 保有時間
  const holds = closed.map((r) => r.holdSeconds).filter((x): x is number => x != null);
  const holdsWin = closed
    .filter((r) => num(r.realizedPnlJpy) > 0)
    .map((r) => r.holdSeconds)
    .filter((x): x is number => x != null);
  const holdsLoss = closed
    .filter((r) => num(r.realizedPnlJpy) < 0)
    .map((r) => r.holdSeconds)
    .filter((x): x is number => x != null);

  // ストリーク
  let curWin = 0;
  let curLoss = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  for (const r of ordered) {
    const p = num(r.realizedPnlJpy);
    if (p > 0) {
      curWin++;
      curLoss = 0;
    } else if (p < 0) {
      curLoss++;
      curWin = 0;
    } else {
      curWin = 0;
      curLoss = 0;
    }
    if (curWin > maxWinStreak) maxWinStreak = curWin;
    if (curLoss > maxLossStreak) maxLossStreak = curLoss;
  }

  return {
    totalRounds: rounds.length,
    closedRounds: closed.length,
    wins: wins.length,
    losses: losses.length,
    flats: flats.length,
    winRate,
    totalPnlJpy: totalPnl,
    totalFeesJpy: totalFees,
    netPnlJpy: totalPnl - totalFees,
    avgWin,
    avgLoss,
    maxWin,
    maxLoss,
    expectancyJpy: expectancy,
    payoffRatio: payoff,
    profitFactor,
    maxDrawdownJpy: maxDd,
    maxDrawdownPct: maxDdPct,
    avgHoldSeconds: avg(holds),
    avgHoldSecondsWin: avg(holdsWin),
    avgHoldSecondsLoss: avg(holdsLoss),
    currentWinStreak: curWin,
    currentLossStreak: curLoss,
    maxWinStreak,
    maxLossStreak,
  };
}

function equityOf(rounds: StatsRound[]): EquityPoint[] {
  const closed = [...rounds]
    .filter((r) => r.closedAt)
    .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());
  let cum = 0;
  let cumNet = 0;
  return closed.map((r) => {
    cum += num(r.realizedPnlJpy);
    cumNet += num(r.realizedPnlJpy) - num(r.feesTotalJpy);
    return { t: r.closedAt!, cum, cumNet };
  });
}

function monthlyOf(rounds: StatsRound[]): MonthlyPnl[] {
  // 日次カレンダー (dailyOf) と月の境界を揃えるため JST 基準で yyyy-mm を作る。
  // ISO 文字列 (UTC) のままだと米株の深夜クローズが前月に落ちて日次合計と食い違う。
  const jstFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const map = new Map<string, { pnlJpy: number; rounds: number }>();
  for (const r of rounds) {
    if (!r.closedAt) continue;
    const ym = jstFmt.format(new Date(r.closedAt)).slice(0, 7);
    const cur = map.get(ym) ?? { pnlJpy: 0, rounds: 0 };
    cur.pnlJpy += num(r.realizedPnlJpy);
    cur.rounds += 1;
    map.set(ym, cur);
  }
  return [...map.entries()]
    .map(([ym, v]) => ({ ym, ...v }))
    .sort((a, b) => a.ym.localeCompare(b.ym));
}

// OPTION_US は同じ underlying でも expiry/strike/right が違えば別物として集計する。
// Equity は symbol だけで集約。
function aggregationKey(r: StatsRound): string {
  if (r.instrumentKind === 'OPTION_US') {
    const exp = r.expiry ? r.expiry.slice(0, 10) : '?';
    return `${r.symbol}|${exp}|${r.strike ?? '?'}|${r.right ?? '?'}`;
  }
  return r.symbol;
}

function aggregationLabel(r: StatsRound): string {
  if (r.instrumentKind === 'OPTION_US') {
    const exp = r.expiry ? r.expiry.slice(2, 10).replace(/-/g, '-') : '?';
    const rt = r.right === 'CALL' ? 'C' : r.right === 'PUT' ? 'P' : '?';
    return `${r.symbol} ${exp} ${r.strike ?? '?'}${rt}`;
  }
  return r.symbol;
}

function bySymbolOf(rounds: StatsRound[]): SymbolPnl[] {
  const map = new Map<
    string,
    { label: string; symbol: string; instrumentName: string | null; rounds: number; pnlJpy: number }
  >();
  for (const r of rounds) {
    if (!r.closedAt) continue;
    const key = aggregationKey(r);
    const cur = map.get(key) ?? {
      label: aggregationLabel(r),
      symbol: r.symbol,
      instrumentName: r.instrumentName,
      rounds: 0,
      pnlJpy: 0,
    };
    cur.rounds += 1;
    cur.pnlJpy += num(r.realizedPnlJpy);
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.pnlJpy - a.pnlJpy);
}

function dailyOf(rounds: StatsRound[]): DailyPnl[] {
  // closedAt を JST 日 (Asia/Tokyo, yyyy-mm-dd) にバケット化
  const jstFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const map = new Map<string, { pnlJpy: number; rounds: number }>();
  for (const r of rounds) {
    if (!r.closedAt) continue;
    const date = jstFmt.format(new Date(r.closedAt));
    const cur = map.get(date) ?? { pnlJpy: 0, rounds: 0 };
    cur.pnlJpy += num(r.realizedPnlJpy);
    cur.rounds += 1;
    map.set(date, cur);
  }
  return [...map.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function computeStats(rounds: StatsRound[]): Stats {
  return {
    kpis: kpiOf(rounds),
    equity: equityOf(rounds),
    monthly: monthlyOf(rounds),
    bySymbol: bySymbolOf(rounds),
    daily: dailyOf(rounds),
  };
}
