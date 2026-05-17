// 当日 (JST 基準) + 前日 + 翌日 を moomoo OpenD から取り込む軽量エンドポイント。
// ページ読込時に AutoMoomooSync コンポーネントから 1 回叩かれる。
// dedupeHash で 2 重排除されるので、頻繁に叩いても重複データは入らない。
// OpenD 未起動などは silent failure (ステータス 200 を返してフロントをブロックしない)。

import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { commitImport } from '@/lib/ingest/persist';
import { dealsToNormalized, fetchMoomooDeals } from '@/lib/ingest/moomoo-history';

export const dynamic = 'force-dynamic';

function jstYmd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(d);
}

function shiftJstDay(base: Date, deltaDays: number): string {
  const todayJst = jstYmd(base);
  const dt = new Date(`${todayJst}T00:00:00+09:00`);
  dt.setTime(dt.getTime() + deltaDays * 86400000);
  return jstYmd(dt);
}

type AccountResult = {
  account: string;
  label: string | null;
  newCount: number;
  dupCount: number;
  error?: string;
};

export async function POST() {
  const now = new Date();
  // ET と JST のずれ吸収のため [前日, 翌日] の 3 日窓で取得し dedupe に任せる
  const start = shiftJstDay(now, -1);
  const end = shiftJstDay(now, 1);

  const moomoo = await prisma.broker.findUnique({ where: { code: 'MOOMOO' } });
  if (!moomoo) {
    return Response.json({ ok: false, error: 'moomoo broker not registered', results: [] });
  }
  const accounts = await prisma.account.findMany({
    where: { brokerId: moomoo.id, NOT: { externalId: 'default' } },
  });
  if (accounts.length === 0) {
    return Response.json({ ok: true, totalNew: 0, totalDup: 0, results: [] });
  }

  const results: AccountResult[] = [];
  let totalNew = 0;
  let totalDup = 0;

  for (const acc of accounts) {
    try {
      const deals = await fetchMoomooDeals({ uniCardNum: acc.externalId, start, end });
      if (deals.length === 0) {
        results.push({ account: acc.externalId, label: acc.label, newCount: 0, dupCount: 0 });
        continue;
      }
      const { executions } = dealsToNormalized(acc.externalId, deals);
      if (executions.length === 0) {
        results.push({ account: acc.externalId, label: acc.label, newCount: 0, dupCount: 0 });
        continue;
      }
      const r = await commitImport(
        'MOOMOO',
        acc.externalId,
        'moomoo-api',
        null,
        null,
        executions,
      );
      totalNew += r.newCount;
      totalDup += r.dupCount;
      results.push({
        account: acc.externalId,
        label: acc.label,
        newCount: r.newCount,
        dupCount: r.dupCount,
      });
    } catch (e) {
      // OpenD 未起動などは silent failure。フロントには 200 を返して UI ブロックしない。
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[auto-sync] moomoo today ${acc.externalId} failed: ${msg}`);
      results.push({ account: acc.externalId, label: acc.label, newCount: 0, dupCount: 0, error: msg });
    }
  }

  // 新規があったページのみ revalidate
  if (totalNew > 0) {
    revalidatePath('/');
    revalidatePath('/trades');
    revalidatePath('/stats');
    revalidatePath('/import');
  }

  return Response.json({
    ok: true,
    range: { start, end },
    totalNew,
    totalDup,
    results,
  });
}
