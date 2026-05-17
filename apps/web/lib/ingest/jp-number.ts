// 日本語 CSV 由来の数値・文字列ヘルパ。

import Decimal from 'decimal.js';

/** "1,234.5" / "1,234" / "¥1,234" / "-1,234" を Decimal 文字列に。空欄なら "0"。 */
export function normalizeNumber(input: string | undefined | null): string {
  if (input == null) return '0';
  const s = String(input)
    .replace(/[¥￥$,\s]/g, '')
    .replace(/[、。]/g, '')
    .trim();
  if (!s || s === '-' || s === '−') return '0';
  // 全角マイナスを ASCII に
  const ascii = s.replace(/^[−ー]/, '-');
  try {
    return new Decimal(ascii).toString();
  } catch {
    return '0';
  }
}

/** カンマ区切り CSV の 1 行を配列に分割 (簡易、ダブルクオート対応) */
export function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
