import { describe, expect, it } from 'vitest';
import { DAILY_WINDOW_AFTER_DAYS, DAILY_WINDOW_BEFORE_DAYS, dailyFetchNeed, dailyWindow } from '@/lib/bars/round-daily';

const d = (s: string) => new Date(`${s}T09:00:00+09:00`);

describe('dailyWindow', () => {
  it('建て日の前 60 日〜決済日の後 30 日（JST の日付の 0 時）', () => {
    const w = dailyWindow(d('2026-05-14'), d('2026-05-18'));
    expect(w.from).toEqual(new Date('2026-03-15T00:00:00+09:00'));
    expect(w.to).toEqual(new Date('2026-06-17T00:00:00+09:00'));
    expect(DAILY_WINDOW_BEFORE_DAYS).toBe(60);
    expect(DAILY_WINDOW_AFTER_DAYS).toBe(30);
  });
  it('未決済は建て日基準', () => {
    const w = dailyWindow(d('2026-05-14'), null);
    expect(w.to).toEqual(new Date('2026-06-13T00:00:00+09:00'));
  });
});

describe('dailyFetchNeed', () => {
  it('範囲内の平日だけ。今日より先は含めない', () => {
    const need = dailyFetchNeed({ instrumentId: 7, symbol: '7203', openedAt: d('2026-09-28'), closedAt: d('2026-09-30') }, d('2026-10-02'));
    expect(need.timeframe).toBe('1d');
    expect(need.symbol).toBe('7203');
    expect(need.instrumentId).toBe(7);
    expect(need.dates.every((x) => x <= '2026-10-02')).toBe(true);
    expect(need.dates).toContain('2026-10-02');
    expect(need.dates).not.toContain('2026-10-03');
    // 2026-10-03 は土曜、2026-09-26 は土曜、2026-09-27 は日曜
    expect(need.dates).not.toContain('2026-09-26');
    expect(need.dates).not.toContain('2026-09-27');
    expect(need.dates[0]).toBe('2026-07-30');
  });
});
