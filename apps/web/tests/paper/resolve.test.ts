import { describe, expect, it } from 'vitest';
import { barPrice, manualResolution, resolveOrder, type BarLite, type ResolveOrder } from '@/lib/paper/resolve';

const jst = (hms: string, day = '2026-10-05') => new Date(`${day}T${hms}+09:00`);
const bar = (hm: string, low: number, high: number, close = (low + high) / 2, open = close): BarLite => ({
  ts: jst(`${hm}:00`),
  open,
  high,
  low,
  close,
});
const daily = (low: number, high: number, open = low): BarLite => ({ ts: jst('00:00:00'), open, high, low, close: high });

function mkt(p: Partial<ResolveOrder>): ResolveOrder {
  return {
    orderType: 'market',
    side: 'buy',
    limitPrice: null,
    placedAt: jst('10:00:30.000'),
    state: 'MARKET',
    fillMarkedAt: null,
    shotPrice: '1000',
    ...p,
  };
}
function lmt(p: Partial<ResolveOrder>): ResolveOrder {
  return {
    orderType: 'limit',
    side: 'buy',
    limitPrice: '990',
    placedAt: jst('10:00:30.000'),
    state: 'PENDING',
    fillMarkedAt: null,
    shotPrice: '1000',
    ...p,
  };
}

describe('規則 1: 寄り前の成行', () => {
  it('日足があれば始値で確定（OPEN_AUCTION）', () => {
    const r = resolveOrder(mkt({ placedAt: jst('08:59:59.999') }), [], daily(990, 1020, 1001));
    expect(r).toMatchObject({ kind: 'FILL', price: '1001', priceStatus: 'CONFIRMED', priceBasis: 'OPEN_AUCTION' });
  });
  it('約定時刻は発注時刻ではなく寄り（09:00 JST）', () => {
    const r = resolveOrder(mkt({ placedAt: jst('08:55:00.000') }), [], daily(990, 1020, 1001));
    expect(r.kind === 'FILL' && r.executedAt.toISOString()).toBe(jst('09:00:00.000').toISOString());
    const u = resolveOrder(mkt({ placedAt: jst('08:30:00.000') }), [], null);
    expect(u.kind === 'FILL' && u.executedAt.toISOString()).toBe(jst('09:00:00.000').toISOString());
  });
  it('日足が無ければ未確定', () => {
    const r = resolveOrder(mkt({ placedAt: jst('08:30:00.000') }), [], null);
    expect(r).toMatchObject({ kind: 'FILL', price: null, priceStatus: 'UNRESOLVED', priceBasis: null });
  });
  it('09:00:00.000 ちょうどは寄り前ではない（規則 2）', () => {
    const r = resolveOrder(mkt({ placedAt: jst('09:00:00.000'), shotPrice: '1005' }), [bar('09:00', 1000, 1010)], daily(990, 1020, 1001));
    expect(r).toMatchObject({ priceStatus: 'CONFIRMED', priceBasis: 'SCREEN', price: '1005' });
  });
});

