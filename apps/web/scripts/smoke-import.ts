// S4 スモークテスト: SBI CSV パース → commitImport で DB へ書き込み
// → 2 度目の commit で全件 dup になることを確認 → Round が生成されたか確認。
//
// 実行: npm run smoke
import iconv from 'iconv-lite';
import { parseSbiCsvBuffer } from '@/lib/ingest/sbi-csv';
import { commitImport } from '@/lib/ingest/persist';
import { prisma } from '@/lib/db';

const CSV = [
  ',お客様の取引履歴一覧,',
  ',期間: 2026年5月1日 ～ 2026年5月14日',
  ',',
  '"約定日","約定時刻","銘柄コード","銘柄名","市場","取引区分","数量[株]","約定単価","手数料[円]","税金[円]","注文番号","約定番号"',
  '"2026/05/14","09:00:30","7203","トヨタ自動車","東証P","株式現物買","100","2500","0","0","ORD001","FIL001"',
  '"2026/05/14","14:55:00","7203","トヨタ自動車","東証P","株式現物売","100","2550","0","0","ORD002","FIL002"',
  '"2026/05/15","10:00:00","9984","ソフトバンクＧ","東証P","信用新規買","200","8000","550","55","ORD003","FIL003"',
  '"2026/05/16","11:30:00","9984","ソフトバンクＧ","東証P","信用返済売","200","8100","550","55","ORD004","FIL004"',
].join('\n');

async function main() {
  const buf = iconv.encode(CSV, 'cp932');
  const { executions, warnings } = parseSbiCsvBuffer(buf);
  console.log(`parsed: ${executions.length} executions, ${warnings.length} warnings`);

  console.log('\n=== 1st commit ===');
  const r1 = await commitImport('SBI', 'default', 'sbi-csv', 'smoke-1.csv', buf, executions);
  console.log(r1);

  console.log('\n=== 2nd commit (should all dup) ===');
  const r2 = await commitImport('SBI', 'default', 'sbi-csv', 'smoke-2.csv', buf, executions);
  console.log(r2);

  console.log('\n=== rounds ===');
  const rounds = await prisma.round.findMany({
    include: { instrument: true },
    orderBy: { openedAt: 'asc' },
  });
  for (const r of rounds) {
    console.log(
      `  [${r.instrument.symbol}] ${r.direction} ${r.marginType} qty=${r.qtyOpened} avg=${r.avgEntryPrice} pnl=${r.realizedPnl} closed=${r.closedAt?.toISOString() ?? 'open'}`,
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
