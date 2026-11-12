// 本番の注文記録 v2（board_order / real_note。契約は docs/real-events.md）の取り込みと、SBI の約定への結び付け。
// - 取り込みは id で冪等。行の読み取り（test・書きかけ・契約違反の除外）は parseRealEvents（lib/real/memos.ts）。
// - 結び付けは daily のたびに全件やり直す（SBI の約定時刻は後から注文履歴で付くため）。
//   filled の注文 → assignFills、理由のメモ → pickNoteExecution。同じ order_key の他の行は filled が結び付いた約定に間接的に属する。

import Decimal from 'decimal.js';
import type { PrismaClient } from '@/generated/prisma/client';
import { isOpeningSide } from '@/lib/rounds/builder';
import { pickEntryExecution, type RealParseResult } from '@/lib/real/memos';

/** filled の時刻とこの秒数以内の約定だけを候補にする（全板で数字が消えた瞬間と SBI の約定時刻は秒単位でずれる） */
export const FILL_WINDOW_SEC = 15;
/** 注文に結び付かない理由のメモは、前後この秒数以内の建て約定に載せる */
export const NOTE_WINDOW_SEC = 300;

export type FillOrder = { id: string; ts: Date; side: 'BUY' | 'SELL'; price: string | null; symbol: string | null };
export type FillCandidate = { id: string; executedAt: Date; side: 'BUY' | 'SELL'; price: string | null; symbol: string };
export type FillLink = { executionId: string; deltaMs: number };

const samePrice = (a: string, b: string) => new Decimal(a).eq(new Decimal(b));

/**
 * filled の注文と SBI の時刻付き約定の組を決める（純粋関数）。
 * 候補: 同じ売買方向・同じ値段・（注文の symbol が null でなければ）同じ銘柄で、時刻差の絶対値が windowSec 秒以内。値段が読めなかった注文は結び付けない。
 * 組み方: 全候補の組を「時刻差の小さい順 → 約定の早い順 → 約定 id の小さい順 → 注文の早い順 → 注文 id の小さい順」に並べ、
 * 注文も約定もまだ使っていない組から採る。1 つの約定に複数の注文が当たったら差の小さい方だけが取り、負けた注文は残りの候補から選び直す。
 */
export function assignFills(orders: FillOrder[], execs: FillCandidate[], windowSec = FILL_WINDOW_SEC): Map<string, FillLink> {
  const pairs: Array<{ o: FillOrder; e: FillCandidate; d: number }> = [];
  for (const o of orders) {
    if (o.price === null) continue;
    for (const e of execs) {
      if (e.side !== o.side || e.price === null || !samePrice(e.price, o.price)) continue;
      if (o.symbol !== null && o.symbol !== e.symbol) continue;
      const d = Math.abs(e.executedAt.getTime() - o.ts.getTime());
      if (d > windowSec * 1000) continue;
      pairs.push({ o, e, d });
    }
  }
  const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);
  pairs.sort(
    (a, b) =>
      a.d - b.d ||
      a.e.executedAt.getTime() - b.e.executedAt.getTime() ||
      cmp(a.e.id, b.e.id) ||
      a.o.ts.getTime() - b.o.ts.getTime() ||
      cmp(a.o.id, b.o.id),
  );
  const out = new Map<string, FillLink>();
  const usedExec = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.o.id) || usedExec.has(p.e.id)) continue;
    out.set(p.o.id, { executionId: p.e.id, deltaMs: p.e.executedAt.getTime() - p.o.ts.getTime() });
    usedExec.add(p.e.id);
  }
  return out;
}

export type NoteLink = { executionId: string; method: 'order' | 'time' | 'symbol_day'; deltaMs: number };

export type DayCandidate = { id: string; executedAt: Date; timePrecision: string; seq: number; symbol: string; side: string; marginType: string | null };

// 日付だけの約定は executedAt がその日の 00:00Z（日付そのもの）。時刻付きは実時刻なので日本時間に直して日付を取る
const jstDay = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const execDay = (e: { executedAt: Date; timePrecision: string }) => (e.timePrecision === 'ms' ? jstDay(e.executedAt) : e.executedAt.toISOString().slice(0, 10));

/**
 * 銘柄と向きを持つメモ（手で書いたメモ）を、同じ日（日本時間）・同じ銘柄・同じ向きの建て約定に載せる（純粋関数）。
 * 時刻で結び付けられない時の手がかり。LONG = 現物買い・信用新規買い、SHORT = 信用新規売り。
 * 候補が複数なら、時刻付きはメモの時刻に最も近いもの、日付だけのものは行順 → id の早いもの（日付だけの日はどれも同じラウンドに属するので代表 1 件で足りる）
 */
