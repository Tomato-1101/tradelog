// 本番の注文記録 v2（board_order / real_note）のパースと、結び付け・要約の対象選びの規則（純粋関数）。DB を通す確認は board-flow.test.ts
import { describe, expect, it } from 'vitest';
import { parseRealEvents } from '@/lib/real/memos';
import { FILL_WINDOW_SEC, NOTE_WINDOW_SEC, assignFills, pickNoteBySymbol, pickNoteExecution, type DayCandidate, type FillCandidate, type FillOrder } from '@/lib/real/board';
import { SUMMARY_MIN_CHARS, pickNotesToSummarize } from '@/lib/real/summarize';

const order = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 2,
    type: 'board_order',
    id: 'o1',
    ts: '2026-11-11T10:36:33.073+09:00',
    order_key: 'k1',
    event: 'placed',
    side: 'BUY',
    price: 5870.8,
    qty: 100,
    pending_ms: 120,
    symbol: '6976',
    symbol_name: '太陽誘電',
    board: [{ price: 5871, sell: 300, buy: null, sell_count: 2, buy_count: null, my_sell: null, my_buy: null }, { price: null, label: 'UNDER', sell: null, buy: 1000 }],
    ...o,
  });
const note = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 2,
    type: 'real_note',
    id: 'n1',
    ts: '2026-11-11T10:36:40.000+09:00',
    text: '押し目で買った',
    last_order: { order_key: 'k1', event: 'placed', side: 'BUY', price: 5870.8, ts: '2026-11-11T10:36:33.073+09:00' },
    ...o,
  });
const memo = JSON.stringify({ v: 1, type: 'real_memo', id: 'm1', ts: '2026-11-11T09:21:32.123+09:00', tags: [], shots: [], active_window_title: 'x' });

describe('parseRealEvents（v1 と v2 の混在）', () => {
  it('v1 の real_memo と v2 の board_order / real_note を振り分け、test・書きかけ・契約違反は取り込まない', () => {
    const text = [
      memo,
      order(),
      order({ id: 'o2', event: 'filled', price: null, qty: null, pending_ms: null, symbol: null, symbol_name: null }),
      order({ id: 'o3', symbol: undefined, symbol_name: undefined }), // 欄が無いのは null として読む
      note(),
      note({ id: 'n2', last_order: null }),
      order({ id: 'o-test', test: true }),
      note({ id: 'n-test', test: true }),
      '{"v":2,"type":"board_order","id":"o-half"',
      order({ id: 'bad-event', event: 'moved' }),
      order({ id: 'bad-side', side: 'LONG' }),
      order({ id: 'bad-price', price: '5870' }),
      order({ id: 'bad-board', board: null }),
      order({ id: 'bad-key', order_key: '' }),
      note({ id: 'bad-text', text: '  ' }),
      note({ id: 'bad-lo', last_order: { event: 'placed' } }),
      note({ id: 'bad-ts', ts: '2026-11-11T10:36:40+09:00' }),
      JSON.stringify({ v: 2, type: 'other', id: 'x' }),
      JSON.stringify({ v: 3, type: 'board_order', id: 'y' }),
    ].join('\n');
    const r = parseRealEvents(text);
    expect({ lines: r.lines, test: r.test, partial: r.partial, memos: r.memos.map((m) => m.id) }).toEqual({ lines: 19, test: 2, partial: 1, memos: ['m1'] });
    expect(r.boardOrders.map((o) => [o.id, o.event, o.price, o.qty, o.symbol])).toEqual([
      ['o1', 'placed', 5870.8, 100, '6976'],
      ['o2', 'filled', null, null, null],
      ['o3', 'placed', 5870.8, 100, null],
    ]);
    expect(r.boardOrders[0]).toMatchObject({ orderKey: 'k1', side: 'BUY', pendingMs: 120, symbolName: '太陽誘電' });
    expect(r.boardOrders[0].ts.toISOString()).toBe('2026-11-11T01:36:33.073Z');
    expect(r.boardOrders[0].board).toHaveLength(2);
    expect(r.notes.map((n) => [n.id, n.text, n.lastOrder?.order_key ?? null])).toEqual([
      ['n1', '押し目で買った', 'k1'],
      ['n2', '押し目で買った', null],
    ]);
    expect(r.errors.map((e) => [e.line, e.id])).toEqual([
      [10, 'bad-event'],
      [11, 'bad-side'],
      [12, 'bad-price'],
      [13, 'bad-board'],
      [14, 'bad-key'],
      [15, 'bad-text'],
      [16, 'bad-lo'],
      [17, 'bad-ts'],
      [18, 'x'],
      [19, 'y'],
    ]);
  });
});

