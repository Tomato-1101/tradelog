import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { parseSbiCsvBuffer } from '@/lib/ingest/sbi-csv';
import { commitImport, type ImportSource, type CommitImportOptions } from '@/lib/ingest/persist';
import { dealsToNormalized, fetchMoomooDeals } from '@/lib/ingest/moomoo-history';
import { distinctGroups, reaggregateGroups } from '@/lib/rounds/reaggregate';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import Pill from '@/components/ui/Pill';
import ImportBatchActions from './ImportBatchActions';

export const dynamic = 'force-dynamic';

async function importSbi(formData: FormData) {
  'use server';
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect('/import?error=' + encodeURIComponent('CSV ファイルが指定されていません'));
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const { executions, warnings, format, earliestDate } = parseSbiCsvBuffer(buf);
  if (executions.length === 0) {
    redirect(
      '/import?error=' +
        encodeURIComponent(
          `パース結果が空です。${warnings.map((w) => `${w.code}: ${w.message}`).join(' / ') || '原因不明'}`,
        ),
    );
  }
  // フォーマット種別ごとに source を切り替える。全期間 CSV (third-savefile) は
  // 当日 CSV を権威ソースで上書きするため supersedeDailyFrom を渡す。
  let source: ImportSource = 'sbi-csv';
  const opts: CommitImportOptions = {};
  if (format === 'new-daily') {
    source = 'sbi-csv-daily';
  } else if (format === 'third-savefile') {
    source = 'sbi-csv-savefile';
    if (earliestDate) opts.supersedeDailyFrom = earliestDate;
  }
  const result = await commitImport('SBI', 'default', source, file.name, buf, executions, opts);
  revalidatePath('/import');
  revalidatePath('/trades');
  revalidatePath('/stats');
  revalidatePath('/');
  const supersededMsg = result.supersededCount > 0 ? ` / 上書き ${result.supersededCount}` : '';
  redirect(
    `/import?ok=${encodeURIComponent(
      `取り込み完了 [${format ?? 'unknown'}]: 新規 ${result.newCount} 件 / 重複 ${result.dupCount} 件${supersededMsg} / Round ${result.roundsRebuilt} 再生成`,
    )}`,
  );
}

