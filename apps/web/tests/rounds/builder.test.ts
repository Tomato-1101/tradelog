import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { buildPaperRounds, buildSbiRounds, compareExecs } from '@/lib/rounds/builder';
import type { ExecForRound } from '@/lib/rounds/types';

let nextId = 1;
function ex(p: Partial<ExecForRound>): ExecForRound {
  const id = p.id ?? `e${String(nextId++).padStart(4, '0')}`;
  return {
    id,
    source: p.source ?? 'SBI',
    instrumentId: p.instrumentId ?? 1,
    account: p.account ?? 'default',
    marginType: p.marginType === undefined ? 'CASH' : p.marginType,
    positionId: p.positionId ?? null,
    executedAt: p.executedAt ?? new Date('2026-05-14T00:00:00Z'),
    timePrecision: p.timePrecision ?? 'ms',
    seq: p.seq ?? 0,
    side: p.side ?? 'BUY',
    qty: p.qty ?? '100',
    price: p.price === undefined ? '100' : p.price,
    fee: p.fee ?? '0',
    priceStatus: p.priceStatus ?? 'CONFIRMED',
    dedupeHash: p.dedupeHash === undefined ? `hash-${id}-0123456789abcdef` : p.dedupeHash,
  };
}
const t = (hhmm: string, day = '2026-05-14') => new Date(`${day}T${hhmm}:00+09:00`);

