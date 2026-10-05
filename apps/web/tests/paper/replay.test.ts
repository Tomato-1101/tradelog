// リプレイ（録画を再生しながらの練習。data/paper/replay/events.jsonl）の取り込み〜画面データ〜AI 書き出し。
// 一時 SQLite（マイグレーションをそのまま当てた空 DB）を使い、本番の data/app.db には触れない。足は手で入れる（Yahoo は呼ばない）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { parseEventLine, parseEventsText } from '@/lib/paper/events';
import { ingestPaperEvents, resolvePaperExecutions, setManualPrice } from '@/lib/paper/ingest';
import { rebuildRounds } from '@/lib/rounds/rebuild';
import { barWindowTo, openRoundEnd } from '@/lib/rounds/excursion';
import { readRecordingMeta, recordedSymbolDays, replayEndResolver, replayEvalEnd } from '@/lib/paper/recordings';
import { fetchAndStoreBars, planBarFetches } from '@/lib/bars/store';
import { exportForAi } from '@/lib/ai/export';
import { listRounds, loadRoundDetail, loadStatsRounds, reviewRoundCounts } from '@/lib/review/queries';
import { fmtVideoMs } from '@/lib/format';

const MIGRATIONS = path.resolve(__dirname, '../../../../prisma/migrations');
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SESSION = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const REC = '20261002-085312';
// 録画は 10/02（金）の朝、練習と daily は 10/05（月）
const REC_DAY = '2026-10-02';
const PAPER_DAY = '2026-10-05';
const NOW = new Date(`${PAPER_DAY}T16:00:00.000+09:00`);
const at = (day: string, hms: string) => new Date(`${day}T${hms}+09:00`);

type O = { id: string; pos: string; intent: 'open' | 'add' | 'close'; side: 'buy' | 'sell'; ts: string; day: string; shot?: Record<string, unknown> | null };
const orderObj = (o: O) => ({
  v: 1,
  id: o.id,
  type: 'order',
  ts: `${o.day}T${o.ts}+09:00`,
  position_id: o.pos,
  intent: o.intent,
  symbol: '7203',
  side: o.side,
  qty: '100',
  order_type: 'market',
  limit_price: null,
  shot: o.shot === undefined ? null : o.shot,
});
const replayOf = (videoMs: number) => ({ recording_id: REC, session_id: SESSION, video_ms: videoMs });
const paperOrder = (o: Omit<O, 'day'>) => JSON.stringify(orderObj({ ...o, day: PAPER_DAY }));
const replayOrder = (o: Omit<O, 'day'>, videoMs: number) => JSON.stringify({ ...orderObj({ ...o, day: REC_DAY }), replay: replayOf(videoMs) });
const replayShot = (name: string, price: string | null) => ({
  path: `replay/shots/${REC_DAY}/${name}.png`,
  price_text: price,
  price,
  symbol_text: null,
  confidence: price ? 0.99 : null,
  captured_at: `${REC_DAY}T09:05:10.000+09:00`,
  window_title: '全板　トヨタ自動車(7203)',
  ocr_path: `replay/shots/${REC_DAY}/${name}.ocr.json`,
});

