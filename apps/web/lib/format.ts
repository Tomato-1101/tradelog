// 表示整形。金額・数量・価格は 10 進数文字列のまま扱い、Number(浮動小数)に変換して丸めない。
// 丸め（円の整数化・長い小数の切り詰め）が要る箇所は decimal.js で行う。

import Decimal from 'decimal.js';
import { jstYmd } from '@/lib/time';

const DEC = /^-?\d+(\.\d+)?$/;

/** 整数部だけ 3 桁区切りにする。小数部・符号はそのまま */
export function groupDigits(s: string): string {
  if (!DEC.test(s)) return s;
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${g}${frac !== undefined ? `.${frac}` : ''}`;
}

/** 株価・数量。小数はそのまま。maxDp を渡すと、それより長い小数だけ decimal.js で切り詰めて末尾の 0 を落とす（平均建値など計算値用） */
export function fmtPrice(s: string | null | undefined, maxDp?: number): string {
  if (s == null) return '—';
  if (maxDp !== undefined && DEC.test(s) && (s.split('.')[1]?.length ?? 0) > maxDp) {
    return groupDigits(new Decimal(s).toDecimalPlaces(maxDp, Decimal.ROUND_HALF_UP).toFixed());
  }
  return groupDigits(s);
}

/** 円（整数）。符号付きにするときは signed。四捨五入は decimal.js で行う */
export function fmtYen(s: string | null | undefined, signed = false): string {
  if (s == null || !DEC.test(s)) return '—';
  const d = new Decimal(s).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const body = groupDigits(d.abs().toFixed());
  if (d.isZero()) return body;
  if (d.isNeg()) return `-${body}`;
  return signed ? `+${body}` : body;
}

/** 損益の符号（色分け用）。null は 0 */
export function pnlSign(s: string | null | undefined): 1 | 0 | -1 {
  if (s == null || !DEC.test(s)) return 0;
  const d = new Decimal(s).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return d.isZero() ? 0 : d.isNeg() ? -1 : 1;
}

/** 保有時間。日付だけ（day 精度）の約定は日数、時刻付きは 時間・分・秒 */
export function fmtHold(seconds: number | null | undefined, precision: 'ms' | 'day'): string {
  if (seconds == null) return '—';
  if (precision === 'day') {
    const days = Math.round(seconds / 86_400);
    return days === 0 ? '当日' : `${days}日`;
  }
  if (seconds < 60) return `${seconds}秒`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}分${seconds % 60 ? `${seconds % 60}秒` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間${m % 60 ? `${m % 60}分` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}日${h % 24 ? `${h % 24}時間` : ''}`;
}

const JST_MS = 9 * 3600_000;

/** JST の MM/DD HH:MM（seconds=true で :SS まで）。day 精度は日付だけ */
export function fmtJst(d: Date, precision: 'ms' | 'day' = 'ms', seconds = false): string {
  const j = new Date(d.getTime() + JST_MS).toISOString();
  const date = `${j.slice(5, 7)}/${j.slice(8, 10)}`;
  if (precision === 'day') return date;
  return `${date} ${seconds ? j.slice(11, 19) : j.slice(11, 16)}`;
}

/** JST の YYYY/MM/DD（長い表示用） */
export function fmtJstDate(d: Date): string {
  return jstYmd(d).replaceAll('-', '/');
}

export const PRICE_STATUS_LABEL = { CONFIRMED: '確定', NEEDS_REVIEW: '要確認', UNRESOLVED: '未確定' } as const;
export const PRICE_BASIS_LABEL = {
  OPEN_AUCTION: '寄りの板寄せ',
  CLOSE_AUCTION: '引けの板寄せ',
  SCREEN: '発注時の画面',
  SCREEN_AUTO: '発注時の画面（自動読取）',
  BAR: '足の終値（仮）',
  LIMIT: '指値',
  MANUAL: '手入力',
  CSV: '約定履歴 CSV',
} as const;
export const SIDE_LABEL = { BUY: '買', SELL: '売' } as const;
export const DIRECTION_LABEL = { LONG: 'ロング', SHORT: 'ショート' } as const;
export const MARGIN_LABEL = { CASH: '現物', MARGIN_LONG: '信用買', MARGIN_SHORT: '信用売' } as const;
