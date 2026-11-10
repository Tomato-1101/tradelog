// SBI ウェブ「注文履歴（詳細）」を集めた JSON（data/raw/sbi-orders/*.json）から約定（秒まで）を取り出し、
// 約定履歴照会 CSV 由来の SBI 約定（日付だけ）に時刻を割り当てる。純関数（DB は sbi-orders-import.ts）。
//
// JSON の rows は注文 1 件の履歴表。1 行目が見出し、日付セルは日付が変わった行にだけ出る（以降の行は 1 列少ない）。
// 状況=「約定」の行が 1 約定（SOR は市場ごと、分割約定は複数行）。
//
// 割り当ての規則（推測で当てない）:
//  1. 「日付・銘柄・売買・信用区分・市場・単価」が同じ組の中で、約定数量の合計が CSV と注文履歴で一致するときだけ当てる。
//     CSV は同じ注文・同じ単価の分割約定を 1 行にまとめたり、返済を建玉ごとに分けたりするので、件数ではなく数量で揃える。
//     CSV 行は行順（seq）、注文履歴は時刻順に並べて数量を先頭から割り振り、CSV 行がまたがる約定の時刻が全部同じときだけ採用。
//     同じ組の CSV 行どうしは日付・単価・数量が同じで区別できない（違うのは建玉ごとの手数料・決済損益だけ）ので、行順で決める。
//  2. 「日付・口座・銘柄・信用区分」（＝同じ日のラウンドの並び）の中に 1 件でも時刻の付かない約定が残るなら、その組は全部見送る。
//     時刻付き（実時刻）と日付だけ（09:00 固定）が混ざると、同じ日の約定の並びが壊れてラウンドを誤るため。

import Decimal from 'decimal.js';
import type { MarginType, Side } from './types';

export type SbiOrderKind = '信新買' | '信新売' | '信返買' | '信返売' | '現買' | '現売';

const KIND: Record<SbiOrderKind, { side: Side; marginType: MarginType }> = {
  信新買: { side: 'BUY', marginType: 'MARGIN_LONG' },
  信返売: { side: 'SELL', marginType: 'MARGIN_LONG' },
  信新売: { side: 'SELL', marginType: 'MARGIN_SHORT' },
  信返買: { side: 'BUY', marginType: 'MARGIN_SHORT' },
  現買: { side: 'BUY', marginType: 'CASH' },
  現売: { side: 'SELL', marginType: 'CASH' },
};

export type SbiOrderFill = {
  /** UTC（JST の日付 + 秒までの時刻） */
  executedAt: Date;
  /** JST の YYYY-MM-DD（約定行の日付。期間注文は注文日と違うことがある） */
  date: string;
  /** JST の HH:MM:SS */
  time: string;
  symbol: string;
  name: string | null;
  kind: SbiOrderKind;
  side: Side;
  marginType: MarginType;
  qty: string;
  price: string;
  market: string;
  orderNo: string;
  /** 一覧の注文種別（通常注文 / 逆指値注文 など） */
  orderKind: string | null;
  /** 一覧の執行条件（指値 / 成行 など） */
  orderType: string | null;
  /** 一覧の注文単価（成行は null） */
  orderPrice: string | null;
  /** 逆指値の「待機中」行の時刻（UTC）。逆指値でなければ null */
  stopWaitAt: Date | null;
  /** 逆指値の「待機中」行の条件 */
  stopCondition: string | null;
};

export type SbiOrderWarning = { orderNo: string; code: string; message: string };

type RawOrder = { date?: string; orderNo?: string; listRow?: string[]; rows?: string[][] };
export type SbiOrderHistoryJson = { collectedAt?: string; days?: Record<string, { cnt?: number; got?: number }>; orders?: RawOrder[] };

const DATE_CELL = /^(\d{2})\/(\d{2})\/(\d{2})$/;
const TIME_CELL = /^\d{2}:\d{2}:\d{2}$/;
const SYMBOL = /^[0-9][0-9A-Z]{3}$/;

function cell(s: string | undefined): string | null {
  const t = (s ?? '').trim();
  return !t || t === '--' ? null : t;
}

function num(s: string): string {
  return new Decimal(s.replace(/,/g, '')).toString();
}

/** 一覧の銘柄セル「太陽誘電 6976 SOR」→ コードと名前（名前に空白を含むことがある） */
function parseSymbolCell(s: string | undefined): { symbol: string; name: string | null } | null {
  const tokens = (s ?? '').trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (SYMBOL.test(tokens[i])) return { symbol: tokens[i], name: tokens.slice(0, i).join(' ') || null };
  }
  return null;
}