describe('assignFills', () => {
  const t0 = new Date('2026-11-11T01:00:00.000Z');
  const o = (id: string, sec: number, x: Partial<FillOrder> = {}): FillOrder => ({ id, ts: new Date(t0.getTime() + sec * 1000), side: 'BUY', price: '5870.8', symbol: '6976', ...x });
  const e = (id: string, sec: number, x: Partial<FillCandidate> = {}): FillCandidate => ({ id, executedAt: new Date(t0.getTime() + sec * 1000), side: 'BUY', price: '5870.8', symbol: '6976', ...x });
  const pick = (os: FillOrder[], es: FillCandidate[]) => Object.fromEntries([...assignFills(os, es)].map(([k, v]) => [k, [v.executionId, v.deltaMs]]));

  it(`同じ銘柄・売買・値段で、時刻差 ${FILL_WINDOW_SEC} 秒以内の最も近い約定（境界ちょうどは入る）`, () => {
    expect(pick([o('a', 0)], [e('far', 10), e('near', -3)])).toEqual({ a: ['near', -3000] });
    expect(pick([o('a', 0)], [e('edge', FILL_WINDOW_SEC)])).toEqual({ a: ['edge', 15000] });
    expect(pick([o('a', 0)], [e('out', FILL_WINDOW_SEC + 0.001), e('out2', -FILL_WINDOW_SEC - 1)])).toEqual({});
  });

  it('売買方向・値段・銘柄が違う約定には結び付けない。値段は 10 進数として比べる', () => {
    expect(pick([o('a', 0)], [e('sell', 1, { side: 'SELL' }), e('px', 1, { price: '5871' }), e('sym', 1, { symbol: '7203' }), e('nopx', 1, { price: null })])).toEqual({});
    expect(pick([o('a', 0, { price: '5870.80' })], [e('x', 1)])).toEqual({ a: ['x', 1000] });
  });

  it('値段が読めなかった注文は結び付けない。symbol が null なら銘柄を問わず値段で', () => {
    expect(pick([o('a', 0, { price: null })], [e('x', 1)])).toEqual({});
    expect(pick([o('a', 0, { symbol: null })], [e('other', 2, { symbol: '7203' })])).toEqual({ a: ['other', 2000] });
  });

  it('同じ差なら約定の早い方、同時刻なら id の小さい方（入力順に依らない）', () => {
    expect(pick([o('a', 0)], [e('late', 3), e('early', -3)])).toEqual({ a: ['early', -3000] });
    expect(pick([o('a', 0)], [e('early', -3), e('late', 3)])).toEqual({ a: ['early', -3000] });
    expect(pick([o('a', 0)], [e('z', 2), e('b', 2)])).toEqual({ a: ['b', 2000] });
    expect(pick([o('a', 0)], [e('b', 2), e('z', 2)])).toEqual({ a: ['b', 2000] });
  });

  it('1 つの約定に複数の注文が当たったら差の小さい方だけ。負けた注文は残りの候補から選ぶ', () => {
    expect(pick([o('a', 0), o('b', 1)], [e('x', 1)])).toEqual({ b: ['x', 0] });
    expect(pick([o('b', 1), o('a', 0)], [e('x', 1)])).toEqual({ b: ['x', 0] });
    // 差が同じなら注文の早い方が取る
    expect(pick([o('b', 2), o('a', 0)], [e('x', 1)])).toEqual({ a: ['x', 1000] });
    expect(pick([o('a', 0), o('b', 1)], [e('x', 1), e('y', 5)])).toEqual({ b: ['x', 0], a: ['y', 5000] });
  });
});