describe('SBI: 基本ケース（旧テストの移植）', () => {
  it('long-simple: BUY 100 / SELL 100 → 1 ラウンド CLOSE', () => {
    const rounds = buildSbiRounds([
      ex({ side: 'BUY', price: '100', executedAt: t('09:00') }),
      ex({ side: 'SELL', price: '110', executedAt: t('10:00') }),
    ]);
    expect(rounds).toHaveLength(1);
    const r = rounds[0];
    expect(r.direction).toBe('LONG');
    expect(r.status).toBe('CLOSED');
    expect(r.closedAt?.toISOString()).toBe('2026-05-14T01:00:00.000Z');
    expect(r.qtyOpened).toBe('100');
    expect(r.remainingQty).toBe('0');
    expect(r.avgEntryPrice).toBe('100');
    expect(r.avgExitPrice).toBe('110');
    expect(r.realizedPnl).toBe('1000');
    expect(r.netPnl).toBe('1000');
    expect(r.holdSeconds).toBe(3600);
    expect(r.executions.map((e) => e.role)).toEqual(['OPEN', 'CLOSE']);
  });

  it('long-partial: BUY 1.0 / SELL 0.5 / SELL 0.5 → SCALE_OUT + CLOSE', () => {
    const [r] = buildSbiRounds([
      ex({ side: 'BUY', qty: '1', price: '100', executedAt: t('09:00') }),
      ex({ side: 'SELL', qty: '0.5', price: '110', executedAt: t('09:01') }),
      ex({ side: 'SELL', qty: '0.5', price: '120', executedAt: t('09:02') }),
    ]);
    expect(r.realizedPnl).toBe('15');
    expect(r.avgExitPrice).toBe('115');
    expect(r.executions.map((e) => e.role)).toEqual(['OPEN', 'SCALE_OUT', 'CLOSE']);
    expect(r.qtyOpened).toBe('1');
  });

  it('long-scaled-in: BUY 0.5 / BUY 0.5 / SELL 1.0 → 加重平均', () => {
    const [r] = buildSbiRounds([
      ex({ side: 'BUY', qty: '0.5', price: '100', executedAt: t('09:00') }),
      ex({ side: 'BUY', qty: '0.5', price: '120', executedAt: t('09:01') }),
      ex({ side: 'SELL', qty: '1', price: '130', executedAt: t('09:02') }),
    ]);
    expect(r.avgEntryPrice).toBe('110');
    expect(r.realizedPnl).toBe('20');
    expect(r.executions.map((e) => e.role)).toEqual(['OPEN', 'SCALE_IN', 'CLOSE']);
  });

  it('same-day-restart: BUY/SELL/BUY/SELL → 2 ラウンド', () => {
    const rounds = buildSbiRounds([
      ex({ side: 'BUY', price: '100', executedAt: t('09:00') }),
      ex({ side: 'SELL', price: '110', executedAt: t('10:00') }),
      ex({ side: 'BUY', price: '105', executedAt: t('11:00') }),
      ex({ side: 'SELL', price: '108', executedAt: t('13:00') }),
    ]);
    expect(rounds.map((r) => r.realizedPnl)).toEqual(['1000', '300']);
    expect(new Set(rounds.map((r) => r.id)).size).toBe(2);
  });

  it('short-simple: SELL 100 / BUY 100 → ショート', () => {
    const [r] = buildSbiRounds([
      ex({ side: 'SELL', price: '100', executedAt: t('09:00') }),
      ex({ side: 'BUY', price: '90', executedAt: t('09:10') }),
    ]);
    expect(r.direction).toBe('SHORT');
    expect(r.realizedPnl).toBe('1000');
  });

  it('short-scaled-out: SELL 1.0 / BUY 0.4 / BUY 0.6', () => {
    const [r] = buildSbiRounds([
      ex({ side: 'SELL', qty: '1', price: '100', executedAt: t('09:00') }),
      ex({ side: 'BUY', qty: '0.4', price: '90', executedAt: t('09:01') }),
      ex({ side: 'BUY', qty: '0.6', price: '80', executedAt: t('09:02') }),
    ]);
    expect(r.realizedPnl).toBe('16');
  });

  it('flip-overfill: BUY 100 / SELL 150 → ロング CLOSE + ショート OPEN（ID は別）', () => {
    const rounds = buildSbiRounds([
      ex({ side: 'BUY', price: '100', executedAt: t('09:00') }),
      ex({ side: 'SELL', qty: '150', price: '110', executedAt: t('10:00') }),
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].direction).toBe('LONG');
    expect(rounds[0].realizedPnl).toBe('1000');
    expect(rounds[1].direction).toBe('SHORT');
    expect(rounds[1].status).toBe('OPEN');
    expect(rounds[1].qtyOpened).toBe('50');
    expect(rounds[1].remainingQty).toBe('50');
    expect(rounds[1].remainingAvgPrice).toBe('110');
    expect(rounds[1].executions[0].role).toBe('FLIP');
    // ドテンで生まれたラウンドは、ドテン約定の hash 由来 + '-flip'
    expect(rounds[1].id).toMatch(/^sbi-[0-9a-z-]{16}-flip$/);
    expect(rounds[1].id).not.toBe(rounds[0].id);
  });

  it('別銘柄は別ラウンド', () => {
    const rounds = buildSbiRounds([
      ex({ instrumentId: 10, side: 'BUY', qty: '1', price: '1', executedAt: t('09:00') }),
      ex({ instrumentId: 11, side: 'BUY', qty: '1', price: '2', executedAt: t('09:01') }),
      ex({ instrumentId: 10, side: 'SELL', qty: '1', price: '1.5', executedAt: t('09:02') }),
      ex({ instrumentId: 11, side: 'SELL', qty: '1', price: '3', executedAt: t('09:03') }),
    ]);
    const byInst = new Map(rounds.map((r) => [r.instrumentId, r]));
    expect(byInst.get(10)!.realizedPnl).toBe('0.5');
    expect(byInst.get(11)!.realizedPnl).toBe('1');
  });

  it('margin-cash-split: 同じ銘柄でも信用区分が違えば別ラウンド', () => {
    const rounds = buildSbiRounds([
      ex({ marginType: 'CASH', side: 'BUY', price: '100', executedAt: t('09:00') }),
      ex({ marginType: 'MARGIN_LONG', side: 'BUY', price: '100', executedAt: t('09:01') }),
      ex({ marginType: 'CASH', side: 'SELL', price: '110', executedAt: t('09:02') }),
      ex({ marginType: 'MARGIN_LONG', side: 'SELL', price: '105', executedAt: t('09:03') }),
    ]);
    const byMt = new Map(rounds.map((r) => [r.marginType, r]));
    expect(byMt.get('CASH')!.realizedPnl).toBe('1000');
    expect(byMt.get('MARGIN_LONG')!.realizedPnl).toBe('500');
  });

  it('口座が違えば別ラウンド', () => {
    const rounds = buildSbiRounds([
      ex({ account: 'A', side: 'BUY', price: '100', executedAt: t('09:00') }),
      ex({ account: 'B', side: 'SELL', price: '110', executedAt: t('09:01') }),
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds.every((r) => r.status === 'OPEN')).toBe(true);
  });

  it('tie-timestamp: 同時刻は行順（seq）→ id で安定ソート', () => {
    const rounds = buildSbiRounds([
      ex({ id: 'b', seq: 1, side: 'SELL', price: '110', executedAt: t('09:00') }),
      ex({ id: 'a', seq: 0, side: 'BUY', price: '100', executedAt: t('09:00') }),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].executions.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('cross-day-hold: 日跨ぎの holdSeconds', () => {
    const [r] = buildSbiRounds([
      ex({ side: 'BUY', executedAt: new Date('2026-05-14T00:00:00Z') }),
      ex({ side: 'SELL', price: '110', executedAt: new Date('2026-05-16T00:00:00Z') }),
    ]);
    expect(r.holdSeconds).toBe(2 * 86400);
  });

  it('未決済: 残数量と残平均建値を持つ', () => {
    const [r] = buildSbiRounds([
      ex({ side: 'BUY', price: '100', executedAt: t('09:00') }),
      ex({ side: 'SELL', qty: '50', price: '110', executedAt: t('09:10') }),
    ]);
    expect(r.status).toBe('OPEN');
    expect(r.closedAt).toBeNull();
    expect(r.holdSeconds).toBeNull();
    expect(r.realizedPnl).toBe('500');
    expect(r.remainingQty).toBe('50');
    expect(r.remainingAvgPrice).toBe('100');
  });

  it('決済後の買い増し: 残平均建値は移動平均、avgEntryPrice は建て全体の加重平均', () => {
    const [r] = buildSbiRounds([
      ex({ side: 'BUY', qty: '100', price: '100', executedAt: t('09:00') }),
      ex({ side: 'SELL', qty: '50', price: '110', executedAt: t('09:10') }),
      ex({ side: 'BUY', qty: '50', price: '120', executedAt: t('09:20') }),
    ]);
    expect(r.remainingQty).toBe('100');
    expect(r.remainingAvgPrice).toBe('110'); // (50*100 + 50*120) / 100
    expect(r.qtyOpened).toBe('150');
    expect(new Decimal(r.avgEntryPrice!).toFixed(4)).toBe('106.6667'); // (100*100 + 50*120) / 150
    expect(r.realizedPnl).toBe('500');
  });

  it('手数料は全約定の合計、netPnl は手数料込み', () => {
    const [r] = buildSbiRounds([
      ex({ side: 'BUY', price: '100', fee: '110', executedAt: t('09:00') }),
      ex({ side: 'SELL', price: '110', fee: '132', executedAt: t('09:10') }),
    ]);
    expect(r.fees).toBe('242');
    expect(r.realizedPnl).toBe('1000');
    expect(r.netPnl).toBe('758');
  });
});

describe('SBI: 日付だけの約定（timePrecision=day）', () => {
  const d = new Date('2026-01-07T00:00:00Z');
  it('同じ日の中では、CSV で返済行が先でも建てを先に並べる（信用買）', () => {
    const rounds = buildSbiRounds([
      ex({ marginType: 'MARGIN_LONG', side: 'SELL', price: '1124', fee: '8', seq: 0, executedAt: d, timePrecision: 'day' }),
      ex({ marginType: 'MARGIN_LONG', side: 'BUY', price: '1118', seq: 1, executedAt: d, timePrecision: 'day' }),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].direction).toBe('LONG');
    expect(rounds[0].netPnl).toBe('592'); // CSV の決済損益と一致
    expect(rounds[0].timePrecision).toBe('day');
  });

  it('信用売は新規売を先に並べる', () => {
    const rounds = buildSbiRounds([
      ex({ marginType: 'MARGIN_SHORT', side: 'BUY', price: '90', seq: 0, executedAt: d, timePrecision: 'day' }),
      ex({ marginType: 'MARGIN_SHORT', side: 'SELL', price: '100', seq: 1, executedAt: d, timePrecision: 'day' }),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].direction).toBe('SHORT');
    expect(rounds[0].realizedPnl).toBe('1000');
  });

  it('compareExecs: 時刻つきの約定は時刻順のまま', () => {
    const a = ex({ side: 'SELL', executedAt: t('09:00') });
    const b = ex({ side: 'BUY', executedAt: t('09:01') });
    expect(compareExecs(a, b)).toBeLessThan(0);
  });
});

describe('安定 ID', () => {
  it('SBI: 先頭約定の dedupeHash から決まり、後ろに約定が増えても変わらない', () => {
    const open = ex({ side: 'BUY', price: '100', executedAt: t('09:00'), dedupeHash: 'abcdef0123456789zzzz' });
    const before = buildSbiRounds([open]);
    const after = buildSbiRounds([open, ex({ side: 'SELL', price: '101', executedAt: t('09:05') })]);
    expect(before[0].id).toBe('sbi-abcdef0123456789');
    expect(after[0].id).toBe(before[0].id);
  });

  it('PAPER: positionId がそのまま ID', () => {
    const rounds = buildPaperRounds([
      ex({ source: 'PAPER', marginType: null, positionId: 'pos-1', side: 'BUY', executedAt: t('09:00') }),
      ex({ source: 'PAPER', marginType: null, positionId: 'pos-1', side: 'SELL', price: '101', executedAt: t('09:05') }),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].id).toBe('pos-1');
    expect(rounds[0].realizedPnl).toBe('100');
    expect(rounds[0].warnings).toEqual([]);
  });
});

describe('PAPER: positionId 単位', () => {
  it('同じ銘柄でも positionId が違えば別ラウンド（同時に 2 建玉）', () => {
    const rounds = buildPaperRounds([
      ex({ source: 'PAPER', marginType: null, positionId: 'A', side: 'BUY', price: '100', executedAt: t('09:00') }),
      ex({ source: 'PAPER', marginType: null, positionId: 'B', side: 'SELL', price: '101', executedAt: t('09:01') }),
      ex({ source: 'PAPER', marginType: null, positionId: 'A', side: 'SELL', price: '102', executedAt: t('09:02') }),
      ex({ source: 'PAPER', marginType: null, positionId: 'B', side: 'BUY', price: '99', executedAt: t('09:03') }),
    ]);
    const byId = new Map(rounds.map((r) => [r.id, r]));
    expect(byId.get('A')!.direction).toBe('LONG');
    expect(byId.get('A')!.realizedPnl).toBe('200');
    expect(byId.get('B')!.direction).toBe('SHORT');
    expect(byId.get('B')!.realizedPnl).toBe('200');
  });

  it('0 に戻った後の約定は分割して警告', () => {
    const rounds = buildPaperRounds([
      ex({ source: 'PAPER', marginType: null, positionId: 'P', side: 'BUY', executedAt: t('09:00') }),
      ex({ source: 'PAPER', marginType: null, positionId: 'P', side: 'SELL', executedAt: t('09:01') }),
      ex({ source: 'PAPER', marginType: null, positionId: 'P', side: 'BUY', executedAt: t('09:02') }),
    ]);
    expect(rounds.map((r) => r.id)).toEqual(['P', 'P#2']);
    expect(rounds[0].warnings[0]).toMatch(/分割/);
  });

  it('positionId が無い PAPER 約定は例外', () => {
    expect(() => buildPaperRounds([ex({ source: 'PAPER', positionId: null })])).toThrow();
  });
});

describe('価格の欠け・未確定', () => {
  it('未確定（price=null）を含むラウンドは損益が null、数量は追える', () => {
    const [r] = buildPaperRounds([
      ex({ source: 'PAPER', marginType: null, positionId: 'P', side: 'BUY', price: '100', executedAt: t('09:00') }),
      ex({ source: 'PAPER', marginType: null, positionId: 'P', side: 'SELL', price: null, priceStatus: 'UNRESOLVED', executedAt: t('09:05') }),
    ]);
    expect(r.status).toBe('CLOSED');
    expect(r.remainingQty).toBe('0');
    expect(r.realizedPnl).toBeNull();
    expect(r.netPnl).toBeNull();
    expect(r.avgEntryPrice).toBeNull();
    expect(r.hasUnresolved).toBe(true);
  });

  it('要確認（仮置き価格あり）は損益を計算し hasUnresolved を立てる', () => {
    const [r] = buildPaperRounds([
      ex({ source: 'PAPER', marginType: null, positionId: 'P', side: 'BUY', price: '100', priceStatus: 'NEEDS_REVIEW', executedAt: t('09:00') }),
      ex({ source: 'PAPER', marginType: null, positionId: 'P', side: 'SELL', price: '103', executedAt: t('09:05') }),
    ]);
    expect(r.realizedPnl).toBe('300');
    expect(r.hasUnresolved).toBe(true);
  });

  it('数量 0 の約定は無視', () => {
    const rounds = buildSbiRounds([ex({ qty: '0' })]);
    expect(rounds).toHaveLength(0);
  });
});

