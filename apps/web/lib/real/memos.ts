// 本番エントリー記録（Windows の記録小窓の real_memo、data/real/events.jsonl。契約は docs/real-events.md）の取り込みと、
// SBI の建て約定への結び付け。
// - 取り込みは id で冪等（取り込み済みの id は無視）。`"test": true` の行と、書きかけ（JSON として読めない）の行は飛ばす。
// - 結び付けは daily のたびに全件付け直す（SBI の約定時刻は後から注文履歴で付くため）。規則は pickEntryExecution。

import type { PrismaClient } from '@/generated/prisma/client';
import { isOpeningSide } from '@/lib/rounds/builder';

/** 記録の前後この秒数以内の建て約定だけを候補にする（ボタンは約定の前後数秒〜数十秒に押す想定） */
export const LINK_WINDOW_SEC = 60;

// ミリ秒付き・オフセット付き（PC の時計のオフセット。通常は +09:00）
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

export type RealMemoEvent = {
  id: string;
  ts: Date;
  tags: string[];
  shots: Array<Record<string, unknown> & { path: string }>;
  activeWindowTitle: string | null;
  captureError: string | null;
  raw: string;
};
export type RealParseError = { line: number; id: string | null; message: string };
export type RealParseResult = { lines: number; memos: RealMemoEvent[]; test: number; partial: number; errors: RealParseError[] };

/** events.jsonl の全行を読む（純粋関数）。契約違反の行はエラーに入れてその行だけ捨てる */
export function parseRealEvents(text: string): RealParseResult {
  const out: RealParseResult = { lines: 0, memos: [], test: 0, partial: 0, errors: [] };
  const rows = text.replace(/^﻿/, '').split('\n');
  rows.forEach((row, i) => {
    const line = i + 1;
    const s = row.trim();
    if (!s) return;
    out.lines++;
    let o: unknown;
    try {
      o = JSON.parse(s);
    } catch {
      out.partial++; // 書きかけ。次の回収で揃う
      return;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      out.errors.push({ line, id: null, message: 'JSON のオブジェクトではない' });
      return;
    }
    const e = o as Record<string, unknown>;
    const id = typeof e.id === 'string' && e.id ? e.id : null;
    const err = (message: string) => out.errors.push({ line, id, message });
    if (e.test === true) {
      out.test++;
      return;
    }
    if (e.v !== 1) return err(`v が 1 でない（${JSON.stringify(e.v)}）`);
    if (e.type !== 'real_memo') return err(`type が real_memo でない（${JSON.stringify(e.type)}）`);
    if (!id) return err('id が無い');
    if (typeof e.ts !== 'string' || !TS.test(e.ts) || Number.isNaN(Date.parse(e.ts))) return err(`ts の形式が違う（${JSON.stringify(e.ts)}）`);
    if (!Array.isArray(e.tags) || !e.tags.every((t) => typeof t === 'string')) return err('tags が文字列の配列でない');
    if (!Array.isArray(e.shots) || !e.shots.every((x) => x && typeof x === 'object' && typeof (x as { path?: unknown }).path === 'string')) {
      return err('shots が path を持つオブジェクトの配列でない');
    }
    out.memos.push({
      id,
      ts: new Date(e.ts),
      tags: e.tags as string[],
      shots: e.shots as RealMemoEvent['shots'],
      activeWindowTitle: typeof e.active_window_title === 'string' ? e.active_window_title : null,
      captureError: typeof e.capture_error === 'string' ? e.capture_error : null,
      raw: s,
    });
  });
  return out;
}

export type EntryCandidate = { id: string; executedAt: Date };

/**
 * 記録 1 件に結び付ける建て約定（純粋関数）。候補は呼び出し側で「SBI・時刻付き・建て側（新規買い・信用新規売り）」に絞ってある。
 * 規則: 記録時刻との差が LINK_WINDOW_SEC 秒以内のうち、差の絶対値が最小のもの。同じ差なら約定時刻が早い方、さらに同じなら id の小さい方。
 */
export function pickEntryExecution<T extends EntryCandidate>(ts: Date, cands: T[], windowSec = LINK_WINDOW_SEC): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const c of cands) {
    const d = Math.abs(c.executedAt.getTime() - ts.getTime());
    if (d > windowSec * 1000) continue;
    const better =
      d < bestD ||
      (d === bestD && best !== null && (c.executedAt < best.executedAt || (c.executedAt.getTime() === best.executedAt.getTime() && c.id < best.id)));
    if (better) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export type RealIngestReport = RealParseResult & { newMemos: number };

/** 新しい記録だけを DB に入れる（取り込み済みの id は触らない） */
export async function ingestRealMemos(db: PrismaClient, text: string): Promise<RealIngestReport> {
  const parsed = parseRealEvents(text);
  const have = new Set((await db.realMemo.findMany({ select: { id: true } })).map((m) => m.id));
  const fresh = parsed.memos.filter((m, i, xs) => !have.has(m.id) && xs.findIndex((x) => x.id === m.id) === i);
  for (const m of fresh) {
    await db.realMemo.create({
      data: {
        id: m.id,
        ts: m.ts,
        tagsJson: JSON.stringify(m.tags),
        shotsJson: JSON.stringify(m.shots),
        activeWindowTitle: m.activeWindowTitle,
        captureError: m.captureError,
        rawJson: m.raw,
      },
    });
  }
  return { ...parsed, newMemos: fresh.length };
}

/** 全記録を付け直す。戻り値は結び付いた件数と、変わった件数 */
export async function linkRealMemos(db: PrismaClient, windowSec = LINK_WINDOW_SEC): Promise<{ memos: number; linked: number; changed: number }> {
  const memos = await db.realMemo.findMany({ select: { id: true, ts: true, executionId: true, linkDeltaMs: true } });
  if (memos.length === 0) return { memos: 0, linked: 0, changed: 0 };
  const times = memos.map((m) => m.ts.getTime());
  const execs = (
    await db.execution.findMany({
      where: {
        source: 'SBI',
        timePrecision: 'ms',
        executedAt: { gte: new Date(Math.min(...times) - windowSec * 1000), lte: new Date(Math.max(...times) + windowSec * 1000) },
      },
      select: { id: true, executedAt: true, side: true, marginType: true },
    })
  ).filter(isOpeningSide);
  let linked = 0;
  let changed = 0;
  for (const m of memos) {
    const hit = pickEntryExecution(m.ts, execs, windowSec);
    const executionId = hit?.id ?? null;
    const linkDeltaMs = hit ? hit.executedAt.getTime() - m.ts.getTime() : null;
    if (hit) linked++;
    if (executionId !== m.executionId || linkDeltaMs !== m.linkDeltaMs) {
      await db.realMemo.update({ where: { id: m.id }, data: { executionId, linkDeltaMs } });
      changed++;
    }
  }
  return { memos: memos.length, linked, changed };
}