describe('pickNoteExecution', () => {
  const ts = new Date('2026-11-11T01:00:00.000Z');
  const at = (id: string, sec: number) => ({ id, executedAt: new Date(ts.getTime() + sec * 1000) });

  it('last_order の注文が約定に結び付いていればその約定（時刻が離れていても）', () => {
    const orderExec = new Map([['k1', at('fill', -900)]]);
    expect(pickNoteExecution({ ts, lastOrderKey: 'k1' }, orderExec, [at('open', 1)])).toEqual({ executionId: 'fill', method: 'order', deltaMs: -900_000 });
  });

  it(`結び付いていなければ前後 ${NOTE_WINDOW_SEC / 60} 分以内で最も近い建て約定。それも無ければ null`, () => {
    const orderExec = new Map([['other', at('fill', 0)]]);
    expect(pickNoteExecution({ ts, lastOrderKey: 'k1' }, orderExec, [at('a', -120), at('b', 60)])).toEqual({ executionId: 'b', method: 'time', deltaMs: 60_000 });
    expect(pickNoteExecution({ ts, lastOrderKey: null }, orderExec, [at('edge', -NOTE_WINDOW_SEC)])).toMatchObject({ executionId: 'edge', method: 'time' });
    expect(pickNoteExecution({ ts, lastOrderKey: null }, orderExec, [at('far', NOTE_WINDOW_SEC + 1)])).toBeNull();
    expect(pickNoteExecution({ ts, lastOrderKey: 'k1' }, new Map(), [])).toBeNull();
  });
});

describe('手で書いたメモ（symbol・position）', () => {
  it('symbol・position を読む。無ければ null、position が LONG / SHORT 以外なら契約違反', () => {
    const r = parseRealEvents([note({ id: 'm1', symbol: '6525', position: 'SHORT' }), note({ id: 'm2' }), note({ id: 'm3', symbol: '6525', position: 'BUY' })].join('\n'));
    expect(r.notes.map((n) => [n.id, n.symbol, n.position])).toEqual([
      ['m1', '6525', 'SHORT'],
      ['m2', null, null],
    ]);
    expect(r.errors.map((e) => e.id)).toEqual(['m3']);
  });

  const day = (id: string, o: Partial<DayCandidate> = {}): DayCandidate => ({
    id,
    executedAt: new Date('2026-11-11T00:00:00.000Z'),
    timePrecision: 'day',
    seq: 0,
    symbol: '6525',
    side: 'BUY',
    marginType: 'MARGIN_LONG',
    ...o,
  });
  const ts = new Date('2026-11-11T09:24:00.000+09:00');

  it('同じ日・同じ銘柄・同じ向きの建て約定。日付だけなら行順の早いもの', () => {
    const execs = [
      day('close', { side: 'SELL', seq: 1 }), // 買い建ての返済
      day('short', { side: 'SELL', marginType: 'MARGIN_SHORT', seq: 2 }),
      day('long-b', { seq: 9 }),
      day('long-a', { seq: 5 }),
      day('other', { symbol: '9984', seq: 0 }),
      day('yesterday', { executedAt: new Date('2026-11-10T00:00:00.000Z'), seq: 0 }),
    ];
    expect(pickNoteBySymbol({ ts, symbol: '6525', position: 'LONG' }, execs)).toMatchObject({ executionId: 'long-a', method: 'symbol_day' });
    expect(pickNoteBySymbol({ ts, symbol: '6525', position: 'SHORT' }, execs)).toMatchObject({ executionId: 'short' });
    expect(pickNoteBySymbol({ ts, symbol: '4062', position: 'LONG' }, execs)).toBeNull();
  });

  it('時刻付きの約定はメモの時刻に最も近いもの。日本時間の日付で比べる', () => {
    const at = (id: string, iso: string) => day(id, { timePrecision: 'ms', executedAt: new Date(iso) });
    const execs = [at('early', '2026-11-11T00:01:00.000Z'), at('near', '2026-11-11T00:25:00.000Z'), at('prev-day', '2026-11-10T14:59:00.000Z')];
    expect(pickNoteBySymbol({ ts, symbol: '6525', position: 'LONG' }, execs)).toMatchObject({ executionId: 'near', deltaMs: 60_000 });
    expect(pickNoteBySymbol({ ts, symbol: '6525', position: 'LONG' }, [execs[2]])).toBeNull();
  });
});

describe('pickNotesToSummarize', () => {
  it(`文が ${SUMMARY_MIN_CHARS} 文字を超え、summary が空のものだけ（文字数はコードポイントで数える）`, () => {
    const long = 'あ'.repeat(SUMMARY_MIN_CHARS + 1);
    const just = '🍅'.repeat(SUMMARY_MIN_CHARS); // UTF-16 では 160 だが 80 文字
    const notes = [
      { id: 'long', text: long, summary: null },
      { id: 'done', text: long, summary: '要約済み' },
      { id: 'blank', text: long, summary: '  ' },
      { id: 'just', text: just, summary: null },
      { id: 'short', text: '短い', summary: null },
    ];
    expect(pickNotesToSummarize(notes).map((n) => n.id)).toEqual(['long', 'blank']);
  });
});
