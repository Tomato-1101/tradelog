import { describe, expect, it } from 'vitest';
import { computeStats } from '@/lib/stats/compute';
import type { StatsRound } from '@/lib/stats/types';

let n = 0;
const jst = (s: string) => new Date(`${s}+09:00`);
function r(p: Partial<StatsRound> & { netPnl: string | null }): StatsRound {
  n++;
  const openedAt = p.openedAt ?? jst(`2026-09-01T09:${String(n % 60).padStart(2, '0')}:00`);
  return {
    id: p.id ?? `r${String(n).padStart(3, '0')}`,
    source: p.source ?? 'PAPER',
    symbol: p.symbol ?? '7203',
    direction: p.direction ?? 'LONG',
    status: p.status ?? 'CLOSED',
    openedAt,
    closedAt: p.closedAt === undefined ? new Date(openedAt.getTime() + 60_000) : p.closedAt,
    timePrecision: p.timePrecision ?? 'ms',
    netPnl: p.netPnl,
    holdSeconds: p.holdSeconds === undefined ? 60 : p.holdSeconds,
  };
}
const at = (i: number) => jst(`2026-09-${String(i).padStart(2, '0')}T10:00:00`);

describe('空入力', () => {
  it('件数 0 で比率は null、金額は 0', () => {
    const s = computeStats([]);
    expect(s.counted).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.payoffRatio).toBeNull();
    expect(s.expectancy).toBeNull();
    expect(s.avgHoldSeconds).toBeNull();
    expect(s.totalNetPnl).toBe('0');
    expect(s.maxDrawdown).toBe('0');
    expect(s.equityCurve).toEqual([]);
    expect(s.byHalfHour).toEqual([]);
    expect(s.bySymbol).toEqual([]);
  });
});

describe('勝敗の判定（手数料込み netPnl > 0）', () => {
  it('netPnl が 0 は引き分け、負は負け', () => {
    const s = computeStats([r({ netPnl: '100' }), r({ netPnl: '0' }), r({ netPnl: '-50' })]);
    expect(s.wins).toBe(1);
    expect(s.draws).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo(1 / 3);
  });

  it('グロスでは勝ちでも手数料込みで負けなら負け（netPnl だけを見る）', () => {
    const s = computeStats([r({ netPnl: '-8' })]);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(1);
  });

  it('未決済と netPnl=null（未確定）は集計から外して件数だけ数える', () => {
    const s = computeStats([
      r({ netPnl: '100' }),
      r({ netPnl: null }),
      r({ netPnl: '50', status: 'OPEN', closedAt: null }),
    ]);
    expect(s.counted).toBe(1);
    expect(s.excludedNoPnl).toBe(1);
    expect(s.openCount).toBe(1);
    expect(s.totalNetPnl).toBe('100');
  });
});

describe('PF・平均損益・ペイオフレシオ・期待値', () => {
  const rounds = () => [r({ netPnl: '300' }), r({ netPnl: '100' }), r({ netPnl: '-100' }), r({ netPnl: '-50' })];
  it('PF = 総利益 / 総損失', () => {
    const s = computeStats(rounds());
    expect(s.grossProfit).toBe('400');
    expect(s.grossLoss).toBe('150');
    expect(s.profitFactor).toBeCloseTo(400 / 150);
  });
  it('平均勝ち・平均負け（負値）・ペイオフレシオ', () => {
    const s = computeStats(rounds());
    expect(s.avgWin).toBe('200');
    expect(s.avgLoss).toBe('-75');
    expect(s.payoffRatio).toBeCloseTo(200 / 75);
  });
  it('期待値 = netPnl の平均（引き分けも分母に入る）', () => {
    const s = computeStats([...rounds(), r({ netPnl: '0' })]);
    expect(s.expectancy).toBe('50'); // 250 / 5
    expect(s.totalNetPnl).toBe('250');
  });
  it('負けが無ければ PF は null（分母 0）、ペイオフレシオも null', () => {
    const s = computeStats([r({ netPnl: '10' }), r({ netPnl: '0' })]);
    expect(s.profitFactor).toBeNull();
    expect(s.payoffRatio).toBeNull();
    expect(s.avgLoss).toBeNull();
  });
  it('勝ちが無ければ PF は 0、avgWin は null', () => {
    const s = computeStats([r({ netPnl: '-10' })]);
    expect(s.profitFactor).toBe(0);
    expect(s.avgWin).toBeNull();
  });
  it('小数の金額も誤差なく足す', () => {
    const s = computeStats([r({ netPnl: '0.1' }), r({ netPnl: '0.2' })]);
    expect(s.totalNetPnl).toBe('0.3');
  });
});

