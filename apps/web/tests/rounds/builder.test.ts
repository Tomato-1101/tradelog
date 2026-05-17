import { describe, expect, it } from 'vitest';
import {
  buildRoundsForGroup,
  buildRoundsFromExecutions,
} from '@/lib/rounds/builder';
import type { ExecForRound } from '@/lib/rounds/types';

let nextId = 1;
function ex(partial: Partial<ExecForRound>): ExecForRound {
  return {
    id: partial.id ?? nextId++,
    instrumentId: partial.instrumentId ?? 1,
    accountId: partial.accountId ?? 1,
    marginType: partial.marginType ?? 'CASH',
    executedAt: partial.executedAt ?? new Date('2026-05-14T00:00:00Z'),
    side: partial.side ?? 'BUY',
    qty: partial.qty ?? '100',
    price: partial.price ?? '100',
    fee: partial.fee ?? '0',
    tax: partial.tax ?? '0',
    fxRateToJpy: partial.fxRateToJpy ?? '1',
    multiplier: partial.multiplier,
  };
}

describe('buildRoundsForGroup: 基本ケース', () => {
  it('long-simple: BUY 100 / SELL 100 → 1 ラウンド CLOSE', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '100', price: '100', executedAt: new Date('2026-05-14T00:00:00Z') }),
      ex({ side: 'SELL', qty: '100', price: '110', executedAt: new Date('2026-05-14T01:00:00Z') }),
    ]);
    expect(rounds).toHaveLength(1);
    const r = rounds[0];
    expect(r.direction).toBe('BUY');
    expect(r.closedAt?.toISOString()).toBe('2026-05-14T01:00:00.000Z');
    expect(r.qtyOpened).toBe('100');
    expect(r.avgEntryPrice).toBe('100');
    expect(r.realizedPnl).toBe('1000'); // (110-100)*100
    expect(r.holdSeconds).toBe(3600);
    expect(r.executions.map((e) => e.role)).toEqual(['OPEN', 'CLOSE']);
  });

  it('long-partial: BUY 1.0 / SELL 0.5 / SELL 0.5 → SCALE_OUT + CLOSE', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '1', price: '100' }),
      ex({ side: 'SELL', qty: '0.5', price: '110' }),
      ex({ side: 'SELL', qty: '0.5', price: '120' }),
    ]);
    expect(rounds).toHaveLength(1);
    const r = rounds[0];
    expect(r.realizedPnl).toBe('15'); // (110-100)*0.5 + (120-100)*0.5
    expect(r.executions.map((e) => e.role)).toEqual(['OPEN', 'SCALE_OUT', 'CLOSE']);
    expect(r.qtyOpened).toBe('1');
  });

  it('long-scaled-in: BUY 0.5 / BUY 0.5 / SELL 1.0 → 加重平均', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '0.5', price: '100' }),
      ex({ side: 'BUY', qty: '0.5', price: '120' }),
      ex({ side: 'SELL', qty: '1', price: '130' }),
    ]);
    expect(rounds).toHaveLength(1);
    const r = rounds[0];
    expect(r.avgEntryPrice).toBe('110'); // (0.5*100 + 0.5*120) / 1
    expect(r.realizedPnl).toBe('20'); // (130-110)*1
    expect(r.qtyOpened).toBe('1');
    expect(r.executions.map((e) => e.role)).toEqual(['OPEN', 'SCALE_IN', 'CLOSE']);
  });

  it('same-day-restart: BUY/SELL/BUY/SELL → 2 ラウンド', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '100', price: '100', executedAt: new Date('2026-05-14T00:00:00Z') }),
      ex({ side: 'SELL', qty: '100', price: '110', executedAt: new Date('2026-05-14T01:00:00Z') }),
      ex({ side: 'BUY', qty: '100', price: '105', executedAt: new Date('2026-05-14T02:00:00Z') }),
      ex({ side: 'SELL', qty: '100', price: '108', executedAt: new Date('2026-05-14T03:00:00Z') }),
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].realizedPnl).toBe('1000');
    expect(rounds[1].realizedPnl).toBe('300');
  });
});

