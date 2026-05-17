// SBI 証券「取引履歴」CSV のパーサ。
// CSV は通常 Shift_JIS (CP932) でエクスポートされる。
// 冒頭に案内文の数行が入ることがあり、ヘッダ行を内容から検出する。
// カラム名はバージョンによって揺れるため、エイリアスでマッピングする。

import iconv from 'iconv-lite';
import { combineJstDateTime, parseJpDate } from './jp-date';
import { normalizeNumber, splitCsvRow } from './jp-number';
import type {
  MarginType,
  NormalizedExecution,
  NormalizedInstrument,
  ParseResult,
  ParseWarning,
  Side,
} from './types';

type ColumnKey =
  | 'tradeDate'      // 約定日
  | 'tradeTime'      // 約定時刻
  | 'symbol'         // 銘柄コード
  | 'name'           // 銘柄名
  | 'exchange'       // 市場
  | 'kind'           // 取引区分 (現物買/信用新規買 等)
  | 'marginType'     // 信用区分 (制度/一般 等) ※あれば
  | 'qty'            // 数量
  | 'price'          // 約定単価
  | 'fee'            // 手数料
  | 'tax'            // 税金
  | 'orderId'        // 注文番号
  | 'fillId';        // 約定番号

// 注意: 部分一致なので、より具体的な名前は他カラムと混同しないこと。
// 例: name の alias に「銘柄」だけ書くと「銘柄コード」にも一致してしまう。
const HEADER_ALIASES: Record<ColumnKey, string[]> = {
  tradeDate: ['約定日', '取引日'],
  tradeTime: ['約定時刻', '約定時間'],
  symbol: ['銘柄コード', 'コード'],
  name: ['銘柄名'],
  exchange: ['市場', '取引所'],
  kind: ['取引区分', '売買区分', '区分'],
  marginType: ['信用区分'],
  qty: ['数量', '株数'],
  price: ['約定単価', '単価', '取引単価'],
  fee: ['手数料'],
  tax: ['税金', '消費税'],
  orderId: ['注文番号'],
  fillId: ['約定番号'],
};

const KIND_PATTERNS: Array<{
  re: RegExp;
  side: Side;
  marginType: MarginType;
}> = [
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

// 現引/現渡 は 1 行で 2 つのポジション変化が起きる。
//   - 現引 = 信用買建を現物として引き取る → MARGIN_LONG SELL (建玉解消) + CASH BUY (現物取得)
//   - 現渡 = 信用売建に対して現物を渡す → MARGIN_SHORT BUY (建玉解消) + CASH SELL (現物減)
// 同 instrument / 同 qty / 同 price / 同 executedAt の 2 Execution を生成する。
// dedupeHash は marginType が違うので衝突しないが、roleSuffix もキーに含めて防御。
type SplitFill = { side: Side; marginType: MarginType; roleSuffix: string };

function expandSplitKind(label: string): SplitFill[] | null {
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
  return null;
}

function buildColumnMap(headerRow: string[]): Partial<Record<ColumnKey, number>> {
  const map: Partial<Record<ColumnKey, number>> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES) as [ColumnKey, string[]][]) {
    const idx = headerRow.findIndex((h) => aliases.some((a) => h.includes(a)));
    if (idx >= 0) map[key] = idx;
  }
  return map;
}

function findHeaderLine(lines: string[]): number {
  // 「約定日」「銘柄コード」を両方含む行をヘッダとして検出。
  for (let i = 0; i < lines.length; i++) {
    const row = splitCsvRow(lines[i]);
    const joined = row.join('|');
    if (/約定日|取引日/.test(joined) && /銘柄コード|コード/.test(joined) && /数量|株数/.test(joined)) {
      return i;
    }
  }
  return -1;
}

export type SbiParseOptions = {
  /** 既定: 自動判定 (BOM 付きは utf-8、それ以外は cp932)。 */
  encoding?: 'cp932' | 'utf-8' | 'auto';
  accountExternalId?: string; // デフォルト "default"
};

