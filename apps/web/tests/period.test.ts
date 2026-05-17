import { describe, expect, it } from 'vitest';
import { parsePeriodParams, periodToRange, applyPeriodToRounds } from '@/lib/period';

describe('parsePeriodParams', () => {
  it('preset を正規化する', () => {
    expect(parsePeriodParams({ preset: 'last30' }).preset).toBe('last30');
  });
  it('未知の preset は all に倒す', () => {
    expect(parsePeriodParams({ preset: 'bogus' }).preset).toBe('all');
  });
  it('custom は from/to を保持', () => {
    expect(parsePeriodParams({ preset: 'custom', from: '2026-05-01', to: '2026-05-10' })).toEqual({
      preset: 'custom',
      from: '2026-05-01',
      to: '2026-05-10',
    });
  });
});

describe('periodToRange', () => {
  it('all は空オブジェクト', () => {
    expect(periodToRange({ preset: 'all' })).toEqual({});
  });
  it('today: gte と lte が JST 同日範囲', () => {
    const now = new Date('2026-05-14T05:00:00Z'); // JST 14:00
    const r = periodToRange({ preset: 'today' }, now);
    // JST 2026-05-14 00:00:00 = UTC 2026-05-13 15:00:00
    expect(r.gte?.toISOString()).toBe('2026-05-13T15:00:00.000Z');
    expect(r.lte?.toISOString()).toBe('2026-05-14T14:59:59.999Z');
  });
  it('last30: gte=29日前, lte=今日終端', () => {
    const now = new Date('2026-05-14T05:00:00Z');
    const r = periodToRange({ preset: 'last30' }, now);
    expect(r.gte?.toISOString()).toBe('2026-04-14T15:00:00.000Z'); // JST 2026-04-15 00:00 = 29 日前
    expect(r.lte?.toISOString()).toBe('2026-05-14T14:59:59.999Z');
  });
  it('thisYear: 1/1 起点', () => {
    const now = new Date('2026-05-14T05:00:00Z');
    const r = periodToRange({ preset: 'thisYear' }, now);
    expect(r.gte?.toISOString()).toBe('2025-12-31T15:00:00.000Z'); // JST 2026-01-01 00:00
  });
  it('custom: from と to を反映', () => {
    const r = periodToRange({ preset: 'custom', from: '2026-05-01', to: '2026-05-10' });
    expect(r.gte?.toISOString()).toBe('2026-04-30T15:00:00.000Z');
    expect(r.lte?.toISOString()).toBe('2026-05-10T14:59:59.999Z');
  });
});

describe('applyPeriodToRounds', () => {
  it('closedAt が null の Round は除外', () => {
    const rows = [
      { closedAt: null, label: 'open' },
      { closedAt: new Date('2026-05-14T05:00:00Z'), label: 'closed' },
    ];
    const out = applyPeriodToRounds(rows, { preset: 'all' });
    expect(out.map((r) => r.label)).toEqual(['closed']);
  });
  it('preset=last30 で範囲外を除外', () => {
    const now = new Date('2026-05-14T05:00:00Z');
    const rows = [
      { closedAt: new Date('2026-03-01T05:00:00Z'), label: 'old' },
      { closedAt: new Date('2026-05-10T05:00:00Z'), label: 'recent' },
    ];
    const out = applyPeriodToRounds(rows, { preset: 'last30' }, now);
    expect(out.map((r) => r.label)).toEqual(['recent']);
  });
});
