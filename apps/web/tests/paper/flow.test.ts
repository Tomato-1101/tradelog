// 一時 SQLite（マイグレーションをそのまま当てた空 DB）で、取り込み → 約定確定 → ラウンド → 画面データ / AI 書き出しを通す。
// 本番の data/app.db には触れない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { ingestPaperEvents, resolvePaperExecutions, setManualPrice } from '@/lib/paper/ingest';
import { rebuildRounds } from '@/lib/rounds/rebuild';
import { exportForAi } from '@/lib/ai/export';
import { loadRoundDetail } from '@/lib/review/queries';

const MIGRATIONS = path.resolve(__dirname, '../../../../prisma/migrations');
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jst = (hms: string) => new Date(`2026-10-05T${hms}+09:00`);
const NOW = jst('16:00:00.000');

let dir: string;
let db: PrismaClient;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradelog-flow-'));
  const file = path.join(dir, 'app.db');
  const raw = new Database(file);
  for (const m of fs.readdirSync(MIGRATIONS).filter((d) => fs.existsSync(path.join(MIGRATIONS, d, 'migration.sql'))).sort()) {
    raw.exec(fs.readFileSync(path.join(MIGRATIONS, m, 'migration.sql'), 'utf8'));
  }
  raw.close();
  db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  fs.mkdirSync(path.join(dir, 'paper/shots/2026-10-05'), { recursive: true });
});
afterEach(async () => {
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

type OrderOpts = {
  id: string;
  pos: string;
  intent: 'open' | 'add' | 'close';
  side: 'buy' | 'sell';
  qty: string;
  ts: string;
  symbol?: string;
  shot?: Record<string, unknown> | null;
};
function order(o: OrderOpts): string {
  return JSON.stringify({
    v: 1,
    id: o.id,
    type: 'order',
    ts: `2026-10-05T${o.ts}+09:00`,
    position_id: o.pos,
    intent: o.intent,
    symbol: o.symbol ?? '7203',
    side: o.side,
    qty: o.qty,
    order_type: 'market',
    limit_price: null,
    shot: o.shot === undefined ? null : o.shot,
  });
}
const shot = (name: string, price: string | null, captured: string, extra: Record<string, unknown> = {}) => ({
  path: `shots/2026-10-05/${name}.png`,
  price_text: price,
  price,
  symbol_text: null,
  confidence: price ? 0.99 : null,
  captured_at: `2026-10-05T${captured}+09:00`,
  window_title: '全板　トヨタ自動車(7203)',
  ocr_path: `shots/2026-10-05/${name}.ocr.json`,
  ...extra,
});
function writeSidecar(name: string, auto: Record<string, unknown>) {
  const body = { v: 1, width: 3074, height: 2714, captured_at: '2026-10-05T10:00:30.900+09:00', window_title: null, auto, items: [] };
  fs.writeFileSync(path.join(dir, 'paper/shots/2026-10-05', `${name}.ocr.json`), JSON.stringify(body));
}
async function bars(symbol: string, rows: Array<[string, number, number, number]>) {
  const inst = await db.instrument.findUniqueOrThrow({ where: { market_symbol: { market: 'TSE', symbol } } });
  await db.bar.createMany({
    data: rows.map(([hm, low, high, close]) => ({ instrumentId: inst.id, timeframe: '1m', ts: jst(`${hm}:00.000`), open: close, high, low, close, volume: 100, source: 'test' })),
  });
}
async function daily(text: string) {
  const ing = await ingestPaperEvents(db, text, NOW, { paperDir: path.join(dir, 'paper') });
  const res = await resolvePaperExecutions(db);
  const rb = await rebuildRounds(db, NOW);
  return { ing, res, rb };
}
const execOf = (orderId: string) => db.execution.findUniqueOrThrow({ where: { paperOrderId: orderId } });

describe('ドテン（close + open の 2 行・同じ ts・同じ shot）', () => {
  const DOTEN = shot('doten', '1010', '10:05:20.873');
  const text = [
    order({ id: U(1), pos: U(900), intent: 'open', side: 'buy', qty: '100', ts: '10:00:10.000', shot: shot('a1', '1000', '10:00:10.250') }),
    order({ id: U(2), pos: U(900), intent: 'close', side: 'sell', qty: '100', ts: '10:05:20.123', shot: DOTEN }),
    order({ id: U(3), pos: U(901), intent: 'open', side: 'sell', qty: '50', ts: '10:05:20.123', shot: DOTEN }),
    order({ id: U(4), pos: U(901), intent: 'close', side: 'buy', qty: '50', ts: '10:10:30.000', shot: shot('b2', '1005', '10:10:30.400') }),
  ].join('\n');

  it('2 行とも取り込まれ、同じ shot path の Shot が 2 行できる（一意制約で落ちない）', async () => {
    const { ing } = await daily(text);
    expect(ing.errors).toEqual([]);
    expect(ing.accepted).toBe(4);
    const shots = await db.shot.findMany({ where: { path: 'shots/2026-10-05/doten.png' }, orderBy: { paperOrderId: 'asc' } });
    expect(shots.map((s) => [s.paperOrderId, s.captureDelayMs])).toEqual([
      [U(2), 750],
      [U(3), 750],
    ]);
    // 2 回目も同じ結果（冪等）
    const again = await daily(text);
    expect(again.ing.newEvents).toBe(0);
    expect(await db.shot.count()).toBe(4);
  });

  it('2 行目の open が新しいラウンドになり、損益がそれぞれで出る', async () => {
    await ingestPaperEvents(db, text, NOW, { paperDir: path.join(dir, 'paper') });
    await bars('7203', [
      ['10:00', 995, 1005, 1001],
      ['10:05', 1005, 1015, 1012],
      ['10:10', 1000, 1010, 1006],
    ]);
    await resolvePaperExecutions(db);
    const rb = await rebuildRounds(db, NOW);
    expect(rb.warnings).toEqual([]);
    const rounds = await db.round.findMany({ orderBy: { openedAt: 'asc' } });
    expect(rounds.map((r) => [r.id, r.direction, r.status, r.qtyOpened, r.avgEntryPrice, r.avgExitPrice, r.netPnl, r.hasUnresolved])).toEqual([
      [U(900), 'LONG', 'CLOSED', '100', '1000', '1010', '1000', false],
      [U(901), 'SHORT', 'CLOSED', '50', '1010', '1005', '250', false],
    ]);
    expect(rounds[0].closedAt?.getTime()).toBe(rounds[1].openedAt.getTime());
    // 約定はそれぞれのラウンドに 1 回ずつ
    expect((await execOf(U(2))).roundId).toBe(U(900));
    expect((await execOf(U(3))).roundId).toBe(U(901));
  });
});

describe('追加2: 指値の状態は検証済みの現在値で決まる（生の shot.price で PENDING のまま残さない）', () => {
  const limitOrder = (id: string, pos: string, limit: string, s: Record<string, unknown>) =>
    JSON.stringify({ ...JSON.parse(order({ id, pos, intent: 'open', side: 'buy', qty: '100', ts: '10:00:30.000', shot: s })), order_type: 'limit', limit_price: limit });
  const MISREAD = U(21);
  const MARKETABLE = U(22);
  const text = [
    // 領域の誤読 980 で即約定に見えるが、検証済みの現在値（auto 1001）は買い指値 990 より上 → 約定しない
    limitOrder(MISREAD, U(921), '990', shot('m1', '980', '10:00:30.500')),
    // 領域の値 1000 が分足内で指値 1010 以内 → 即約定
    limitOrder(MARKETABLE, U(922), '1010', shot('m2', '1000', '10:00:30.500')),
  ].join('\n');
  const state = async (id: string) => (await db.paperOrder.findUniqueOrThrow({ where: { id } })).state;

  it('誤読で即約定に見えた指値は引け後に EXPIRED、即約定した指値は MARKET（成行と同じ扱い）で失効に数えない', async () => {
    await ingestPaperEvents(db, text, NOW, { paperDir: path.join(dir, 'paper') });
    await bars('7203', [['10:00', 995, 1005, 1003]]);
    writeSidecar('m1', { price: '1001', price_text: '1,001', price_time: '10:00', symbol: '7203', source: 'label' });
    const { res } = await daily(text);
    expect(await state(MISREAD)).toBe('EXPIRED');
    expect(await db.execution.findUnique({ where: { paperOrderId: MISREAD } })).toBeNull();
    expect(await state(MARKETABLE)).toBe('MARKET');
    expect(await execOf(MARKETABLE)).toMatchObject({ price: '1000', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN' });
    expect(res.noFill).toBe(1);
    const out = path.join(dir, 'ai');
    await exportForAi(db, out, NOW);
    expect(fs.readFileSync(path.join(out, 'summary.md'), 'utf8')).toMatch(/失効した指値: 1 件/);
  });

  it('足がまだ無く検証できない間は時刻どおり（引け後は EXPIRED・約定なし）、足が来たら即約定に上がる', async () => {
    await daily(text);
    expect(await state(MARKETABLE)).toBe('EXPIRED');
    expect(await db.execution.findUnique({ where: { paperOrderId: MARKETABLE } })).toBeNull();
    await bars('7203', [['10:00', 995, 1005, 1003]]);
    await daily(text);
    expect(await state(MARKETABLE)).toBe('MARKET');
    expect(await execOf(MARKETABLE)).toMatchObject({ price: '1000', priceStatus: 'CONFIRMED' });
  });
});

describe('サイドカーの自動読取で約定価格を確定する', () => {
  const ORDER = U(11);
  const text = order({ id: ORDER, pos: U(910), intent: 'open', side: 'buy', qty: '100', ts: '10:00:30.000', shot: shot('s1', null, '10:00:30.850') });
  const prepare = async () => {
    await ingestPaperEvents(db, text, NOW, { paperDir: path.join(dir, 'paper') });
    await bars('7203', [['10:00', 995, 1005, 1003]]);
  };

  it('サイドカーが範囲内 → 確定（SCREEN_AUTO）、撮影の遅れも保持', async () => {
    await prepare();
    writeSidecar('s1', { price: '1001', price_text: '1,001', price_time: '10:00', symbol: '7203', source: 'label' });
    const { ing } = await daily(text);
    expect(ing.sidecars).toEqual({ loaded: 1, missing: 0, errors: [] });
    const e = await execOf(ORDER);
    expect([e.price, e.priceStatus, e.priceBasis]).toEqual(['1001', 'CONFIRMED', 'SCREEN_AUTO']);
    expect(e.priceNote).toMatch(/自動読取（label）/);
    const s = await db.shot.findUniqueOrThrow({ where: { paperOrderId: ORDER } });
    expect([s.autoPrice, s.autoPriceTime, s.autoSymbol, s.autoSource, s.captureDelayMs, s.windowTitle]).toEqual([
      '1001',
      '10:00',
      '7203',
      'label',
      850,
      '全板　トヨタ自動車(7203)',
    ]);
  });

  it('サイドカーが範囲外 → 足の終値を仮置きして要確認', async () => {
    await prepare();
    writeSidecar('s1', { price: '1200', price_text: '1,200', price_time: '10:00', symbol: '7203', source: 'label' });
    await daily(text);
    const e = await execOf(ORDER);
    expect([e.price, e.priceStatus, e.priceBasis]).toEqual(['1003', 'NEEDS_REVIEW', 'BAR']);
    expect(e.priceNote).toMatch(/1200/);
  });

  it('サイドカーがまだ無い → 要確認。後から書かれたら次の daily で確定に上がる', async () => {
    await prepare();
    const first = await daily(text);
    expect(first.ing.sidecars).toEqual({ loaded: 0, missing: 1, errors: [] });
    expect(await execOf(ORDER)).toMatchObject({ price: '1003', priceStatus: 'NEEDS_REVIEW', priceBasis: 'BAR' });
    expect((await db.round.findUniqueOrThrow({ where: { id: U(910) } })).hasUnresolved).toBe(true);

    writeSidecar('s1', { price: '999', price_text: '999', price_time: '10:00', symbol: '7203', source: 'region' });
    const second = await daily(text);
    expect(second.ing.sidecars.loaded).toBe(1);
    expect(await execOf(ORDER)).toMatchObject({ price: '999', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN_AUTO' });
    expect((await db.round.findUniqueOrThrow({ where: { id: U(910) } })).hasUnresolved).toBe(false);
  });

  it('書きかけのサイドカーは読めない扱いで、前の状態のまま（次回読み直す）', async () => {
    await prepare();
    fs.writeFileSync(path.join(dir, 'paper/shots/2026-10-05/s1.ocr.json'), '{"v":1,"auto":{"pri');
    const { ing } = await daily(text);
    expect(ing.sidecars.loaded).toBe(0);
    expect(ing.sidecars.errors).toHaveLength(1);
    expect(await execOf(ORDER)).toMatchObject({ priceStatus: 'NEEDS_REVIEW', priceBasis: 'BAR' });
  });

  it('指摘11: ENOENT 以外の読み取りエラー（ディレクトリ等）でも止まらず errors に積み、前回の OCR 値を残す', async () => {
    await prepare();
    writeSidecar('s1', { price: '1001', price_text: '1,001', price_time: '10:00', symbol: '7203', source: 'label' });
    await daily(text);
    const f = path.join(dir, 'paper/shots/2026-10-05/s1.ocr.json');
    fs.rmSync(f);
    fs.mkdirSync(f); // 読むと EISDIR
    const { ing } = await daily(text);
    expect(ing.sidecars.loaded).toBe(0);
    expect(ing.sidecars.errors).toHaveLength(1);
    expect(ing.sidecars.errors[0].message).toMatch(/EISDIR/);
    expect((await db.shot.findUniqueOrThrow({ where: { paperOrderId: ORDER } })).autoPrice).toBe('1001');
    expect(await execOf(ORDER)).toMatchObject({ price: '1001', priceBasis: 'SCREEN_AUTO' });
  });

  it('手入力（MANUAL）で確定した値は、後からサイドカーが来ても上書きしない', async () => {
    await prepare();
    await daily(text);
    await setManualPrice(db, (await execOf(ORDER)).id, '1002', '板を見て確定');
    writeSidecar('s1', { price: '1001', price_text: '1,001', price_time: '10:00', symbol: '7203', source: 'label' });
    const { res } = await daily(text);
    expect(res.manualKept).toBe(1);
    expect(await execOf(ORDER)).toMatchObject({ price: '1002', priceStatus: 'CONFIRMED', priceBasis: 'MANUAL', priceNote: '板を見て確定' });
  });

  it('撮影画面の銘柄が発注銘柄と違えば、ラウンドの警告に残す（銘柄は order のまま）', async () => {
    await prepare();
    writeSidecar('s1', { price: '1001', price_text: '1,001', price_time: '10:00', symbol: '5803', source: 'label' });
    const { rb } = await daily(text);
    const r = await db.round.findUniqueOrThrow({ where: { id: U(910) }, include: { instrument: true } });
    expect(r.instrument.symbol).toBe('7203');
    expect(JSON.parse(r.warningsJson)).toEqual(['撮影画面の銘柄と発注銘柄が違う（画面 5803 / 発注 7203）']);
    expect(rb.warnings).toEqual([`${U(910)}: 撮影画面の銘柄と発注銘柄が違う（画面 5803 / 発注 7203）`]);
  });

  it('指摘4: 撮影画面の銘柄が違えば、価格帯が重なっても auto.price で確定しない（警告は残す）', async () => {
    await prepare();
    writeSidecar('s1', { price: '1001', price_text: '1,001', price_time: '10:00', symbol: '5803', source: 'label' });
    const { rb } = await daily(text);
    expect(await execOf(ORDER)).toMatchObject({ price: '1003', priceStatus: 'NEEDS_REVIEW', priceBasis: 'BAR' });
    expect(rb.warnings).toEqual([`${U(910)}: 撮影画面の銘柄と発注銘柄が違う（画面 5803 / 発注 7203）`]);
  });

  it('撮影の遅れは取引詳細の約定と AI 書き出しに出る', async () => {
    await prepare();
    writeSidecar('s1', { price: '1001', price_text: '1,001', price_time: '10:00', symbol: '7203', source: 'label' });
    await daily(text);
    const d = await loadRoundDetail(db, U(910), NOW);
    expect(d?.executions.map((e) => [e.captureDelayMs, e.priceBasis])).toEqual([[850, 'SCREEN_AUTO']]);
    expect(d?.shots[0].autoPrice).toBe('1001');

    const out = path.join(dir, 'ai');
    await exportForAi(db, out, NOW);
    const rec = JSON.parse(fs.readFileSync(path.join(out, 'trades.jsonl'), 'utf8').trim());
    expect(rec.executions[0]).toMatchObject({
      price: '1001',
      price_basis: 'SCREEN_AUTO',
      screen_price: null,
      screen_auto_price: '1001',
      screen_auto_source: 'label',
      capture_delay_ms: 850,
    });
  });
});