/** 注文 1 件の履歴表から約定を取り出す */
export function parseSbiOrder(o: RawOrder): { fills: SbiOrderFill[]; warnings: SbiOrderWarning[] } {
  const orderNo = o.orderNo ?? '';
  const warnings: SbiOrderWarning[] = [];
  const warn = (code: string, message: string) => warnings.push({ orderNo, code, message });
  const fills: SbiOrderFill[] = [];
  const rows = o.rows ?? [];
  const list = o.listRow ?? [];
  const inst = parseSymbolCell(list[5]);
  if (!inst) {
    warn('no-symbol', `銘柄コードを読めません: "${list[5] ?? ''}"`);
    return { fills, warnings };
  }
  if (rows[0]?.[0] !== '日付') {
    warn('no-header', '注文履歴の見出し行がありません');
    return { fills, warnings };
  }
  // 日付セルの無い行に合わせ、見出しから「日付」を除いた列位置で読む
  const header = rows[0].slice(1);
  const col = (name: string) => header.indexOf(name);
  const iTime = col('時刻');
  const iMarket = col('市場');
  const iKind = col('取引');
  const iStatus = col('状況');
  const iQty = col('約定株数');
  const iPrice = col('単価');
  const iCond = col('条件');
  if ([iTime, iMarket, iKind, iStatus, iQty, iPrice].some((i) => i < 0)) {
    warn('missing-columns', `注文履歴の列が足りません: ${rows[0].join(',')}`);
    return { fills, warnings };
  }
  const orderPriceCell = cell((list[8] ?? '').trim().split(/\s+/)[0]);
  const orderPrice = orderPriceCell ? num(orderPriceCell) : null;

  let date = o.date ?? null;
  let stopWaitAt: Date | null = null;
  let stopCondition: string | null = null;
  for (let r = 1; r < rows.length; r++) {
    let cells = rows[r];
    const m = DATE_CELL.exec(cells[0] ?? '');
    if (m) {
      date = `20${m[1]}-${m[2]}-${m[3]}`;
      cells = cells.slice(1);
    }
    if (cells.length !== header.length) {
      warn('bad-row', `${r} 行目の列数が見出しと違います: ${rows[r].join(',')}`);
      continue;
    }
    const time = cells[iTime];
    if (!date || !TIME_CELL.test(time)) {
      warn('bad-time', `${r} 行目の日時を読めません: ${rows[r].join(',')}`);
      continue;
    }
    const at = new Date(`${date}T${time}+09:00`);
    const status = cells[iStatus];
    if (status === '待機中') {
      stopWaitAt = at;
      stopCondition = iCond >= 0 ? cell(cells[iCond]) : null;
      continue;
    }
    if (status !== '約定') continue;
    const kind = cells[iKind] as SbiOrderKind;
    if (!KIND[kind]) {
      warn('unknown-kind', `${r} 行目の取引を解釈できません: "${cells[iKind]}"`);
      continue;
    }
    const qty = cell(cells[iQty]);
    const price = cell(cells[iPrice]);
    const market = cell(cells[iMarket]);
    if (!qty || !price || !market) {
      warn('bad-fill', `${r} 行目の約定に数量・単価・市場が欠けています: ${rows[r].join(',')}`);
      continue;
    }
    fills.push({
      executedAt: at,
      date,
      time,
      symbol: inst.symbol,
      name: inst.name,
      kind,
      ...KIND[kind],
      qty: num(qty),
      price: num(price),
      market,
      orderNo,
      orderKind: cell(list[3]),
      orderType: cell(list[7]),
      orderPrice,
      stopWaitAt,
      stopCondition,
    });
  }
  return { fills, warnings };
}

export type SbiOrderFile = { name: string; json: SbiOrderHistoryJson };

export type SbiOrderParseResult = {
  fills: SbiOrderFill[];
  warnings: SbiOrderWarning[];
  orders: number;
  /** 複数ファイルに出た同じ注文（注文日 + 注文番号）で、捨てた側の数 */
  duplicateOrders: number;
  /** 集め終わっていない日（一覧の件数 cnt より詳細を取れた数 got が少ない）。ファイル名ごと */
  incompleteDays: Array<{ file: string; date: string; cnt: number; got: number }>;
};

