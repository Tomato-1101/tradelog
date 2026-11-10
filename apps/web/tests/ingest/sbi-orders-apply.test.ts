// 一時 SQLite（マイグレーションをそのまま当てた空 DB）で、CSV 取り込み → 注文履歴の時刻反映 → ラウンドを通す。
// 本番の data/app.db には触れない。
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

const MIGRATIONS = path.resolve(__dirname, '../../../../prisma/migrations');
const NOW = new Date('2026-11-06T16:00:00+09:00');

let dir: string;
let db: PrismaClient;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradelog-orders-'));
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

const THIRD = [
  '約定履歴照会 ',
  '',
  '約定日,銘柄,銘柄コード,市場,取引,期限,預り,課税,約定数量,約定単価,手数料/諸経費等,税額,受渡日,受渡金額/決済損益',
  // CSV は同日内で返済が先に並ぶ
  '"2026/11/06","太陽誘電","6976","PTS（X）",信用返済売,"6ヶ月"," 特定 ","申告",100,5880,22,--,"2026/11/10",900',
  '"2026/11/06","太陽誘電","6976","PTS（X）",信用新規買,"6ヶ月"," 特定 ","--",100,5870.8,--,--,"2026/11/10",--',
].join('\n');

const HEAD = ['日付', '時刻', '市場', '取引', '状況', '未約定株数', '約定株数', '執行条件', '単価', '条件'];
const order = (orderNo: string, kind: string, hms: string, price: string) => ({
  date: '2026-11-06',
  orderNo,
  listRow: [orderNo, '', '完了(全部約定)', '通常注文', `${kind}(6ヶ月) 特定/A`, '太陽誘電 6976 SOR', '', '指値', `${price} ${price}`, '--', ''],
  rows: [HEAD, ['26/11/06', hms, 'PTS（X）', kind, '約定', '0', '100', '--', price, '--']],
});
const FILLS = [...parseSbiOrder(order('10052', '信新買', '09:21:32', '5,870.8')).fills, ...parseSbiOrder(order('10053', '信返売', '09:40:05', '5,880')).fills];

describe('applySbiOrderTimes', () => {
  it('時刻と精度を書き換え、2 回目は何も変えない。ラウンドに保有秒数が出る', async () => {
    await importSbiCsv(db, Buffer.from(THIRD), 'SaveFile_test.csv');
    const r1 = await applySbiOrderTimes(db, FILLS);
    expect({ candidates: r1.candidates, timed: r1.timed, updated: r1.updated }).toEqual({ candidates: 2, timed: 2, updated: 2 });
    const execs = await db.execution.findMany({ orderBy: { executedAt: 'asc' } });
    expect(execs.map((e) => [e.side, e.executedAt.toISOString(), e.timePrecision])).toEqual([
      ['BUY', '2026-11-06T00:21:32.000Z', 'ms'],
      ['SELL', '2026-11-06T00:40:05.000Z', 'ms'],
    ]);
    const raw = JSON.parse(execs[0].rawJson);
    expect(raw['市場']).toBe('PTS（X）'); // CSV の行は残す
    expect(raw._sbiOrder).toMatchObject({ time: '09:21:32', market: 'PTS（X）', fills: [{ orderNo: '10052', orderType: '指値', orderPrice: '5870.8' }] });

    const r2 = await applySbiOrderTimes(db, FILLS);
    expect(r2.updated).toBe(0);
    expect(r2.timed).toBe(2);

    await rebuildRounds(db, NOW, { replayEnd: () => null });
    const rounds = await db.round.findMany();
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ timePrecision: 'ms', holdSeconds: 18 * 60 + 33, realizedPnl: '920', status: 'CLOSED' });
  });

  it('時刻を付けた後に同じ CSV を取り込み直しても重複として除かれる', async () => {
    await importSbiCsv(db, Buffer.from(THIRD), 'SaveFile_test.csv');
    await applySbiOrderTimes(db, FILLS);
    const again = await importSbiCsv(db, Buffer.from(THIRD), 'SaveFile_test.csv');
    expect(again.newCount).toBe(0);
    expect(again.dupCount).toBe(2);
    expect(await db.execution.count()).toBe(2);
  });

  it('時刻を付けた日（09:00 以外）も、当日約定 CSV は「約定履歴で取り込み済みの日」として取り込まない', async () => {
    await importSbiCsv(db, Buffer.from(THIRD), 'SaveFile_test.csv');
    await applySbiOrderTimes(db, FILLS);
    const daily = [
      '銘柄,銘柄,銘柄,取引区分,期限,預り区分,約定日,受渡日,株数,平均約定単価,手数料・諸経費等,課税額・譲渡益税,受渡金額・決済損益,受渡金額(日計り分)',
      '6976,太陽誘電,PTS（X）,信用新規買,６ヵ月,特定,2026/11/06,2026/11/10,100,"5,870.8",--,--,--,--',
    ].join('\n');
    const r = await importSbiCsv(db, Buffer.from(daily), '注文一覧_当日約定20261106.csv');
    expect(r.coveredByHistory).toBe(1);
    expect(r.newCount).toBe(0);
  });
});
