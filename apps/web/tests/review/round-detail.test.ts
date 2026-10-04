// 1 約定を 2 ラウンドで分け合うケース（ドテン・現物の建玉超過売り）を、実際の
// buildSbiRounds → rebuildRounds → loadRoundDetail で確かめる。DB は一時ファイルの SQLite にマイグレーションを流して作る。

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@/generated/prisma/client';
import { rebuildRounds } from '@/lib/rounds/rebuild';
import { loadRoundDetail } from '@/lib/review/queries';

const MIGRATIONS = path.resolve(__dirname, '../../../../prisma/migrations');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradelog-round-detail-'));
let n = 0;
const clients: PrismaClient[] = [];

function freshDb(): PrismaClient {
  const file = path.join(dir, `t${n++}.db`);
  const raw = new Database(file);
  for (const m of fs.readdirSync(MIGRATIONS).filter((d) => fs.statSync(path.join(MIGRATIONS, d)).isDirectory()).sort()) {
    raw.exec(fs.readFileSync(path.join(MIGRATIONS, m, 'migration.sql'), 'utf8'));
  }
  raw.close();
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  clients.push(db);
  return db;
}

afterAll(async () => {
  for (const c of clients) await c.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY = new Date('2026-05-14T00:00:00Z'); // JST 2026-05-14 09:00（日付精度）
const NOW = new Date('2026-06-01T00:00:00Z');

type MT = 'CASH' | 'MARGIN_LONG' | 'MARGIN_SHORT';
let db: PrismaClient;
let instrumentId: number;

beforeEach(async () => {
  db = freshDb();
  instrumentId = (await db.instrument.create({ data: { symbol: '7203', name: 'テスト' } })).id;
});

async function exec(id: string, p: { side: 'BUY' | 'SELL'; qty: string; price: string; marginType: MT; hash: string; seq: number }) {
  await db.execution.create({
    data: {
      id,
      source: 'SBI',
      instrumentId,
      account: 'default',
      executedAt: DAY,
      timePrecision: 'day',
      side: p.side,
      qty: p.qty,
      price: p.price,
      fee: '0',
      marginType: p.marginType,
      priceStatus: 'CONFIRMED',
      dedupeHash: p.hash,
      seq: p.seq,
      rawJson: '{}',
    },
  });
}

const rid = (hash: string, flip = false) => `sbi-${hash.slice(0, 16)}${flip ? '-flip' : ''}`;
const roundExecIds = async (id: string) =>
  (await db.execution.findMany({ where: { roundId: id }, select: { id: true } })).map((e) => e.id).sort();

describe('共有約定の所属（rebuildRounds）', () => {
  // SELL の hash が BUY より辞書順で小さいと、-flip ラウンドが先に書かれる（以前はここで所属が上書きされた）
  const orders = [
    { label: 'SELL の hash が小さい', buy: 'bbbbbbbbbbbbbbbbXX', sell: 'aaaaaaaaaaaaaaaaXX' },
    { label: 'SELL の hash が大きい', buy: 'aaaaaaaaaaaaaaaaXX', sell: 'bbbbbbbbbbbbbbbbXX' },
  ];

  for (const o of orders) {
    it(`現物の建玉超過売り（${o.label}）: 共有約定は建値不明ラウンドに属し、元ラウンドの建玉は 0 で終わる`, async () => {
      await exec('buy', { side: 'BUY', qty: '100', price: '100', marginType: 'CASH', hash: o.buy, seq: 1 });
      await exec('sell', { side: 'SELL', qty: '150', price: '110', marginType: 'CASH', hash: o.sell, seq: 2 });
      await rebuildRounds(db, NOW);

      expect(await roundExecIds(rid(o.sell, true))).toEqual(['sell']);
      expect(await roundExecIds(rid(o.buy))).toEqual(['buy']);

      const main = (await loadRoundDetail(db, rid(o.buy), NOW))!;
      expect(main.executions.map((e) => [e.id, e.flipShared, e.posAfter, e.avgAfter])).toEqual([
        ['buy', false, '100', '100'],
        ['sell', true, '0', null],
      ]);
      expect(main.executions[1].shareNote).toBe('一部は期間外に買った株の売却（別の取引）');
      expect(main.chart.execs.map((e) => e.id)).toEqual(['buy', 'sell']);
      // 平均建値の線は決済の日で終わる（to が null のまま続かない）
      expect(main.chart.avgSteps).toEqual([{ from: '2026-05-14', to: '2026-05-14', avg: '100' }]);

      const prior = (await loadRoundDetail(db, rid(o.sell, true), NOW))!;
      expect(prior.round.qtyOpened).toBe('50');
      expect(prior.executions.map((e) => [e.id, e.flipShared, e.posAfter])).toEqual([['sell', false, null]]);
      expect(prior.executions[0].shareNote).toBe('うち 50 株が期間外に買った株の売却（残りは前の取引の決済）');
      expect(prior.chart.avgSteps).toEqual([]);
    });

    it(`信用ドテン（${o.label}）: 共有約定は -flip ラウンドに属し、元ラウンドには決済側として出る`, async () => {
      await exec('buy', { side: 'BUY', qty: '100', price: '100', marginType: 'MARGIN_LONG', hash: o.buy, seq: 1 });
      await exec('sell', { side: 'SELL', qty: '150', price: '110', marginType: 'MARGIN_LONG', hash: o.sell, seq: 2 });
      await rebuildRounds(db, NOW);

      expect(await roundExecIds(rid(o.sell, true))).toEqual(['sell']);
      expect(await roundExecIds(rid(o.buy))).toEqual(['buy']);

      const main = (await loadRoundDetail(db, rid(o.buy), NOW))!;
      expect(main.executions.map((e) => [e.id, e.flipShared, e.posAfter, e.avgAfter, e.shareNote])).toEqual([
        ['buy', false, '100', '100', null],
        ['sell', true, '0', null, '反転（一部は次の取引の建て）'],
      ]);
      expect(main.chart.execs.map((e) => e.id)).toEqual(['buy', 'sell']);
      expect(main.chart.avgSteps).toEqual([{ from: '2026-05-14', to: '2026-05-14', avg: '100' }]);

      const flip = (await loadRoundDetail(db, rid(o.sell, true), NOW))!;
      expect(flip.round.direction).toBe('SHORT');
      expect(flip.executions.map((e) => [e.id, e.flipShared, e.shareNote])).toEqual([['sell', false, null]]);
    });
  }
});

describe('反転約定の検索（findFlipClosers）', () => {
  it('例 A: 同日の別の現物売り（建値不明ラウンド）の詳細に、超過売りの約定が混ざらない', async () => {
    await exec('buy', { side: 'BUY', qty: '100', price: '100', marginType: 'CASH', hash: 'c1ccccccccccccccczz', seq: 1 });
    await exec('sell150', { side: 'SELL', qty: '150', price: '110', marginType: 'CASH', hash: 'c2ccccccccccccccczz', seq: 2 });
    await exec('sell20', { side: 'SELL', qty: '20', price: '111', marginType: 'CASH', hash: 'c3ccccccccccccccczz', seq: 3 });
    await rebuildRounds(db, NOW);

    const small = (await loadRoundDetail(db, rid('c3ccccccccccccccczz'), NOW))!;
    expect(small.round.qtyOpened).toBe('20');
    expect(small.executions.map((e) => [e.id, e.flipShared, e.shareNote])).toEqual([['sell20', false, null]]);
    expect(small.chart.execs.map((e) => e.id)).toEqual(['sell20']);

    // 元ラウンドには自分の決済だけが補われる
    const main = (await loadRoundDetail(db, rid('c1ccccccccccccccczz'), NOW))!;
    expect(main.executions.map((e) => [e.id, e.flipShared, e.posAfter])).toEqual([
      ['buy', false, '100'],
      ['sell150', true, '0'],
    ]);
  });

  it('例 B: 同日の信用ロングの決済ラウンドに、現物の超過売りの約定が混ざらない', async () => {
    await exec('cbuy', { side: 'BUY', qty: '100', price: '100', marginType: 'CASH', hash: 'd1ddddddddddddddzz', seq: 1 });
    await exec('csell', { side: 'SELL', qty: '150', price: '110', marginType: 'CASH', hash: 'd2ddddddddddddddzz', seq: 2 });
    await exec('mbuy', { side: 'BUY', qty: '100', price: '100', marginType: 'MARGIN_LONG', hash: 'd3ddddddddddddddzz', seq: 3 });
    await exec('msell', { side: 'SELL', qty: '100', price: '105', marginType: 'MARGIN_LONG', hash: 'd4ddddddddddddddzz', seq: 4 });
    await rebuildRounds(db, NOW);

    const margin = (await loadRoundDetail(db, rid('d3ddddddddddddddzz'), NOW))!;
    expect(margin.executions.map((e) => [e.id, e.flipShared, e.posAfter])).toEqual([
      ['mbuy', false, '100'],
      ['msell', false, '0'],
    ]);
    expect(margin.chart.execs.map((e) => e.id)).toEqual(['mbuy', 'msell']);
  });
});
