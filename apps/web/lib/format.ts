// 表示用ユーティリティ。

import Decimal from 'decimal.js';

const numFmt = new Intl.NumberFormat('ja-JP');
const numFmt2 = new Intl.NumberFormat('ja-JP', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function fmtMoney(value: string | number, ccy: string = 'JPY'): string {
  try {
    const d = new Decimal(value);
    const fmt = ccy === 'JPY' ? numFmt : numFmt2;
    const sign = d.lt(0) ? '-' : '';
    const abs = d.abs().toNumber();
    if (ccy === 'JPY') {
      return `${sign}¥${fmt.format(Math.round(abs))}`;
    }
    return `${sign}$${fmt.format(abs)}`;
  } catch {
    return String(value);
  }
}

export function fmtNumber(value: string | number, digits = 2): string {
  try {
    const d = new Decimal(value);
    return d.toFixed(digits).replace(/\.?0+$/, '') || '0';
  } catch {
    return String(value);
  }
}

export function fmtDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

export function fmtPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtRatio(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

export function fmtDate(d: Date | null | undefined): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  }).format(d);
}
