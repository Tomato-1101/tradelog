// ラウンド 1 件の日足（SBI の個別トレード画面用）。SBI は時刻が無いので daily ジョブでは足を取らない。
// 画面の「日足を取得」から、そのラウンドの前後だけ取る（Yahoo 1 リクエスト）。

import { addDays, isWeekend, jstAt, jstYmd } from '@/lib/time';
import type { FetchNeed } from './store';

/** 約定の何日前・何日後までの日足を表示・取得するか（暦日） */
export const DAILY_WINDOW_BEFORE_DAYS = 60;
export const DAILY_WINDOW_AFTER_DAYS = 30;

export type DailyWindow = { from: Date; to: Date };

/** 表示する日足の範囲（UTC。from は JST の日付の 00:00、to は JST の日付の 00:00） */
export function dailyWindow(openedAt: Date, closedAt: Date | null): DailyWindow {
  return {
    from: jstAt(addDays(jstYmd(openedAt), -DAILY_WINDOW_BEFORE_DAYS)),
    to: jstAt(addDays(jstYmd(closedAt ?? openedAt), DAILY_WINDOW_AFTER_DAYS)),
  };
}

/** 取得が要る日付（範囲内の平日。今日より先は除く） */
export function dailyFetchNeed(
  r: { instrumentId: number; symbol: string; openedAt: Date; closedAt: Date | null },
  now: Date,
): FetchNeed {
  const w = dailyWindow(r.openedAt, r.closedAt);
  const today = jstYmd(now);
  const dates: string[] = [];
  for (let d = jstYmd(w.from); d <= jstYmd(w.to) && d <= today; d = addDays(d, 1)) if (!isWeekend(d)) dates.push(d);
  return { instrumentId: r.instrumentId, symbol: r.symbol, timeframe: '1d', dates };
}