/**
 * 複数ファイルをまとめて読む。同じ注文（注文日 + 注文番号）が複数ファイルにあれば、collectedAt が新しいファイル
 * （同じなら引数で後ろのファイル）の内容を採る（後から集めた方が約定が出揃っているため）。
 */
export function parseSbiOrderFiles(files: SbiOrderFile[]): SbiOrderParseResult {
  const pick = new Map<string, { rank: [string, number]; order: RawOrder }>();
  const incompleteDays: SbiOrderParseResult['incompleteDays'] = [];
  let total = 0;
  files.forEach((f, idx) => {
    const rank: [string, number] = [f.json.collectedAt ?? '', idx];
    for (const [date, d] of Object.entries(f.json.days ?? {})) {
      if ((d.got ?? 0) < (d.cnt ?? 0)) incompleteDays.push({ file: f.name, date, cnt: d.cnt ?? 0, got: d.got ?? 0 });
    }
    for (const o of f.json.orders ?? []) {
      total++;
      const key = `${o.date ?? ''}|${o.orderNo ?? ''}`;
      const cur = pick.get(key);
      if (!cur || rank[0] > cur.rank[0] || (rank[0] === cur.rank[0] && rank[1] > cur.rank[1])) pick.set(key, { rank, order: o });
    }
  });
  const fills: SbiOrderFill[] = [];
  const warnings: SbiOrderWarning[] = [];
  for (const { order } of pick.values()) {
    const r = parseSbiOrder(order);
    fills.push(...r.fills);
    warnings.push(...r.warnings);
  }
  return { fills, warnings, orders: pick.size, duplicateOrders: total - pick.size, incompleteDays };
}

// ---------- 割り当て ----------

/** 時刻を付ける対象（DB の SBI 約定）。date は JST の日付 */
export type OrderMatchCandidate = {
  id: string;
  date: string;
  account: string;
  symbol: string;
  side: Side;
  marginType: MarginType | null;
  qty: string;
  price: string | null;
  /** CSV の「市場」列（"--" や不明は null） */
  market: string | null;
  seq: number;
};

export type UnmatchReason =
  | 'no-fill' // 同じ組の約定が注文履歴に無い（集めていない注文など）
  | 'no-exec' // 注文履歴の約定に当たる CSV の行が無い
  | 'no-csv-day' // その日の SBI 約定が DB に 1 件も無い（CSV 未取り込みの日）
  | 'qty-mismatch' // 同じ組の約定数量の合計が CSV と注文履歴で違う
  | 'split-time-ambiguous' // CSV の 1 行が時刻の違う複数の約定にまたがる
  | 'bucket-incomplete'; // 同じ日・銘柄・信用区分に時刻の付かない約定が残るので見送り

export const UNMATCH_LABEL: Record<UnmatchReason, string> = {
  'no-fill': '注文履歴に同じ約定が無い',
  'no-exec': 'CSV に同じ約定が無い',
  'no-csv-day': 'CSV 未取り込みの日',
  'qty-mismatch': '同じ単価・市場の約定数量の合計が合わない',
  'split-time-ambiguous': 'CSV の 1 行が時刻の違う約定にまたがる',
  'bucket-incomplete': '同じ日・銘柄・信用区分に時刻の付かない約定が残るため見送り',
};

export type OrderAssignment = { id: string; executedAt: Date; fills: SbiOrderFill[] };

export type OrderMatchResult = {
  /** 対象（注文履歴のある日）の約定数 */
  candidates: number;
  assignments: OrderAssignment[];
  unmatchedExecs: Array<{ id: string; reason: UnmatchReason }>;
  unmatchedFills: Array<{ fill: SbiOrderFill; reason: UnmatchReason }>;
};

const priceKey = (p: string) => new Decimal(p).toString();

function groupKey(x: { date: string; symbol: string; side: Side; marginType: MarginType | null; market: string | null; price: string }): string {
  return [x.date, x.symbol, x.side, x.marginType ?? '', x.market ?? '', priceKey(x.price)].join('|');
}

function fillOrder(a: SbiOrderFill, b: SbiOrderFill): number {
  const t = a.executedAt.getTime() - b.executedAt.getTime();
  if (t !== 0) return t;
  return a.orderNo < b.orderNo ? -1 : a.orderNo > b.orderNo ? 1 : 0;
}

