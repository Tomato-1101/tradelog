// 影響を受けた (instrumentId, accountId, marginType) のラウンドを再計算する。
// 「Execution が真実、Round はキャッシュ」なので、対象 3 つ組の Execution を全部読み、
// 既存 Round を削除して新規 Round を insert する。

import { prisma } from '@/lib/db';
import { buildRoundsForGroup } from './builder';
import type { ExecForRound } from './types';

export type RoundGroupKey = {
  instrumentId: number;
  accountId: number;
  marginType: 'CASH' | 'MARGIN_LONG' | 'MARGIN_SHORT';
};

function keyOf(g: RoundGroupKey): string {
  return `${g.instrumentId}|${g.accountId}|${g.marginType}`;
}

/** Execution を 3 つ組ごとにまとめてユニーク化 */
export function distinctGroups(execs: RoundGroupKey[]): RoundGroupKey[] {
  const map = new Map<string, RoundGroupKey>();
  for (const e of execs) {
    const k = keyOf(e);
    if (!map.has(k)) map.set(k, { ...e });
  }
  return Array.from(map.values());
}

export async function reaggregateGroups(groups: RoundGroupKey[]): Promise<{ rounds: number }> {
  if (groups.length === 0) return { rounds: 0 };
  let total = 0;
  // 3 つ組ごとに同じトランザクションで delete + insert
  for (const g of groups) {
    await prisma.$transaction(async (tx) => {
      await tx.round.deleteMany({
        where: {
          instrumentId: g.instrumentId,
          accountId: g.accountId,
          marginType: g.marginType,
        },
      });
      const instrument = await tx.instrument.findUnique({
        where: { id: g.instrumentId },
        select: { multiplier: true },
      });
      const multiplier = (instrument?.multiplier ?? 1).toString();
      const execs = await tx.execution.findMany({
        where: {
          instrumentId: g.instrumentId,
          accountId: g.accountId,
          marginType: g.marginType,
          // ImportBatch.hidden=true (ノーカン) は集計から除外。
          // Execution データは残るが Round はそれを除いて再構築される。
          importBatch: { hidden: false },
        },
        orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
      });
      const forRound: ExecForRound[] = execs.map((e) => ({
        id: e.id,
        instrumentId: e.instrumentId,
        accountId: e.accountId,
        marginType: e.marginType,
        executedAt: e.executedAt,
        side: e.side,
        qty: e.qty.toString(),
        price: e.price.toString(),
        fee: e.fee.toString(),
        tax: e.tax.toString(),
        fxRateToJpy: e.fxRateToJpy.toString(),
        multiplier,
      }));
      const drafts = buildRoundsForGroup(forRound);
      for (const d of drafts) {
        await tx.round.create({
          data: {
            instrumentId: d.instrumentId,
            accountId: d.accountId,
            marginType: d.marginType,
            direction: d.direction,
            openedAt: d.openedAt,
            closedAt: d.closedAt,
            qtyOpened: d.qtyOpened,
            avgEntryPrice: d.avgEntryPrice,
            realizedPnl: d.realizedPnl,
            realizedPnlJpy: d.realizedPnlJpy,
            feesTotal: d.feesTotal,
            holdSeconds: d.holdSeconds,
            executionsJson: JSON.stringify(d.executions),
          },
        });
        total++;
      }
    });
  }
  return { rounds: total };
}
