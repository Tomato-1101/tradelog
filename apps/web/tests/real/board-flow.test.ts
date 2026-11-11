// 本番の注文記録 v2 を一時 SQLite（マイグレーションを当てた空 DB）で通す: 取り込み（冪等・v1 と混在）→ 結び付け → 要約（偽物の要約関数）→ AI 書き出し。
// 本番 DB にも外部 API にも触れない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { importSbiCsv } from '@/lib/ingest/sbi-import';
import { parseSbiOrder } from '@/lib/ingest/sbi-orders';
import { applySbiOrderTimes } from '@/lib/ingest/sbi-orders-import';
import { rebuildRounds } from '@/lib/rounds/rebuild';
import { exportForAi } from '@/lib/ai/export';
import { ingestRealMemos, linkRealMemos } from '@/lib/real/memos';
import { ingestRealV2, linkBoardOrders, linkRealNotes } from '@/lib/real/board';
import { summarizeNotes } from '@/lib/real/summarize';

const MIGRATIONS = path.resolve(__dirname, '../../../../prisma/migrations');
const NOW = new Date('2026-11-06T16:00:00+09:00');

let dir: string;
let db: PrismaClient;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradelog-real-v2-'));
  const file = path.join(dir, 'app.db');
  const raw = new Database(file);
  for (const m of fs.readdirSync(MIGRATIONS).filter((d) => fs.existsSync(path.join(MIGRATIONS, d, 'migration.sql'))).sort()) {
    raw.exec(fs.readFileSync(path.join(MIGRATIONS, m, 'migration.sql'), 'utf8'));
  }
  raw.close();
  db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
});
afterEach(async () => {
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

// 6976: 信用新規買 09:21:32 @5870.8 → 信用返済売 09:40:05 @5880（注文履歴で時刻が付く）
const THIRD = [
  '約定履歴照会 ',
  '',
  '約定日,銘柄,銘柄コード,市場,取引,期限,預り,課税,約定数量,約定単価,手数料/諸経費等,税額,受渡日,受渡金額/決済損益',
  '"2026/11/06","太陽誘電","6976","PTS（X）",信用返済売,"6ヶ月"," 特定 ","申告",100,5880,22,--,"2026/11/10",900',
  '"2026/11/06","太陽誘電","6976","PTS（X）",信用新規買,"6ヶ月"," 特定 ","--",100,5870.8,--,--,"2026/11/10",--',
].join('\n');
const HEAD = ['日付', '時刻', '市場', '取引', '状況', '未約定株数', '約定株数', '執行条件', '単価', '条件'];
const sbiOrder = (orderNo: string, kind: string, hms: string, price: string) => ({
  date: '2026-11-06',
  orderNo,
  listRow: [orderNo, '', '完了(全部約定)', '通常注文', `${kind}(6ヶ月) 特定/A`, '太陽誘電 6976 SOR', '', '指値', `${price} ${price}`, '--', ''],
  rows: [HEAD, ['26/11/06', hms, 'PTS（X）', kind, '約定', '0', '100', '--', price, '--']],
});
const FILLS = [...parseSbiOrder(sbiOrder('10052', '信新買', '09:21:32', '5,870.8')).fills, ...parseSbiOrder(sbiOrder('10053', '信返売', '09:40:05', '5,880')).fills];

async function setup() {
  await importSbiCsv(db, Buffer.from('﻿' + THIRD), 'SaveFile_test.csv');
  await applySbiOrderTimes(db, FILLS);
  await rebuildRounds(db, NOW, { replayEnd: () => null });
}

const BOARD = [{ price: 5871, sell: 300, buy: null, sell_count: 2, buy_count: null, my_sell: null, my_buy: null }];
const bo = (id: string, key: string, event: string, ts: string, o: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 2, type: 'board_order', id, ts: `2026-11-06T${ts}+09:00`, order_key: key, event, side: 'BUY', price: 5870.8, qty: 100, pending_ms: null, symbol: '6976', symbol_name: '太陽誘電', board: BOARD, ...o });
const LONG = '前の高値を抜けたところで出来高が急に増えて、板の売りが薄くなっていたので、押し目を待たずに少しだけ成行に近い指値で入った。損切りは直近の安値の少し下に置く予定にしている。';
const EVENTS = [
  JSON.stringify({ v: 1, type: 'real_memo', id: 'm1', ts: '2026-11-06T09:21:30.000+09:00', tags: [], shots: [], active_window_title: 'x' }),
  // 建て: 09:21:20 に発注、09:21:33.5 に数字が消えた（SBI 09:21:32 と 1.5 秒差）
  bo('b1', 'kBuy', 'placed', '09:21:20.000', { pending_ms: 150, qty: null }),
  bo('b2', 'kBuy', 'filled', '09:21:33.500', { qty: null }),
  // 返済: 一度取消を始めて戻し（reverted）、09:40:06 に約定
  bo('s1', 'kSell', 'appeared', '09:39:00.000', { side: 'SELL', price: 5880 }),
  bo('s2', 'kSell', 'cancel_requested', '09:39:30.000', { side: 'SELL', price: 5880, qty: null }),
  bo('s3', 'kSell', 'reverted', '09:39:33.000', { side: 'SELL', price: 5880 }),
  bo('s4', 'kSell', 'filled', '09:40:06.000', { side: 'SELL', price: 5880 }),
  // 取消した注文
  bo('c1', 'kCancel', 'placed', '09:25:00.000', { price: 5860, pending_ms: 200 }),
  bo('c2', 'kCancel', 'cancel_requested', '09:25:10.000', { price: 5860, qty: null }),
  bo('c3', 'kCancel', 'cancelled', '09:25:13.000', { price: 5860, qty: null, pending_ms: 3000 }),
  // 消えたが SBI 約定が 15 秒より離れている → 未結び付け
  bo('u1', 'kFar', 'filled', '09:21:50.000'),
  bo('t1', 'kTest', 'filled', '09:21:32.000', { test: true }),
  // 理由のメモ: 注文経由（返済の注文。時刻は建てに近い）/ 時刻で建て約定 / どこにも結び付かない
  JSON.stringify({ v: 2, type: 'real_note', id: 'n1', ts: '2026-11-06T09:22:00.000+09:00', text: '利確の指値を置いた', last_order: { order_key: 'kSell', event: 'appeared', side: 'SELL', price: 5880, ts: '2026-11-06T09:39:00.000+09:00' } }),
  JSON.stringify({ v: 2, type: 'real_note', id: 'n2', ts: '2026-11-06T09:24:00.000+09:00', text: LONG, last_order: { order_key: 'kCancel', event: 'placed', side: 'BUY', price: 5860, ts: '2026-11-06T09:25:00.000+09:00' } }),
  JSON.stringify({ v: 2, type: 'real_note', id: 'n3', ts: '2026-11-06T10:30:00.000+09:00', text: '様子見', last_order: null }),
  '{"v":2,"type":"real_note","id":"n-half"',
].join('\n');

describe('本番の注文記録 v2', () => {
  it('v1 と混在したまま冪等に取り込み、filled を SBI 約定に、メモをラウンドに結び付け、要約して書き出す', async () => {
    await setup();
    const r1 = await ingestRealMemos(db, EVENTS);
    expect({ newMemos: r1.newMemos, test: r1.test, partial: r1.partial, errors: r1.errors.length }).toEqual({ newMemos: 1, test: 1, partial: 1, errors: 0 });
    expect(await ingestRealV2(db, r1)).toEqual({ newBoardOrders: 10, newNotes: 3 });
    expect(await ingestRealV2(db, await ingestRealMemos(db, EVENTS)), '2 回目は入れない').toEqual({ newBoardOrders: 0, newNotes: 0 });
    await linkRealMemos(db);

    expect(await linkBoardOrders(db)).toEqual({ filled: 3, linked: 2, changed: 2 });
    expect(await linkBoardOrders(db), '2 回目は何も変えない').toEqual({ filled: 3, linked: 2, changed: 0 });
    const b2 = await db.boardOrder.findUniqueOrThrow({ where: { id: 'b2' }, include: { execution: true } });
    expect(b2.execution).toMatchObject({ side: 'BUY', marginType: 'MARGIN_LONG', price: '5870.8' });
    expect(b2.linkDeltaMs).toBe(-1500);
    expect((await db.boardOrder.findUniqueOrThrow({ where: { id: 'u1' } })).executionId).toBeNull();

    expect(await linkRealNotes(db)).toEqual({ notes: 3, linked: 2, byOrder: 1, changed: 2 });
    expect(await linkRealNotes(db)).toEqual({ notes: 3, linked: 2, byOrder: 1, changed: 0 });
    const n1 = await db.realNote.findUniqueOrThrow({ where: { id: 'n1' }, include: { execution: true } });
    expect(n1).toMatchObject({ linkMethod: 'order' });
    expect(n1.execution?.side).toBe('SELL');
    expect(await db.realNote.findUniqueOrThrow({ where: { id: 'n2' } })).toMatchObject({ linkMethod: 'time', linkDeltaMs: -148_000 });
    expect((await db.realNote.findUniqueOrThrow({ where: { id: 'n3' } })).executionId).toBeNull();

    // 要約: 鍵が無ければ警告だけ。偽物の要約関数で長い文（n2）だけ要約し、60 文字に切り詰める。2 回目は対象なし
    expect(await summarizeNotes(db, () => null)).toMatchObject({ targets: 1, summarized: 0, warning: expect.stringContaining('鍵') });
    const asked: string[] = [];
    const fake = async (t: string) => {
      asked.push(t);
      return '高値抜けと出来高急増で早めに指値で入った。'.repeat(3);
    };
    expect(await summarizeNotes(db, () => fake)).toEqual({ targets: 1, summarized: 1, warning: null });
    expect(asked).toEqual([LONG]);
    const s2 = (await db.realNote.findUniqueOrThrow({ where: { id: 'n2' } })).summary!;
    expect([...s2]).toHaveLength(60);
    expect(await summarizeNotes(db, () => fake)).toEqual({ targets: 0, summarized: 0, warning: null });

    const out = path.join(dir, 'ai');
    await exportForAi(db, out, NOW, { replayEnd: () => null });
    const [line] = fs.readFileSync(path.join(out, 'trades.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(line.real_memos).toHaveLength(1);
    expect(line.board_orders).toEqual([
      {
        order_key: 'kBuy',
        side: 'BUY',
        price: '5870.8',
        qty: null,
        placed_at: '2026-11-06T09:21:20.000+09:00',
        filled_at: '2026-11-06T09:21:33.500+09:00',
        execution_at: '2026-11-06T09:21:32.000+09:00',
        placed_to_fill_sec: 13.5,
        pending_ms: 150,
        board_at_placed: BOARD,
        board_at_fill: BOARD,
      },
      {
        order_key: 'kSell',
        side: 'SELL',
        price: '5880',
        qty: 100,
        placed_at: '2026-11-06T09:39:00.000+09:00',
        filled_at: '2026-11-06T09:40:06.000+09:00',
        execution_at: '2026-11-06T09:40:05.000+09:00',
        placed_to_fill_sec: 66,
        pending_ms: null,
        board_at_placed: BOARD,
        board_at_fill: BOARD,
      },
    ]);
    expect(line.notes).toEqual([
      { at: '2026-11-06T09:24:00.000+09:00', text: LONG, summary: s2 },
      { at: '2026-11-06T09:22:00.000+09:00', text: '利確の指値を置いた', summary: null },
    ]);
    const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
    expect(md).toContain('- 板の記録: 注文 4 件（約定 2 / 取消 1 / 未結び付け 1）');
    expect(md).toContain('- 理由のメモ 3 件（結び付き 2）');
    expect(md).toContain('本番エントリー記録（Windows の記録小窓）: 1 件 / SBI の建て約定に結び付いた 1 件');
  });

  it('要約が失敗・タイムアウトしたら警告 1 行で止め、summary は空のまま（次回の対象に残る）', async () => {
    const r = await ingestRealMemos(db, EVENTS);
    await ingestRealV2(db, r);
    const timeout = async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    };
    expect(await summarizeNotes(db, () => timeout)).toEqual({ targets: 1, summarized: 0, warning: '要約に失敗（10 秒でタイムアウト）。残り 1 件は次回の daily で' });
    const fail = async () => {
      throw new Error('HTTP 429');
    };
    expect((await summarizeNotes(db, () => fail)).warning).toBe('要約に失敗（HTTP 429）。残り 1 件は次回の daily で');
    expect((await db.realNote.findUniqueOrThrow({ where: { id: 'n2' } })).summary).toBeNull();
  });

  it('SBI 約定が消えたら結び付きを外す', async () => {
    await setup();
    const r = await ingestRealMemos(db, EVENTS);
    await ingestRealV2(db, r);
    await linkBoardOrders(db);
    await linkRealNotes(db);
    await db.execution.updateMany({ data: { roundId: null } });
    await db.execution.deleteMany({});
    expect((await db.boardOrder.findUniqueOrThrow({ where: { id: 'b2' } })).executionId).toBeNull();
    expect(await linkBoardOrders(db)).toEqual({ filled: 3, linked: 0, changed: 2 });
    expect(await linkRealNotes(db)).toMatchObject({ linked: 0 });
    expect(await db.boardOrder.count({ where: { linkDeltaMs: { not: null } } })).toBe(0);
  });
});
