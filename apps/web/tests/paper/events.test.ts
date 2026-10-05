import { describe, expect, it } from 'vitest';
import { deriveOrderState, parseEventLine, parseEventsText, type OrderEvent } from '@/lib/paper/events';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const POS = U(900);
function order(p: Record<string, unknown> = {}) {
  return {
    v: 1,
    id: U(1),
    type: 'order',
    ts: '2026-10-05T10:00:30.123+09:00',
    position_id: POS,
    intent: 'open',
    symbol: '7203',
    side: 'buy',
    qty: '100',
    order_type: 'market',
    limit_price: null,
    shot: { path: 'shots/2026-10-05/x.png', price_text: '2,856.5', price: '2856.5', symbol_text: '7203', confidence: 0.98 },
    ...p,
  };
}
const line = (o: unknown) => JSON.stringify(o);
const errOf = (o: unknown) => {
  const r = parseEventLine(typeof o === 'string' ? o : line(o), 1);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error.message;
};

describe('parseEventLine: 正常系', () => {
  it('order（成行・shot あり）', () => {
    const r = parseEventLine(line(order()), 3);
    expect(r.ok).toBe(true);
    if (!r.ok || r.event.type !== 'order') return;
    expect(r.event.ts.toISOString()).toBe('2026-10-05T01:00:30.123Z');
    expect(r.event.shot).toEqual({ path: 'shots/2026-10-05/x.png', priceText: '2,856.5', price: '2856.5', symbolText: '7203', confidence: 0.98 });
    expect(r.event.line).toBe(3);
  });
  it('order（指値・shot null・英字入りコード・大文字 UUID）', () => {
    const r = parseEventLine(line(order({ id: U(1).toUpperCase(), symbol: '285A', order_type: 'limit', limit_price: '1234.5', shot: null })), 1);
    expect(r.ok).toBe(true);
  });
  it('fill_mark / cancel / memo（order_id 省略・null・あり）', () => {
    const base = { v: 1, ts: '2026-10-05T10:01:00.000+09:00' };
    expect(parseEventLine(line({ ...base, id: U(2), type: 'fill_mark', order_id: U(1) }), 1).ok).toBe(true);
    expect(parseEventLine(line({ ...base, id: U(3), type: 'cancel', order_id: U(1) }), 1).ok).toBe(true);
    expect(parseEventLine(line({ ...base, id: U(4), type: 'memo', position_id: POS, text: 'あ' }), 1).ok).toBe(true);
    expect(parseEventLine(line({ ...base, id: U(5), type: 'memo', position_id: POS, order_id: null, text: '' }), 1).ok).toBe(true);
    expect(parseEventLine(line({ ...base, id: U(6), type: 'memo', position_id: POS, order_id: U(1), text: 'x' }), 1).ok).toBe(true);
  });
});

