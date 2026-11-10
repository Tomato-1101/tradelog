// 時刻付き（注文履歴で秒まで付けた）SBI ラウンドが、ペーパーと同じく 1 分足の取得・MAE/MFE・AI 書き出しの対象になるか。
// 日付だけの SBI ラウンドは従来どおり対象外。一時 SQLite（マイグレーションを当てた空 DB）で通す。本番 DB には触れない。
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
import { planBarFetches } from '@/lib/bars/store';
import { exportForAi } from '@/lib/ai/export';
import { ingestRealMemos, linkRealMemos } from '@/lib/real/memos';

const MIGRATIONS = path.resolve(__dirname, '../../../../prisma/migrations');
const NOW = new Date('2026-11-06T16:00:00+09:00');

let dir: string;
let db: PrismaClient;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradelog-sbi-timed-'));
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

// 6976 は注文履歴で時刻が付く。7203 は時刻が付かない（日付だけ）
const THIRD = [
  '約定履歴照会 ',
  '',
  '約定日,銘柄,銘柄コード,市場,取引,期限,預り,課税,約定数量,約定単価,手数料/諸経費等,税額,受渡日,受渡金額/決済損益',
  '"2026/11/06","太陽誘電","6976","PTS（X）",信用返済売,"6ヶ月"," 特定 ","申告",100,5880,22,--,"2026/11/10",900',
  '"2026/11/06","太陽誘電","6976","PTS（X）",信用新規買,"6ヶ月"," 特定 ","--",100,5870.8,--,--,"2026/11/10",--',
  '"2026/11/05","トヨタ自動車","7203","東証",信用返済売,"6ヶ月"," 特定 ","申告",100,3010,22,--,"2026/11/09",1000',
  '"2026/11/05","トヨタ自動車","7203","東証",信用新規買,"6ヶ月"," 特定 ","--",100,3000,--,--,"2026/11/09",--',
].join('\n');

const HEAD = ['日付', '時刻', '市場', '取引', '状況', '未約定株数', '約定株数', '執行条件', '単価', '条件'];
const order = (orderNo: string, kind: string, hms: string, price: string) => ({
  date: '2026-11-06',
  orderNo,
  listRow: [orderNo, '', '完了(全部約定)', '通常注文', `${kind}(6ヶ月) 特定/A`, '太陽誘電 6976 SOR', '', '指値', `${price} ${price}`, '--', ''],
  rows: [HEAD, ['26/11/06', hms, 'PTS（X）', kind, '約定', '0', '100', '--', price, '--']],
});
const FILLS = [...parseSbiOrder(order('10052', '信新買', '09:21:32', '5,870.8')).fills, ...parseSbiOrder(order('10053', '信返売', '09:40:05', '5,880')).fills];

async function setup() {
  // 512 バイトを超えると文字コードの自動判定が UTF-8 の途中で切れて cp932 と誤判定するので BOM を付ける
  await importSbiCsv(db, Buffer.from('\ufeff' + THIRD), 'SaveFile_test.csv');
  await applySbiOrderTimes(db, FILLS);
  await rebuildRounds(db, NOW, { replayEnd: () => null });
  const inst = await db.instrument.findUniqueOrThrow({ where: { market_symbol: { market: 'TSE', symbol: '6976' } } });
  return inst.id;
}

/** 6976 の 1 分足（09:10〜09:50）。建玉中（09:21〜09:40）の高値 5900・安値 5850、窓の外に 6000 / 5700 を置く */
async function seedBars(instrumentId: number) {
  for (let m = 10; m <= 50; m++) {
    const ts = new Date(`2026-11-06T09:${String(m).padStart(2, '0')}:00+09:00`);
    const inside = m >= 21 && m <= 40;
    const high = inside ? (m === 30 ? 5900 : 5880) : m === 15 ? 6000 : 5880;
    const low = inside ? (m === 25 ? 5850 : 5865) : m === 45 ? 5700 : 5865;
    await db.bar.create({ data: { instrumentId, timeframe: '1m', ts, open: 5870, high, low, close: 5870, volume: 100, source: 'yahoo' } });
  }
}