function detectEncoding(buf: Buffer): 'cp932' | 'utf-8' {
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  // 先頭 256 バイトで非 ASCII の Shift_JIS 妥当性をざっくり評価
  const head = buf.subarray(0, Math.min(buf.length, 512));
  // 単純化: utf-8 として decode した結果に置換文字が含まれていなければ utf-8
  try {
    const decoded = head.toString('utf-8');
    if (decoded.includes('�')) return 'cp932';
    return 'utf-8';
  } catch {
    return 'cp932';
  }
}

export function parseSbiCsvBuffer(
  buf: Buffer,
  opts: SbiParseOptions = {},
): ParseResult {
  const enc = opts.encoding && opts.encoding !== 'auto' ? opts.encoding : detectEncoding(buf);
  const text = enc === 'utf-8' ? buf.toString('utf-8') : iconv.decode(buf, 'cp932');
  return parseSbiCsvText(text, opts);
}

/**
 * 新フォーマット (注文一覧_当日約定): ヘッダの先頭が「銘柄,銘柄,銘柄」と 3 列連続し、
 * 「平均約定単価」が含まれる。1=コード, 2=名称, 3=市場、約定時刻なし、手数料/税が "--" のことあり。
 */
function findNewFormatHeader(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const row = splitCsvRow(lines[i]).map((c) => c.trim());
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

function parseNewFormatRows(
  rawLines: string[],
  headerIdx: number,
  accountExternalId: string,
): ParseResult {
  const warnings: ParseWarning[] = [];
  const executions: NormalizedExecution[] = [];
  const header = splitCsvRow(rawLines[headerIdx]).map((c) => c.trim());

  // 必須カラム位置
  const idxKind = header.findIndex((h) => h.includes('取引区分'));
  const idxDate = header.findIndex((h) => h.includes('約定日'));
  const idxQty = header.findIndex((h) => h.includes('株数'));
  const idxPrice = header.findIndex((h) => h.includes('平均約定単価'));
  const idxFee = header.findIndex((h) => h.includes('手数料'));
  const idxTax = header.findIndex((h) => h.includes('課税額') || h.includes('譲渡益税'));
  // 「注文一覧_約定履歴」固有: 受渡金額・決済損益。同日同銘柄同価格でも建玉違いの返済を区別する識別子になる。
  // 値が "--" (T+2 前の当日約定) のときは null として扱い、後段の seq fallback に任せる。
  const idxSettlement = header.findIndex(
    (h) => h.includes('受渡金額') && h.includes('決済損益'),
  );

  const missing: string[] = [];
  if (idxKind < 0) missing.push('取引区分');
  if (idxDate < 0) missing.push('約定日');
  if (idxQty < 0) missing.push('株数');
  if (idxPrice < 0) missing.push('平均約定単価');
  if (missing.length) {
    return {
      executions: [],
      warnings: [{ line: headerIdx + 1, code: 'missing-columns', message: `新フォーマット必須カラム不足: ${missing.join(', ')}` }],
    };
  }

  // 同自然キー (executedAt+symbol+marginType+side+qty+price+roleSuffix) の出現回数を
  // 行ループ中に追跡。2 件目以降は roleSuffix に `seq=N` を付けて dedupeHash を別物にする。
  // CSV 上で「受渡損益も同じ」完全重複が出ても (理論上ほぼ無い) 衝突しない最終安全網。
  const seqByKey = new Map<string, number>();
  const bumpSeq = (key: string): number => {
    const n = (seqByKey.get(key) ?? 0) + 1;
    seqByKey.set(key, n);
    return n;
  };
  const composeRoleSuffix = (
    base: string | undefined,
    pnl: string | null,
    naturalKey: string,
  ): string | undefined => {
    const parts: string[] = [];
    if (base) parts.push(base);
    if (pnl) parts.push(`pnl=${pnl}`);
    const probe = parts.join('|');
    const n = bumpSeq(`${naturalKey}|${probe}`);
    if (n > 1) parts.push(`seq=${n}`);
    return parts.length ? parts.join('|') : undefined;
  };

  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    const row = splitCsvRow(line);
    if (row.every((c) => !c.trim())) continue;

    const dateRaw = (row[idxDate] ?? '').trim();
    const date = parseJpDate(dateRaw);
    if (!date) {
      warnings.push({ line: i + 1, code: 'bad-date', message: `約定日のパース失敗: "${dateRaw}"` });
      continue;
    }

    const kindLabel = (row[idxKind] ?? '').trim();
    const split = expandSplitKind(kindLabel);
    const classified = split ? null : classifyKind(kindLabel);
    if (!split && !classified) {
      warnings.push({ line: i + 1, code: 'unknown-kind', message: `取引区分を解釈できません: "${kindLabel}"` });
      continue;
    }

    const symbol = (row[0] ?? '').trim();
    const name = (row[1] ?? '').trim();
    const exchange = (row[2] ?? '').trim();
    if (!symbol) {
      warnings.push({ line: i + 1, code: 'no-symbol', message: '銘柄コードが空' });
      continue;
    }

    const instrument: NormalizedInstrument = {
      kind: 'EQUITY_JP',
      symbol,
      exchange: exchange || undefined,
      name: name || undefined,
      ccy: 'JPY',
    };

    const qty = normalizeNumber(row[idxQty]);
    const price = normalizeNumber(row[idxPrice]);
    // 現引/現渡 の手数料・税金は信用建玉決済側に寄せる (現物側はゼロ扱い)。
    // 受渡金額 = -建値×数量 のみで、手数料/課税は "--" で来るのが通常。
    const fee = idxFee >= 0 ? normalizeNumber(row[idxFee]) : '0';
    const tax = idxTax >= 0 ? normalizeNumber(row[idxTax]) : '0';
    // 受渡損益: "--" / 空 のときは null。それ以外は normalizeNumber で数値文字列化。
    const settlementRaw = idxSettlement >= 0 ? (row[idxSettlement] ?? '').trim() : '';
    const settlementPnl =
      settlementRaw && settlementRaw !== '--' ? normalizeNumber(settlementRaw) : null;
    const rawRow = Object.fromEntries(header.map((h, idx) => [h, row[idx] ?? '']));

    if (split) {
      for (let k = 0; k < split.length; k++) {
        const s = split[k];
        const naturalKey = `${date.toISOString()}|${symbol}|${s.marginType}|${s.side}|${qty}|${price}`;
        const roleSuffix = composeRoleSuffix(s.roleSuffix, settlementPnl, naturalKey);
        executions.push({
          broker: 'SBI',
          accountExternalId,
          instrument,
          executedAt: date,
          side: s.side,
          marginType: s.marginType,
          qty,
          price,
          // 信用建玉決済側 (k=0) に手数料/税を寄せ、現物側は 0
          fee: k === 0 ? fee : '0',
          tax: k === 0 ? tax : '0',
          externalOrderId: undefined,
          externalFillId: undefined,
          roleSuffix,
          raw: { ...rawRow, _roleSuffix: roleSuffix ?? '' },
        });
      }
      continue;
    }

    const naturalKey = `${date.toISOString()}|${symbol}|${classified!.marginType}|${classified!.side}|${qty}|${price}`;
    const roleSuffix = composeRoleSuffix(undefined, settlementPnl, naturalKey);
    executions.push({
      broker: 'SBI',
      accountExternalId,
      instrument,
      executedAt: date,
      side: classified!.side,
      marginType: classified!.marginType,
      qty,
      price,
      fee,
      tax,
      externalOrderId: undefined,
      externalFillId: undefined,
      roleSuffix,
      raw: roleSuffix ? { ...rawRow, _roleSuffix: roleSuffix } : rawRow,
    });
  }
  return { executions, warnings };
}

