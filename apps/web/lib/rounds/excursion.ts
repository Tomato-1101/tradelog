// MAE / MFE（建値からの最大逆行・最大順行、1 株あたりの値幅）。純粋関数。
// 窓は建てた分〜決済した分（未決済は now の分）の 1 分足。日付だけのラウンド・建値が無い・足が無いときは null。

import Decimal from 'decimal.js';
import { floorToMinute } from '@/lib/time';
import { barPrice, type BarLite } from '@/lib/paper/resolve';

export type ExcursionInput = {
  direction: 'LONG' | 'SHORT';
  avgEntryPrice: string | null;
  openedAt: Date;
  closedAt: Date | null;
  timePrecision: 'ms' | 'day';
};

/**
 * 未決済ラウンドの窓（MAE/MFE・チャート・AI 書き出しの足）の終わり。通常は now。
 * リプレイは録画の中の時間なので、録画の終わり（replayEnd: メタの ended_at、無ければ started_at ＋ planned_minutes）で止める
 * （大引けや今日まで延ばすと、録画で見ていない値動きまで窓に入る）。録画の終わりが分からなければ null（評価しない）。
 */
export function openRoundEnd(source: string, replayEnd: Date | null, now: Date): Date | null {
  if (source !== 'REPLAY') return now;
  if (!replayEnd) return null;
  return replayEnd < now ? replayEnd : now;
}

/**
 * チャート・AI 書き出しの 1 分足の窓の終わり。決済済み・ペーパー・SBI は（決済 or now）＋ padMin 分。
 * 未決済のリプレイは録画の終わりまで（後ろに延ばさない）、録画の終わりが分からなければ最後の約定まで
 */
export function barWindowTo(
  r: { source: string; openedAt: Date; closedAt: Date | null },
  lastExecutedAt: Date | null,
  replayEnd: Date | null,
  now: Date,
  padMin: number,
): Date {
  const pad = (d: Date) => new Date(floorToMinute(d).getTime() + padMin * 60_000);
  if (r.closedAt) return pad(r.closedAt);
  const end = openRoundEnd(r.source, replayEnd, now);
  if (r.source !== 'REPLAY') return pad(end ?? now);
  return floorToMinute(end ?? lastExecutedAt ?? r.openedAt);
}

export function computeExcursion(
  r: ExcursionInput,
  minuteBars: BarLite[],
  now: Date,
): { mae: string; mfe: string } | null {
  if (r.timePrecision === 'day' || r.avgEntryPrice === null) return null;
  const from = floorToMinute(r.openedAt).getTime();
  const to = floorToMinute(r.closedAt ?? now).getTime();
  const inWin = minuteBars.filter((b) => b.ts.getTime() >= from && b.ts.getTime() <= to);
  if (inWin.length === 0) return null;
  const hi = Decimal.max(...inWin.map((b) => barPrice(b.high)));
  const lo = Decimal.min(...inWin.map((b) => barPrice(b.low)));
  const entry = new Decimal(r.avgEntryPrice);
  const [fav, adv] = r.direction === 'LONG' ? [hi.minus(entry), lo.minus(entry)] : [entry.minus(lo), entry.minus(hi)];
  // 建値が足の範囲外（約定価格が仮置き等）でも符号の約束（MAE ≤ 0 ≤ MFE）を守る
  return { mae: Decimal.min(adv, 0).toString(), mfe: Decimal.max(fav, 0).toString() };
}
