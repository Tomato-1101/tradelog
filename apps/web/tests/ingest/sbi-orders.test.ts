import { describe, expect, it } from 'vitest';
import {
  matchOrderFills,
  parseSbiOrder,
  parseSbiOrderFiles,
  type OrderMatchCandidate,
  type SbiOrderFill,
} from '@/lib/ingest/sbi-orders';

const HEAD = ['日付', '時刻', '市場', '取引', '状況', '未約定株数', '約定株数', '執行条件', '単価', '条件'];

// 実データ（11/06 太陽誘電 注文 10052）と同じ形
const SOR_ORDER = {
  date: '2026-11-06',
  orderNo: '10052',
  listRow: ['10052', '26/11/06 26/11/06', '完了(全部約定)', '通常注文', '信新買(6ヶ月) 特定/A', '太陽誘電 6976 SOR', '100 (0ポイント) 100', '指値', '5,873 5,870.8', '--', ''],
  rows: [
    HEAD,
    ['26/11/06', '09:21:32', '--', '信新買', 'SOR注文', '100', '--', '成行', '--', '--'],
    ['09:21:32', 'PTS（X）', '信新買', '注文', '--', '--', '指値', '5,873', '--'],
    ['09:21:32', 'PTS（X）', '信新買', '約定', '0', '100', '--', '5,870.8', '--'],
  ],
};

const STOP_ORDER = {
  date: '2026-11-06',
  orderNo: '10067',
  listRow: ['10067', '26/11/06 26/11/06', '完了(全部約定)', '逆指値注文', '信返売(6ヶ月) --/A', 'キオクシアホールディングス 285A 東証', '100 (0ポイント) 100', '成行', '-- 8,318', '--', ''],
  rows: [
    HEAD,
    ['26/11/06', '09:36:42', '東証', '信返売', '待機中', '100', '--', '--', '--', '現在値が8,316円以下になった時点で成行で執行'],
    ['09:36:45', '東証', '信返売', '注文', '100', '--', '成行', '--', '逆指値注文執行済'],
    ['09:36:45', '東証', '信返売', '約定', '0', '100', '--', '8,318', '--'],
  ],
};

describe('parseSbiOrder', () => {
  it('SOR の約定行を秒まで読み、一覧の執行条件・注文単価を付ける', () => {
    const { fills, warnings } = parseSbiOrder(SOR_ORDER);
    expect(warnings).toEqual([]);
    expect(fills).toHaveLength(1);
    const f = fills[0];
    expect(f.executedAt.toISOString()).toBe('2026-11-06T00:21:32.000Z'); // 09:21:32 JST
    expect(f).toMatchObject({
      date: '2026-11-06',
      time: '09:21:32',
      symbol: '6976',
      name: '太陽誘電',
      kind: '信新買',
      side: 'BUY',
      marginType: 'MARGIN_LONG',
      qty: '100',
      price: '5870.8',
      market: 'PTS（X）',
      orderNo: '10052',
      orderKind: '通常注文',
      orderType: '指値',
      orderPrice: '5873',
      stopWaitAt: null,
    });
  });

  it('逆指値は待機開始の時刻と条件を持つ。英字入りのコードも読む', () => {
    const [f] = parseSbiOrder(STOP_ORDER).fills;
    expect(f.symbol).toBe('285A');
    expect(f.name).toBe('キオクシアホールディングス');
    expect(f.time).toBe('09:36:45');
    expect(f.side).toBe('SELL');
    expect(f.marginType).toBe('MARGIN_LONG');
    expect(f.orderType).toBe('成行');
    expect(f.orderPrice).toBeNull();
    expect(f.stopWaitAt?.toISOString()).toBe('2026-11-06T00:36:42.000Z');
    expect(f.stopCondition).toBe('現在値が8,316円以下になった時点で成行で執行');
  });

  it('日付セルが出たら日付を更新して持ち越す（期間注文）。分割約定は 1 行ずつ', () => {
    const { fills } = parseSbiOrder({
      date: '2026-11-05',
      orderNo: '20000',
      listRow: ['20000', '', '完了(全部約定)', '通常注文', '信新売(6ヶ月) 特定/A', 'ＮＥＸＴ ＦＵＮＤＳ 日経平均 1570 東証', '', '指値', '52,000 52,000', '--', ''],
      rows: [
        HEAD,
        ['26/11/05', '14:00:00', '東証', '信新売', '注文', '20', '--', '指値', '52,000', '--'],
        ['26/11/06', '09:00:00', '東証', '信新売', '約定', '10', '10', '--', '52,000', '--'],
        ['09:00:01', '東証', '信新売', '約定', '0', '10', '--', '52,000', '--'],
      ],
    });
    expect(fills.map((f) => [f.date, f.time, f.qty, f.symbol, f.name])).toEqual([
      ['2026-11-06', '09:00:00', '10', '1570', 'ＮＥＸＴ ＦＵＮＤＳ 日経平均'],
      ['2026-11-06', '09:00:01', '10', '1570', 'ＮＥＸＴ ＦＵＮＤＳ 日経平均'],
    ]);
  });

  it('取消だけの注文は約定 0。解釈できない取引は警告して飛ばす', () => {
    const cancelled = parseSbiOrder({
      ...SOR_ORDER,
      rows: [HEAD, ['26/11/05', '09:04:46', '東証', '信新売', '取消', '100', '--', '--', '--', '--']],
    });
    expect(cancelled).toEqual({ fills: [], warnings: [] });
    const odd = parseSbiOrder({ ...SOR_ORDER, rows: [HEAD, ['26/11/06', '09:00:00', '東証', '謎', '約定', '0', '100', '--', '1', '--']] });
    expect(odd.fills).toEqual([]);
    expect(odd.warnings.map((w) => w.code)).toEqual(['unknown-kind']);
  });
});