describe('最大ドローダウン（決済済み累積 netPnl のピークからの下落）', () => {
  it('ピーク 300 → 谷 -100 で 400', () => {
    const s = computeStats([
      r({ netPnl: '100', closedAt: at(1) }),
      r({ netPnl: '200', closedAt: at(2) }), // 300（ピーク）
      r({ netPnl: '-250', closedAt: at(3) }), // 50
      r({ netPnl: '-150', closedAt: at(4) }), // -100（谷）
      r({ netPnl: '500', closedAt: at(5) }), // 400
    ]);
    expect(s.maxDrawdown).toBe('400');
  });
  it('最初から負けが続くときは 0 起点で測る', () => {
    const s = computeStats([r({ netPnl: '-30', closedAt: at(1) }), r({ netPnl: '-20', closedAt: at(2) })]);
    expect(s.maxDrawdown).toBe('50');
  });
  it('入力順ではなく決済時刻順で並べる', () => {
    const s = computeStats([
      r({ netPnl: '-250', closedAt: at(3) }),
      r({ netPnl: '300', closedAt: at(1) }),
    ]);
    expect(s.maxDrawdown).toBe('250');
    expect(s.equityCurve.map((p) => p.cumulative)).toEqual(['300', '50']);
  });
  it('勝ち続けなら 0', () => {
    const s = computeStats([r({ netPnl: '1', closedAt: at(1) }), r({ netPnl: '2', closedAt: at(2) })]);
    expect(s.maxDrawdown).toBe('0');
  });
});

describe('エクイティカーブ', () => {
  it('決済ごとの累積', () => {
    const s = computeStats([
      r({ id: 'a', netPnl: '100', closedAt: at(1) }),
      r({ id: 'b', netPnl: '-30', closedAt: at(2) }),
    ]);
    expect(s.equityCurve).toEqual([
      { at: at(1), roundId: 'a', netPnl: '100', cumulative: '100' },
      { at: at(2), roundId: 'b', netPnl: '-30', cumulative: '70' },
    ]);
  });
});

describe('連勝・連敗', () => {
  it('最大連勝・最大連敗・現在の連続（引き分けでリセット）', () => {
    const pn = ['1', '1', '1', '-1', '-1', '0', '-1', '1', '1'];
    const s = computeStats(pn.map((v, i) => r({ netPnl: v, closedAt: at(i + 1) })));
    expect(s.maxWinStreak).toBe(3);
    expect(s.maxLossStreak).toBe(2);
    expect(s.currentStreak).toEqual({ kind: 'WIN', count: 2 });
  });
  it('最後が引き分けなら現在の連続は無し', () => {
    const s = computeStats([r({ netPnl: '1', closedAt: at(1) }), r({ netPnl: '0', closedAt: at(2) })]);
    expect(s.currentStreak).toEqual({ kind: null, count: 0 });
  });
});

describe('平均保有時間', () => {
  it('日付だけのラウンド（timePrecision=day）は除外', () => {
    const s = computeStats([
      r({ netPnl: '1', holdSeconds: 60 }),
      r({ netPnl: '1', holdSeconds: 180 }),
      r({ netPnl: '1', holdSeconds: 86400, timePrecision: 'day' }),
    ]);
    expect(s.avgHoldSeconds).toBe(120);
  });
});

describe('時間帯別（JST 30 分刻み・エントリー時刻基準）', () => {
  it('エントリー時刻で振り分け、決済時刻は見ない', () => {
    const s = computeStats([
      r({ netPnl: '100', openedAt: jst('2026-09-01T09:00:00'), closedAt: jst('2026-09-01T09:45:00') }),
      r({ netPnl: '-40', openedAt: jst('2026-09-01T09:29:59'), closedAt: jst('2026-09-01T10:10:00') }),
      r({ netPnl: '10', openedAt: jst('2026-09-02T09:30:00') }),
      r({ netPnl: '5', openedAt: jst('2026-09-02T14:59:00') }),
    ]);
    expect(s.byHalfHour).toEqual([
      { slot: '09:00', count: 2, wins: 1, winRate: 0.5, netPnl: '60' },
      { slot: '09:30', count: 1, wins: 1, winRate: 1, netPnl: '10' },
      { slot: '14:30', count: 1, wins: 1, winRate: 1, netPnl: '5' },
    ]);
  });
  it('timePrecision=day は除外', () => {
    const s = computeStats([r({ netPnl: '100', timePrecision: 'day', openedAt: jst('2026-09-01T09:00:00') })]);
    expect(s.byHalfHour).toEqual([]);
    expect(s.counted).toBe(1);
  });
});

describe('銘柄別', () => {
  it('件数の多い順、同数は銘柄コード順', () => {
    const s = computeStats([
      r({ symbol: '285A', netPnl: '100' }),
      r({ symbol: '7203', netPnl: '-10' }),
      r({ symbol: '7203', netPnl: '30' }),
      r({ symbol: '1662', netPnl: '-5' }),
    ]);
    expect(s.bySymbol).toEqual([
      { symbol: '7203', count: 2, wins: 1, winRate: 0.5, netPnl: '20' },
      { symbol: '1662', count: 1, wins: 0, winRate: 0, netPnl: '-5' },
      { symbol: '285A', count: 1, wins: 1, winRate: 1, netPnl: '100' },
    ]);
  });
});
