// SBI 証券の約定 CSV パーサ。CSV は通常 Shift_JIS（CP932）。
// 対応形式:
//   third-savefile: 約定履歴照会（SaveFile_*.csv）。約定日,銘柄,銘柄コード,市場,取引,…,受渡金額/決済損益
//   new-daily:      注文一覧_当日約定。先頭 3 列が「銘柄」、平均約定単価・受渡金額・決済損益
//   legacy:         取引履歴（約定時刻・注文番号・約定番号の列がある旧形式）
// third-savefile と new-daily には約定時刻が無い。executedAt は JST 当日 09:00（UTC 00:00）を置き、
// timePrecision='day' で「日付しか分からない」ことを明示する。

import iconv from 'iconv-lite';
import { combineJstDateTime, parseJpDate } from './jp-date';
import { normalizeNumber, splitCsvRow } from './jp-number';
import type {
  MarginType,
  NormalizedExecution,
  NormalizedInstrument,
  ParseResult,
  ParseWarning,
  SbiCsvFormat,
  Side,
  TimePrecision,
} from './types';

const KIND_PATTERNS: Array<{ re: RegExp; side: Side; marginType: MarginType }> = [
  { re: /信用.*新規.*買/, side: 'BUY', marginType: 'MARGIN_LONG' },
  { re: /信用.*返済.*売/, side: 'SELL', marginType: 'MARGIN_LONG' },
  { re: /信用.*新規.*売/, side: 'SELL', marginType: 'MARGIN_SHORT' },
  { re: /信用.*返済.*買/, side: 'BUY', marginType: 'MARGIN_SHORT' },
  { re: /(現物|株式).*買/, side: 'BUY', marginType: 'CASH' },
  { re: /(現物|株式).*売/, side: 'SELL', marginType: 'CASH' },
  { re: /^買$|買付/, side: 'BUY', marginType: 'CASH' },
  { re: /^売$|売却|売付/, side: 'SELL', marginType: 'CASH' },
];

function classifyKind(label: string): { side: Side; marginType: MarginType } | null {
  for (const p of KIND_PATTERNS) {
    if (p.re.test(label)) return { side: p.side, marginType: p.marginType };
  }
  return null;
}

// 損益計算の対象外（MRF の自動運用・投信・株式の入出庫）。警告を出さずに読み飛ばす。
const SKIP_KIND_PATTERNS: RegExp[] = [/^MRF/, /^投信/, /預り(入庫|出庫)/];

function shouldSkipKind(label: string): boolean {
  return SKIP_KIND_PATTERNS.some((re) => re.test(label));
}

function isMarginSettlement(label: string): boolean {
  return /信用.*返済/.test(label);
}

// 現引/現渡 は 1 行で 2 つの建玉変化が起きる。
//   現引 = 信用買建を現物で引き取る → MARGIN_LONG SELL（建玉解消）+ CASH BUY（現物取得）
//   現渡 = 信用売建に現物を渡す     → MARGIN_SHORT BUY（建玉解消）+ CASH SELL（現物減）
type Leg = { side: Side; marginType: MarginType; roleSuffix?: string };

function legsOf(label: string): Leg[] | null {
  if (/現引/.test(label)) {
    return [
      { side: 'SELL', marginType: 'MARGIN_LONG', roleSuffix: 'close-margin' },
      { side: 'BUY', marginType: 'CASH', roleSuffix: 'cash-receipt' },
    ];
  }
  if (/現渡/.test(label)) {
    return [
      { side: 'BUY', marginType: 'MARGIN_SHORT', roleSuffix: 'close-short' },
      { side: 'SELL', marginType: 'CASH', roleSuffix: 'cash-deliver' },
    ];
  }
  const c = classifyKind(label);
  return c ? [c] : null;
}

/** "--" / 空欄を null にしてから数値文字列化 */
function numOrNull(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s || s === '--') return null;
  return normalizeNumber(s);
}

function finish(
  executions: NormalizedExecution[],
  warnings: ParseWarning[],
  format: SbiCsvFormat,
): ParseResult {
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const e of executions) {
    if (!earliest || e.executedAt < earliest) earliest = e.executedAt;
    if (!latest || e.executedAt > latest) latest = e.executedAt;
  }
  return { executions, warnings, format, earliestDate: earliest, latestDate: latest };
}

/** 1 行分の共通入力（形式ごとの列位置の違いを吸収したあと） */
type RowInput = {
  line: number;
  seq: number;
  kindLabel: string;
  executedAt: Date;
  timePrecision: TimePrecision;
  instrument: NormalizedInstrument;
  qty: string;
  price: string;
  fee: string;
  tax: string;
  /** 受渡金額/決済損益 列（無い形式は undefined） */
  settlement?: string | null;
  externalOrderId?: string;
  externalFillId?: string;
  raw: Record<string, string>;
};