describe('parseSbiOrderFiles', () => {
  it('同じ注文が複数ファイルにあれば collectedAt が新しい方を採り、集め途中の日を返す', () => {
    const old = { ...SOR_ORDER, rows: SOR_ORDER.rows.slice(0, 3) }; // 約定行の前に集めた
    const r = parseSbiOrderFiles([
      { name: 'b.json', json: { collectedAt: '2026-11-10T09:00:00Z', days: { '2026-11-06': { cnt: 2, got: 2 } }, orders: [SOR_ORDER, STOP_ORDER] } },
      { name: 'a.json', json: { collectedAt: '2026-11-06T01:00:00Z', days: { '2026-11-06': { cnt: 2, got: 1 } }, orders: [old] } },
    ]);
    expect(r.orders).toBe(2);
    expect(r.duplicateOrders).toBe(1);
    expect(r.fills.map((f) => f.orderNo).sort()).toEqual(['10052', '10067']);
    expect(r.incompleteDays).toEqual([{ file: 'a.json', date: '2026-11-06', cnt: 2, got: 1 }]);
  });
});

// ---------- 割り当て ----------

const at = (hms: string, ymd = '2026-11-06') => new Date(`${ymd}T${hms}+09:00`);

function fill(p: Partial<SbiOrderFill> & { time: string; qty: string; price: string }): SbiOrderFill {
  return {
    date: '2026-11-06',
    executedAt: at(p.time, p.date),
    symbol: '7011',
    name: null,
    kind: '信新買',
    side: 'BUY',
    marginType: 'MARGIN_LONG',
    market: 'PTS（X）',
    orderNo: '1',
    orderKind: '通常注文',
    orderType: '指値',
    orderPrice: null,
    stopWaitAt: null,
    stopCondition: null,
    ...p,
  };
}

function cand(p: Partial<OrderMatchCandidate> & { id: string; qty: string; price: string; seq: number }): OrderMatchCandidate {
  return { date: '2026-11-06', account: 'default', symbol: '7011', side: 'BUY', marginType: 'MARGIN_LONG', market: 'PTS（X）', ...p };
}

const times = (r: ReturnType<typeof matchOrderFills>) =>
  Object.fromEntries(r.assignments.map((a) => [a.id, a.executedAt.toISOString()]));