async function importMoomoo(_formData: FormData) {
  'use server';
  // moomoo の本番口座を Account テーブルから取得 (default は除外)
  const moomoo = await prisma.broker.findUniqueOrThrow({ where: { code: 'MOOMOO' } });
  const accounts = await prisma.account.findMany({
    where: { brokerId: moomoo.id, NOT: { externalId: 'default' } },
  });

  if (accounts.length === 0) {
    redirect('/import?error=' + encodeURIComponent('moomoo 本番口座が登録されていません'));
  }

  let totalNew = 0;
  let totalDup = 0;
  let totalRounds = 0;
  const errors: string[] = [];

  for (const acc of accounts) {
    try {
      const deals = await fetchMoomooDeals({ uniCardNum: acc.externalId });
      if (deals.length === 0) continue;
      const { executions, warnings } = dealsToNormalized(acc.externalId, deals);
      for (const w of warnings) errors.push(`${acc.label ?? acc.externalId}: ${w.code}: ${w.message}`);
      if (executions.length === 0) continue;
      const result = await commitImport(
        'MOOMOO',
        acc.externalId,
        'moomoo-api',
        null,
        null,
        executions,
      );
      totalNew += result.newCount;
      totalDup += result.dupCount;
      totalRounds += result.roundsRebuilt;
    } catch (e) {
      errors.push(`${acc.label ?? acc.externalId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  revalidatePath('/import');
  revalidatePath('/trades');
  revalidatePath('/stats');
  revalidatePath('/');

  if (errors.length) {
    redirect(
      '/import?error=' +
        encodeURIComponent(
          `部分的に成功 (新規 ${totalNew} 件 / 重複 ${totalDup}). エラー: ${errors.join(' | ')}`,
        ),
    );
  }
  redirect(
    `/import?ok=${encodeURIComponent(
      `moomoo 取り込み完了: 新規 ${totalNew} / 重複 ${totalDup} / Round ${totalRounds} 再生成`,
    )}`,
  );
}

// 表示用エントリ。CSV 系 (sbi-csv*) は ImportBatch 1 件 = 1 エントリ。
// moomoo API (source='moomoo-api') は (broker × source) で集約し、
// 内部の複数 batchId と合計 new/dup・最新 importedAt を持つ。
type ImportEntry = {
  key: string;
  brokerCode: string;
  source: string;
  fileNames: string[];
  batchIds: string[];
  newCount: number;
  dupCount: number;
  hidden: boolean;
  importedAt: Date;
  count: number;
};

async function fetchRecent(): Promise<ImportEntry[]> {
  const batches = await prisma.importBatch.findMany({
    take: 100,
    orderBy: { importedAt: 'desc' },
    include: { account: { include: { broker: true } } },
  });

  const csvEntries: ImportEntry[] = [];
  const apiGroups = new Map<string, ImportEntry>();
  for (const b of batches) {
    if (b.source === 'moomoo-api') {
      const key = `${b.account.broker.code}|moomoo-api`;
      const existing = apiGroups.get(key);
      if (existing) {
        existing.batchIds.push(b.id);
        existing.newCount += b.newCount;
        existing.dupCount += b.dupCount;
        if (b.importedAt > existing.importedAt) existing.importedAt = b.importedAt;
        // hidden は全 batch が hidden の場合のみ true 扱い
        existing.hidden = existing.hidden && b.hidden;
        existing.count++;
      } else {
        apiGroups.set(key, {
          key,
          brokerCode: b.account.broker.code,
          source: 'moomoo-api',
          fileNames: [],
          batchIds: [b.id],
          newCount: b.newCount,
          dupCount: b.dupCount,
          hidden: b.hidden,
          importedAt: b.importedAt,
          count: 1,
        });
      }
    } else {
      csvEntries.push({
        key: b.id,
        brokerCode: b.account.broker.code,
        source: b.source,
        fileNames: b.fileName ? [b.fileName] : [],
        batchIds: [b.id],
        newCount: b.newCount,
        dupCount: b.dupCount,
        hidden: b.hidden,
        importedAt: b.importedAt,
        count: 1,
      });
    }
  }

  return [...csvEntries, ...apiGroups.values()]
    .sort((a, b) => b.importedAt.getTime() - a.importedAt.getTime())
    .slice(0, 50);
}

// 複数 ImportBatch に含まれる Execution の (instrumentId, accountId, marginType) 集合を返す。
async function affectedGroupsOf(batchIds: string[]) {
  const execs = await prisma.execution.findMany({
    where: { importBatchId: { in: batchIds } },
    select: { instrumentId: true, accountId: true, marginType: true },
  });
  return distinctGroups(execs);
}

function parseBatchIds(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function setHidden(formData: FormData) {
  'use server';
  const batchIds = parseBatchIds(String(formData.get('batchIds') ?? ''));
  if (batchIds.length === 0) return;
  const hiddenStr = String(formData.get('hidden') ?? '');
  const hidden = hiddenStr === 'true';
  const groups = await affectedGroupsOf(batchIds);
  await prisma.importBatch.updateMany({ where: { id: { in: batchIds } }, data: { hidden } });
  await reaggregateGroups(groups);
  revalidatePath('/import');
  revalidatePath('/trades');
  revalidatePath('/trades/list');
  revalidatePath('/stats');
  revalidatePath('/');
}

async function deleteBatch(formData: FormData) {
  'use server';
  const batchIds = parseBatchIds(String(formData.get('batchIds') ?? ''));
  if (batchIds.length === 0) return;
  const groups = await affectedGroupsOf(batchIds);
  await prisma.$transaction(async (tx) => {
    await tx.execution.deleteMany({ where: { importBatchId: { in: batchIds } } });
    await tx.importBatch.deleteMany({ where: { id: { in: batchIds } } });
  });
  await reaggregateGroups(groups);
  revalidatePath('/import');
  revalidatePath('/trades');
  revalidatePath('/trades/list');
  revalidatePath('/stats');
  revalidatePath('/');
}

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const params = await searchParams;
  const recent = await fetchRecent();

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">取り込み</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        SBI 取引履歴 CSV (Shift_JIS / UTF-8 自動判定)・moomoo OpenAPI (S11 で実装予定)
      </p>

      {params.ok && (
        <div className="mt-6 rounded-md border border-[var(--pos)] bg-[var(--pos-bg)] p-3 text-sm text-[var(--pos)]">
          {params.ok}
        </div>
      )}
      {params.error && (
        <div className="mt-6 rounded-md border border-[var(--neg)] bg-[var(--neg-bg)] p-3 text-sm text-[var(--neg)]">
          {params.error}
        </div>
      )}

      <Card className="mt-6">
        <CardHeader title="SBI 取引履歴 CSV" subtitle="data/raw/sbi/ にあるファイルをアップロード、または直接選択" />
        <CardBody>
          <form action={importSbi} className="space-y-4">
            <input
              id="file"
              name="file"
              type="file"
              accept=".csv,.txt"
              required
              className="block w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[var(--primary-soft)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[var(--primary)] hover:file:opacity-90"
            />
            <p className="text-xs text-[var(--muted)]">
              「注文一覧_当日約定」「取引履歴」のどちらでも OK。同じファイルを再投入しても重複は自動で弾かれる。
            </p>
            <button
              type="submit"
              className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
            >
              取り込む
            </button>
          </form>
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="moomoo (米株・オプション)"
          subtitle="OpenD 経由で過去 90 日分の約定を取得"
        />
        <CardBody>
          <form action={importMoomoo} className="space-y-4">
            <p className="text-sm text-[var(--muted-strong)]">
              登録済みの本番口座（現物 / 信用 / デリバティブ）を一括で取得し、重複は自動で弾く。
              OpenD が起動していて moomoo 本番口座にログイン済みである必要がある (
              <Link href="/docs/OPEND_SETUP.md" className="text-[var(--primary)] hover:underline">
                docs/OPEND_SETUP.md
              </Link>
              )。
            </p>
            <button
              type="submit"
              className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
            >
              全口座から取り込む
            </button>
          </form>
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="直近の取り込み"
          subtitle="非表示にしたバッチは集計・チャート・Round から除外される (データは残る)。削除は不可逆。"
        />
        <CardBody className="px-0 py-0">
          {recent.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-[var(--muted)]">まだありません。</div>
          ) : (
            <ul className="divide-y divide-[var(--border)] text-sm">
              {recent.map((e) => (
                <li
                  key={e.key}
                  className={`flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between ${
                    e.hidden ? 'opacity-60' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone="primary">{e.brokerCode}</Pill>
                      <span className="text-[var(--muted-strong)]">{e.source}</span>
                      {e.fileNames.length > 0 && (
                        <span className="truncate">{e.fileNames.join(' / ')}</span>
                      )}
                      {e.source === 'moomoo-api' && (
                        <span className="text-xs text-[var(--muted)]">×{e.count} 回</span>
                      )}
                      {e.hidden && <Pill tone="neutral">非表示中</Pill>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div>
                        <Pill tone="pos">新規 {e.newCount}</Pill>
                        <span className="mx-1" />
                        <Pill tone="neutral">重複 {e.dupCount}</Pill>
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted)]">
                        {e.importedAt.toLocaleString('ja-JP')}
                      </div>
                    </div>
                    <ImportBatchActions
                      batchIds={e.batchIds}
                      hidden={e.hidden}
                      setHiddenAction={setHidden}
                      deleteAction={deleteBatch}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </main>
  );
}