/**
 * 行を Execution に展開する。受渡金額/決済損益 の値を roleSuffix（pnl=）に乗せ、
 * 同じ自然キーの 2 行目以降には seq=N を付けて dedupeHash を別物にする
 * （同日・同銘柄・同価格・同数量の返済が建玉違いで複数あるため）。
 */
function makeRowEmitter(accountExternalId: string, useSettlementSuffix: boolean) {
  const seqByKey = new Map<string, number>();
  return (r: RowInput, warnings: ParseWarning[], out: NormalizedExecution[]) => {
    const legs = legsOf(r.kindLabel);
    if (!legs) {
      warnings.push({ line: r.line, code: 'unknown-kind', message: `取引区分を解釈できません: "${r.kindLabel}"` });
      return;
    }
    const split = legs.length > 1;
    const brokerPnl = isMarginSettlement(r.kindLabel) ? (r.settlement ?? null) : null;
    legs.forEach((leg, k) => {
      let roleSuffix: string | undefined;
      if (useSettlementSuffix) {
        const parts: string[] = [];
        if (leg.roleSuffix) parts.push(leg.roleSuffix);
        if (r.settlement) parts.push(`pnl=${r.settlement}`);
        const naturalKey = `${r.executedAt.toISOString()}|${r.instrument.symbol}|${leg.marginType}|${leg.side}|${r.qty}|${r.price}|${parts.join('|')}`;
        const n = (seqByKey.get(naturalKey) ?? 0) + 1;
        seqByKey.set(naturalKey, n);
        if (n > 1) parts.push(`seq=${n}`);
        roleSuffix = parts.length ? parts.join('|') : undefined;
      } else {
        roleSuffix = leg.roleSuffix;
      }
      out.push({
        broker: 'SBI',
        accountExternalId,
        instrument: r.instrument,
        executedAt: r.executedAt,
        timePrecision: r.timePrecision,
        side: leg.side,
        marginType: leg.marginType,
        qty: r.qty,
        price: r.price,
        // 現引/現渡 の手数料・税は信用建玉の決済側（1 本目）に寄せ、現物側は 0
        fee: k === 0 ? r.fee : '0',
        tax: k === 0 ? r.tax : '0',
        // 分解した行で同じ注文番号/約定番号を使うと hash が衝突するので捨てて自然キーで識別する
        externalOrderId: split ? undefined : r.externalOrderId,
        externalFillId: split ? undefined : r.externalFillId,
        roleSuffix,
        brokerPnl: k === 0 ? brokerPnl : null,
        seq: r.seq,
        raw: split || roleSuffix
          ? {
              ...r.raw,
              _roleSuffix: roleSuffix ?? '',
              ...(split ? { _origOrderId: r.externalOrderId ?? '', _origFillId: r.externalFillId ?? '' } : {}),
            }
          : r.raw,
      });
    });
  };
}

function rowRecord(header: string[], row: string[]): Record<string, string> {
  return Object.fromEntries(header.map((h, idx) => [h, row[idx] ?? '']));
}

// ---------- third-savefile（約定履歴照会） ----------

function findThirdFormatHeader(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const row = splitCsvRow(lines[i]);
    if (row.length < 10) continue;
    if (
      row[0] === '約定日' &&
      row[1] === '銘柄' &&
      row[2] === '銘柄コード' &&
      row[4] === '取引' &&
      row.some((c) => c.includes('約定数量')) &&
      row.some((c) => c.includes('約定単価'))
    ) {
      return i;
    }
  }
  return -1;
}

function parseThirdFormat(lines: string[], headerIdx: number, account: string): ParseResult {
  const warnings: ParseWarning[] = [];
  const executions: NormalizedExecution[] = [];
  const header = splitCsvRow(lines[headerIdx]);
  const idxQty = header.findIndex((h) => h.includes('約定数量'));
  const idxPrice = header.findIndex((h) => h.includes('約定単価'));
  const idxFee = header.findIndex((h) => h.includes('手数料'));
  const idxTax = header.findIndex((h) => h.includes('税額'));
  const idxSettlement = header.findIndex((h) => h.includes('受渡金額') && h.includes('決済損益'));
  if (idxQty < 0 || idxPrice < 0) {
    return finish([], [{ line: headerIdx + 1, code: 'missing-columns', message: '約定履歴照会の必須列不足（約定数量 / 約定単価）' }], 'third-savefile');
  }
  const emit = makeRowEmitter(account, true);
  let seq = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = splitCsvRow(lines[i]);
    if (row.every((c) => !c)) continue;
    const kindLabel = row[4] ?? '';
    if (!kindLabel || shouldSkipKind(kindLabel)) continue;
    const date = parseJpDate(row[0] ?? '');
    if (!date) {
      warnings.push({ line: i + 1, code: 'bad-date', message: `約定日のパース失敗: "${row[0] ?? ''}"` });
      continue;
    }
    const symbol = row[2] ?? '';
    if (!symbol) {
      warnings.push({ line: i + 1, code: 'no-symbol', message: `銘柄コードが空（取引区分=${kindLabel}）` });
      continue;
    }
    const exchange = row[3] && row[3] !== '--' ? row[3] : undefined;
    emit(
      {
        line: i + 1,
        seq: seq++,
        kindLabel,
        executedAt: date,
        timePrecision: 'day',
        instrument: { symbol, exchange, name: row[1] || undefined },
        qty: normalizeNumber(row[idxQty]),
        price: normalizeNumber(row[idxPrice]),
        fee: idxFee >= 0 ? numOrNull(row[idxFee]) ?? '0' : '0',
        tax: idxTax >= 0 ? numOrNull(row[idxTax]) ?? '0' : '0',
        settlement: idxSettlement >= 0 ? numOrNull(row[idxSettlement]) : undefined,
        raw: rowRecord(header, row),
      },
      warnings,
      executions,
    );
  }
  return finish(executions, warnings, 'third-savefile');
}

