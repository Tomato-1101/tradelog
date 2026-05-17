// 期間フィルタ共通ロジック。
// URL query (?preset=...&from=YYYY-MM-DD&to=YYYY-MM-DD) を読んで {gte?, lte?} に変換する。
// JST 基準。プリセットの 'today' は JST 今日 00:00〜翌 00:00。

export type PeriodPreset =
  | 'today'
  | 'thisWeek'
  | 'thisMonth'
  | 'last30'
  | 'last90'
  | 'thisYear'
  | 'all'
  | 'custom';

export type Period = {
  preset: PeriodPreset;
  /** custom 時の開始日 (YYYY-MM-DD, JST) */
  from?: string;
  /** custom 時の終了日 (YYYY-MM-DD, JST, 当日含む) */
  to?: string;
};

const PRESETS: PeriodPreset[] = [
  'today',
  'thisWeek',
  'thisMonth',
  'last30',
  'last90',
  'thisYear',
  'all',
  'custom',
];

const PRESET_LABELS: Record<PeriodPreset, string> = {
  today: '今日',
  thisWeek: '今週',
  thisMonth: '今月',
  last30: '直近30日',
  last90: '直近90日',
  thisYear: '今年',
  all: '全期間',
  custom: 'カスタム',
};

export function isPeriodPreset(v: unknown): v is PeriodPreset {
  return typeof v === 'string' && (PRESETS as string[]).includes(v);
}

export function getPresetLabel(p: PeriodPreset): string {
  return PRESET_LABELS[p];
}

export const PERIOD_PRESETS = PRESETS;

/** URL の searchParams 部分から Period を組み立てる。妥当でないものは 'all' に倒す。 */
export function parsePeriodParams(sp: {
  preset?: string | string[];
  from?: string | string[];
  to?: string | string[];
}): Period {
  const presetRaw = Array.isArray(sp.preset) ? sp.preset[0] : sp.preset;
  const fromRaw = Array.isArray(sp.from) ? sp.from[0] : sp.from;
  const toRaw = Array.isArray(sp.to) ? sp.to[0] : sp.to;
  const preset: PeriodPreset = isPeriodPreset(presetRaw) ? presetRaw : 'all';
  if (preset === 'custom') {
    return { preset: 'custom', from: fromRaw, to: toRaw };
  }
  return { preset };
}

/** YYYY-MM-DD JST → UTC Date (JST 当日 00:00) */
function jstDateStrToUtc(ymd: string, endOfDay = false): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  // JST = UTC+9。JST の YYYY-MM-DD 00:00 は UTC では前日 15:00。
  // SQLite に格納されている executedAt も UTC。
  const base = endOfDay
    ? new Date(`${ymd}T23:59:59.999+09:00`)
    : new Date(`${ymd}T00:00:00+09:00`);
  if (Number.isNaN(base.getTime())) return null;
  return base;
}

/** JST の YYYY-MM-DD 文字列を返す */
function jstYmd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(d);
}

/** 月曜起算で「今週」の月曜日 (JST YYYY-MM-DD) を返す */
function jstStartOfWeek(d: Date): string {
  const ymd = jstYmd(d);
  // YYYY-MM-DD JST のローカル曜日を、JST 12:00 UTC として固定して算出
  const dt = new Date(`${ymd}T12:00:00+09:00`);
  const dow = dt.getUTCDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const offset = (dow + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  const monday = new Date(dt.getTime() - offset * 86400000);
  return jstYmd(monday);
}

/** JST 今月初日 */
function jstStartOfMonth(d: Date): string {
  const ymd = jstYmd(d);
  return `${ymd.slice(0, 7)}-01`;
}

/** JST 今年初日 */
function jstStartOfYear(d: Date): string {
  const ymd = jstYmd(d);
  return `${ymd.slice(0, 4)}-01-01`;
}

/** N 日前の JST YYYY-MM-DD */
function jstDaysBefore(d: Date, days: number): string {
  const today = jstYmd(d);
  const start = new Date(`${today}T00:00:00+09:00`);
  start.setTime(start.getTime() - days * 86400000);
  return jstYmd(start);
}

export type PeriodRange = { gte?: Date; lte?: Date };

/** Period を Prisma where 用の {gte, lte} (UTC Date) に変換する。'all' は空 */
export function periodToRange(p: Period, now: Date = new Date()): PeriodRange {
  const todayJst = jstYmd(now);
  switch (p.preset) {
    case 'today': {
      return {
        gte: jstDateStrToUtc(todayJst) ?? undefined,
        lte: jstDateStrToUtc(todayJst, true) ?? undefined,
      };
    }
    case 'thisWeek': {
      return {
        gte: jstDateStrToUtc(jstStartOfWeek(now)) ?? undefined,
        lte: jstDateStrToUtc(todayJst, true) ?? undefined,
      };
    }
    case 'thisMonth': {
      return {
        gte: jstDateStrToUtc(jstStartOfMonth(now)) ?? undefined,
        lte: jstDateStrToUtc(todayJst, true) ?? undefined,
      };
    }
    case 'last30': {
      return {
        gte: jstDateStrToUtc(jstDaysBefore(now, 29)) ?? undefined,
        lte: jstDateStrToUtc(todayJst, true) ?? undefined,
      };
    }
    case 'last90': {
      return {
        gte: jstDateStrToUtc(jstDaysBefore(now, 89)) ?? undefined,
        lte: jstDateStrToUtc(todayJst, true) ?? undefined,
      };
    }
    case 'thisYear': {
      return {
        gte: jstDateStrToUtc(jstStartOfYear(now)) ?? undefined,
        lte: jstDateStrToUtc(todayJst, true) ?? undefined,
      };
    }
    case 'all':
      return {};
    case 'custom': {
      const gte = p.from ? jstDateStrToUtc(p.from) ?? undefined : undefined;
      const lte = p.to ? jstDateStrToUtc(p.to, true) ?? undefined : undefined;
      return { gte, lte };
    }
  }
}

/** メモリ上の Round 配列を Period でフィルタする (closedAt が null のものは除外) */
export function applyPeriodToRounds<T extends { closedAt: Date | null }>(
  rows: T[],
  p: Period,
  now: Date = new Date(),
): T[] {
  const r = periodToRange(p, now);
  if (!r.gte && !r.lte) return rows.filter((x) => x.closedAt !== null);
  return rows.filter((x) => {
    if (!x.closedAt) return false;
    if (r.gte && x.closedAt < r.gte) return false;
    if (r.lte && x.closedAt > r.lte) return false;
    return true;
  });
}
