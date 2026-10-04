import { describe, expect, it } from 'vitest';
import { equitySeries } from '@/lib/stats/equity';
import type { Stats } from '@/lib/stats/types';

const pt = (iso: string, cumulative: string): Stats['equityCurve'][number] => ({ at: new Date(iso), roundId: iso, netPnl: '0', cumulative });

describe('equitySeries', () => {
  it('時刻付き: JST 表示用に +9h ずらした UTC 秒、同じ秒は後の値', () => {
    const s = equitySeries([pt('2026-10-01T00:00:00Z', '100'), pt('2026-10-01T00:00:00.500Z', '150'), pt('2026-10-01T01:00:00Z', '-20')], 'ms');
    const base = Date.parse('2026-10-01T00:00:00Z') / 1000 + 9 * 3600;
    expect(s).toEqual([
      { time: base, value: 150 },
      { time: base + 3600, value: -20 },
    ]);
  });

  it('日付だけ: JST の日ごとの最終値（日付文字列）', () => {
    // UTC 15:00 以降は JST では翌日
    const s = equitySeries(
      [pt('2026-10-01T00:00:00Z', '100'), pt('2026-10-01T00:00:00Z', '300'), pt('2026-10-01T15:30:00Z', '250'), pt('2026-10-05T00:00:00Z', '400')],
      'day',
    );
    expect(s).toEqual([
      { time: '2026-10-01', value: 300 },
      { time: '2026-10-02', value: 250 },
      { time: '2026-10-05', value: 400 },
    ]);
  });

  it('空なら空', () => {
    expect(equitySeries([], 'ms')).toEqual([]);
  });
});