// ---------- new-daily（注文一覧_当日約定） ----------

function findNewFormatHeader(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const row = splitCsvRow(lines[i]);
    if (row.length < 8) continue;
    if (
      row[0] === '銘柄' &&
      row[1] === '銘柄' &&
      row[2] === '銘柄' &&
      row.some((c) => c.includes('平均約定単価')) &&
      row.some((c) => c.includes('約定日')) &&
      row.some((c) => c.includes('取引区分'))
    ) {
      return i;
    }
  }
  return -1;
}

function parseNewFormat(lines: string[], headerIdx: number, account: string): ParseResult {
  const warnings: ParseWarning[] = [];
  const executions: NormalizedExecution[] = [];
  const header = splitCsvRow(lines[headerIdx]);
  const idxKind = header.findIndex((h) => h.includes('取引区分'));
  const idxDate = header.findIndex((h) => h.includes('約定日'));
  const idxQty = header.findIndex((h) => h.includes('株数'));
  const idxPrice = header.findIndex((h) => h.includes('平均約定単価'));
  const idxFee = header.findIndex((h) => h.includes('手数料'));
  const idxTax = header.findIndex((h) => h.includes('課税額') || h.includes('譲渡益税'));
  const idxSettlement = header.findIndex((h) => h.includes('受渡金額') && h.includes('決済損益'));
  const missing: string[] = [];
  if (idxKind < 0) missing.push('取引区分');
  if (idxDate < 0) missing.push('約定日');
  if (idxQty < 0) missing.push('株数');
  if (idxPrice < 0) missing.push('平均約定単価');
  if (missing.length) {
    return finish([], [{ line: headerIdx + 1, code: 'missing-columns', message: `新フォーマット必須カラム不足: ${missing.join(', ')}` }], 'new-daily');
  }
  const emit = makeRowEmitter(account, true);
  let seq = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = splitCsvRow(lines[i]);
    if (row.every((c) => !c)) continue;
    const date = parseJpDate(row[idxDate] ?? '');
    if (!date) {
      warnings.push({ line: i + 1, code: 'bad-date', message: `約定日のパース失敗: "${row[idxDate] ?? ''}"` });
      continue;
    }
    const symbol = row[0] ?? '';
    if (!symbol) {
      warnings.push({ line: i + 1, code: 'no-symbol', message: '銘柄コードが空' });
      continue;
    }
    emit(
      {
        line: i + 1,
        seq: seq++,
        kindLabel: row[idxKind] ?? '',
        executedAt: date,
        timePrecision: 'day',
        instrument: { symbol, exchange: row[2] || undefined, name: row[1] || undefined },
        qty: normalizeNumber(row[idxQty]),
        price: normalizeNumber(row[idxPrice]),
        fee: idxFee >= 0 ? normalizeNumber(row[idxFee]) : '0',
        tax: idxTax >= 0 ? normalizeNumber(row[idxTax]) : '0',
        settlement: idxSettlement >= 0 ? numOrNull(row[idxSettlement]) : undefined,
        raw: rowRecord(header, row),
      },
      warnings,
      executions,
    );
  }
  return finish(executions, warnings, 'new-daily');
}

// ---------- legacy（約定時刻・注文番号のある旧形式） ----------

type ColumnKey =
  | 'tradeDate' | 'tradeTime' | 'symbol' | 'name' | 'exchange' | 'kind'
  | 'qty' | 'price' | 'fee' | 'tax' | 'orderId' | 'fillId';

