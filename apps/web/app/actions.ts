'use server';
// 画面からの書き込み。価格の手入力確定（lib の setManualPrice → ラウンド再計算）と、SBI の日足の取得。

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { fetchAndStoreBars } from '@/lib/bars/store';
import { dailyFetchNeed } from '@/lib/bars/round-daily';
import { canSetManualPrice, setManualPrice } from '@/lib/paper/ingest';
import { rebuildRounds } from '@/lib/rounds/rebuild';

export type ActionState = { ok: boolean; message: string } | null;

/** 要確認・未確定（または手入力済み）のペーパー・リプレイ約定の価格を手入力で確定し、ラウンドを再計算する */
export async function confirmPriceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const executionId = String(fd.get('executionId') ?? '');
  const price = String(fd.get('price') ?? '').trim().replaceAll(',', '');
  const note = String(fd.get('note') ?? '').trim();
  if (!executionId) return { ok: false, message: '約定が指定されていない' };
  if (!price) return { ok: false, message: '価格を入れてください' };
  try {
    const e = await prisma.execution.findUnique({ where: { id: executionId } });
    if (!e) return { ok: false, message: '約定が見つからない' };
    if (!canSetManualPrice(e.source)) return { ok: false, message: '手入力で確定できるのはペーパー・リプレイの約定だけ' };
    if (e.priceStatus === 'CONFIRMED' && e.priceBasis !== 'MANUAL') {
      return { ok: false, message: '確定済みの約定は変更できない（手入力で確定したものだけ修正できる）' };
    }
    await setManualPrice(prisma, executionId, price, note || undefined);
    await rebuildRounds(prisma, new Date());
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath('/', 'layout');
  return { ok: true, message: `${price} で確定した` };
}

/** SBI ラウンドの前後の日足を Yahoo から取る（1 リクエスト）。日足は SBI の個別トレード画面用 */
export async function fetchDailyBarsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const roundId = String(fd.get('roundId') ?? '');
  try {
    const r = await prisma.round.findUnique({ where: { id: roundId }, include: { instrument: true } });
    if (!r) return { ok: false, message: 'ラウンドが見つからない' };
    if (r.source !== 'SBI') return { ok: false, message: 'SBI のラウンドだけ' };
    const now = new Date();
    const need = dailyFetchNeed({ instrumentId: r.instrumentId, symbol: r.instrument.symbol, openedAt: r.openedAt, closedAt: r.closedAt }, now);
    const rep = await fetchAndStoreBars(prisma, [need], { now });
    if (rep.failures.length) return { ok: false, message: `取得に失敗: ${rep.failures[0].error}` };
    revalidatePath('/', 'layout');
    return { ok: true, message: `日足 ${rep.stored} 本を保存した` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
