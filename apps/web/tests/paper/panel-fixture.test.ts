// 契約テスト: 小窓（apps/panel, Swift）のエンコーダが実際に出力した行を、web がそのまま読めること。
// 見本 docs/fixtures/panel-events.jsonl は Swift 側（apps/panel/Tests/FixtureContractTests.swift）が
// エンコーダの出力と 1 行ずつ完全一致を確認しているので、ここで読めれば「小窓が書いたものを web が読める」が両側から保証される。
// 見本を作り直したら、このファイルの期待値（ID・時刻・価格）も見直すこと。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveOrderState, parseEventLine, parseEventsText, type FillMarkEvent, type OrderEvent } from '@/lib/paper/events';
import { resolveOrder, type BarLite, type ResolveOrder } from '@/lib/paper/resolve';

const FIXTURE = path.resolve(__dirname, '../../../../docs/fixtures/panel-events.jsonl');
const text = readFileSync(FIXTURE, 'utf8');

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const POS_A = U(900);
const POS_B = U(901);
const jst = (hms: string) => new Date(`2026-10-02T${hms}+09:00`);

// 見本の注文 ID（ファイルの行順）
const A1 = U(1); // 寄り前の成行・新規買い
const A2 = U(2); // ザラ場の成行・買い増し
const A3 = U(4); // 指値の決済売り（fill_mark あり）
const B1 = U(6); // 空売りの新規（shot null）
const B2 = U(7); // 指値の決済買い（取消）
const B3 = U(9); // 成行の決済買い

describe('小窓の見本ファイル（panel-events.jsonl）: 取り込み', () => {
  const p = parseEventsText(text);

  it('形式: 1 イベント 1 行・LF 終端・空行なし', () => {
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    const lines = text.slice(0, -1).split('\n');
    expect(lines).toHaveLength(10);
    for (const l of lines) expect(l.trim()).toBe(l);
    expect(text).not.toContain('\r');
  });

  it('契約違反 0・全行採用', () => {
    expect(p.errors).toEqual([]);
    expect(p.accepted).toHaveLength(10);
    expect(p.orders).toHaveLength(6);
    expect(p.memos).toHaveLength(2);
    expect(p.fillMarks.size).toBe(1);
    expect(p.cancels.size).toBe(1);
  });

  it('1 行ずつ単独でもパースできる（キー順・書式に依存しない）', () => {
    text
      .slice(0, -1)
      .split('\n')
      .forEach((l, i) => expect(parseEventLine(l, i + 1).ok, `${i + 1} 行目`).toBe(true));
  });

  it('時刻は JST のミリ秒付きで、UTC に正しく直る', () => {
    const o = p.orders.find((x) => x.id === A1)!;
    expect(o.ts.toISOString()).toBe('2026-10-01T23:55:12.345Z');
    expect(p.orders.find((x) => x.id === A2)!.ts.toISOString()).toBe('2026-10-02T00:12:34.567Z');
  });

  it('建玉ごとの注文の紐づけ（A は買い→買い増し→決済、B は空売り→決済 2 回）', () => {
    const byPos = (pos: string) => p.orders.filter((o) => o.positionId === pos);
    expect(byPos(POS_A).map((o) => [o.id, o.intent, o.side, o.qty, o.orderType, o.limitPrice])).toEqual([
      [A1, 'open', 'buy', '100', 'market', null],
      [A2, 'add', 'buy', '100', 'market', null],
      [A3, 'close', 'sell', '200', 'limit', '2875'],
    ]);
    expect(byPos(POS_B).map((o) => [o.id, o.intent, o.side, o.qty, o.orderType, o.limitPrice])).toEqual([
      [B1, 'open', 'sell', '100', 'market', null],
      [B2, 'close', 'buy', '100', 'limit', '2840'],
      [B3, 'close', 'buy', '100', 'market', null],
    ]);
    expect(p.orders.every((o) => o.symbol === '7203')).toBe(true);
  });

  it('shot: 読み取れた値は文字列の価格・数値の信頼度、撮れなかった注文は null', () => {
    const o = p.orders.find((x) => x.id === A1)!;
    expect(o.shot).toEqual({
      path: `shots/2026-10-02/${A1}.png`,
      priceText: '2,856.5',
      price: '2856.5',
      symbolText: '7203',
      confidence: 0.97,
    });
    expect(p.orders.find((x) => x.id === A2)!.shot).toMatchObject({ price: '2860', priceText: '2,860', confidence: 0.98 });
    expect(p.orders.find((x) => x.id === B1)!.shot).toBeNull();
    expect(p.orders.find((x) => x.id === B2)!.shot).toBeNull();
  });

  it('fill_mark / cancel は対象の指値に紐づく', () => {
    const fm = p.fillMarks.get(A3)!;
    expect(fm.id).toBe(U(5));
    expect(fm.ts.toISOString()).toBe('2026-10-02T01:02:41.789Z');
    expect(p.cancels.get(B2)?.id).toBe(U(8));
    expect(p.fillMarks.has(B2)).toBe(false);
    expect(p.cancels.has(A3)).toBe(false);
  });

  it('メモ: 建玉中（order_id null）と決済後（order_id あり）、日本語がそのまま入る', () => {
    expect(p.memos.map((m) => [m.id, m.positionId, m.orderId, m.text])).toEqual([
      [U(3), POS_A, null, '押し目で入った、出来高増'],
      [U(10), POS_B, B3, '損切り、板が薄かった'],
    ]);
  });

  it('注文の状態（大引け後に評価）', () => {
    const now = jst('16:00:00.000');
    const st = (id: string) => {
      const o = p.orders.find((x) => x.id === id)!;
      return deriveOrderState(o, p.fillMarks.get(id), p.cancels.get(id), now);
    };
    expect(st(A1)).toBe('MARKET');
    expect(st(A2)).toBe('MARKET');
    expect(st(A3)).toBe('FILL_MARKED');
    expect(st(B1)).toBe('MARKET');
    expect(st(B2)).toBe('CANCELLED');
    expect(st(B3)).toBe('MARKET');
  });
});

