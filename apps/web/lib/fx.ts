// FX レート取得層。
// 取引日の USDJPY 中値を DB の FxRate にキャッシュし、無ければ sidecar /fx/usdjpy/{day} に問い合わせる。
// Execution.fxRateToJpy の保存に使う。

import { prisma } from '@/lib/db';
import { sidecarUrl } from '@/lib/sidecar';

const PAIR_USDJPY = 'USDJPY';

/** yyyy-mm-dd 形式に正規化 (UTC ベース) */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** yyyy-mm-dd → UTC 00:00:00 DateTime */
function dayKey(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * 指定日の USDJPY レート (1 USD = X JPY) を取得。
 * 1) DB FxRate から検索
 * 2) なければ sidecar /fx/usdjpy/{day}
 * 3) sidecar 失敗時は直近 14 日の DB レートにフォールバック
 * 4) 全て失敗したら例外
 */
export async function getUsdJpyRate(date: Date): Promise<string> {
  const day = ymd(date);

  const cached = await prisma.fxRate.findUnique({
    where: { pair_date: { pair: PAIR_USDJPY, date: dayKey(day) } },
  });
  if (cached) return cached.rate.toString();

  try {
    const res = await fetch(sidecarUrl(`/fx/usdjpy/${day}`), { cache: 'no-store' });
    if (!res.ok) throw new Error(`sidecar fx ${res.status}`);
    const j: { date: string; rate: number | null } = await res.json();
    if (j.rate != null && Number.isFinite(j.rate)) {
      await prisma.fxRate.upsert({
        where: { pair_date: { pair: PAIR_USDJPY, date: dayKey(day) } },
        create: {
          pair: PAIR_USDJPY,
          date: dayKey(day),
          rate: j.rate.toString(),
          source: 'yfinance',
        },
        update: { rate: j.rate.toString(), source: 'yfinance' },
      });
      return j.rate.toString();
    }
  } catch {
    // 後段のフォールバックへ
  }

  // 直近 14 日で最も近い過去レートを引く (祝日 / sidecar 落ち対策)
  const fallback = await prisma.fxRate.findFirst({
    where: {
      pair: PAIR_USDJPY,
      date: { lte: dayKey(day), gte: new Date(dayKey(day).getTime() - 14 * 86400_000) },
    },
    orderBy: { date: 'desc' },
  });
  if (fallback) return fallback.rate.toString();

  throw new Error(`USDJPY rate unavailable for ${day}`);
}

/**
 * 通貨に応じて適切な fxRateToJpy を返す。
 * JPY → "1"、USD → 取引日の USDJPY、それ以外は未対応で例外。
 */
export async function getFxRateToJpy(ccy: string, date: Date): Promise<string> {
  const c = ccy.toUpperCase();
  if (c === 'JPY') return '1';
  if (c === 'USD') return getUsdJpyRate(date);
  throw new Error(`unsupported currency for JPY conversion: ${ccy}`);
}
