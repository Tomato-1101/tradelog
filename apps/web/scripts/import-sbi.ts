// SBI 約定 CSV の取り込み。使い方: npm run import:sbi -- <path> [<path> ...]
// 取り込み後に Round を作り直す（AI 書き出しは daily で行う）。

import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { importSbiCsv } from '@/lib/ingest/sbi-import';
import { rebuildRounds } from '@/lib/rounds/rebuild';

async function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('使い方: npm run import:sbi -- <CSV のパス> [...]');
    process.exitCode = 2;
    return;
  }
  for (const f of files) {
    const r = await importSbiCsv(prisma, fs.readFileSync(f), path.basename(f));
    console.log(
      `[import] ${path.basename(f)}: 形式 ${r.format} / 行 ${r.rows} / 新規 ${r.newCount} / 重複 ${r.dupCount} / 約定履歴で取り込み済みの日 ${r.coveredByHistory} / 当日約定を置き換え ${r.superseded} / 警告 ${r.warnings.length}`,
    );
    for (const w of r.warnings) console.log(`  [警告] ${w.line} 行目 ${w.code}: ${w.message}`);
    if (r.format === 'unknown') process.exitCode = 1;
  }
  const rb = await rebuildRounds(prisma, new Date());
  console.log(`[rounds] ${rb.rounds}（PAPER ${rb.paper} / SBI ${rb.sbi}）/ 削除 ${rb.deleted} / 警告 ${rb.warnings.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
