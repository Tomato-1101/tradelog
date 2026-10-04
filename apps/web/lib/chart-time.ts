// lightweight-charts の時間軸用。チャートは UTC 表示しかできないので、JST で見せるために +9 時間ずらした UTC 秒を渡す
// （軸ラベルがそのまま JST になる）。日足は営業日の文字列 YYYY-MM-DD（JST の日付）。

import { jstYmd } from '@/lib/time';

const JST_SEC = 9 * 3600;

/** 分足・約定用の時間（JST 表示用に +9h ずらした UTC 秒） */
export function chartSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000) + JST_SEC;
}

/** 日足用の時間（JST の日付） */
export function chartDay(d: Date): string {
  return jstYmd(d);
}