/** 注文履歴の約定を SBI 約定に割り当てる。candidates は注文履歴のある日以外を含んでもよい（無視する） */
export function matchOrderFills(candidates: OrderMatchCandidate[], fills: SbiOrderFill[]): OrderMatchResult {
  const fillDates = new Set(fills.map((f) => f.date));
  const cands = candidates.filter((c) => fillDates.has(c.date));
  const candDates = new Set(cands.map((c) => c.date));

  const execGroups = new Map<string, OrderMatchCandidate[]>();
  const unmatchedExecs: OrderMatchResult['unmatchedExecs'] = [];
  for (const c of cands) {
    if (c.price == null) {
      unmatchedExecs.push({ id: c.id, reason: 'no-fill' });
      continue;
    }
    const k = groupKey({ ...c, price: c.price });
    execGroups.set(k, [...(execGroups.get(k) ?? []), c]);
  }
  const fillGroups = new Map<string, SbiOrderFill[]>();
  for (const f of fills) {
    const k = groupKey(f);
    fillGroups.set(k, [...(fillGroups.get(k) ?? []), f]);
  }

  const tentative = new Map<string, OrderAssignment>();
  const unmatchedFills: OrderMatchResult['unmatchedFills'] = [];
  for (const k of new Set([...execGroups.keys(), ...fillGroups.keys()])) {
    const es = (execGroups.get(k) ?? []).slice().sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const fs = (fillGroups.get(k) ?? []).slice().sort(fillOrder);
    if (!fs.length) {
      for (const e of es) unmatchedExecs.push({ id: e.id, reason: 'no-fill' });
      continue;
    }
    if (!es.length) {
      for (const f of fs) unmatchedFills.push({ fill: f, reason: candDates.has(f.date) ? 'no-exec' : 'no-csv-day' });
      continue;
    }
    const sum = (xs: Array<{ qty: string }>) => xs.reduce((a, x) => a.plus(x.qty), new Decimal(0));
    if (!sum(es).eq(sum(fs))) {
      for (const e of es) unmatchedExecs.push({ id: e.id, reason: 'qty-mismatch' });
      for (const f of fs) unmatchedFills.push({ fill: f, reason: 'qty-mismatch' });
      continue;
    }
    // 数量を先頭から割り振る: CSV 行 [a, a+qty) と重なる約定を集める
    const fillRanges: Array<{ f: SbiOrderFill; from: Decimal; to: Decimal }> = [];
    let acc = new Decimal(0);
    for (const f of fs) {
      fillRanges.push({ f, from: acc, to: acc.plus(f.qty) });
      acc = acc.plus(f.qty);
    }
    let pos = new Decimal(0);
    for (const e of es) {
      const from = pos;
      const to = pos.plus(e.qty);
      pos = to;
      const over = fillRanges.filter((r) => r.from.lt(to) && r.to.gt(from)).map((r) => r.f);
      const t = over[0].executedAt.getTime();
      if (over.some((f) => f.executedAt.getTime() !== t)) {
        unmatchedExecs.push({ id: e.id, reason: 'split-time-ambiguous' });
        for (const f of over) unmatchedFills.push({ fill: f, reason: 'split-time-ambiguous' });
        continue;
      }
      tentative.set(e.id, { id: e.id, executedAt: over[0].executedAt, fills: over });
    }
  }

  // 同じ日・口座・銘柄・信用区分に 1 件でも未割り当てが残る組は、全部見送る
  const bucketOf = (c: OrderMatchCandidate) => [c.date, c.account, c.symbol, c.marginType ?? ''].join('|');
  const incomplete = new Set(cands.filter((c) => !tentative.has(c.id)).map(bucketOf));
  const assignments: OrderAssignment[] = [];
  for (const c of cands) {
    const a = tentative.get(c.id);
    if (!a) continue;
    if (incomplete.has(bucketOf(c))) {
      unmatchedExecs.push({ id: c.id, reason: 'bucket-incomplete' });
      for (const f of a.fills) unmatchedFills.push({ fill: f, reason: 'bucket-incomplete' });
      continue;
    }
    assignments.push(a);
  }
  return { candidates: cands.length, assignments, unmatchedExecs, unmatchedFills: dedupeFills(unmatchedFills) };
}

/** 同じ約定が複数回数えられたら最初の理由だけ残す（CSV 2 行が 1 約定を分け合うとき等） */
function dedupeFills(xs: OrderMatchResult['unmatchedFills']): OrderMatchResult['unmatchedFills'] {
  const seen = new Set<SbiOrderFill>();
  return xs.filter((x) => (seen.has(x.fill) ? false : (seen.add(x.fill), true)));
}