// 部分一致なので、具体的な名前が他の列と混同しないこと（「銘柄」だけだと「銘柄コード」にも一致する）
const HEADER_ALIASES: Record<ColumnKey, string[]> = {
  tradeDate: ['約定日', '取引日'],
  tradeTime: ['約定時刻', '約定時間'],
  symbol: ['銘柄コード', 'コード'],
  name: ['銘柄名'],
  exchange: ['市場', '取引所'],
  kind: ['取引区分', '売買区分', '区分'],
  qty: ['数量', '株数'],
  price: ['約定単価', '単価', '取引単価'],
  fee: ['手数料'],
  tax: ['税金', '消費税'],
  orderId: ['注文番号'],
  fillId: ['約定番号'],
};

function findLegacyHeader(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const joined = splitCsvRow(lines[i]).join('|');
    if (/約定日|取引日/.test(joined) && /銘柄コード|コード/.test(joined) && /数量|株数/.test(joined)) {
      return i;
    }
  }
  return -1;
}

function parseLegacyFormat(lines: string[], headerIdx: number, account: string): ParseResult {
  const warnings: ParseWarning[] = [];
  const executions: NormalizedExecution[] = [];
  const header = splitCsvRow(lines[headerIdx]);
  const cols: Partial<Record<ColumnKey, number>> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES) as [ColumnKey, string[]][]) {
    const idx = header.findIndex((h) => aliases.some((a) => h.includes(a)));
    if (idx >= 0) cols[key] = idx;
  }
  const required: ColumnKey[] = ['tradeDate', 'symbol', 'kind', 'qty', 'price'];
  const missing = required.filter((k) => cols[k] == null);
  if (missing.length) {
    return finish([], [{ line: headerIdx + 1, code: 'missing-columns', message: `必須カラム不足: ${missing.join(', ')}` }], 'legacy');
  }
  const emit = makeRowEmitter(account, false);
  let seq = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = splitCsvRow(lines[i]);
    if (row.every((c) => !c)) continue;
    const get = (k: ColumnKey) => (cols[k] != null ? row[cols[k]!] ?? '' : '');
    const date = parseJpDate(get('tradeDate'));
    if (!date) {
      warnings.push({ line: i + 1, code: 'bad-date', message: `約定日のパース失敗: "${get('tradeDate')}"` });
      continue;
    }
    const timeRaw = get('tradeTime');
    const symbol = get('symbol');
    if (!symbol) {
      warnings.push({ line: i + 1, code: 'no-symbol', message: '銘柄コードが空' });
      continue;
    }
    emit(
      {
        line: i + 1,
        seq: seq++,
        kindLabel: get('kind'),
        executedAt: timeRaw ? combineJstDateTime(date, timeRaw) : date,
        timePrecision: timeRaw ? 'ms' : 'day',
        instrument: { symbol, exchange: get('exchange') || undefined, name: get('name') || undefined },
        qty: normalizeNumber(get('qty')),
        price: normalizeNumber(get('price')),
        fee: normalizeNumber(get('fee')),
        tax: normalizeNumber(get('tax')),
        externalOrderId: get('orderId') || undefined,
        externalFillId: get('fillId') || undefined,
        raw: rowRecord(header, row),
      },
      warnings,
      executions,
    );
  }
  return finish(executions, warnings, 'legacy');
}

// ---------- 入口 ----------

export type SbiParseOptions = {
  /** 既定: 自動判定（UTF-8 として読めれば utf-8、それ以外は cp932） */
  encoding?: 'cp932' | 'utf-8' | 'auto';
  accountExternalId?: string; // 既定 "default"
};

function detectEncoding(buf: Buffer): 'cp932' | 'utf-8' {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  const head = buf.subarray(0, Math.min(buf.length, 512)).toString('utf-8');
  return head.includes('�') ? 'cp932' : 'utf-8';
}

export function parseSbiCsvBuffer(buf: Buffer, opts: SbiParseOptions = {}): ParseResult {
  const enc = opts.encoding && opts.encoding !== 'auto' ? opts.encoding : detectEncoding(buf);
  const text = enc === 'utf-8' ? buf.toString('utf-8') : iconv.decode(buf, 'cp932');
  return parseSbiCsvText(text, opts);
}

export function parseSbiCsvText(text: string, opts: SbiParseOptions = {}): ParseResult {
  const account = opts.accountExternalId ?? 'default';
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');

  const thirdIdx = findThirdFormatHeader(lines);
  if (thirdIdx >= 0) return parseThirdFormat(lines, thirdIdx, account);

  const newIdx = findNewFormatHeader(lines);
  if (newIdx >= 0) return parseNewFormat(lines, newIdx, account);

  const legacyIdx = findLegacyHeader(lines);
  if (legacyIdx >= 0) return parseLegacyFormat(lines, legacyIdx, account);

  return finish(
    [],
    [{ line: 0, code: 'no-header', message: 'ヘッダ行を検出できません（約定日/銘柄コード/数量 を含む行が必要）' }],
    'unknown',
  );
}