describe('parseEventLine: 契約違反', () => {
  it('JSON でない・オブジェクトでない', () => {
    expect(errOf('{oops')).toMatch(/JSON/);
    expect(errOf('[1]')).toMatch(/オブジェクト/);
  });
  it('バージョン違い・未知の type', () => {
    expect(errOf(order({ v: 2 }))).toMatch(/バージョン/);
    expect(errOf(order({ type: 'fill' }))).toMatch(/未知の type/);
  });
  it('必須キーの欠け・契約に無いキー', () => {
    const o = order();
    delete (o as Record<string, unknown>).shot;
    expect(errOf(o)).toMatch(/shot が無い/);
    expect(errOf(order({ note: 'x' }))).toMatch(/契約に無いキー: note/);
  });
  it('ts: ミリ秒なし・UTC 表記・不正日付', () => {
    expect(errOf(order({ ts: '2026-10-05T10:00:30+09:00' }))).toMatch(/ts/);
    expect(errOf(order({ ts: '2026-10-05T01:00:30.000Z' }))).toMatch(/ts/);
    expect(errOf(order({ ts: '2026-13-45T10:00:30.000+09:00' }))).toMatch(/ts/);
  });
  it('id・position_id が UUID でない', () => {
    expect(errOf(order({ id: 'abc' }))).toMatch(/id/);
    expect(errOf(order({ position_id: 1 }))).toMatch(/position_id/);
  });
  it('数量: 0・小数・数値型', () => {
    expect(errOf(order({ qty: '0' }))).toMatch(/qty/);
    expect(errOf(order({ qty: '1.5' }))).toMatch(/qty/);
    expect(errOf(order({ qty: 100 }))).toMatch(/qty/);
  });
  it('銘柄コード・intent・side・order_type', () => {
    expect(errOf(order({ symbol: '7203.T' }))).toMatch(/symbol/);
    expect(errOf(order({ intent: 'buy' }))).toMatch(/intent/);
    expect(errOf(order({ side: 'BUY' }))).toMatch(/side/);
    expect(errOf(order({ order_type: 'stop' }))).toMatch(/order_type/);
  });
  it('指値と limit_price の整合', () => {
    expect(errOf(order({ order_type: 'limit', limit_price: null }))).toMatch(/limit_price が null/);
    expect(errOf(order({ limit_price: '100' }))).toMatch(/成行なのに/);
    expect(errOf(order({ order_type: 'limit', limit_price: '1,000' }))).toMatch(/limit_price/);
    expect(errOf(order({ order_type: 'limit', limit_price: 1000 }))).toMatch(/limit_price/);
    expect(errOf(order({ order_type: 'limit', limit_price: '0' }))).toMatch(/0 以下/);
  });
  it('shot の中身', () => {
    const shot = { path: 'a.png', price_text: null, price: null, symbol_text: null, confidence: null };
    expect(parseEventLine(line(order({ shot })), 1).ok).toBe(true);
    expect(errOf(order({ shot: { ...shot, confidence: 1.2 } }))).toMatch(/confidence/);
    expect(errOf(order({ shot: { ...shot, price: '2,856' } }))).toMatch(/price/);
    expect(errOf(order({ shot: { ...shot, path: '/etc/passwd' } }))).toMatch(/相対パス/);
    expect(errOf(order({ shot: { ...shot, path: '../x.png' } }))).toMatch(/相対パス/);
    expect(errOf(order({ shot: { ...shot, extra: 1 } }))).toMatch(/shot\.契約に無いキー/);
    expect(errOf(order({ shot: 'x' }))).toMatch(/shot/);
  });
  it('エラーに id を添える（読めた場合）', () => {
    const r = parseEventLine(line(order({ qty: '0' })), 7);
    expect(r.ok ? null : r.error).toEqual({ line: 7, id: U(1), message: expect.stringMatching(/qty/) });
  });
});