describe('規則 2: ザラ場の成行', () => {
  it('その分の分足の [low, high] 内なら画面の価格で確定', () => {
    const r = resolveOrder(mkt({}), [bar('10:00', 995, 1005)], null);
    expect(r).toMatchObject({ price: '1000', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN' });
  });
  it('境界（low / high と同値）は範囲内', () => {
    expect(resolveOrder(mkt({ shotPrice: '995' }), [bar('10:00', 995, 1005)], null)).toMatchObject({ priceStatus: 'CONFIRMED' });
    expect(resolveOrder(mkt({ shotPrice: '1005' }), [bar('10:00', 995, 1005)], null)).toMatchObject({ priceStatus: 'CONFIRMED' });
  });
  it('範囲外ならその分の終値を仮置きして要確認（BAR）', () => {
    const r = resolveOrder(mkt({ shotPrice: '1100' }), [bar('10:00', 995, 1005, 1003)], daily(900, 1200));
    expect(r).toMatchObject({ price: '1003', priceStatus: 'NEEDS_REVIEW', priceBasis: 'BAR' });
    expect((r as { priceNote: string }).priceNote).toMatch(/1100/);
  });
  it('分足が無ければ日足の範囲で照合して確定', () => {
    const r = resolveOrder(mkt({}), [bar('09:59', 995, 1005)], daily(950, 1050));
    expect(r).toMatchObject({ price: '1000', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN' });
  });
  it('分足が無く日足の範囲外なら未確定', () => {
    const r = resolveOrder(mkt({ shotPrice: '2000' }), [], daily(950, 1050));
    expect(r).toMatchObject({ price: null, priceStatus: 'UNRESOLVED' });
  });
  it('分足も日足も無ければ未確定', () => {
    const r = resolveOrder(mkt({}), [], null);
    expect(r).toMatchObject({ price: null, priceStatus: 'UNRESOLVED' });
  });
  it('画面の価格が読めなければ分足の終値を仮置きして要確認', () => {
    const r = resolveOrder(mkt({ shotPrice: null }), [bar('10:00', 995, 1005, 1001.5)], daily(950, 1050));
    expect(r).toMatchObject({ price: '1001.5', priceStatus: 'NEEDS_REVIEW', priceBasis: 'BAR' });
  });
  it('画面の価格が読めず分足も無ければ未確定（日足があっても）', () => {
    const r = resolveOrder(mkt({ shotPrice: null }), [], daily(950, 1050));
    expect(r).toMatchObject({ price: null, priceStatus: 'UNRESOLVED' });
  });
  it('約定時刻は発注時刻', () => {
    const r = resolveOrder(mkt({}), [bar('10:00', 995, 1005)], null);
    expect((r as { executedAt: Date }).executedAt).toEqual(jst('10:00:30.000'));
  });
  it('売りの成行も同じ規則', () => {
    const r = resolveOrder(mkt({ side: 'sell' }), [bar('10:00', 995, 1005)], null);
    expect(r).toMatchObject({ priceStatus: 'CONFIRMED', price: '1000' });
  });
});

describe('規則 3: 指値', () => {
  it('取消済みは約定しない（即約定できる指値でも本人の取消を優先）', () => {
    expect(resolveOrder(lmt({ state: 'CANCELLED', limitPrice: '1010' }), [], null)).toEqual({ kind: 'NO_FILL', reason: 'CANCELLED' });
  });
  it('買い: 指値 ≥ 現在値なら発注時刻・現在値で即約定（指値ではない）', () => {
    const r = resolveOrder(lmt({ limitPrice: '1010' }), [bar('10:00', 995, 1005)], null);
    expect(r).toMatchObject({ executedAt: jst('10:00:30.000'), price: '1000', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN' });
  });
  it('売り: 指値 ≤ 現在値なら現在値で即約定', () => {
    const r = resolveOrder(lmt({ side: 'sell', limitPrice: '990' }), [bar('10:00', 995, 1005)], null);
    expect(r).toMatchObject({ price: '1000', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN' });
  });
  it('即約定の指値で現在値が足の外なら終値を仮置きし、指値で頭打ち', () => {
    const r = resolveOrder(lmt({ limitPrice: '1002' }), [bar('10:00', 1001, 1009, 1008)], null);
    expect(r).toMatchObject({ price: '1002', priceStatus: 'NEEDS_REVIEW', priceBasis: 'BAR' });
    expect((r as { priceNote: string }).priceNote).toMatch(/頭打ち/);
  });
  it('即約定は fill_mark より優先（発注時刻で約定）', () => {
    const r = resolveOrder(lmt({ limitPrice: '1001', state: 'FILL_MARKED', fillMarkedAt: jst('10:30:00.000') }), [bar('10:00', 995, 1005)], null);
    expect(r).toMatchObject({ executedAt: jst('10:00:30.000'), priceStatus: 'CONFIRMED' });
  });
  it('画面の価格が読めない指値は即約定扱いにしない', () => {
    expect(resolveOrder(lmt({ shotPrice: null, limitPrice: '5000' }), [], null)).toEqual({ kind: 'NO_FILL', reason: 'PENDING' });
  });
  it('fill_mark が無い指値: 待機中と失効', () => {
    expect(resolveOrder(lmt({}), [], null)).toEqual({ kind: 'NO_FILL', reason: 'PENDING' });
    expect(resolveOrder(lmt({ state: 'EXPIRED' }), [], null)).toEqual({ kind: 'NO_FILL', reason: 'EXPIRED' });
  });

  const marked = (p: Partial<ResolveOrder> = {}) =>
    lmt({ state: 'FILL_MARKED', fillMarkedAt: jst('10:03:10.000'), ...p });
  const window = (lowAt0202: number) => [
    bar('10:00', 995, 1005),
    bar('10:01', 992, 1000),
    bar('10:02', lowAt0202, 1000),
    bar('10:03', 991, 999),
  ];

  it('買い: 発注〜fill_mark の分足の low が指値を下回れば fill_mark 時刻・指値で確定', () => {
    const r = resolveOrder(marked(), window(989), null);
    expect(r).toMatchObject({ executedAt: jst('10:03:10.000'), price: '990', priceStatus: 'CONFIRMED', priceBasis: 'LIMIT' });
  });
  it('売り: high が指値を上回れば確定', () => {
    const r = resolveOrder(marked({ side: 'sell', limitPrice: '1004', shotPrice: '1000' }), window(990), null);
    expect(r).toMatchObject({ price: '1004', priceStatus: 'CONFIRMED' });
  });
  it('同値（low == 指値）は越えていない → 足が揃っていれば要確認（指値を仮置き）', () => {
    const r = resolveOrder(marked(), window(990), null);
    expect(r).toMatchObject({ price: '990', priceStatus: 'NEEDS_REVIEW', priceBasis: 'LIMIT' });
  });
  it('越えておらず連続売買の分足が欠けていれば未確定', () => {
    const bars = window(991).filter((b) => b.ts.getTime() !== jst('10:02:00').getTime());
    const r = resolveOrder(marked(), bars, null);
    expect(r).toMatchObject({ price: null, priceStatus: 'UNRESOLVED', priceBasis: null });
    expect((r as { priceNote: string }).priceNote).toMatch(/1 本欠け/);
  });
  it('欠けがあっても越えた足があれば確定', () => {
    const bars = [bar('10:00', 995, 1005), bar('10:03', 980, 999)];
    expect(resolveOrder(marked(), bars, null)).toMatchObject({ priceStatus: 'CONFIRMED' });
  });
  it('昼休み・引けの板寄せの分は欠けに数えない', () => {
    const r1 = resolveOrder(
      marked({ placedAt: jst('11:29:10.000'), fillMarkedAt: jst('12:30:20.000') }),
      [bar('11:29', 995, 1000), bar('12:30', 991, 1000)],
      null,
    );
    expect(r1).toMatchObject({ priceStatus: 'NEEDS_REVIEW' });
    const r2 = resolveOrder(
      marked({ placedAt: jst('15:24:10.000'), fillMarkedAt: jst('15:31:00.000') }),
      [bar('15:24', 995, 1000)],
      null,
    );
    expect(r2).toMatchObject({ priceStatus: 'NEEDS_REVIEW' });
  });
  it('窓の外の足は見ない（発注の分より前・fill_mark の分より後）', () => {
    const bars = [bar('09:59', 900, 1000), bar('10:00', 995, 1005), bar('10:01', 991, 1000), bar('10:02', 900, 1000)];
    const r = resolveOrder(marked({ fillMarkedAt: jst('10:01:59.999') }), bars, null);
    expect(r).toMatchObject({ priceStatus: 'NEEDS_REVIEW' });
  });
  it('発注と fill_mark が同じ分でもその分の足を見る', () => {
    const r = resolveOrder(marked({ fillMarkedAt: jst('10:00:50.000') }), [bar('10:00', 985, 1005)], null);
    expect(r).toMatchObject({ priceStatus: 'CONFIRMED' });
  });
});

describe('規則 4: 手入力', () => {
  it('MANUAL で確定', () => {
    expect(manualResolution('1234.5')).toEqual({ price: '1234.5', priceStatus: 'CONFIRMED', priceBasis: 'MANUAL', priceNote: '手入力で確定' });
  });
  it('不正な価格は例外', () => {
    expect(() => manualResolution('0')).toThrow();
    expect(() => manualResolution('1,000')).toThrow();
    expect(() => manualResolution('-5')).toThrow();
  });
});

describe('barPrice', () => {
  it('浮動小数の誤差を落とす', () => {
    expect(barPrice(1666.8000000000002)).toBe('1666.8');
    expect(barPrice(2856.5)).toBe('2856.5');
  });
});

describe('板寄せの時間帯（寄り前・昼休み・引け）', () => {
  it('昼休みの成行は 12:30 の分足始値・12:30 で確定', () => {
    const r = resolveOrder(mkt({ placedAt: jst('11:45:00.000') }), [bar('12:30', 990, 1010, 1000, 1003)], daily(980, 1020));
    expect(r).toMatchObject({ executedAt: jst('12:30:00.000'), price: '1003', priceStatus: 'CONFIRMED', priceBasis: 'OPEN_AUCTION' });
  });
  it('昼休みの成行で 12:30 の足が無ければ未確定', () => {
    const r = resolveOrder(mkt({ placedAt: jst('11:30:00.000') }), [], daily(980, 1020));
    expect(r).toMatchObject({ executedAt: jst('12:30:00.000'), price: null, priceStatus: 'UNRESOLVED' });
  });
  it('11:29 台の成行は連続売買（規則 2）', () => {
    const r = resolveOrder(mkt({ placedAt: jst('11:29:59.999') }), [bar('11:29', 995, 1005)], null);
    expect(r).toMatchObject({ priceBasis: 'SCREEN', price: '1000' });
  });
  it('15:25〜15:29 の成行は日足終値・15:30（CLOSE_AUCTION）', () => {
    const r = resolveOrder(mkt({ placedAt: jst('15:27:10.000') }), [], daily(980, 1020));
    expect(r).toMatchObject({ executedAt: jst('15:30:00.000'), price: '1020', priceStatus: 'CONFIRMED', priceBasis: 'CLOSE_AUCTION' });
  });
  it('大引け後の成行は未確定', () => {
    const r = resolveOrder(mkt({ placedAt: jst('15:30:00.000') }), [], daily(980, 1020));
    expect(r).toMatchObject({ price: null, priceStatus: 'UNRESOLVED' });
  });
  it('寄り前の買い指値: 始値 ≤ 指値なら始値・09:00 で確定（画面の値では即約定にしない）', () => {
    const r = resolveOrder(lmt({ placedAt: jst('08:50:00.000'), limitPrice: '1001', shotPrice: '900', state: 'EXPIRED' }), [], daily(990, 1020, 1001));
    expect(r).toMatchObject({ executedAt: jst('09:00:00.000'), price: '1001', priceStatus: 'CONFIRMED', priceBasis: 'OPEN_AUCTION' });
  });
  it('寄り前の買い指値: 始値 > 指値なら寄りでは約定せず、以降は通常の指値', () => {
    const o = lmt({ placedAt: jst('08:50:00.000'), limitPrice: '1000', shotPrice: '900' });
    expect(resolveOrder(o, [], daily(990, 1020, 1001))).toEqual({ kind: 'NO_FILL', reason: 'PENDING' });
    const f = resolveOrder({ ...o, state: 'FILL_MARKED', fillMarkedAt: jst('09:10:00.000') }, [bar('09:05', 998, 1004)], daily(990, 1020, 1001));
    expect(f).toMatchObject({ price: '1000', priceStatus: 'CONFIRMED', priceBasis: 'LIMIT' });
  });
  it('寄り前の売り指値: 始値 ≥ 指値なら始値で確定', () => {
    const r = resolveOrder(lmt({ side: 'sell', placedAt: jst('08:50:00.000'), limitPrice: '1000', shotPrice: null }), [], daily(990, 1020, 1001));
    expect(r).toMatchObject({ price: '1001', priceBasis: 'OPEN_AUCTION' });
  });
});
