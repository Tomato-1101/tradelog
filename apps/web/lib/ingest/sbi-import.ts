// SBI 約定 CSV を DB に取り込む（ImportBatch 単位、dedupeHash で重複を除く）。
// 「注文一覧_当日約定」（new-daily）と「約定履歴照会」（third-savefile）は同じ約定でも行の形が違い、ハッシュが一致しない。
// 正本は約定履歴照会なので、それを取り込んだら同じ期間の当日約定由来の約定を置き換える（旧版の supersede と同じ考え方）。
// 逆に、約定履歴照会で取り込み済みの日の当日約定は重複として取り込まない。

import Decimal from 'decimal.js';
import type { PrismaClient } from '@/generated/prisma/client';
import { jstYmd } from '@/lib/time';
import { makeDedupeHash, sha256OfBuffer } from './dedupe';
import { parseSbiCsvBuffer } from './sbi-csv';
import type { ParseWarning, SbiCsvFormat } from './types';

export type SbiImportReport = {
  batchId: string | null;
  format: SbiCsvFormat;
  rows: number;
  newCount: number;
  dupCount: number;
  coveredByHistory: number;
  superseded: number;
  warnings: ParseWarning[];
};

export async function importSbiCsv(db: PrismaClient, buf: Buffer, fileName: string): Promise<SbiImportReport> {
  const parsed = parseSbiCsvBuffer(buf);
  const report: SbiImportReport = {
    batchId: null,
    format: parsed.format,
    rows: parsed.executions.length,
    newCount: 0,
    dupCount: 0,
    coveredByHistory: 0,
    superseded: 0,
    warnings: parsed.warnings,
  };
  if (parsed.format === 'unknown') return report;

  const rows = parsed.executions.map((e) => ({ e, hash: makeDedupeHash(e) }));

  if (parsed.format === 'third-savefile' && parsed.earliestDate && parsed.latestDate) {
    const r = await db.execution.deleteMany({
      where: { source: 'SBI', importBatch: { format: 'new-daily' }, executedAt: { gte: parsed.earliestDate, lte: parsed.latestDate } },
    });
    report.superseded = r.count;
  }
  let covered = new Set<string>();
  if (parsed.format === 'new-daily' && parsed.earliestDate && parsed.latestDate) {
    const hist = await db.execution.findMany({
      where: { source: 'SBI', importBatch: { format: 'third-savefile' }, executedAt: { gte: parsed.earliestDate, lte: parsed.latestDate } },
      select: { executedAt: true },
    });
    covered = new Set(hist.map((h) => jstYmd(h.executedAt)));
  }

  const existing = new Set<string>();
  const hashes = rows.map((r) => r.hash);
  for (let i = 0; i < hashes.length; i += 500) {
    const found = await db.execution.findMany({ where: { dedupeHash: { in: hashes.slice(i, i + 500) } }, select: { dedupeHash: true } });
    for (const f of found) existing.add(f.dedupeHash!);
  }

  const instIds = new Map<string, number>();
  for (const { e } of rows) {
    if (instIds.has(e.instrument.symbol)) continue;
    const i = await db.instrument.upsert({
      where: { market_symbol: { market: 'TSE', symbol: e.instrument.symbol } },
      create: { symbol: e.instrument.symbol, market: 'TSE', name: e.instrument.name ?? null },
      update: e.instrument.name ? { name: e.instrument.name } : {},
    });
    instIds.set(e.instrument.symbol, i.id);
  }

  const batch = await db.importBatch.create({
    data: {
      source: 'sbi-csv',
      format: parsed.format,
      fileName,
      fileSha256: sha256OfBuffer(buf),
      newCount: 0,
      dupCount: 0,
      warnings: JSON.stringify(parsed.warnings),
    },
  });
  report.batchId = batch.id;

  const seen = new Set<string>();
  const data = [];
  for (const { e, hash } of rows) {
    if (covered.has(jstYmd(e.executedAt))) {
      report.coveredByHistory++;
      continue;
    }
    if (existing.has(hash) || seen.has(hash)) {
      report.dupCount++;
      continue;
    }
    seen.add(hash);
    data.push({
      source: 'SBI' as const,
      instrumentId: instIds.get(e.instrument.symbol)!,
      account: e.accountExternalId,
      executedAt: e.executedAt,
      timePrecision: e.timePrecision,
      side: e.side,
      qty: e.qty,
      price: e.price,
      // 手数料・諸経費と税をまとめて Execution.fee に入れる（netPnl はこれを引いた値）
      fee: new Decimal(e.fee).plus(e.tax).toString(),
      marginType: e.marginType,
      priceStatus: 'CONFIRMED' as const,
      priceBasis: 'CSV' as const,
      dedupeHash: hash,
      seq: e.seq,
      importBatchId: batch.id,
      rawJson: JSON.stringify({ ...e.raw, _brokerPnl: e.brokerPnl }),
    });
  }
  if (data.length) await db.execution.createMany({ data });
  report.newCount = data.length;
  await db.importBatch.update({
    where: { id: batch.id },
    data: { newCount: report.newCount, dupCount: report.dupCount + report.coveredByHistory },
  });
  return report;
}
