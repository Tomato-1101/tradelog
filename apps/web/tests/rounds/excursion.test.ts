import { describe, expect, it } from 'vitest';
import { computeExcursion, type ExcursionInput } from '@/lib/rounds/excursion';
import type { BarLite } from '@/lib/paper/resolve';

const jst = (hm: string) => new Date(`2026-10-05T${hm}:00+09:00`);
const b = (hm: string, low: number, high: number): BarLite => ({ ts: jst(hm), open: low, high, low, close: high });
const bars = [b('09:59', 900, 1100), b('10:00', 995, 1004), b('10:01', 990, 1010), b('10:02', 998, 1002), b('10:03', 800, 1200)];
const base: ExcursionInput = {
  direction: 'LONG',
  avgEntryPrice: '1000',
  openedAt: new Date('2026-10-05T10:00:30+09:00'),
  closedAt: new Date('2026-10-05T10:02:45+09:00'),
  timePrecision: 'ms',
};
const now = jst('15:00');

describe('computeExcursion', () => {
  it('ロング: MAE = 最安値 − 建値、MFE = 最高値 − 建値（窓は建てた分〜決済した分）', () => {
    expect(computeExcursion(base, bars, now)).toEqual({ mae: '-10', mfe: '10' });
  });
  it('ショート: MAE = 建値 − 最高値、MFE = 建値 − 最安値', () => {
    expect(computeExcursion({ ...base, direction: 'SHORT' }, bars, now)).toEqual({ mae: '-10', mfe: '10' });
    expect(computeExcursion({ ...base, direction: 'SHORT', avgEntryPrice: '1005' }, bars, now)).toEqual({ mae: '-5', mfe: '15' });
  });
  it('順行が無ければ MFE=0、逆行が無ければ MAE=0', () => {
    expect(computeExcursion({ ...base, avgEntryPrice: '980' }, bars, now)).toEqual({ mae: '0', mfe: '30' });
    expect(computeExcursion({ ...base, avgEntryPrice: '1020' }, bars, now)).toEqual({ mae: '-30', mfe: '0' });
  });
  it('未決済は now の分まで', () => {
    expect(computeExcursion({ ...base, closedAt: null }, bars, jst('10:03'))).toEqual({ mae: '-200', mfe: '200' });
  });
  it('日付だけ・建値なし・窓に足が無いときは null', () => {
    expect(computeExcursion({ ...base, timePrecision: 'day' }, bars, now)).toBeNull();
    expect(computeExcursion({ ...base, avgEntryPrice: null }, bars, now)).toBeNull();
    expect(computeExcursion(base, [b('11:00', 1, 2)], now)).toBeNull();
  });
});