describe('時刻付き SBI ラウンド', () => {
  it('1 分足・日足の取得対象になる（日付だけのラウンドの銘柄は入らない）', async () => {
    const id6976 = await setup();
    const plan = await planBarFetches(db, NOW);
    expect(plan.needs.map((n) => [n.instrumentId, n.symbol, n.timeframe, n.dates])).toEqual([
      [id6976, '6976', '1m', ['2026-11-06']],
      [id6976, '6976', '1d', ['2026-11-06']],
    ]);
  });

  it('MAE/MFE をペーパーと同じく建て〜決済の 1 分足で出す。日付だけのラウンドは null のまま', async () => {
    const id6976 = await setup();
    await seedBars(id6976);
    await rebuildRounds(db, NOW, { replayEnd: () => null });
    const rounds = await db.round.findMany({ include: { instrument: true }, orderBy: { openedAt: 'asc' } });
    const timed = rounds.find((r) => r.instrument.symbol === '6976')!;
    const day = rounds.find((r) => r.instrument.symbol === '7203')!;
    expect(timed).toMatchObject({ timePrecision: 'ms', direction: 'LONG', avgEntryPrice: '5870.8', mae: '-20.8', mfe: '29.2' });
    expect(day).toMatchObject({ timePrecision: 'day', mae: null, mfe: null });
  });

  it('AI 書き出しに前後 30 分の 1 分足とエントリー時刻が入る。日付だけのラウンドは bars_1m が null', async () => {
    const id6976 = await setup();
    await seedBars(id6976);
    await rebuildRounds(db, NOW, { replayEnd: () => null });
    const out = path.join(dir, 'ai');
    const rep = await exportForAi(db, out, NOW, { replayEnd: () => null });
    expect(rep).toMatchObject({ trades: 2, withBars: 1 });
    const lines = fs.readFileSync(path.join(out, 'trades.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const timed = lines.find((l) => l.symbol === '6976');
    const day = lines.find((l) => l.symbol === '7203');
    expect(timed.opened_at).toBe('2026-11-06T09:21:32.000+09:00');
    expect(timed.time_precision).toBe('ms');
    expect(timed.bars_1m.from).toBe('2026-11-06T08:51:00.000+09:00');
    expect(timed.bars_1m.to).toBe('2026-11-06T10:10:00.000+09:00');
    expect(timed.bars_1m.rows).toHaveLength(41);
    expect(day.bars_1m).toBeNull();
    const summary = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
    expect(summary).toContain('時間帯別');
  });
});

describe('本番エントリー記録（real_memo）', () => {
  const line = (id: string, ts: string, o: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, type: 'real_memo', id, ts, tags: ['押し目'], shots: [{ path: `shots/2026-11-06/${id}-1.png`, window_title: '太陽誘電(6976)', process: 'HYPERSBI2', rect: [0, 0, 1, 1], method: 'print' }], active_window_title: 'HYPER SBI 2', ...o });
  const EVENTS = [
    line('m-entry', '2026-11-06T09:21:30.000+09:00'), // 建て（信用新規買 09:21:32）の 2 秒前
    line('m-exit', '2026-11-06T09:40:04.000+09:00', { tags: [] }), // 近くにあるのは返済売だけ → 結び付けない
    line('m-test', '2026-11-06T09:21:31.000+09:00', { test: true }),
    '{"v":1,"type":"real_memo","id":"m-half"',
  ].join('\n');

  it('test と書きかけを飛ばして冪等に取り込み、前後 60 秒の建て約定にだけ結び付け、AI 書き出しに載せる', async () => {
    await setup();
    const r1 = await ingestRealMemos(db, EVENTS);
    expect({ newMemos: r1.newMemos, test: r1.test, partial: r1.partial, errors: r1.errors.length }).toEqual({ newMemos: 2, test: 1, partial: 1, errors: 0 });
    expect((await ingestRealMemos(db, EVENTS)).newMemos).toBe(0);
    expect(await db.realMemo.count()).toBe(2);

    expect(await linkRealMemos(db)).toEqual({ memos: 2, linked: 1, changed: 1 });
    expect(await linkRealMemos(db), '2 回目は何も変えない').toEqual({ memos: 2, linked: 1, changed: 0 });
    const entry = await db.realMemo.findUniqueOrThrow({ where: { id: 'm-entry' }, include: { execution: true } });
    expect(entry.execution).toMatchObject({ side: 'BUY', marginType: 'MARGIN_LONG' });
    expect(entry.linkDeltaMs).toBe(2000);
    expect((await db.realMemo.findUniqueOrThrow({ where: { id: 'm-exit' } })).executionId).toBeNull();

    const out = path.join(dir, 'ai');
    await exportForAi(db, out, NOW, { replayEnd: () => null });
    const lines = fs.readFileSync(path.join(out, 'trades.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.find((l) => l.symbol === '6976').real_memos).toEqual([
      {
        at: '2026-11-06T09:21:30.000+09:00',
        execution_at: '2026-11-06T09:21:32.000+09:00',
        delta_ms: 2000,
        tags: ['押し目'],
        shots: ['data/real/shots/2026-11-06/m-entry-1.png'],
        active_window_title: 'HYPER SBI 2',
        capture_error: null,
      },
    ]);
    expect(lines.find((l) => l.symbol === '7203').real_memos).toEqual([]);
    expect(fs.readFileSync(path.join(out, 'summary.md'), 'utf8')).toContain('本番エントリー記録（Windows の記録小窓）: 2 件 / SBI の建て約定に結び付いた 1 件');
  });
});
