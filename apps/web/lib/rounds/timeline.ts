// ラウンド内の建玉の推移（移動平均法の平均建値）。チャートの「平均建値の横線」と、約定ごとの建玉数の表示に使う。
// 計算は builder.ts の buildCycles と同じ（買い増しは加重平均、決済は平均建値を変えない）。純粋関数。

import Decimal from 'decimal.js';
import { compareExecs, type SortableExec } from './builder';

export type TimelineExec = SortableExec & { qty: string; price: string | null };

export type TimelinePoint = {
  id: string;
  at: Date;
  /** 約定後の建玉数（ロング正・ショート負、10 進数文字列） */
  pos: string;
  /** 約定後の平均建値。建玉 0・価格の欠けた約定を含むときは null */
  avg: string | null;
};

export function avgPriceTimeline(execs: TimelineExec[]): TimelinePoint[] {
  const sorted = [...execs].sort(compareExecs);
  const out: TimelinePoint[] = [];
  let pos = new Decimal(0);
  let avg: Decimal | null = new Decimal(0);
  let missing = false;
  for (const e of sorted) {
    const q = new Decimal(e.qty);
    if (q.lte(0)) continue;
    const s = e.side === 'BUY' ? q : q.neg();
    const price = e.price == null ? null : new Decimal(e.price);
    if (price == null) missing = true;
    if (pos.isZero()) {
      pos = s;
      avg = price;
      missing = price == null;
    } else if (pos.gt(0) === s.gt(0)) {
      const next = pos.plus(s);
      avg = price && avg ? pos.times(avg).plus(s.times(price)).div(next) : null;
      pos = next;
    } else {
      const next = pos.plus(s);
      if (next.isZero()) {
        pos = next;
      } else if (next.gt(0) === pos.gt(0)) {
        pos = next; // 一部決済: 平均建値は変わらない
      } else {
        pos = next; // 決済しすぎ（ドテン）: 残りが新しい建玉
        avg = price;
        missing = price == null;
      }
    }
    out.push({
      id: e.id,
      at: e.executedAt,
      pos: pos.toString(),
      avg: pos.isZero() || missing || !avg ? null : avg.toString(),
    });
  }
  return out;
}

export type AvgStep = {
  from: Date;
  /** 次の約定の時刻。ラウンドの最後の区間は null（未決済ならその先も続く） */
  to: Date | null;
  avg: string;
};

/** 平均建値の区間。建玉があり平均建値が分かっている間だけ。平均が変わらない区間（一部決済）は 1 つにまとめる */
export function avgSteps(points: TimelinePoint[]): AvgStep[] {
  const out: AvgStep[] = [];
  points.forEach((p, i) => {
    if (p.avg == null) return;
    const to = i + 1 < points.length ? points[i + 1].at : null;
    const last = out[out.length - 1];
    if (last && last.avg === p.avg && last.to && last.to.getTime() === p.at.getTime()) last.to = to;
    else out.push({ from: p.at, to, avg: p.avg });
  });
  return out;
}