export function pickNoteBySymbol(note: { ts: Date; symbol: string; position: 'LONG' | 'SHORT' }, execs: DayCandidate[]): NoteLink | null {
  const day = jstDay(note.ts);
  const hit = execs
    .filter((e) => e.symbol === note.symbol && execDay(e) === day)
    .filter((e) => (note.position === 'SHORT' ? e.marginType === 'MARGIN_SHORT' && e.side === 'SELL' : e.marginType !== 'MARGIN_SHORT' && e.side === 'BUY'))
    .map((e) => ({ e, d: e.timePrecision === 'ms' ? Math.abs(e.executedAt.getTime() - note.ts.getTime()) : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.d - b.d || a.e.seq - b.e.seq || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0))[0]?.e;
  return hit ? { executionId: hit.id, method: 'symbol_day', deltaMs: hit.executedAt.getTime() - note.ts.getTime() } : null;
}

/**
 * 理由のメモ 1 件を載せる約定（純粋関数）。
 * 1. last_order.order_key の注文が約定に結び付いていればその約定（orderExec: order_key → 約定）
 * 2. 無ければメモの時刻の前後 windowSec 秒以内で最も近い建て約定（openingExecs は呼び出し側で SBI・時刻付き・建て側に絞る。同点は pickEntryExecution の規則）
 *    メモに銘柄（小窓が保存時に全板で見ていた銘柄）があれば同じ銘柄の約定だけ。5 分以内に別銘柄を建てても取り違えない
 */
export function pickNoteExecution(
  note: { ts: Date; lastOrderKey: string | null; symbol?: string | null },
  orderExec: Map<string, { id: string; executedAt: Date }>,
  openingExecs: Array<{ id: string; executedAt: Date; symbol?: string }>,
  windowSec = NOTE_WINDOW_SEC,
): NoteLink | null {
  const byOrder = note.lastOrderKey ? orderExec.get(note.lastOrderKey) : undefined;
  if (byOrder) return { executionId: byOrder.id, method: 'order', deltaMs: byOrder.executedAt.getTime() - note.ts.getTime() };
  const hit = pickEntryExecution(note.ts, note.symbol ? openingExecs.filter((e) => e.symbol === note.symbol) : openingExecs, windowSec);
  return hit ? { executionId: hit.id, method: 'time', deltaMs: hit.executedAt.getTime() - note.ts.getTime() } : null;
}

/** 新しい v2 の行だけを DB に入れる（取り込み済みの id は触らない） */
export async function ingestRealV2(db: PrismaClient, parsed: Pick<RealParseResult, 'boardOrders' | 'notes'>): Promise<{ newBoardOrders: number; newNotes: number }> {
  const haveO = new Set((await db.boardOrder.findMany({ select: { id: true } })).map((x) => x.id));
  const freshO = parsed.boardOrders.filter((x, i, xs) => !haveO.has(x.id) && xs.findIndex((y) => y.id === x.id) === i);
  for (const o of freshO) {
    await db.boardOrder.create({
      data: {
        id: o.id,
        ts: o.ts,
        orderKey: o.orderKey,
        event: o.event,
        side: o.side,
        price: o.price === null ? null : String(o.price),
        qty: o.qty === null ? null : Math.round(o.qty),
        pendingMs: o.pendingMs === null ? null : Math.round(o.pendingMs),
        symbol: o.symbol,
        symbolName: o.symbolName,
        boardJson: JSON.stringify(o.board),
        rawJson: o.raw,
      },
    });
  }
  const haveN = new Set((await db.realNote.findMany({ select: { id: true } })).map((x) => x.id));
  const freshN = parsed.notes.filter((x, i, xs) => !haveN.has(x.id) && xs.findIndex((y) => y.id === x.id) === i);
  for (const n of freshN) {
    await db.realNote.create({
      data: {
        id: n.id,
        ts: n.ts,
        text: n.text,
        lastOrderKey: n.lastOrder?.order_key ?? null,
        lastOrderJson: n.lastOrder ? JSON.stringify(n.lastOrder) : null,
        rawJson: n.raw,
      },
    });
  }
  return { newBoardOrders: freshO.length, newNotes: freshN.length };
}

const timeRange = (times: number[], windowSec: number) => ({
  gte: new Date(Math.min(...times) - windowSec * 1000),
  lte: new Date(Math.max(...times) + windowSec * 1000),
});

/** filled の注文を全件付け直す。filled 以外の行に結び付きが残っていれば外す */
export async function linkBoardOrders(db: PrismaClient, windowSec = FILL_WINDOW_SEC): Promise<{ filled: number; linked: number; changed: number }> {
  const rows = await db.boardOrder.findMany({ select: { id: true, ts: true, event: true, side: true, price: true, symbol: true, executionId: true, linkDeltaMs: true } });
  const fills = rows.filter((r) => r.event === 'filled');
  const execs = fills.length
    ? (
        await db.execution.findMany({
          where: { source: 'SBI', timePrecision: 'ms', executedAt: timeRange(fills.map((f) => f.ts.getTime()), windowSec) },
          select: { id: true, executedAt: true, side: true, price: true, instrument: { select: { symbol: true } } },
        })
      ).map((e) => ({ id: e.id, executedAt: e.executedAt, side: e.side, price: e.price, symbol: e.instrument.symbol }))
    : [];
  const links = assignFills(fills, execs, windowSec);
  let changed = 0;
  for (const r of rows) {
    const l = r.event === 'filled' ? links.get(r.id) : undefined;
    const executionId = l?.executionId ?? null;
    const linkDeltaMs = l?.deltaMs ?? null;
    if (executionId !== r.executionId || linkDeltaMs !== r.linkDeltaMs) {
      await db.boardOrder.update({ where: { id: r.id }, data: { executionId, linkDeltaMs } });
      changed++;
    }
  }
  return { filled: fills.length, linked: links.size, changed };
}

/** 理由のメモを全件付け直す（linkBoardOrders の後に呼ぶ） */
export async function linkRealNotes(db: PrismaClient, windowSec = NOTE_WINDOW_SEC): Promise<{ notes: number; linked: number; byOrder: number; changed: number }> {
  const notes = await db.realNote.findMany({ select: { id: true, ts: true, lastOrderKey: true, executionId: true, linkMethod: true, linkDeltaMs: true, rawJson: true } });
  if (notes.length === 0) return { notes: 0, linked: 0, byOrder: 0, changed: 0 };
  // order_key → 結び付いた約定（同じ order_key に filled が複数あれば早い方）
  const orderExec = new Map<string, { id: string; executedAt: Date }>();
  for (const o of await db.boardOrder.findMany({
    where: { event: 'filled', executionId: { not: null } },
    select: { orderKey: true, execution: { select: { id: true, executedAt: true } } },
    orderBy: [{ ts: 'asc' }, { id: 'asc' }],
  })) {
    if (o.execution && !orderExec.has(o.orderKey)) orderExec.set(o.orderKey, o.execution);
  }
  const opening = (
    await db.execution.findMany({
      where: { source: 'SBI', timePrecision: 'ms', executedAt: timeRange(notes.map((n) => n.ts.getTime()), windowSec) },
      select: { id: true, executedAt: true, side: true, marginType: true, instrument: { select: { symbol: true } } },
    })
  )
    .filter(isOpeningSide)
    .map((e) => ({ id: e.id, executedAt: e.executedAt, symbol: e.instrument.symbol }));
  // 手で書いたメモの銘柄と向き（rawJson にだけある）。その日の SBI 約定を時刻の有無に関係なく候補にする
  const hint = new Map<string, { symbol: string; position: 'LONG' | 'SHORT' }>();
  const noteSymbol = new Map<string, string>();
  for (const n of notes) {
    const r = JSON.parse(n.rawJson) as { symbol?: unknown; position?: unknown };
    if (typeof r.symbol === 'string') noteSymbol.set(n.id, r.symbol);
    if (typeof r.symbol === 'string' && (r.position === 'LONG' || r.position === 'SHORT')) hint.set(n.id, { symbol: r.symbol, position: r.position });
  }
  const hinted = notes.filter((n) => hint.has(n.id));
  const dayExecs: DayCandidate[] = hinted.length
    ? (
        await db.execution.findMany({
          where: { source: 'SBI', instrument: { symbol: { in: [...new Set([...hint.values()].map((h) => h.symbol))] } }, executedAt: timeRange(hinted.map((n) => n.ts.getTime()), 86_400) },
          select: { id: true, executedAt: true, timePrecision: true, seq: true, side: true, marginType: true, instrument: { select: { symbol: true } } },
        })
      ).map((e) => ({ ...e, symbol: e.instrument.symbol }))
    : [];
  let linked = 0;
  let byOrder = 0;
  let changed = 0;
  for (const n of notes) {
    const h = hint.get(n.id);
    // 銘柄が書いてあるメモは銘柄を優先（時刻だけだと 5 分以内の別銘柄と取り違える）
    const l = (h ? pickNoteBySymbol({ ts: n.ts, ...h }, dayExecs) : null) ?? pickNoteExecution({ ...n, symbol: noteSymbol.get(n.id) }, orderExec, opening, windowSec);
    if (l) linked++;
    if (l?.method === 'order') byOrder++;
    const data = { executionId: l?.executionId ?? null, linkMethod: l?.method ?? null, linkDeltaMs: l?.deltaMs ?? null };
    if (data.executionId !== n.executionId || data.linkMethod !== n.linkMethod || data.linkDeltaMs !== n.linkDeltaMs) {
      await db.realNote.update({ where: { id: n.id }, data });
      changed++;
    }
  }
  return { notes: notes.length, linked, byOrder, changed };
}
