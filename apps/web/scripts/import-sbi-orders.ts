// SBI ウェブ「注文履歴（詳細）」の JSON から約定時刻（秒まで）を取り、取り込み済みの SBI 約定に付ける。
// 使い方: npm run import:sbi-orders -- [<json> ...]（引数なしなら data/raw/sbi-orders/*.json 全部）
// 約定履歴照会 CSV を取り込んだ後に回す（CSV に無い日の約定は作らない。CSV を入れてから回し直せば付く）。
// 反映後に Round を作り直す（AI 書き出しは daily で行う）。

import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { jstYmd } from '@/lib/time';
import { parseSbiOrderFiles, UNMATCH_LABEL, type UnmatchReason } from '@/lib/ingest/sbi-orders';
import { applySbiOrderTimes } from '@/lib/ingest/sbi-orders-import';
import { rebuildRounds } from '@/lib/rounds/rebuild';

const ROOT = path.resolve(__dirname, '../../..');

function reasons(x: Partial<Record<UnmatchReason, number>>): string {
  const parts = Object.entries(x).map(([k, n]) => `${UNMATCH_LABEL[k as UnmatchReason]} ${n}`);
  return parts.length ? parts.join(' / ') : 'なし';
}

async function main() {
  let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    const dir = path.join(ROOT, 'data/raw/sbi-orders');
    files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f)) : [];
  }
  if (files.length === 0) {
    console.error('使い方: npm run import:sbi-orders -- [<注文履歴 JSON のパス> ...]（既定は data/raw/sbi-orders/*.json）');
    process.exitCode = 2;
    return;
  }
  const parsed = parseSbiOrderFiles(files.map((f) => ({ name: path.basename(f), json: JSON.parse(fs.readFileSync(f, 'utf-8')) })));
  console.log(`[orders] ファイル ${files.length} / 注文 ${parsed.orders}（重複で除いた注文 ${parsed.duplicateOrders}）/ 約定 ${parsed.fills.length} / 警告 ${parsed.warnings.length}`);
  for (const w of parsed.warnings) console.log(`  [警告] 注文 ${w.orderNo} ${w.code}: ${w.message}`);
  for (const d of parsed.incompleteDays) console.log(`  [集め途中] ${d.file} ${d.date}: 詳細 ${d.got} / 一覧 ${d.cnt}`);

  const r = await applySbiOrderTimes(prisma, parsed.fills);
  console.log(`[match] 対象の SBI 約定 ${r.candidates} / 時刻が付いた ${r.timed}（今回書き換え ${r.updated}）/ 付かなかった ${r.candidates - r.timed}`);
  console.log(`  付かなかった約定の理由: ${reasons(r.unmatchedExecs)}`);
  console.log(`  使われなかった注文履歴の約定 ${r.match.unmatchedFills.length} / ${r.fills}: ${reasons(r.unmatchedFills)}`);
  for (const { fill: f, reason } of r.match.unmatchedFills) {
    if (reason === 'no-csv-day' || reason === 'bucket-incomplete') continue;
    console.log(`  [未対応] ${f.date} ${f.time} ${f.symbol} ${f.kind} ${f.market} ${f.qty}株 @${f.price} 注文 ${f.orderNo}: ${UNMATCH_LABEL[reason]}`);
  }
  const noCsv = [...new Set(r.match.unmatchedFills.filter((x) => x.reason === 'no-csv-day').map((x) => x.fill.date))].sort();
  if (noCsv.length) console.log(`  CSV 未取り込みの日: ${noCsv.join(', ')}（約定履歴照会 CSV を取り込んでから回し直す）`);
  const byDay = new Map<string, number>();
  for (const a of r.match.assignments) byDay.set(jstYmd(a.executedAt), (byDay.get(jstYmd(a.executedAt)) ?? 0) + 1);
  console.log(`  日別の時刻付き: ${[...byDay].sort().map(([d, n]) => `${d} ${n}`).join(' / ') || 'なし'}`);

  const rb = await rebuildRounds(prisma, new Date());
  console.log(`[rounds] ${rb.rounds}（PAPER ${rb.paper} / REPLAY ${rb.replay} / SBI ${rb.sbi}）/ 削除 ${rb.deleted} / 警告 ${rb.warnings.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
