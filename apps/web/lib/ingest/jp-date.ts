// 和暦 (令和=R / 平成=H / 昭和=S) → 西暦 + JST 日時 → UTC 変換。
// SBI CSV では稀に "R6/05/14" のような和暦表記が混じる。

const ERA_BASE: Record<string, number> = {
  R: 2018, // R1 = 2019
  H: 1988, // H1 = 1989
  S: 1925, // S1 = 1926
};

const JST_OFFSET_MIN = 9 * 60;

/** "2026/05/14", "2026-05-14", "26/05/14", "R8/05/14" などを Date(YYYY,MM,DD) に正規化 */
export function parseJpDate(input: string): Date | null {
  const s = input.trim();
  if (!s) return null;

  // 和暦判定 (先頭が R/H/S + 数字)
  const eraMatch = s.match(/^([RHS])(\d{1,2})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/);
  if (eraMatch) {
    const [, era, eraYear, mo, da] = eraMatch;
    const base = ERA_BASE[era];
    if (base == null) return null;
    const year = base + Number(eraYear);
    return new Date(Date.UTC(year, Number(mo) - 1, Number(da)));
  }

  // 西暦4桁
  const western = s.match(/^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/);
  if (western) {
    const [, y, mo, da] = western;
    return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(da)));
  }

  // 西暦2桁 (20YY と解釈)
  const western2 = s.match(/^(\d{2})[/.\-](\d{1,2})[/.\-](\d{1,2})/);
  if (western2) {
    const [, y, mo, da] = western2;
    return new Date(Date.UTC(2000 + Number(y), Number(mo) - 1, Number(da)));
  }

  return null;
}

/** JST の (Date, "HH:MM" or "HH:MM:SS") を UTC の Date に */
export function combineJstDateTime(dateUtcMidnight: Date, time: string): Date {
  const m = time.trim().match(/^(\d{1,2})[:時](\d{1,2})([:分](\d{1,2}))?/);
  if (!m) {
    // 時刻不明なら 09:00 JST = 00:00 UTC (寄付き相当) で代用
    return new Date(dateUtcMidnight.getTime());
  }
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[4] != null ? Number(m[4]) : 0;
  const jstMinutes = hh * 60 + mm;
  const utcOffsetMin = jstMinutes - JST_OFFSET_MIN;
  const ms = dateUtcMidnight.getTime() + utcOffsetMin * 60_000 + ss * 1000;
  return new Date(ms);
}
