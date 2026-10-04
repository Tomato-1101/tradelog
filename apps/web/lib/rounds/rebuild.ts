// Execution（真実）から Round（キャッシュ）を作り直す。Round の ID は安定なので upsert し、消えたものだけ消す。
// あわせて Execution.roundId / Memo.roundId を付け直し、ペーパーのラウンドは 1 分足から MAE/MFE を出す。

import type { PrismaClient } from '@/generated/prisma/client';
import { floorToMinute } from '@/lib/time';
import { loadMinuteBars } from '@/lib/bars/store';
import { buildPaperRounds, buildSbiRounds } from './builder';
import { computeExcursion } from './excursion';
import type { ExecForRound, RoundDraft } from './types';

export type RebuildReport = { rounds: number; paper: number; sbi: number; deleted: number; warnings: string[] };

export async function rebuildRounds(db: PrismaClient, now: Date): Promise<RebuildReport> {
  const execs = await db.execution.findMany({ include: { paperOrder: { select: { positionId: true } } } });
  const toRound = (e: (typeof execs)[number]): ExecForRound => ({
    id: e.id,
    source: e.source,
    instrumentId: e.instrumentId,
    account: e.account,
    marginType: e.marginType,
    positionId: e.paperOrder?.positionId ?? null,
    executedAt: e.executedAt,
    timePrecision: e.timePrecision,
    seq: e.seq,
    side: e.side,
    qty: e.qty,
    price: e.price,
    fee: e.fee,
    priceStatus: e.priceStatus,
    dedupeHash: e.dedupeHash,
  });
  const paper = buildPaperRounds(execs.filter((e) => e.source === 'PAPER').map(toRound));
  const sbi = buildSbiRounds(execs.filter((e) => e.source === 'SBI').map(toRound));
  const all: RoundDraft[] = [...paper, ...sbi];

  const excursion = new Map<string, { mae: string; mfe: string } | null>();
  for (const r of paper) {
    const bars = await loadMinuteBars(db, r.instrumentId, floorToMinute(r.openedAt), floorToMinute(r.closedAt ?? now));
    excursion.set(r.id, computeExcursion(r, bars, now));
  }

  // ドテン・現物の建玉超過売りの約定は、決済側（元ラウンド）と建て側（role FLIP のラウンド）の両方に載る。
  // DB 上は必ず FLIP 側に所属させる（ラウンドの書き込み順で付け替わらないよう、決済側では付けない）。
  const flipOwned = new Set(all.flatMap((r) => r.executions.filter((x) => x.role === 'FLIP').map((x) => x.id)));

  const keep = new Set(all.map((r) => r.id));
  const stale = (await db.round.findMany({ select: { id: true } })).map((r) => r.id).filter((id) => !keep.has(id));

  await db.$transaction(async (tx) => {
    if (stale.length) {
      await tx.execution.updateMany({ where: { roundId: { in: stale } }, data: { roundId: null } });
      await tx.memo.updateMany({ where: { roundId: { in: stale } }, data: { roundId: null } });
      await tx.round.deleteMany({ where: { id: { in: stale } } });
    }
    for (const r of all) {
      const ex = excursion.get(r.id) ?? null;
      const data = {
        source: r.source,
        instrumentId: r.instrumentId,
        account: r.account,
        marginType: r.marginType,
        direction: r.direction,
        openedAt: r.openedAt,
        closedAt: r.closedAt,
        timePrecision: r.timePrecision,
        qtyOpened: r.qtyOpened,
        remainingQty: r.remainingQty,
        avgEntryPrice: r.avgEntryPrice,
        avgExitPrice: r.avgExitPrice,
        remainingAvgPrice: r.remainingAvgPrice,
        realizedPnl: r.realizedPnl,
        fees: r.fees,
        netPnl: r.netPnl,
        holdSeconds: r.holdSeconds,
        mae: ex?.mae ?? null,
        mfe: ex?.mfe ?? null,
        status: r.status,
        hasUnresolved: r.hasUnresolved,
        warningsJson: JSON.stringify(r.warnings),
      };
      await tx.round.upsert({ where: { id: r.id }, create: { id: r.id, ...data }, update: data });
      const own = r.executions.filter((x) => x.role === 'FLIP' || !flipOwned.has(x.id)).map((x) => x.id);
      await tx.execution.updateMany({ where: { id: { in: own } }, data: { roundId: r.id } });
    }

    // メモ → ラウンド: 注文に紐づくメモはその約定のラウンド、それ以外は建玉の中でメモ時刻に建っていたラウンド
    const memos = await tx.memo.findMany();
    const byPosition = new Map<string, RoundDraft[]>();
    for (const r of paper) {
      const pos = r.id.split('#')[0];
      byPosition.set(pos, [...(byPosition.get(pos) ?? []), r]);
    }
    const orderRound = new Map(
      (await tx.execution.findMany({ where: { paperOrderId: { not: null } }, select: { paperOrderId: true, roundId: true } })).map((e) => [
        e.paperOrderId!,
        e.roundId,
      ]),
    );
    for (const m of memos) {
      let roundId: string | null = (m.orderId && orderRound.get(m.orderId)) || null;
      if (!roundId) {
        const cands = (byPosition.get(m.positionId) ?? []).slice().sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
        const hit = cands.filter((r) => r.openedAt <= m.ts).pop() ?? cands[0];
        roundId = hit?.id ?? null;
      }
      if (roundId !== m.roundId) await tx.memo.update({ where: { id: m.id }, data: { roundId } });
    }
  }, { timeout: 120_000 });

  return {
    rounds: all.length,
    paper: paper.length,
    sbi: sbi.length,
    deleted: stale.length,
    warnings: all.flatMap((r) => r.warnings.map((w) => `${r.id}: ${w}`)),
  };
}
