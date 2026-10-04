// JST（Asia/Tokyo、夏時間なし = UTC+9 固定）の時刻ヘルパ。DB の時刻はすべて UTC。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST の YYYY-MM-DD */
export function jstYmd(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JST の 0 時からの経過分（0..1439） */
export function jstMinuteOfDay(d: Date): number {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return j.getUTCHours() * 60 + j.getUTCMinutes();
}

/** JST の HH:MM */
export function jstHm(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(11, 16);
}

/** JST の YYYY-MM-DD と分（0 時起点）から UTC の Date */
export function jstAt(ymd: string, minuteOfDay = 0): Date {
  const base = Date.parse(`${ymd}T00:00:00+09:00`);
  return new Date(base + minuteOfDay * 60_000);
}

/** 分の頭に切り捨て（分足の開始時刻） */
export function floorToMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

/** YYYY-MM-DD に日数を足す */
export function addDays(ymd: string, days: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// 東証の立会時間（2024-11-05 以降、大引け 15:30）。分足は開始時刻で数える。
export const SESSION = {
  open: 9 * 60, // 09:00
  amClose: 11 * 60 + 30, // 11:30（前場の最後の分足は 11:29 開始）
  pmOpen: 12 * 60 + 30, // 12:30
  close: 15 * 60 + 30, // 15:30
} as const;

/** 寄り前（〜08:59:59 JST） */
export function isPreOpen(d: Date): boolean {
  return jstMinuteOfDay(d) < SESSION.open;
}

/** その JST 日の大引け時刻（UTC） */
export function closeOf(ymd: string): Date {
  return jstAt(ymd, SESSION.close);
}

/**
 * 連続売買で分足が出るはずの分（開始時刻）か。
 * 前場 09:00〜11:29、後場 12:30〜15:24。15:25〜15:30 は引けの板寄せ（クロージング・オークション）で
 * 約定が 15:30 に 1 回だけなので、分足の有無を「欠け」とは判定しない。
 */
export function isContinuousSessionMinute(minuteOfDay: number): boolean {
  return (
    (minuteOfDay >= SESSION.open && minuteOfDay < SESSION.amClose) ||
    (minuteOfDay >= SESSION.pmOpen && minuteOfDay < SESSION.close - 5)
  );
}

/** 土日か（祝日は判定しない。足が無ければ EMPTY として記録される） */
export function isWeekend(ymd: string): boolean {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}
