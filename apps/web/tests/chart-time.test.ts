import { describe, expect, it } from 'vitest';
import { chartDay, chartSeconds } from '@/lib/chart-time';

describe('chart-time', () => {
  it('分足: JST 09:00 は UTC 表示で 09:00 に見えるよう +9h ずらす', () => {
    const t = chartSeconds(new Date('2026-10-01T09:00:00+09:00'));
    expect(new Date(t * 1000).toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });
  it('日足: JST の日付', () => {
    expect(chartDay(new Date('2026-10-01T15:30:00Z'))).toBe('2026-10-02');
    expect(chartDay(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01');
  });
});
