// 日次バッチ: events 取り込み → 不足分の 1m/1d 足取得（取りこぼし日も遡って補う）→ 約定確定 → Round 再構築（MAE/MFE）→ AI 書き出し。
// 使い方: npm run daily -- [--events <path>] [--out <dir>] [--no-fetch]
// 検証用に DATABASE_URL で別の DB に向けられる（lib/db.ts / prisma.config.ts）。

import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE, prisma } from '@/lib/db';
import { dailyResult, dailyStatusPath, writeDailyStatus } from '@/lib/daily-status';
import { fetchAndStoreBars, planBarFetches } from '@/lib/bars/store';
import { ingestPaperEvents, resolvePaperExecutions } from '@/lib/paper/ingest';
import { rebuildRounds } from '@/lib/rounds/rebuild';
import { exportForAi } from '@/lib/ai/export';

const ROOT = path.resolve(__dirname, '../../..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// 状態ファイル（web の上部の警告）に書く件数。main の途中で例外が出ても、そこまでの件数を残す
const counts = { barFailures: 0, sidecarErrors: 0, ordersIngested: 0 };
const startedAt = new Date();

async function main() {
  const now = startedAt;
  const eventsPath = path.resolve(arg('--events') ?? path.join(ROOT, 'data/paper/events.jsonl'));
  const outDir = path.resolve(arg('--out') ?? path.join(ROOT, 'data/ai'));
  const noFetch = process.argv.includes('--no-fetch');

  // 1. events
  const text = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf-8') : '';
  // サイドカー（ocr.json）のパスは events.jsonl と同じ data/paper/ からの相対
  const ing = await ingestPaperEvents(prisma, text, now, { paperDir: path.dirname(eventsPath) });
  console.log(`[events] ${eventsPath}: ${ing.lines} 行 / 採用 ${ing.accepted} / 新規 ${ing.newEvents} / 契約違反 ${ing.errors.length}`);
  for (const e of ing.errors) console.log(`  [契約違反] ${e.line} 行目${e.id ? `（${e.id}）` : ''}: ${e.message}`);
  counts.ordersIngested = ing.orders;
  const sc = ing.sidecars;
  counts.sidecarErrors = sc.errors.length;
  console.log(`[ocr] サイドカー 読込 ${sc.loaded} / まだ無い ${sc.missing} / 読めず ${sc.errors.length}`);
  for (const e of sc.errors) console.log(`  [サイドカー] ${e.path}: ${e.message}（次回の daily で読み直す）`);

  // 2. 足（1 回目の約定確定・再構築の前に、建玉の日付が分かっている分を取る。未決済の延長は 2 周目で拾う）
  if (!noFetch) {
    for (let pass = 1; pass <= 2; pass++) {
      const plan = await planBarFetches(prisma, now);
      const todo = plan.needs.reduce((a, n) => a + n.dates.length, 0);
      if (todo === 0) {
        if (pass === 1) console.log(`[bars] 取得不要（遡れず取得不可 ${plan.unavailable} 日）`);
        break;
      }
      const rep = await fetchAndStoreBars(prisma, plan.needs, { now });
      console.log(`[bars] ${pass} 周目: ${todo} 日分 / リクエスト ${rep.requests} / 保存 ${rep.stored} 本 / 失敗 ${rep.failures.length} / 遡れず ${plan.unavailable} 日`);
      counts.barFailures += rep.failures.length;
      for (const f of rep.failures) console.log(`  [取得失敗] ${f.symbol} ${f.timeframe} ${f.dates.join(',')}: ${f.error}`);
      // 2 周目は再構築で未決済と分かった建玉の今日までを取る
      if (pass === 1) {
        await resolvePaperExecutions(prisma);
        await rebuildRounds(prisma, now);
      }
    }
  } else {
    console.log('[bars] --no-fetch のため取得しない');
  }

  // 3. 約定確定
  const res = await resolvePaperExecutions(prisma);
  console.log(
    `[resolve] 確定 ${res.confirmed} / 要確認 ${res.needsReview} / 未確定 ${res.unresolved} / 手入力維持 ${res.manualKept} / 約定なし ${res.noFill}（削除 ${res.removed}）`,
  );

  // 4. Round 再構築
  const rb = await rebuildRounds(prisma, now);
  console.log(`[rounds] ${rb.rounds}（PAPER ${rb.paper} / SBI ${rb.sbi}）/ 削除 ${rb.deleted} / 警告 ${rb.warnings.length}`);
  for (const w of rb.warnings) console.log(`  [警告] ${w}`);

  // 5. AI 書き出し
  const ex = await exportForAi(prisma, outDir, now);
  console.log(`[ai] ${ex.tradesPath}（${ex.trades} 件、1 分足あり ${ex.withBars}）/ ${ex.summaryPath}`);
}

function writeStatus(error: string | null) {
  const file = dailyStatusPath(DB_FILE);
  try {
    const result = dailyResult(counts, error);
    writeDailyStatus(file, { v: 1, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), result, error, ...counts });
    console.log(`[status] ${result} → ${file}`);
  } catch (e) {
    console.error(`[status] ${file} に書けない: ${(e as Error).message}`);
  }
}

main()
  .then(() => writeStatus(null))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
    writeStatus(String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300));
  })
  .finally(() => prisma.$disconnect());