describe('buildRoundsForGroup: ショート', () => {
  it('short-simple: SELL 100 / BUY 100 → 1 ショートラウンド', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'SELL', qty: '100', price: '100' }),
      ex({ side: 'BUY', qty: '100', price: '90' }),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].direction).toBe('SELL');
    expect(rounds[0].realizedPnl).toBe('1000'); // (100-90)*100
  });

  it('short-scaled-out: SELL 1.0 / BUY 0.4 / BUY 0.6 → 1 ラウンド', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'SELL', qty: '1', price: '100' }),
      ex({ side: 'BUY', qty: '0.4', price: '90' }),
      ex({ side: 'BUY', qty: '0.6', price: '80' }),
    ]);
    expect(rounds).toHaveLength(1);
    // (100-90)*0.4 + (100-80)*0.6 = 4 + 12 = 16
    expect(rounds[0].realizedPnl).toBe('16');
  });
});

describe('buildRoundsForGroup: 反対売買 / オーバーフィル', () => {
  it('flip-overfill: BUY 100 / SELL 150 → 1 ロング CLOSE + 1 ショート OPEN', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '100', price: '100', executedAt: new Date('2026-05-14T00:00:00Z') }),
      ex({ side: 'SELL', qty: '150', price: '110', executedAt: new Date('2026-05-14T01:00:00Z') }),
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].direction).toBe('BUY');
    expect(rounds[0].closedAt).toBeTruthy();
    expect(rounds[0].realizedPnl).toBe('1000');
    expect(rounds[1].direction).toBe('SELL');
    expect(rounds[1].closedAt).toBeNull();
    expect(rounds[1].qtyOpened).toBe('50');
    expect(rounds[1].executions[0].role).toBe('FLIP');
  });
});

describe('buildRoundsFromExecutions: グルーピング', () => {
  it('option-by-strike: 異なる instrumentId は別ラウンド', () => {
    const rounds = buildRoundsFromExecutions([
      ex({ instrumentId: 10, side: 'BUY', qty: '1', price: '1' }),
      ex({ instrumentId: 11, side: 'BUY', qty: '1', price: '2' }),
      ex({ instrumentId: 10, side: 'SELL', qty: '1', price: '1.5' }),
      ex({ instrumentId: 11, side: 'SELL', qty: '1', price: '3' }),
    ]);
    expect(rounds).toHaveLength(2);
    const byInst = new Map(rounds.map((r) => [r.instrumentId, r]));
    expect(byInst.get(10)!.realizedPnl).toBe('0.5');
    expect(byInst.get(11)!.realizedPnl).toBe('1');
  });

  it('margin-cash-split: 同 instrumentId でも marginType が違えば別ラウンド', () => {
    const rounds = buildRoundsFromExecutions([
      ex({ instrumentId: 7, marginType: 'CASH', side: 'BUY', qty: '100', price: '100' }),
      ex({ instrumentId: 7, marginType: 'MARGIN_LONG', side: 'BUY', qty: '100', price: '100' }),
      ex({ instrumentId: 7, marginType: 'CASH', side: 'SELL', qty: '100', price: '110' }),
      ex({ instrumentId: 7, marginType: 'MARGIN_LONG', side: 'SELL', qty: '100', price: '105' }),
    ]);
    expect(rounds).toHaveLength(2);
    const byMt = new Map(rounds.map((r) => [r.marginType, r]));
    expect(byMt.get('CASH')!.realizedPnl).toBe('1000');
    expect(byMt.get('MARGIN_LONG')!.realizedPnl).toBe('500');
  });

  it('tie-timestamp: 同時刻の約定は id 順で安定ソート', () => {
    const t = new Date('2026-05-14T00:00:00Z');
    const rounds = buildRoundsFromExecutions([
      ex({ id: 2, side: 'SELL', qty: '100', price: '110', executedAt: t }),
      ex({ id: 1, side: 'BUY', qty: '100', price: '100', executedAt: t }),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].executions.map((e) => e.id)).toEqual([1, 2]);
  });
});