describe('matchOrderFills', () => {
  it('日付・銘柄・売買・信用区分・市場・単価・数量が同じものに 1 対 1 で付ける（単価は表記ゆれを吸収）', () => {
    const r = matchOrderFills(
      [cand({ id: 'a', qty: '100', price: '2904.70', seq: 1 }), cand({ id: 'b', qty: '100', price: '2850', seq: 2, side: 'SELL' })],
      [fill({ time: '13:31:53', qty: '100', price: '2904.7' }), fill({ time: '13:40:00', qty: '100', price: '2850', side: 'SELL', kind: '信返売' })],
    );
    expect(times(r)).toEqual({ a: '2026-11-06T04:31:53.000Z', b: '2026-11-06T04:40:00.000Z' });
    expect(r.unmatchedExecs).toEqual([]);
    expect(r.unmatchedFills).toEqual([]);
  });

  it('CSV が分割約定を 1 行にまとめた（200 ← 100+100 同時刻）・返済を建玉ごとに分けた（100+100 ← 200）も数量で揃える', () => {
    const r = matchOrderFills(
      [
        cand({ id: 'open200', qty: '200', price: '2904.7', seq: 1 }),
        cand({ id: 'close1', qty: '100', price: '2905.7', seq: 2, side: 'SELL' }),
        cand({ id: 'close2', qty: '100', price: '2905.7', seq: 3, side: 'SELL' }),
      ],
      [
        fill({ time: '13:31:53', qty: '100', price: '2904.7', orderNo: '10129' }),
        fill({ time: '13:31:53', qty: '100', price: '2904.7', orderNo: '10129' }),
        fill({ time: '13:35:00', qty: '200', price: '2905.7', side: 'SELL', kind: '信返売', orderNo: '10130' }),
      ],
    );
    expect(times(r)).toEqual({
      open200: '2026-11-06T04:31:53.000Z',
      close1: '2026-11-06T04:35:00.000Z',
      close2: '2026-11-06T04:35:00.000Z',
    });
    expect(r.assignments.find((a) => a.id === 'open200')!.fills).toHaveLength(2);
  });

  it('同じ組の候補は CSV の行順と約定の時刻順で決まり、入力の並びに依らない', () => {
    const cs = [cand({ id: 'x', qty: '100', price: '2763', seq: 5, side: 'SELL' }), cand({ id: 'y', qty: '100', price: '2763', seq: 4, side: 'SELL' })];
    const fs = [fill({ time: '10:00:00', qty: '100', price: '2763', side: 'SELL', kind: '信返売' }), fill({ time: '09:00:00', qty: '100', price: '2763', side: 'SELL', kind: '信返売' })];
    const r1 = matchOrderFills(cs, fs);
    const r2 = matchOrderFills([...cs].reverse(), [...fs].reverse());
    expect(times(r1)).toEqual({ y: '2026-11-06T00:00:00.000Z', x: '2026-11-06T01:00:00.000Z' });
    expect(times(r2)).toEqual(times(r1));
  });

  it('CSV の 1 行が時刻の違う約定にまたがるなら付けない', () => {
    const r = matchOrderFills(
      [cand({ id: 'a', qty: '200', price: '100', seq: 1 })],
      [fill({ time: '09:00:00', qty: '100', price: '100' }), fill({ time: '09:00:05', qty: '100', price: '100' })],
    );
    expect(r.assignments).toEqual([]);
    expect(r.unmatchedExecs).toEqual([{ id: 'a', reason: 'split-time-ambiguous' }]);
    expect(r.unmatchedFills.map((x) => x.reason)).toEqual(['split-time-ambiguous', 'split-time-ambiguous']);
  });

  it('数量の合計が合わない・市場が違うなら付けない', () => {
    const r = matchOrderFills(
      [cand({ id: 'a', qty: '200', price: '100', seq: 1 }), cand({ id: 'b', qty: '100', price: '200', seq: 2, market: '東証', marginType: 'MARGIN_SHORT' })],
      [fill({ time: '09:00:00', qty: '100', price: '100' }), fill({ time: '09:01:00', qty: '100', price: '200', marginType: 'MARGIN_SHORT' })],
    );
    expect(r.assignments).toEqual([]);
    expect(r.unmatchedExecs).toEqual(expect.arrayContaining([{ id: 'a', reason: 'qty-mismatch' }, { id: 'b', reason: 'no-fill' }]));
    expect(r.unmatchedFills.map((x) => x.reason).sort()).toEqual(['no-exec', 'qty-mismatch']);
  });

  it('同じ日・銘柄・信用区分に時刻の付かない約定が残るなら、その組は全部見送る（別の組・別の日には付ける）', () => {
    const r = matchOrderFills(
      [
        cand({ id: 'open', qty: '100', price: '100', seq: 1 }),
        cand({ id: 'close-missing', qty: '100', price: '110', seq: 2, side: 'SELL' }), // 注文履歴に無い
        cand({ id: 'short', qty: '100', price: '120', seq: 3, side: 'SELL', marginType: 'MARGIN_SHORT' }),
        cand({ id: 'other-day', qty: '100', price: '100', seq: 4, date: '2026-11-05' }),
      ],
      [
        fill({ time: '09:00:00', qty: '100', price: '100' }),
        fill({ time: '09:05:00', qty: '100', price: '120', side: 'SELL', marginType: 'MARGIN_SHORT', kind: '信新売' }),
        fill({ time: '10:00:00', qty: '100', price: '100', date: '2026-11-05' }),
      ],
    );
    expect(Object.keys(times(r)).sort()).toEqual(['other-day', 'short']);
    expect(r.unmatchedExecs).toEqual(
      expect.arrayContaining([
        { id: 'close-missing', reason: 'no-fill' },
        { id: 'open', reason: 'bucket-incomplete' },
      ]),
    );
    expect(r.unmatchedFills.map((x) => x.reason)).toEqual(['bucket-incomplete']);
  });

  it('DB に SBI 約定の無い日（CSV 未取り込み）の約定は no-csv-day。注文履歴の無い日の候補は数えない', () => {
    const r = matchOrderFills(
      [cand({ id: 'a', qty: '100', price: '100', seq: 1, date: '2026-11-04' })],
      [fill({ time: '09:00:00', qty: '100', price: '100', date: '2026-11-10' })],
    );
    expect(r.candidates).toBe(0);
    expect(r.unmatchedExecs).toEqual([]);
    expect(r.unmatchedFills.map((x) => x.reason)).toEqual(['no-csv-day']);
  });
});
