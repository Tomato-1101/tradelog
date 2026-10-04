import { describe, expect, it } from 'vitest';
import { buildPaperRounds } from '@/lib/rounds/builder';
import { avgPriceTimeline, avgSteps, type TimelineExec } from '@/lib/rounds/timeline';
import type { ExecForRound } from '@/lib/rounds/types';

const t = (hhmm: string, day = '2026-10-01') => new Date(`${day}T${hhmm}:00+09:00`);
let n = 1;
function ex(p: Partial<TimelineExec> & { side: 'BUY' | 'SELL'; qty: string; price: string | null; executedAt: Date }): TimelineExec {
  return { id: p.id ?? `e${n++}`, timePrecision: 'ms', marginType: null, seq: 0, ...p };
}

describe('avgPriceTimeline（移動平均法）', () => {
  it('買い増しは加重平均、一部決済は平均建値を変えず、全決済で null', () => {
    const tl = avgPriceTimeline([
      ex({ side: 'BUY', qty: '100', price: '100', executedAt: t('09:00') }),
      ex({ side: 'BUY', qty: '100', price: '110', executedAt: t('09:10') }),
      ex({ side: 'SELL', qty: '50', price: '120', executedAt: t('09:20') }),
      ex({ side: 'SELL', qty: '150', price: '90', executedAt: t('09:30') }),
    ]);
    expect(tl.map((p) => [p.pos, p.avg])).toEqual([
      ['100', '100'],
      ['200', '105'],
      ['150', '105'],
      ['0', null],
    ]);
  });

  it('ショート: 売りで建て、買いで決済', () => {
    const tl = avgPriceTimeline([
      ex({ side: 'SELL', qty: '200', price: '2880', executedAt: t('09:02') }),
      ex({ side: 'BUY', qty: '200', price: '2860', executedAt: t('14:59') }),
    ]);
    expect(tl.map((p) => [p.pos, p.avg])).toEqual([
      ['-200', '2880'],
      ['0', null],
    ]);
  });

  it('価格の欠けた約定以降は建玉が 0 に戻るまで平均建値 null', () => {
    const tl = avgPriceTimeline([
      ex({ side: 'BUY', qty: '100', price: null, executedAt: t('09:00') }),
      ex({ side: 'BUY', qty: '100', price: '110', executedAt: t('09:10') }),
      ex({ side: 'SELL', qty: '200', price: '120', executedAt: t('09:20') }),
      ex({ side: 'BUY', qty: '100', price: '130', executedAt: t('09:30') }),
    ]);
    expect(tl.map((p) => p.avg)).toEqual([null, null, null, '130']);
  });

  it('入力順に依らず時刻順に並べる', () => {
    const a = ex({ side: 'BUY', qty: '100', price: '100', executedAt: t('09:00') });
    const b = ex({ side: 'SELL', qty: '100', price: '110', executedAt: t('10:00') });
    expect(avgPriceTimeline([b, a]).map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('builder の remainingAvgPrice（未決済の平均建値）と一致する', () => {
    const base = { source: 'PAPER' as const, instrumentId: 1, account: 'paper', marginType: null, positionId: 'p1', dedupeHash: null, priceStatus: 'CONFIRMED' as const, fee: '0', timePrecision: 'ms' as const, seq: 0 };
    const execs: ExecForRound[] = [
      { ...base, id: 'a', executedAt: t('09:00'), side: 'BUY', qty: '300', price: '2900' },
      { ...base, id: 'b', executedAt: t('09:10'), side: 'BUY', qty: '100', price: '2910.5' },
      { ...base, id: 'c', executedAt: t('09:20'), side: 'SELL', qty: '150', price: '2950' },
    ];
    const round = buildPaperRounds(execs)[0];
    const tl = avgPriceTimeline(execs);
    expect(tl[tl.length - 1].avg).toBe(round.remainingAvgPrice);
    expect(tl[tl.length - 1].pos).toBe(round.remainingQty);
  });
});

describe('avgSteps', () => {
  it('一部決済で平均が変わらない区間は 1 つにまとめ、全決済の時刻で閉じる', () => {
    const tl = avgPriceTimeline([
      ex({ side: 'BUY', qty: '100', price: '100', executedAt: t('09:00') }),
      ex({ side: 'SELL', qty: '40', price: '120', executedAt: t('09:20') }),
      ex({ side: 'SELL', qty: '60', price: '90', executedAt: t('09:30') }),
    ]);
    const steps = avgSteps(tl);
    expect(steps).toHaveLength(1);
    expect(steps[0].avg).toBe('100');
    expect(steps[0].from).toEqual(t('09:00'));
    expect(steps[0].to).toEqual(t('09:30'));
  });

  it('買い増しで平均が変わると新しい区間。最後が未決済なら to は null', () => {
    const tl = avgPriceTimeline([
      ex({ side: 'BUY', qty: '100', price: '100', executedAt: t('09:00') }),
      ex({ side: 'BUY', qty: '100', price: '110', executedAt: t('09:10') }),
    ]);
    const steps = avgSteps(tl);
    expect(steps.map((s) => [s.avg, s.to?.toISOString() ?? null])).toEqual([
      ['100', t('09:10').toISOString()],
      ['105', null],
    ]);
  });
});
