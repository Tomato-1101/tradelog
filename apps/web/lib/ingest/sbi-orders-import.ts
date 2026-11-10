// 注文履歴（詳細）の約定時刻を DB の SBI 約定に反映する。Execution は作らない・消さない（時刻と rawJson を書き換えるだけ）。
// 約定の正本は約定履歴照会 CSV（手数料・税・決済損益がある）。注文履歴にしか無い約定（CSV 未取り込みの日）は
// 作らずに「CSV 未取り込みの日」として数え、CSV を取り込んだ後にもう一度回せば時刻が付く。
// dedupeHash は CSV 取り込み時の値（09:00 の日時で作ったもの）のまま変えないので、CSV を取り込み直しても重複として除かれる。
// 何度回しても同じ結果（割り当ては CSV の行順と注文履歴の時刻順だけで決まり、executedAt の今の値に依存しない）。

import type { PrismaClient } from '@/generated/prisma/client';
import { addDays, jstAt, jstYmd } from '@/lib/time';
import { matchOrderFills, type OrderMatchResult, type SbiOrderFill, type UnmatchReason } from './sbi-orders';

export type SbiOrderApplyReport = {
  /** 注文履歴のある日の SBI 約定数 */
  candidates: number;
  /** 時刻が付いた約定数（前回から変わらないものを含む） */
  timed: number;
  /** 今回書き換えた数（executedAt / timePrecision / rawJson のどれかが変わった） */
  updated: number;
  unmatchedExecs: Partial<Record<UnmatchReason, number>>;
  unmatchedFills: Partial<Record<UnmatchReason, number>>;
  fills: number;
  match: OrderMatchResult;
};

function count<T extends { reason: UnmatchReason }>(xs: T[]): Partial<Record<UnmatchReason, number>> {
  const out: Partial<Record<UnmatchReason, number>> = {};
  for (const x of xs) out[x.reason] = (out[x.reason] ?? 0) + 1;
  return out;
}

function fillRecord(f: SbiOrderFill) {
  return {
    orderNo: f.orderNo,
    time: f.time,
    market: f.market,
    kind: f.kind,
    qty: f.qty,
    price: f.price,
    orderKind: f.orderKind,
    orderType: f.orderType,
    orderPrice: f.orderPrice,
    stopWaitAt: f.stopWaitAt?.toISOString() ?? null,
    stopCondition: f.stopCondition,
  };
}

export async function applySbiOrderTimes(db: PrismaClient, fills: SbiOrderFill[]): Promise<SbiOrderApplyReport> {
  const dates = [...new Set(fills.map((f) => f.date))].sort();
  const execs = dates.length
    ? await db.execution.findMany({
        where: { source: 'SBI', executedAt: { gte: jstAt(dates[0]), lt: jstAt(addDays(dates[dates.length - 1], 1)) } },
        include: { instrument: { select: { symbol: true } } },
      })
    : [];
  const raws = new Map(execs.map((e) => [e.id, JSON.parse(e.rawJson) as Record<string, unknown>]));
  const match = matchOrderFills(
    execs.map((e) => {
      const market = raws.get(e.id)!['市場'];
      return {
        id: e.id,
        date: jstYmd(e.executedAt),
        account: e.account,
        symbol: e.instrument.symbol,
        side: e.side,
        marginType: e.marginType,
        qty: e.qty,
        price: e.price,
        market: typeof market === 'string' && market && market !== '--' ? market : null,
        seq: e.seq,
      };
    }),
    fills,
  );

  const byId = new Map(execs.map((e) => [e.id, e]));
  const updates: Array<{ id: string; executedAt: Date; rawJson: string }> = [];
  for (const a of match.assignments) {
    const e = byId.get(a.id)!;
    const raw = { ...raws.get(a.id)!, _sbiOrder: { time: a.fills[0].time, market: a.fills[0].market, fills: a.fills.map(fillRecord) } };
    const rawJson = JSON.stringify(raw);
    if (e.executedAt.getTime() === a.executedAt.getTime() && e.timePrecision === 'ms' && e.rawJson === rawJson) continue;
    updates.push({ id: a.id, executedAt: a.executedAt, rawJson });
  }
  if (updates.length) {
    await db.$transaction(
      updates.map((u) =>
        // 'ms' は「時刻まで分かっている」の意味（画面・AI 書き出し・集計が 'ms' で時刻ありの扱いに切り替わる）。値は秒まで
        db.execution.update({ where: { id: u.id }, data: { executedAt: u.executedAt, timePrecision: 'ms', rawJson: u.rawJson } }),
      ),
    );
  }
  return {
    candidates: match.candidates,
    timed: match.assignments.length,
    updated: updates.length,
    unmatchedExecs: count(match.unmatchedExecs),
    unmatchedFills: count(match.unmatchedFills),
    fills: fills.length,
    match,
  };
}