describe('小窓の見本ファイル: 約定の確定（resolve）まで通す', () => {
  const p = parseEventsText(text);
  const now = jst('16:00:00.000');
  const bar = (hm: string, low: number, high: number, open = low, close = high): BarLite => ({ ts: jst(`${hm}:00.000`), open, high, low, close });
  // 2026-10-02 の日足（寄り前の成行の約定価格は始値）
  const daily: BarLite = { ts: jst('00:00:00.000'), open: 2855, high: 2880, low: 2840, close: 2850 };

  function input(o: OrderEvent): ResolveOrder {
    const fm: FillMarkEvent | undefined = p.fillMarks.get(o.id);
    return {
      orderType: o.orderType,
      side: o.side,
      limitPrice: o.limitPrice,
      placedAt: o.ts,
      state: deriveOrderState(o, fm, p.cancels.get(o.id), now),
      fillMarkedAt: fm?.ts ?? null,
      shotPrice: o.shot?.price ?? null,
    };
  }
  const order = (id: string) => p.orders.find((x) => x.id === id)!;
  const run = (id: string, bars: BarLite[]) => resolveOrder(input(order(id)), bars, daily);

  it('寄り前の成行（A1）→ 日足始値・09:00 で確定', () => {
    const r = run(A1, []);
    expect(r).toMatchObject({ kind: 'FILL', price: '2855', priceStatus: 'CONFIRMED', priceBasis: 'OPEN_AUCTION' });
    expect(r.kind === 'FILL' && r.executedAt.toISOString()).toBe(jst('09:00:00.000').toISOString());
  });

  it('ザラ場の成行（A2）→ shot.price で確定（その分の足の範囲内）', () => {
    const r = run(A2, [bar('09:12', 2855, 2865)]);
    expect(r).toMatchObject({ kind: 'FILL', price: '2860', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN' });
    expect(r.kind === 'FILL' && r.executedAt.toISOString()).toBe(order(A2).ts.toISOString());
  });

  it('ザラ場の成行（A2）で shot.price が足の外 → 足の終値を仮置きして要確認', () => {
    const r = run(A2, [bar('09:12', 2840, 2850, 2840, 2845)]);
    expect(r).toMatchObject({ price: '2845', priceStatus: 'NEEDS_REVIEW', priceBasis: 'BAR' });
  });

  it('指値の決済売り（A3）→ fill_mark までの足が指値を越えていれば確定（約定は fill_mark の時刻・指値）', () => {
    const r = run(A3, [bar('09:40', 2860, 2870), bar('09:55', 2870, 2877)]);
    expect(r).toMatchObject({ kind: 'FILL', price: '2875', priceStatus: 'CONFIRMED', priceBasis: 'LIMIT' });
    expect(r.kind === 'FILL' && r.executedAt.toISOString()).toBe(p.fillMarks.get(A3)!.ts.toISOString());
  });

  it('指値の決済売り（A3）で足が指値に届いていない → 要確認（指値を仮置き）', () => {
    // 発注 09:40 〜 fill_mark 10:02 の連続売買の分足をすべて用意し、高値は指値と同値止まり
    const bars: BarLite[] = [];
    for (let m = 40; m < 120; m++) bars.push(bar(`${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, 2860, 2875));
    const r = run(A3, bars.filter((b) => b.ts <= jst('10:02:59.999')));
    expect(r).toMatchObject({ kind: 'FILL', price: '2875', priceStatus: 'NEEDS_REVIEW', priceBasis: 'LIMIT' });
  });

  it('shot が null の空売り（B1）→ 画面の値が無いので足の終値を仮置きして要確認', () => {
    const r = run(B1, [bar('10:30', 2850, 2858, 2852, 2856)]);
    expect(r).toMatchObject({ kind: 'FILL', price: '2856', priceStatus: 'NEEDS_REVIEW', priceBasis: 'BAR' });
  });

  it('取消した指値（B2）→ 約定しない', () => {
    expect(run(B2, [bar('11:05', 2830, 2845)])).toEqual({ kind: 'NO_FILL', reason: 'CANCELLED' });
  });

  it('成行の決済（B3）→ shot.price で確定', () => {
    const r = run(B3, [bar('13:15', 2845, 2850)]);
    expect(r).toMatchObject({ kind: 'FILL', price: '2848', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN' });
  });
});