export function parseSbiCsvText(
  text: string,
  opts: SbiParseOptions = {},
): ParseResult {
  const accountExternalId = opts.accountExternalId ?? 'default';
  const warnings: ParseWarning[] = [];
  const executions: NormalizedExecution[] = [];

  // BOM 除去、改行統一
  const cleaned = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const rawLines = cleaned.split('\n');

  // 新フォーマット (注文一覧_当日約定) を先に試す
  const newIdx = findNewFormatHeader(rawLines);
  if (newIdx >= 0) {
    return parseNewFormatRows(rawLines, newIdx, accountExternalId);
  }

  const headerIdx = findHeaderLine(rawLines);
  if (headerIdx < 0) {
    return {
      executions: [],
      warnings: [{ line: 0, code: 'no-header', message: 'ヘッダ行を検出できません (約定日/銘柄コード/数量 を含む行が必要)' }],
    };
  }
  const headerRow = splitCsvRow(rawLines[headerIdx]);
  const cols = buildColumnMap(headerRow);

  const required: ColumnKey[] = ['tradeDate', 'symbol', 'kind', 'qty', 'price'];
  const missing = required.filter((k) => cols[k] == null);
  if (missing.length) {
    return {
      executions: [],
      warnings: [{ line: headerIdx + 1, code: 'missing-columns', message: `必須カラム不足: ${missing.join(', ')}` }],
    };
  }

  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    const row = splitCsvRow(line);
    if (row.every((c) => !c.trim())) continue;

    const get = (k: ColumnKey) => (cols[k] != null ? row[cols[k]!] ?? '' : '');

    const dateRaw = get('tradeDate');
    const date = parseJpDate(dateRaw);
    if (!date) {
      warnings.push({ line: i + 1, code: 'bad-date', message: `約定日のパース失敗: "${dateRaw}"` });
      continue;
    }
    const timeRaw = get('tradeTime');
    const executedAt = timeRaw ? combineJstDateTime(date, timeRaw) : date;

    const kindLabel = get('kind');
    const split = expandSplitKind(kindLabel);
    const classified = split ? null : classifyKind(kindLabel);
    if (!split && !classified) {
      warnings.push({ line: i + 1, code: 'unknown-kind', message: `取引区分を解釈できません: "${kindLabel}"` });
      continue;
    }

    const symbol = get('symbol').trim();
    if (!symbol) {
      warnings.push({ line: i + 1, code: 'no-symbol', message: '銘柄コードが空' });
      continue;
    }

    const instrument: NormalizedInstrument = {
      kind: 'EQUITY_JP',
      symbol,
      exchange: get('exchange') || undefined,
      name: get('name') || undefined,
      ccy: 'JPY',
    };

    const qty = normalizeNumber(get('qty'));
    const price = normalizeNumber(get('price'));
    const fee = normalizeNumber(get('fee'));
    const tax = normalizeNumber(get('tax'));
    const orderId = get('orderId') || undefined;
    const fillId = get('fillId') || undefined;
    const rawRow = Object.fromEntries(headerRow.map((h, idx) => [h, row[idx] ?? '']));

    if (split) {
      for (let k = 0; k < split.length; k++) {
        const s = split[k];
        executions.push({
          broker: 'SBI',
          accountExternalId,
          instrument,
          executedAt,
          side: s.side,
          marginType: s.marginType,
          qty,
          price,
          fee: k === 0 ? fee : '0',
          tax: k === 0 ? tax : '0',
          // 同一 orderId/fillId のままだと dedupeHash が衝突する経路に入るので、
          // split 行では external ID を捨て、自然キー + roleSuffix で識別する。
          externalOrderId: undefined,
          externalFillId: undefined,
          roleSuffix: s.roleSuffix,
          raw: { ...rawRow, _origOrderId: orderId ?? '', _origFillId: fillId ?? '', _roleSuffix: s.roleSuffix },
        });
      }
      continue;
    }

    executions.push({
      broker: 'SBI',
      accountExternalId,
      instrument,
      executedAt,
      side: classified!.side,
      marginType: classified!.marginType,
      qty,
      price,
      fee,
      tax,
      externalOrderId: orderId,
      externalFillId: fillId,
      raw: rawRow,
    });
  }

  return { executions, warnings };
}
