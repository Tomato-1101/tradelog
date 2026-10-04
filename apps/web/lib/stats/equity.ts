// エクイティカーブをチャート用の系列にする。
// 時刻付き（ペーパー）はラウンドごとに 1 点（同じ秒に重なったら後の値）。
// 日付だけ（SBI）は同じ時刻に大量の点が重なるので、JST の日ごとの最終値にする。

import { chartDay, chartSeconds } from '@/lib/chart-time';
import type { Stats } from './types';

export type EquityPoint = { time: number | string; value: number };

export function equitySeries(curve: Stats['equityCurve'], precision: 'ms' | 'day'): EquityPoint[] {
  const m = new Map<number | string, number>();
  for (const p of curve) {
    const t = precision === 'day' ? chartDay(p.at) : chartSeconds(p.at);
    m.set(t, Number(p.cumulative)); // 描画用なので Number でよい（表示する金額は decimal 文字列のまま）
  }
  return [...m].map(([time, value]) => ({ time, value })).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}
