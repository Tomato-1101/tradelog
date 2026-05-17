// 取り込み NormalizedExecution[] を DB に書き込む。
// 1. Instrument を upsert (kind + 自然キー)
// 2. dedupeHash で既存 Execution と突き合わせ、新規分のみ INSERT
// 3. ImportBatch を作成して new/dup カウントを記録
// 4. 影響範囲の Round を再計算

import { prisma } from '@/lib/db';
import { sha256OfBuffer, makeDedupeHash } from './dedupe';
import {
  distinctGroups,
  reaggregateGroups,
  type RoundGroupKey,
} from '@/lib/rounds/reaggregate';
import { getFxRateToJpy } from '@/lib/fx';
import type { BrokerCode, NormalizedExecution, NormalizedInstrument } from './types';

export type PreviewItem = {
  /** index in the parsed array */
  idx: number;
  status: 'new' | 'dup';
  dedupeHash: string;
  exec: NormalizedExecution;
};

export type Preview = {
  brokerId: number;
  accountId: number;
  newCount: number;
  dupCount: number;
  items: PreviewItem[];
};

async function resolveBrokerAndAccount(
  broker: BrokerCode,
  accountExternalId: string,
): Promise<{ brokerId: number; accountId: number }> {
  const b = await prisma.broker.findUniqueOrThrow({ where: { code: broker } });
  const a = await prisma.account.findUniqueOrThrow({
    where: { brokerId_externalId: { brokerId: b.id, externalId: accountExternalId } },
  });
  return { brokerId: b.id, accountId: a.id };
}

async function upsertInstrument(inst: NormalizedInstrument): Promise<number> {
  const naturalKey = {
    kind: inst.kind,
    symbol: inst.symbol,
    expiry: inst.kind === 'OPTION_US' ? inst.expiry : null,
    strike: inst.kind === 'OPTION_US' ? inst.strike : null,
    right: inst.kind === 'OPTION_US' ? inst.right : null,
  };
  const existing = await prisma.instrument.findFirst({ where: naturalKey });
  if (existing) return existing.id;

  const created = await prisma.instrument.create({
    data: {
      kind: inst.kind,
      symbol: inst.symbol,
      exchange: inst.exchange ?? null,
      name: inst.name ?? null,
      ccy: inst.ccy,
      underlying: inst.kind === 'OPTION_US' ? inst.underlying : null,
      expiry: inst.kind === 'OPTION_US' ? inst.expiry : null,
      strike: inst.kind === 'OPTION_US' ? inst.strike : null,
      right: inst.kind === 'OPTION_US' ? inst.right : null,
      multiplier: inst.kind === 'OPTION_US' ? inst.multiplier : null,
      occSymbol: inst.kind === 'OPTION_US' ? inst.occSymbol : null,
    },
  });
  return created.id;
}

/** Preview: 新規/重複の判定だけ行い DB には書き込まない */
export async function previewImport(
  broker: BrokerCode,
  accountExternalId: string,
  execs: NormalizedExecution[],
): Promise<Preview> {
  const { brokerId, accountId } = await resolveBrokerAndAccount(broker, accountExternalId);
  const items: PreviewItem[] = execs.map((e, idx) => ({
    idx,
    status: 'new',
    dedupeHash: makeDedupeHash(e),
    exec: e,
  }));
  const hashes = items.map((i) => i.dedupeHash);
  if (hashes.length === 0) {
    return { brokerId, accountId, newCount: 0, dupCount: 0, items: [] };
  }
  const existing = await prisma.execution.findMany({
    where: { dedupeHash: { in: hashes } },
    select: { dedupeHash: true },
  });
  const existingSet = new Set(existing.map((e) => e.dedupeHash));
  let newCount = 0;
  let dupCount = 0;
  for (const it of items) {
    if (existingSet.has(it.dedupeHash)) {
      it.status = 'dup';
      dupCount++;
    } else {
      newCount++;
    }
  }
  return { brokerId, accountId, newCount, dupCount, items };
}

/** 確定: 新規分を DB に INSERT し、ImportBatch を作成、影響範囲を再集計 */
export async function commitImport(
  broker: BrokerCode,
  accountExternalId: string,
  source: 'sbi-csv' | 'moomoo-api' | 'moomoo-csv',
  fileName: string | null,
  fileBuf: Buffer | null,
  execs: NormalizedExecution[],
): Promise<{ batchId: string; newCount: number; dupCount: number; roundsRebuilt: number }> {
  const preview = await previewImport(broker, accountExternalId, execs);
  const fileSha256 = fileBuf ? sha256OfBuffer(fileBuf) : null;

  // 新規分について FX レートを事前取得 (トランザクション内で外部 IO しないため)
  // key = `${ccy}|${yyyy-mm-dd}`
  const fxNeeded = new Map<string, { ccy: string; date: Date }>();
  for (const it of preview.items) {
    if (it.status !== 'new') continue;
    const ccy = it.exec.instrument.ccy;
    const day = it.exec.executedAt.toISOString().slice(0, 10);
    fxNeeded.set(`${ccy}|${day}`, { ccy, date: it.exec.executedAt });
  }
  const fxMap = new Map<string, string>();
  for (const [key, v] of fxNeeded) {
    fxMap.set(key, await getFxRateToJpy(v.ccy, v.date));
  }

  // 影響を受ける (instrumentId, accountId, marginType) を新規分から集める
  const affected: RoundGroupKey[] = [];

  const batch = await prisma.$transaction(async (tx) => {
    const ib = await tx.importBatch.create({
      data: {
        accountId: preview.accountId,
        source,
        fileName,
        fileSha256,
        newCount: 0,
        dupCount: 0,
      },
    });

    let newCount = 0;
    let dupCount = 0;

    for (const it of preview.items) {
      if (it.status === 'dup') {
        dupCount++;
        continue;
      }
      // Instrument 解決 (トランザクション内でも prisma 直で OK: SQLite シリアル)
      const instrumentId = await upsertInstrument(it.exec.instrument);
      const ccy = it.exec.instrument.ccy;
      const day = it.exec.executedAt.toISOString().slice(0, 10);
      const fxRateToJpy = fxMap.get(`${ccy}|${day}`) ?? '1';

      await tx.execution.create({
        data: {
          accountId: preview.accountId,
          instrumentId,
          importBatchId: ib.id,
          executedAt: it.exec.executedAt,
          side: it.exec.side,
          qty: it.exec.qty,
          price: it.exec.price,
          fee: it.exec.fee,
          tax: it.exec.tax,
          marginType: it.exec.marginType,
          externalOrderId: it.exec.externalOrderId ?? null,
          externalFillId: it.exec.externalFillId ?? null,
          fxRateToJpy,
          dedupeHash: it.dedupeHash,
          rawJson: JSON.stringify(it.exec.raw),
        },
      });
      affected.push({
        instrumentId,
        accountId: preview.accountId,
        marginType: it.exec.marginType,
      });
      newCount++;
    }

    await tx.importBatch.update({
      where: { id: ib.id },
      data: { newCount, dupCount },
    });

    return { id: ib.id, newCount, dupCount };
  });

  const uniqueGroups = distinctGroups(affected);
  const { rounds } = await reaggregateGroups(uniqueGroups);

  return {
    batchId: batch.id,
    newCount: batch.newCount,
    dupCount: batch.dupCount,
    roundsRebuilt: rounds,
  };
}
