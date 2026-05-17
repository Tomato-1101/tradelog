import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { parseSbiCsvBuffer } from '@/lib/ingest/sbi-csv';
import { commitImport } from '@/lib/ingest/persist';
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
  const { executions, warnings } = parseSbiCsvBuffer(buf);
  if (executions.length === 0) {
    redirect(
      '/import?error=' +
        encodeURIComponent(
          `パース結果が空です。${warnings.map((w) => `${w.code}: ${w.message}`).join(' / ') || '原因不明'}`,
        ),
    );
  }
  const result = await commitImport('SBI', 'default', 'sbi-csv', file.name, buf, executions);
  revalidatePath('/import');
  revalidatePath('/trades');
  redirect(
    `/import?ok=${encodeURIComponent(
      `取り込み完了: 新規 ${result.newCount} 件 / 重複 ${result.dupCount} 件 / Round ${result.roundsRebuilt} 再生成`,
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

async function fetchRecent() {
  return prisma.importBatch.findMany({
    take: 30,
    orderBy: { importedAt: 'desc' },
    include: { account: { include: { broker: true } } },
  });
}

// ImportBatch に含まれる Execution の (instrumentId, accountId, marginType) 集合を返す。
// hide/unhide/delete のあと、これらの group だけ Round を再構築する。
async function affectedGroupsOf(batchId: string) {
  const execs = await prisma.execution.findMany({
    where: { importBatchId: batchId },
    select: { instrumentId: true, accountId: true, marginType: true },
  });
  return distinctGroups(execs);
}

async function setHidden(formData: FormData) {
  'use server';
  const batchId = String(formData.get('batchId') ?? '');
  const hiddenStr = String(formData.get('hidden') ?? '');
  if (!batchId) redirect('/import?error=' + encodeURIComponent('batchId が空'));
  const hidden = hiddenStr === 'true';
  const groups = await affectedGroupsOf(batchId);
  await prisma.importBatch.update({ where: { id: batchId }, data: { hidden } });
  const { rounds } = await reaggregateGroups(groups);
  revalidatePath('/import');
  revalidatePath('/trades');
  revalidatePath('/trades/list');
  revalidatePath('/stats');
  revalidatePath('/');
  redirect(
    '/import?ok=' +
      encodeURIComponent(
        `${hidden ? '非表示' : '再表示'}: ${groups.length} グループ / Round ${rounds} 再生成`,
      ),
  );
}

async function deleteBatch(formData: FormData) {
  'use server';
  const batchId = String(formData.get('batchId') ?? '');
  if (!batchId) redirect('/import?error=' + encodeURIComponent('batchId が空'));
  const confirm = String(formData.get('confirm') ?? '');
  if (confirm !== 'yes') {
    redirect('/import?error=' + encodeURIComponent('削除確認が取れていません'));
  }
  const groups = await affectedGroupsOf(batchId);
  let deletedExecs = 0;
  await prisma.$transaction(async (tx) => {
    const r = await tx.execution.deleteMany({ where: { importBatchId: batchId } });
    deletedExecs = r.count;
    await tx.importBatch.delete({ where: { id: batchId } });
  });
  const { rounds } = await reaggregateGroups(groups);
  revalidatePath('/import');
  revalidatePath('/trades');
  revalidatePath('/trades/list');
  revalidatePath('/stats');
  revalidatePath('/');
  redirect(
    '/import?ok=' +
      encodeURIComponent(
        `削除: Execution ${deletedExecs} 件 / ${groups.length} グループ / Round ${rounds} 再生成`,
      ),
  );
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
              {recent.map((b) => (
                <li
                  key={b.id}
                  className={`flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between ${
                    b.hidden ? 'opacity-60' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-mono text-xs text-[var(--muted)]">{b.id}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone="primary">{b.account.broker.code}</Pill>
                      <span className="text-[var(--muted-strong)]">{b.source}</span>
                      <span className="truncate">{b.fileName ?? '(no file)'}</span>
                      {b.hidden && <Pill tone="neutral">非表示中</Pill>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div>
                        <Pill tone="pos">新規 {b.newCount}</Pill>
                        <span className="mx-1" />
                        <Pill tone="neutral">重複 {b.dupCount}</Pill>
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted)]">
                        {b.importedAt.toLocaleString('ja-JP')}
                      </div>
                    </div>
                    <ImportBatchActions
                      batchId={b.id}
                      hidden={b.hidden}
                      newCount={b.newCount}
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