describe('parse: replay フィールドの検証', () => {
  const base = { ...orderObj({ id: U(1), pos: U(900), intent: 'open', side: 'buy', ts: '09:05:10.000', day: REC_DAY }) };
  const err = (o: unknown, replay = true) => {
    const r = parseEventLine(JSON.stringify(o), 1, { replay });
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.error.message;
  };

  it('リプレイの行は replay を読み、イベントに載せる（全型）', () => {
    const r = parseEventLine(JSON.stringify({ ...base, replay: replayOf(483123) }), 1, { replay: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.replay).toEqual({ recordingId: REC, sessionId: SESSION, videoMs: 483123 });
    const ts = `${REC_DAY}T09:06:00.000+09:00`;
    for (const ev of [
      { v: 1, id: U(2), type: 'fill_mark', ts, order_id: U(1) },
      { v: 1, id: U(3), type: 'cancel', ts, order_id: U(1) },
      { v: 1, id: U(4), type: 'memo', ts, position_id: U(900), text: 'あ' },
    ]) {
      const x = parseEventLine(JSON.stringify({ ...ev, replay: replayOf(0) }), 1, { replay: true });
      expect(x.ok && x.event.replay).toEqual({ recordingId: REC, sessionId: SESSION, videoMs: 0 });
    }
    // 同じ秒の 2 本目の録画（-2）
    expect(parseEventLine(JSON.stringify({ ...base, replay: { ...replayOf(1), recording_id: `${REC}-2` } }), 1, { replay: true }).ok).toBe(true);
  });

  it('通常の行には replay を付けない（従来と同じ形）', () => {
    const r = parseEventLine(JSON.stringify(base), 1);
    expect(r.ok && r.event.replay).toBeUndefined();
  });

  it('通常の events.jsonl に replay がある・リプレイの行に replay が無いのは契約違反', () => {
    expect(err({ ...base, replay: replayOf(1) }, false)).toMatch(/通常の events.jsonl に replay/);
    expect(err(base)).toMatch(/リプレイの行に replay が無い/);
  });

  it('replay の中身の違反', () => {
    expect(err({ ...base, replay: null })).toMatch(/replay がオブジェクトでない/);
    expect(err({ ...base, replay: { recording_id: REC, session_id: SESSION } })).toMatch(/replay.video_ms が無い/);
    expect(err({ ...base, replay: { ...replayOf(1), extra: 1 } })).toMatch(/replay.契約に無いキー: extra/);
    expect(err({ ...base, replay: { ...replayOf(1), recording_id: 'abc' } })).toMatch(/recording_id の形式が不正/);
    expect(err({ ...base, replay: { ...replayOf(1), recording_id: 20261002 } })).toMatch(/recording_id が文字列でない/);
    expect(err({ ...base, replay: { ...replayOf(1), session_id: 'not-uuid' } })).toMatch(/session_id の形式が不正/);
    expect(err({ ...base, replay: { ...replayOf(1), video_ms: -1 } })).toMatch(/video_ms は 0 以上の整数/);
    expect(err({ ...base, replay: { ...replayOf(1), video_ms: 1.5 } })).toMatch(/video_ms は 0 以上の整数/);
    expect(err({ ...base, replay: { ...replayOf(1), video_ms: '100' } })).toMatch(/video_ms は 0 以上の整数/);
  });

  it('違反の行だけ捨てて他の行は続ける（ファイル全体）', () => {
    const text = [
      replayOrder({ id: U(1), pos: U(900), intent: 'open', side: 'buy', ts: '09:05:10.000' }, 1000),
      JSON.stringify(orderObj({ id: U(2), pos: U(901), intent: 'open', side: 'buy', ts: '09:06:00.000', day: REC_DAY })), // replay 無し
      replayOrder({ id: U(3), pos: U(900), intent: 'close', side: 'sell', ts: '09:10:00.000' }, 290000),
    ].join('\n');
    const p = parseEventsText(text, { replay: true });
    expect(p.orders.map((o) => o.id)).toEqual([U(1), U(3)]);
    expect(p.errors).toEqual([{ line: 2, id: U(2), message: 'リプレイの行に replay が無い' }]);
  });
});

describe('fmtVideoMs', () => {
  it('m:ss.mmm / h:mm:ss.mmm', () => {
    expect(fmtVideoMs(483123)).toBe('8:03.123');
    expect(fmtVideoMs(0)).toBe('0:00.000');
    expect(fmtVideoMs(3_725_004)).toBe('1:02:05.004');
    expect(fmtVideoMs(null)).toBe('—');
  });
});

describe('openRoundEnd（未決済ラウンドの窓の終わり）', () => {
  it('リプレイは録画の終わりで止める（大引けまで延ばさない）。分からなければ null。ペーパー・SBI は now', () => {
    const end = at(REC_DAY, '09:30:12.400');
    expect(openRoundEnd('REPLAY', end, NOW)?.toISOString()).toBe(end.toISOString());
    expect(openRoundEnd('PAPER', null, NOW)).toBe(NOW);
    expect(openRoundEnd('REPLAY', null, NOW)).toBeNull();
    // 録画中に daily を回したら now の方が先
    const early = at(REC_DAY, '09:10:00.000');
    expect(openRoundEnd('REPLAY', end, early)).toBe(early);
  });
  it('チャート・AI 書き出しの窓: 未決済のリプレイは録画の終わりまで（30 分延ばさない）、分からなければ最後の約定まで', () => {
    const opened = at(REC_DAY, '09:05:10.000');
    const last = at(REC_DAY, '09:06:30.000');
    const end = at(REC_DAY, '09:30:12.400');
    const open = { source: 'REPLAY', openedAt: opened, closedAt: null };
    expect(barWindowTo(open, last, end, NOW, 30).toISOString()).toBe(at(REC_DAY, '09:30:00.000').toISOString());
    expect(barWindowTo(open, last, null, NOW, 30).toISOString()).toBe(at(REC_DAY, '09:06:00.000').toISOString());
    // 決済済み・ペーパーは従来どおり 30 分延ばす
    expect(barWindowTo({ ...open, closedAt: last }, last, end, NOW, 30).toISOString()).toBe(at(REC_DAY, '09:36:00.000').toISOString());
    expect(barWindowTo({ ...open, source: 'PAPER' }, last, null, NOW, 30).toISOString()).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
  });
});

describe('録画メタから録画の終わり', () => {
  it('ended_at → 無ければ started_at ＋ planned_minutes → どちらも無ければ null', () => {
    expect(replayEvalEnd({ started_at: '2026-10-02T08:53:12.345+09:00', ended_at: '2026-10-02T09:30:12.400+09:00', planned_minutes: 37 })?.toISOString()).toBe(
      at(REC_DAY, '09:30:12.400').toISOString(),
    );
    expect(replayEvalEnd({ started_at: '2026-10-02T08:53:12.345+09:00', ended_at: null, planned_minutes: 37 })?.toISOString()).toBe(
      at(REC_DAY, '09:30:12.345').toISOString(),
    );
    expect(replayEvalEnd({ started_at: '2026-10-02T08:53:12.345+09:00', ended_at: null, planned_minutes: null })).toBeNull();
    expect(replayEvalEnd({ started_at: null, ended_at: null, planned_minutes: 37 })).toBeNull();
    expect(replayEvalEnd(null)).toBeNull();
  });
  it('rec_id の日付のフォルダから読む。無い・形式が違えば null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradelog-recmeta-'));
    try {
      fs.mkdirSync(path.join(dir, 'replay/recordings', REC_DAY), { recursive: true });
      fs.writeFileSync(path.join(dir, 'replay/recordings', REC_DAY, `${REC}.json`), JSON.stringify({ v: 1, id: REC, ended_at: '2026-10-02T09:30:12.400+09:00' }));
      expect(readRecordingMeta(dir, REC)).toMatchObject({ id: REC });
      expect(readRecordingMeta(dir, '20261003-085312')).toBeNull();
      expect(readRecordingMeta(dir, '../x')).toBeNull();
      expect(replayEndResolver(dir)(REC)?.toISOString()).toBe(at(REC_DAY, '09:30:12.400').toISOString());
      expect(replayEndResolver(dir)(null)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DB: 取り込み → 確定 → ラウンド → 一覧・集計・詳細・AI 書き出し', () => {
  let dir: string;
  let paperDir: string;
  let db: PrismaClient;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradelog-replay-'));
    const file = path.join(dir, 'app.db');
    const raw = new Database(file);
    for (const m of fs.readdirSync(MIGRATIONS).filter((d) => fs.existsSync(path.join(MIGRATIONS, d, 'migration.sql'))).sort()) {
      raw.exec(fs.readFileSync(path.join(MIGRATIONS, m, 'migration.sql'), 'utf8'));
    }
    raw.close();
    db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
    paperDir = path.join(dir, 'paper');
    fs.mkdirSync(path.join(paperDir, 'replay/shots', REC_DAY), { recursive: true });
    replayEnd = replayEndResolver(paperDir);
  });
  let replayEnd: ReturnType<typeof replayEndResolver>;
  // 録画 REC のメタ（08:53:12 から 37 分、09:30:12 に閉じた）。null を渡すとその項目を書かない
  function writeMeta(fields: Record<string, unknown> = { ended_at: `${REC_DAY}T09:30:12.400+09:00` }) {
    fs.mkdirSync(path.join(paperDir, 'replay/recordings', REC_DAY), { recursive: true });
    fs.writeFileSync(
      path.join(paperDir, 'replay/recordings', REC_DAY, `${REC}.json`),
      JSON.stringify({ v: 1, id: REC, started_at: `${REC_DAY}T08:53:12.345+09:00`, status: 'done', planned_minutes: 37, ...fields }),
    );
  }
  afterEach(async () => {
    await db.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 同じ銘柄で、通常のペーパー 1 本（10/05）とリプレイ 1 本（録画 10/02）
  const PAPER_POS = U(800);
  const REPLAY_POS = U(900);
  const paperText = [
    paperOrder({ id: U(801), pos: PAPER_POS, intent: 'open', side: 'buy', ts: '10:00:10.000' }),
    paperOrder({ id: U(802), pos: PAPER_POS, intent: 'close', side: 'sell', ts: '10:05:10.000' }),
  ].join('\n');
  const replayText = [
    replayOrder({ id: U(901), pos: REPLAY_POS, intent: 'open', side: 'buy', ts: '09:05:10.000', shot: replayShot('r1', null) }, 717655),
    JSON.stringify({ v: 1, id: U(903), type: 'memo', ts: `${REC_DAY}T09:06:00.000+09:00`, position_id: REPLAY_POS, text: '押し目で入った', replay: replayOf(767655) }),
    replayOrder({ id: U(902), pos: REPLAY_POS, intent: 'close', side: 'sell', ts: '09:10:00.000', shot: replayShot('r2', '1010') }, 1007655),
  ].join('\n');

  async function bars(day: string, rows: Array<[string, number, number, number]>) {
    const inst = await db.instrument.findUniqueOrThrow({ where: { market_symbol: { market: 'TSE', symbol: '7203' } } });
    await db.bar.createMany({
      data: rows.map(([hm, low, high, close]) => ({ instrumentId: inst.id, timeframe: '1m', ts: at(day, `${hm}:00.000`), open: close, high, low, close, volume: 100, source: 'test' })),
    });
  }
  async function daily() {
    const ing = await ingestPaperEvents(db, paperText, NOW, { paperDir });
    const ring = await ingestPaperEvents(db, replayText, NOW, { paperDir, replay: true });
    const res = await resolvePaperExecutions(db);
    const rb = await rebuildRounds(db, NOW, { replayEnd });
    return { ing, ring, res, rb };
  }
  async function prepare() {
    await ingestPaperEvents(db, paperText, NOW, { paperDir });
    await bars(PAPER_DAY, [
      ['10:00', 995, 1005, 1000],
      ['10:05', 1015, 1025, 1020],
    ]);
    await bars(REC_DAY, [
      ['09:05', 1000, 1006, 1003],
      ['09:10', 1008, 1012, 1010],
    ]);
    // 1 本目のフレームは領域が読めず、サイドカーの自動読取（replay/shots 配下）で確定させる
    fs.writeFileSync(
      path.join(paperDir, 'replay/shots', REC_DAY, 'r1.ocr.json'),
      JSON.stringify({ v: 1, width: 620, height: 900, captured_at: null, window_title: null, auto: { price: '1004', price_text: '1,004', price_time: '09:05', symbol: '7203', source: 'label' }, items: [] }),
    );
  }

  it('REPLAY の約定は source=REPLAY・account=replay で、ペーパーと別のラウンドになる', async () => {
    await prepare();
    const { ing, ring, rb } = await daily();
    expect(ing.errors).toEqual([]);
    expect(ring.errors).toEqual([]);
    expect(ring.orders).toBe(2);
    expect(ring.sidecars).toEqual({ loaded: 1, missing: 1, errors: [] });
    expect([rb.paper, rb.replay, rb.sbi]).toEqual([1, 1, 0]);

    const o = await db.paperOrder.findUniqueOrThrow({ where: { id: U(901) } });
    expect([o.replayRecordingId, o.replaySessionId, o.replayVideoMs]).toEqual([REC, SESSION, 717655]);
    expect((await db.paperOrder.findUniqueOrThrow({ where: { id: U(801) } })).replayRecordingId).toBeNull();
    const m = await db.memo.findUniqueOrThrow({ where: { id: U(903) } });
    expect([m.replayRecordingId, m.replaySessionId, m.replayVideoMs, m.roundId]).toEqual([REC, SESSION, 767655, REPLAY_POS]);

    const ex = await db.execution.findMany({ orderBy: { executedAt: 'asc' }, include: { paperOrder: true } });
    expect(ex.map((e) => [e.paperOrderId, e.source, e.account, e.price, e.priceBasis, e.roundId])).toEqual([
      [U(901), 'REPLAY', 'replay', '1004', 'SCREEN_AUTO', REPLAY_POS],
      [U(902), 'REPLAY', 'replay', '1010', 'SCREEN', REPLAY_POS],
      [U(801), 'PAPER', 'paper', '1000', 'BAR', PAPER_POS],
      [U(802), 'PAPER', 'paper', '1020', 'BAR', PAPER_POS],
    ]);
    const rounds = await db.round.findMany({ orderBy: { openedAt: 'asc' } });
    expect(rounds.map((r) => [r.id, r.source, r.account, r.status, r.netPnl, r.mae, r.mfe])).toEqual([
      [REPLAY_POS, 'REPLAY', 'replay', 'CLOSED', '600', '-4', '8'],
      [PAPER_POS, 'PAPER', 'paper', 'CLOSED', '2000', '-5', '25'],
    ]);

    // 冪等
    const again = await daily();
    expect(again.ring.newEvents).toBe(0);
    expect(await db.execution.count()).toBe(4);
  });

  it('一覧・集計・要確認の件数は PAPER と REPLAY が混ざらない', async () => {
    await prepare();
    await daily();
    const ids = async (source: 'PAPER' | 'REPLAY' | 'SBI') =>
      (await listRounds(db, { source, period: { preset: 'all' }, reviewOnly: false, page: 1, now: NOW })).rows.map((r) => [r.id, r.source]);
    expect(await ids('REPLAY')).toEqual([[REPLAY_POS, 'REPLAY']]);
    expect(await ids('PAPER')).toEqual([[PAPER_POS, 'PAPER']]);
    expect(await ids('SBI')).toEqual([]);
    const stats = async (source: 'PAPER' | 'REPLAY') => (await loadStatsRounds(db, source, { preset: 'all' }, NOW)).map((r) => [r.id, r.netPnl]);
    expect(await stats('REPLAY')).toEqual([[REPLAY_POS, '600']]);
    expect(await stats('PAPER')).toEqual([[PAPER_POS, '2000']]);
    // ペーパーの約定は BAR（要確認）、リプレイは確定のみ
    expect(await reviewRoundCounts(db)).toEqual({ PAPER: 1, SBI: 0, REPLAY: 0 });
  });

  it('同じ録画を 2 回練習しても（時間が重なっても）セッションごとに別の建玉・別のラウンドで、向きは混ざらない', async () => {
    const SESSION2 = '7f1c2d3e-4a5b-4c6d-8e7f-001122334466';
    const POS2 = U(950);
    const shot = (name: string, price: string) => replayShot(name, price);
    const second = (o: Omit<O, 'day'>, videoMs: number) =>
      JSON.stringify({ ...orderObj({ ...o, day: REC_DAY }), replay: { recording_id: REC, session_id: SESSION2, video_ms: videoMs } });
    // 1 回目: 09:05:10 買い → 09:10:00 売り。2 回目: 09:04:00 売り（新規）→ 09:08:00 買い（決済）。2 回目の時刻は 1 回目の間に入る
    const text = [
      replayOrder({ id: U(901), pos: REPLAY_POS, intent: 'open', side: 'buy', ts: '09:05:10.000', shot: shot('a1', '1000') }, 717655),
      replayOrder({ id: U(902), pos: REPLAY_POS, intent: 'close', side: 'sell', ts: '09:10:00.000', shot: shot('a2', '1010') }, 1007655),
      second({ id: U(951), pos: POS2, intent: 'open', side: 'sell', ts: '09:04:00.000', shot: shot('b1', '1002') }, 647655),
      second({ id: U(952), pos: POS2, intent: 'close', side: 'buy', ts: '09:08:00.000', shot: shot('b2', '1005') }, 887655),
    ].join('\n');
    const ring = await ingestPaperEvents(db, text, NOW, { paperDir, replay: true });
    expect(ring.errors).toEqual([]);
    // 画面の価格は足の範囲に入っていれば採る
    await bars(REC_DAY, [
      ['09:04', 995, 1015, 1002],
      ['09:05', 995, 1015, 1000],
      ['09:08', 995, 1015, 1005],
      ['09:10', 995, 1015, 1010],
    ]);
    await resolvePaperExecutions(db);
    await rebuildRounds(db, NOW, { replayEnd });
    const rounds = await db.round.findMany({ orderBy: { openedAt: 'asc' } });
    expect(rounds.map((r) => [r.id, r.direction, r.status, r.netPnl])).toEqual([
      [POS2, 'SHORT', 'CLOSED', '-300'],
      [REPLAY_POS, 'LONG', 'CLOSED', '1000'],
    ]);
    const ex = await db.execution.findMany({ include: { paperOrder: true } });
    for (const e of ex) expect(e.roundId).toBe(e.paperOrder?.replaySessionId === SESSION2 ? POS2 : REPLAY_POS);
  });

  it('録画した日の銘柄（ウィンドウタイトルのコード）は、発注が無くても 1 分足を取る（重複して取らない・Yahoo は呼ばない）', async () => {
    writeMeta({
      samples: [
        { t_ms: 0, windows: [{ title: '全板　フジクラ(5803)' }, { title: 'チャート　トヨタ自動車（7203）' }, { title: 'ポートフォリオ' }] },
        { t_ms: 1000, windows: [{ title: '全板　フジクラ(5803)' }] },
      ],
    });
    // 45 日前の録画は対象外
    const old = '2026-08-21';
    fs.mkdirSync(path.join(paperDir, 'replay/recordings', old), { recursive: true });
    fs.writeFileSync(
      path.join(paperDir, 'replay/recordings', old, '20260821-085300.json'),
      JSON.stringify({ v: 1, id: '20260821-085300', started_at: `${old}T08:53:00.000+09:00`, samples: [{ t_ms: 0, windows: [{ title: '全板　ソニーグループ(6758)' }] }] }),
    );
    const recorded = recordedSymbolDays(paperDir, NOW);
    expect(recorded).toEqual([
      { symbol: '5803', date: REC_DAY },
      { symbol: '7203', date: REC_DAY },
    ]);
    // 7203 は同じ日にリプレイの建玉もある → 1 回にまとめる
    await ingestPaperEvents(db, replayText.split('\n')[0], NOW, { paperDir, replay: true });
    const plan = await planBarFetches(db, NOW, { recorded });
    const needs = plan.needs.map((n) => [n.symbol, n.timeframe, n.dates]).sort();
    expect(needs).toEqual([
      ['5803', '1m', [REC_DAY]],
      ['7203', '1d', [REC_DAY]],
      ['7203', '1m', [REC_DAY]],
    ]);

    const urls: string[] = [];
    const ts = Date.parse(`${REC_DAY}T09:05:00+09:00`) / 1000;
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ chart: { result: [{ timestamp: [ts], indicators: { quote: [{ open: [1], high: [2], low: [0.5], close: [1.5], volume: [10] }] } }], error: null } }),
      );
    }) as typeof fetch;
    const rep = await fetchAndStoreBars(db, plan.needs, { now: NOW, fetchImpl });
    expect(rep.failures).toEqual([]);
    expect(urls).toHaveLength(3);
    const fujikura = await db.instrument.findUniqueOrThrow({ where: { market_symbol: { market: 'TSE', symbol: '5803' } } });
    expect(await db.bar.count({ where: { instrumentId: fujikura.id, timeframe: '1m' } })).toBe(1);
    // 取得済み（出揃い）なら次は取らない
    expect((await planBarFetches(db, NOW, { recorded })).needs).toEqual([]);
  });

  it('リプレイの約定も手入力で確定できる', async () => {
    await ingestPaperEvents(db, replayText, NOW, { paperDir, replay: true });
    await resolvePaperExecutions(db);
    const e = await db.execution.findUniqueOrThrow({ where: { paperOrderId: U(901) } });
    expect(e.priceStatus).toBe('UNRESOLVED'); // 足もサイドカーも無い
    await setManualPrice(db, e.id, '1003', '録画を見て確定');
    expect(await db.execution.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ source: 'REPLAY', price: '1003', priceBasis: 'MANUAL' });
  });

  it('取引詳細: 録画・セッション・再生位置と、replay/shots のフレーム', async () => {
    await prepare();
    await daily();
    const d = await loadRoundDetail(db, REPLAY_POS, NOW, { replayEnd });
    expect(d?.round.source).toBe('REPLAY');
    expect(d?.replay).toEqual({ recordingIds: [REC], sessionIds: [SESSION] });
    expect(d?.executions.map((e) => [e.paperOrderId, e.videoMs])).toEqual([
      [U(901), 717655],
      [U(902), 1007655],
    ]);
    expect(d?.shots.map((s) => [s.path, s.videoMs])).toEqual([
      [`replay/shots/${REC_DAY}/r1.png`, 717655],
      [`replay/shots/${REC_DAY}/r2.png`, 1007655],
    ]);
    expect(d?.memos.map((m) => [m.text, m.videoMs])).toEqual([['押し目で入った', 767655]]);
    // チャートは録画の日の足だけ（10/05 のペーパーの足は入らない）
    expect(d?.chart.bars).toHaveLength(2);
    expect((await loadRoundDetail(db, PAPER_POS, NOW, { replayEnd }))?.replay).toBeNull();
  });

  it('AI 書き出し: REPLAY のラウンドに recording_id / session_id、約定に再生位置、summary に REPLAY 節', async () => {
    await prepare();
    await daily();
    const out = path.join(dir, 'ai');
    await exportForAi(db, out, NOW, { replayEnd });
    const recs = fs
      .readFileSync(path.join(out, 'trades.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const rep = recs.find((r) => r.round_id === REPLAY_POS);
    const pap = recs.find((r) => r.round_id === PAPER_POS);
    expect(rep).toMatchObject({ source: 'REPLAY', recording_id: REC, session_id: SESSION, shots: [`data/paper/replay/shots/${REC_DAY}/r1.png`, `data/paper/replay/shots/${REC_DAY}/r2.png`] });
    expect(rep.executions.map((e: { replay: unknown }) => e.replay)).toEqual([
      { recording_id: REC, session_id: SESSION, video_ms: 717655 },
      { recording_id: REC, session_id: SESSION, video_ms: 1007655 },
    ]);
    expect(rep.memos).toEqual([{ at: `${REC_DAY}T09:06:00.000+09:00`, order_id: null, text: '押し目で入った', video_ms: 767655 }]);
    expect(rep.bars_1m.rows).toHaveLength(2);
    expect(pap).toMatchObject({ source: 'PAPER', recording_id: null, session_id: null });
    expect(pap.executions[0].replay).toBeNull();
    expect(pap.memos).toEqual([]);
    const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
    expect(md).toMatch(/## REPLAY（録画を再生しながらの練習）\n\n\| 項目 \| 値 \|/);
    expect(md).toMatch(/\| 損益合計（手数料込み） \| 600 \|/);
  });

  it('未決済のリプレイは録画の終わりで止め、足の取得も今日まで延ばさない', async () => {
    writeMeta();
    const openOnly = replayText.split('\n').slice(0, 2).join('\n');
    await ingestPaperEvents(db, openOnly, NOW, { paperDir, replay: true });
    await bars(REC_DAY, [['09:05', 1000, 1006, 1003]]);
    // 録画が終わった後（09:30:12 より後）の同じ日の足。録画で見ていないので窓に入ってはいけない
    await bars(REC_DAY, [['09:40', 950, 1050, 1000]]);
    // 10/05 の同じ銘柄の足（ペーパー用）。リプレイの窓に入ってはいけない
    await bars(PAPER_DAY, [['10:00', 900, 1100, 1000]]);
    await resolvePaperExecutions(db);
    await rebuildRounds(db, NOW, { replayEnd });
    const r = await db.round.findUniqueOrThrow({ where: { id: REPLAY_POS } });
    // 建値は足の終値 1003。09:40 の足（950〜1050）が入ると -53 / +47、10/05 の足が入ると -103 / +97 になる
    expect([r.source, r.status, r.mae, r.mfe]).toEqual(['REPLAY', 'OPEN', '-3', '3']);
    // チャートと AI 書き出しも録画の終わりまで（09:40 の足を出さない）
    const d = await loadRoundDetail(db, REPLAY_POS, NOW, { replayEnd });
    expect(d?.chart.bars).toHaveLength(1);
    const out = path.join(dir, 'ai');
    await exportForAi(db, out, NOW, { replayEnd });
    const rec = JSON.parse(fs.readFileSync(path.join(out, 'trades.jsonl'), 'utf8').trim().split('\n')[0]);
    expect(rec.bars_1m.rows.map((x: unknown[]) => x[0])).toEqual([`${REC_DAY}T09:05:00.000+09:00`]);
    expect(rec.bars_1m.to).toBe(`${REC_DAY}T09:30:00.000+09:00`);

    // ended_at が無い（落ちた）録画は started_at ＋ 予定の分（09:30:12.345）で止める
    writeMeta({ ended_at: null });
    await rebuildRounds(db, NOW, { replayEnd: replayEndResolver(paperDir) });
    expect((await db.round.findUniqueOrThrow({ where: { id: REPLAY_POS } })).mae).toBe('-3');
    // 録画の終わりが分からなければ評価しない
    writeMeta({ ended_at: null, planned_minutes: null });
    await rebuildRounds(db, NOW, { replayEnd: replayEndResolver(paperDir) });
    const unknown = await db.round.findUniqueOrThrow({ where: { id: REPLAY_POS } });
    expect([unknown.mae, unknown.mfe]).toEqual([null, null]);
    fs.rmSync(path.join(paperDir, 'replay/recordings'), { recursive: true });
    await rebuildRounds(db, NOW, { replayEnd: replayEndResolver(paperDir) });
    expect((await db.round.findUniqueOrThrow({ where: { id: REPLAY_POS } })).mae, 'メタが無い録画も評価しない').toBeNull();
    const plan = await planBarFetches(db, NOW);
    expect(plan.needs.map((n) => [n.timeframe, n.dates])).toEqual([
      ['1m', [REC_DAY]],
      ['1d', [REC_DAY]],
    ]);
  });
});