describe('parseEventsText: ファイル全体の整合', () => {
  const ts = (hms: string) => `2026-10-05T${hms}.000+09:00`;
  const lim = (n: number, p: Record<string, unknown> = {}) =>
    order({ id: U(n), ts: ts('10:00:00'), order_type: 'limit', limit_price: '990', ...p });
  const ev = (n: number, type: string, p: Record<string, unknown>) => ({ v: 1, id: U(n), type, ts: ts('10:05:00'), ...p });

  it('違反行だけ捨てて他の行は続ける・空行は無視', () => {
    const text = [line(order()), '', '{broken', line(ev(2, 'memo', { position_id: POS, text: 'メモ' })), ''].join('\n');
    const r = parseEventsText(text);
    expect(r.orders).toHaveLength(1);
    expect(r.memos).toHaveLength(1);
    expect(r.errors).toEqual([{ line: 3, id: null, message: expect.any(String) }]);
    expect(r.accepted.map((e) => e.id)).toEqual([U(1), U(2)]);
  });
  it('同じ id・同じ内容の重複は黙って無視、内容が違えばエラー（先の行を採用）', () => {
    const a = line(order());
    const r1 = parseEventsText([a, a].join('\n'));
    expect(r1.orders).toHaveLength(1);
    expect(r1.errors).toEqual([]);
    const r2 = parseEventsText([a, line(order({ qty: '200' }))].join('\n'));
    expect(r2.orders).toHaveLength(1);
    expect(r2.orders[0].qty).toBe('100');
    expect(r2.errors[0].message).toMatch(/重複/);
  });
  it('open の position_id の再利用・建玉の無い add/close', () => {
    const r = parseEventsText(
      [
        line(order()),
        line(order({ id: U(2) })),
        line(order({ id: U(3), position_id: U(901), intent: 'close', side: 'sell' })),
        line(order({ id: U(4), position_id: U(902), intent: 'add' })),
      ].join('\n'),
    );
    expect(r.orders).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
  });
  it('add は同じ方向・close は逆方向・銘柄は建玉と同じ', () => {
    const r = parseEventsText(
      [
        line(order()),
        line(order({ id: U(2), intent: 'add', side: 'sell' })),
        line(order({ id: U(3), intent: 'close', side: 'buy' })),
        line(order({ id: U(4), intent: 'close', side: 'sell', symbol: '6758' })),
        line(order({ id: U(5), intent: 'add', side: 'buy' })),
        line(order({ id: U(6), intent: 'close', side: 'sell', qty: '200' })),
        // 指値が約定しなかった後の再発注を弾かない（数量は約定ベースで見る）
        line(order({ id: U(7), intent: 'close', side: 'sell', qty: '200' })),
      ].join('\n'),
    );
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(r.orders.map((o) => o.id)).toEqual([U(1), U(5), U(6), U(7)]);
  });
  it('空売り（open + sell）と、その close（buy）', () => {
    const r = parseEventsText([line(order({ side: 'sell' })), line(order({ id: U(2), intent: 'close', side: 'buy' }))].join('\n'));
    expect(r.errors).toEqual([]);
  });
  it('fill_mark / cancel の参照先と重複', () => {
    const r = parseEventsText(
      [
        line(order()), // 成行
        line(lim(2, { position_id: U(901) })),
        line(ev(3, 'fill_mark', { order_id: U(1) })), // 成行への fill_mark
        line(ev(4, 'fill_mark', { order_id: U(99) })), // 存在しない注文
        line(ev(5, 'fill_mark', { order_id: U(2) })),
        line(ev(6, 'fill_mark', { order_id: U(2) })), // 二重
        line(ev(7, 'cancel', { order_id: U(2) })), // 約定後の取消
        line(ev(8, 'cancel', { order_id: U(2), ts: ts('09:00:00') })),
      ].join('\n'),
    );
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 6, 7, 8]);
    expect(r.fillMarks.get(U(2))?.id).toBe(U(5));
    expect(r.cancels.size).toBe(0);
  });
  it('発注より前の時刻の fill_mark はエラー', () => {
    const r = parseEventsText([line(lim(1)), line(ev(2, 'fill_mark', { order_id: U(1), ts: ts('09:59:59') }))].join('\n'));
    expect(r.errors[0].message).toMatch(/発注より前/);
  });
  it('fill_mark が order より前の行にあるとエラー（追記順を守る）', () => {
    const r = parseEventsText([line(ev(2, 'fill_mark', { order_id: U(1) })), line(lim(1))].join('\n'));
    expect(r.errors.map((e) => e.line)).toEqual([1]);
  });
  it('memo: 建玉が無い・order_id が別建玉の注文', () => {
    const r = parseEventsText(
      [
        line(order()),
        line(order({ id: U(2), position_id: U(901) })),
        line(ev(3, 'memo', { position_id: U(950), text: 'x' })),
        line(ev(4, 'memo', { position_id: POS, order_id: U(2), text: 'x' })),
        line(ev(5, 'memo', { position_id: POS, order_id: U(77), text: 'x' })),
        line(ev(6, 'memo', { position_id: POS, order_id: U(1), text: 'ok' })),
      ].join('\n'),
    );
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5]);
    expect(r.memos.map((m) => m.text)).toEqual(['ok']);
  });
});

describe('注文の状態', () => {
  const base = parseEventLine(line(order({ order_type: 'limit', limit_price: '2800' })), 1);
  const o = (base.ok ? base.event : null) as OrderEvent;
  const close = new Date('2026-10-05T15:30:00.000+09:00');
  it('成行は MARKET', () => {
    const m = parseEventLine(line(order()), 1);
    expect(deriveOrderState((m.ok ? m.event : null) as OrderEvent, undefined, undefined, close)).toBe('MARKET');
  });
  it('fill_mark → FILL_MARKED、cancel → CANCELLED', () => {
    expect(deriveOrderState(o, {} as never, undefined, close)).toBe('FILL_MARKED');
    expect(deriveOrderState(o, undefined, {} as never, close)).toBe('CANCELLED');
  });
  it('発注日の 15:30 JST ちょうどで EXPIRED、それより前は PENDING', () => {
    expect(deriveOrderState(o, undefined, undefined, new Date(close.getTime() - 1))).toBe('PENDING');
    expect(deriveOrderState(o, undefined, undefined, close)).toBe('EXPIRED');
  });
  it('追加2: 生の shot.price で即約定に見える指値も、状態は時刻だけで決める（引け後は EXPIRED。即約定かは resolve が検証済みの現在値で決める）', () => {
    const m = { ...o, limitPrice: '2900' };
    expect(deriveOrderState(m, undefined, undefined, new Date(close.getTime() - 1))).toBe('PENDING');
    expect(deriveOrderState(m, undefined, undefined, new Date(close.getTime() + 86400_000))).toBe('EXPIRED');
  });
  it('寄り前の指値は画面の値で即約定扱いにしない（引け後は EXPIRED。寄りでの約定は resolve 側）', () => {
    const m = { ...o, limitPrice: '2900', ts: new Date('2026-10-05T08:50:00.000+09:00') };
    expect(deriveOrderState(m, undefined, undefined, close)).toBe('EXPIRED');
  });
});