describe('buildRoundsForGroup: FX 換算', () => {
  it('fx-realized-pnl: USD 建ての pnl を各約定の fxRateToJpy で按分', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '10', price: '100', fxRateToJpy: '150' }),
      // 部分決済 1: fx=151
      ex({ side: 'SELL', qty: '5', price: '110', fxRateToJpy: '151' }),
      // 部分決済 2: fx=152
      ex({ side: 'SELL', qty: '5', price: '120', fxRateToJpy: '152' }),
    ]);
    expect(rounds).toHaveLength(1);
    // USD PnL: (110-100)*5 + (120-100)*5 = 50 + 100 = 150
    expect(rounds[0].realizedPnl).toBe('150');
    // JPY PnL: 50*151 + 100*152 = 7550 + 15200 = 22750
    expect(rounds[0].realizedPnlJpy).toBe('22750');
  });
});

describe('buildRoundsForGroup: クロス日', () => {
  it('cross-day-hold: 日跨ぎで holdSeconds 正しい', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '100', price: '100', executedAt: new Date('2026-05-14T00:00:00Z') }),
      ex({ side: 'SELL', qty: '100', price: '110', executedAt: new Date('2026-05-16T00:00:00Z') }),
    ]);
    expect(rounds[0].holdSeconds).toBe(2 * 86400);
  });

  it('未クローズ: 最後にポジションが残っていても返す', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '100', price: '100' }),
      ex({ side: 'SELL', qty: '50', price: '110' }),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].closedAt).toBeNull();
    expect(rounds[0].holdSeconds).toBeNull();
    // 半分決済で実現 PnL は (110-100)*50 = 500
    expect(rounds[0].realizedPnl).toBe('500');
  });
});

describe('buildRoundsForGroup: 手数料', () => {
  it('全約定の fee + tax が feesTotal に累積', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '100', price: '100', fee: '100', tax: '10' }),
      ex({ side: 'SELL', qty: '100', price: '110', fee: '120', tax: '12' }),
    ]);
    expect(rounds[0].feesTotal).toBe('242'); // 100+10+120+12
  });
});

describe('buildRoundsForGroup: オプション multiplier', () => {
  it('option-long: multiplier=100 で realizedPnl が 100 倍', () => {
    // 1 契約を $5 で買って $7 で売る → (7-5) * 1 * 100 = $200
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '1', price: '5', multiplier: '100' }),
      ex({ side: 'SELL', qty: '1', price: '7', multiplier: '100' }),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].realizedPnl).toBe('200');
  });

  it('option-short: multiplier=100 のショートも 100 倍', () => {
    // 1 契約を $5 で売って $3 で買い戻し → (5-3) * 1 * 100 = $200
    const rounds = buildRoundsForGroup([
      ex({ side: 'SELL', qty: '1', price: '5', multiplier: '100' }),
      ex({ side: 'BUY', qty: '1', price: '3', multiplier: '100' }),
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].direction).toBe('SELL');
    expect(rounds[0].realizedPnl).toBe('200');
  });

  it('option-fx: multiplier 適用後に fxRateToJpy で JPY 換算', () => {
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '2', price: '5', multiplier: '100', fxRateToJpy: '150' }),
      ex({ side: 'SELL', qty: '2', price: '8', multiplier: '100', fxRateToJpy: '151' }),
    ]);
    expect(rounds).toHaveLength(1);
    // USD PnL: (8-5) * 2 * 100 = 600
    expect(rounds[0].realizedPnl).toBe('600');
    // JPY PnL: 600 * 151 = 90600
    expect(rounds[0].realizedPnlJpy).toBe('90600');
  });

  it('multiplier 未指定はデフォルト 1 (現物互換)', () => {
    // 既存テストとの互換確認: multiplier プロパティ無しなら従来通り
    const rounds = buildRoundsForGroup([
      ex({ side: 'BUY', qty: '100', price: '100' }),
      ex({ side: 'SELL', qty: '100', price: '110' }),
    ]);
    expect(rounds[0].realizedPnl).toBe('1000');
  });
});
