import { describe, expect, it } from 'vitest';
import { fmtHold, fmtJst, fmtPrice, fmtYen, groupDigits, pnlSign } from '@/lib/format';

describe('groupDigits / fmtPrice', () => {
  it('整数部だけ 3 桁区切り、小数部・符号はそのまま', () => {
    expect(groupDigits('2925')).toBe('2,925');
    expect(groupDigits('1234567.890')).toBe('1,234,567.890');
    expect(groupDigits('-3400.5')).toBe('-3,400.5');
    expect(groupDigits('285.5')).toBe('285.5');
  });
  it('数値でない文字列はそのまま返す', () => {
    expect(groupDigits('abc')).toBe('abc');
  });
  it('浮動小数で壊れる桁もそのまま（Number を経由しない）', () => {
    expect(fmtPrice('2907.123456789012345678')).toBe('2,907.123456789012345678');
  });
  it('maxDp を渡したときだけ長い小数を decimal.js で切り詰める（末尾 0 は落とす）', () => {
    expect(fmtPrice('2903.333333333333333333', 4)).toBe('2,903.3333');
    expect(fmtPrice('2903.50000000', 4)).toBe('2,903.5');
    expect(fmtPrice('2903.5', 4)).toBe('2,903.5');
  });
  it('null は —', () => {
    expect(fmtPrice(null)).toBe('—');
  });
});

describe('fmtYen', () => {
  it('円は整数（四捨五入は decimal.js）', () => {
    expect(fmtYen('4000')).toBe('4,000');
    expect(fmtYen('-3359.99999999999998')).toBe('-3,360');
    expect(fmtYen('0.4')).toBe('0');
    expect(fmtYen('-0.4', true)).toBe('0');
    expect(fmtYen('1234567.5')).toBe('1,234,568');
  });
  it('signed なら正に + を付ける', () => {
    expect(fmtYen('700', true)).toBe('+700');
    expect(fmtYen('-700', true)).toBe('-700');
  });
  it('null は —', () => {
    expect(fmtYen(null)).toBe('—');
  });
});

describe('pnlSign', () => {
  it('丸めた円で符号を決める（-0.4 円は 0）', () => {
    expect(pnlSign('700')).toBe(1);
    expect(pnlSign('-3400')).toBe(-1);
    expect(pnlSign('-0.4')).toBe(0);
    expect(pnlSign(null)).toBe(0);
  });
});

describe('fmtHold', () => {
  it('時刻付きは秒・分・時間・日', () => {
    expect(fmtHold(45, 'ms')).toBe('45秒');
    expect(fmtHold(75, 'ms')).toBe('1分15秒');
    expect(fmtHold(3600, 'ms')).toBe('1時間');
    expect(fmtHold(5400, 'ms')).toBe('1時間30分');
    expect(fmtHold(90000, 'ms')).toBe('1日1時間');
  });
  it('日付だけ（SBI）は日数。0 は当日', () => {
    expect(fmtHold(0, 'day')).toBe('当日');
    expect(fmtHold(86400 * 3, 'day')).toBe('3日');
  });
  it('null は —', () => {
    expect(fmtHold(null, 'ms')).toBe('—');
  });
});

describe('fmtJst', () => {
  const d = new Date('2026-10-01T00:00:00.123Z'); // JST 09:00:00
  it('JST で表示する', () => {
    expect(fmtJst(d)).toBe('10/01 09:00');
    expect(fmtJst(d, 'ms', true)).toBe('10/01 09:00:00');
  });
  it('day 精度は日付だけ', () => {
    expect(fmtJst(d, 'day')).toBe('10/01');
  });
});
