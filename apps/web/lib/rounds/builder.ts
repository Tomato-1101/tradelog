// ポジションラウンドの構築（純粋関数）。
// SBI: 「銘柄 × 口座 × 信用区分」ごとに、建玉が 0 → 0 に戻るまでを 1 ラウンドとする（部分決済・買い増し・ドテン対応）。
// SBI の現物は空売りできないので、建玉を超える売りは「CSV の期間より前に買った（入庫した）株の売却」として
// 建値不明・損益 null のラウンドにする（ショートを建てない）。
// PAPER: 建玉 ID（positionId）ごとに 1 ラウンド。0 に戻った後にも約定がある・決済しすぎた等は警告付きで分割する。
// 損益は移動平均法（買い増しで建値を加重平均し、決済分は平均建値との差で実現）。

import Decimal from 'decimal.js';
import type { Side } from '@/lib/ingest/types';
import type { ExecForRound, ExecutionRole, RoundDraft } from './types';

const ZERO = new Decimal(0);

function signedQty(side: Side, qty: Decimal): Decimal {
  return side === 'BUY' ? qty : qty.neg();
}

/** その約定が建て（新規）側か。日付しか分からない約定を同じ日の中で並べるのに使う */
function isOpeningSide(e: Pick<ExecForRound, 'marginType' | 'side'>): boolean {
  if (e.marginType === 'MARGIN_SHORT') return e.side === 'SELL';
  return e.side === 'BUY'; // CASH / MARGIN_LONG
}

export type SortableExec = Pick<ExecForRound, 'id' | 'executedAt' | 'timePrecision' | 'marginType' | 'side' | 'seq'>;

/**
 * 並び順: 約定時刻 → （日付だけの約定は）建て → 決済 → 行順 → id。
 * SBI の約定履歴 CSV は時刻が無く、同じ日の中では「返済」行が「新規」行より先に並ぶ。
 * そのまま並べると建玉が一時的にマイナスになり、ラウンドが壊れるため、同日内は建てを先に置く。
 */
export function compareExecs(a: SortableExec, b: SortableExec): number {
  const ta = a.executedAt.getTime();
  const tb = b.executedAt.getTime();
  if (ta !== tb) return ta - tb;
  if (a.timePrecision === 'day' && b.timePrecision === 'day') {
    const ra = isOpeningSide(a) ? 0 : 1;
    const rb = isOpeningSide(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
  }
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type Acc = {
  draft: RoundDraft;
  pos: Decimal; // ロング正・ショート負
  avg: Decimal; // 残り建玉の平均建値
  entryNotional: Decimal;
  exitQty: Decimal;
  exitNotional: Decimal;
  realized: Decimal;
  fees: Decimal;
  priceMissing: boolean;
};

function open(e: ExecForRound, signed: Decimal, id: string, role: ExecutionRole, withFee: boolean): Acc {
  const price = e.price == null ? null : new Decimal(e.price);
  return {
    draft: {
      id,
      source: e.source,
      instrumentId: e.instrumentId,
      account: e.account,
      marginType: e.marginType,
      direction: signed.gt(0) ? 'LONG' : 'SHORT',
      openedAt: e.executedAt,
      closedAt: null,
      timePrecision: e.timePrecision,
      qtyOpened: '0',
      remainingQty: '0',
      avgEntryPrice: null,
      remainingAvgPrice: null,
      avgExitPrice: null,
      realizedPnl: null,
      fees: '0',
      netPnl: null,
      holdSeconds: null,
      status: 'OPEN',
      hasUnresolved: e.priceStatus !== 'CONFIRMED',
      executions: [{ id: e.id, role }],
      warnings: [],
    },
    pos: signed,
    avg: price ?? ZERO,
    entryNotional: price ? price.times(signed.abs()) : ZERO,
    exitQty: ZERO,
    exitNotional: ZERO,
    realized: ZERO,
    // ドテンで生まれたラウンドは、その約定の手数料を決済側のラウンドで計上済み
    fees: withFee ? new Decimal(e.fee) : ZERO,
    priceMissing: price == null,
  };
}

function finalize(a: Acc): RoundDraft {
  const d = a.draft;
  const qtyOpened = new Decimal(d.qtyOpened);
  d.remainingQty = a.pos.abs().toString();
  d.fees = a.fees.toString();
  if (a.priceMissing) {
    d.avgEntryPrice = null;
    d.remainingAvgPrice = null;
    d.avgExitPrice = null;
    d.realizedPnl = null;
    d.netPnl = null;
  } else {
    d.avgEntryPrice = qtyOpened.gt(0) ? a.entryNotional.div(qtyOpened).toString() : null;
    d.remainingAvgPrice = a.pos.isZero() ? null : a.avg.toString();
    d.avgExitPrice = a.exitQty.gt(0) ? a.exitNotional.div(a.exitQty).toString() : null;
    // 0 → 0 で閉じたラウンドは、移動平均の割り算を経由せず「決済代金 − 建て代金」で厳密に出す
    // （移動平均の途中計算は 1/3 などで割り切れず、-3359.99999999999998 のような端数が残るため）。
    // 未決済は移動平均の途中値なので小数 8 桁で丸める。
    const realized = a.pos.isZero()
      ? d.direction === 'LONG'
        ? a.exitNotional.minus(a.entryNotional)
        : a.entryNotional.minus(a.exitNotional)
      : a.realized.toDecimalPlaces(8);
    d.realizedPnl = realized.toString();
    d.netPnl = realized.minus(a.fees).toString();
  }
  d.status = d.closedAt ? 'CLOSED' : 'OPEN';
  return d;
}

export const PRIOR_HOLDING_SALE_WARNING = '期間外に買った株の売却（建値不明・損益は計算しない）';

/**
 * 建玉の無い現物売り（期間外に買った株の売却）を 1 本の決済済みラウンドにする。
 * 建値も保有期間も分からないので、損益・平均建値・保有時間は null。数量は売った株数。
 */
function priorHoldingSale(e: ExecForRound, qty: Decimal, id: string, role: ExecutionRole, withFee: boolean): RoundDraft {
  const d = open(e, qty, id, role, withFee).draft; // qty は正 → direction LONG
  d.qtyOpened = qty.toString();
  d.closedAt = e.executedAt;
  d.avgExitPrice = e.price == null ? null : new Decimal(e.price).toString();
  d.fees = withFee ? new Decimal(e.fee).toString() : '0';
  d.status = 'CLOSED';
  d.warnings.push(PRIOR_HOLDING_SALE_WARNING);
  return d;
}

/**
 * 1 グループ分の約定列（並べ替え済み）を 0 → 0 のサイクルに分ける。
 * idFor(先頭約定, 何本目のサイクルか, ドテンで生まれたか) で安定 ID を決める。
 * noShort: 売りでショートを建てない（SBI 現物）。建玉を超える売りは priorHoldingSale にする。
 */
function buildCycles(
  execs: ExecForRound[],
  idFor: (first: ExecForRound, index: number, flipped: boolean) => string,
  noShort = false,
): RoundDraft[] {
  const out: RoundDraft[] = [];
  let cur: Acc | null = null;

  for (const e of execs) {
    const qty = new Decimal(e.qty);
    if (qty.lte(0)) continue;
    const sQty = signedQty(e.side, qty);
    const price = e.price == null ? null : new Decimal(e.price);
    const fee = new Decimal(e.fee);

    if (!cur) {
      if (noShort && sQty.lt(0)) {
        out.push(priorHoldingSale(e, qty, idFor(e, out.length, false), 'CLOSE', true));
        continue;
      }
      cur = open(e, sQty, idFor(e, out.length, false), 'OPEN', true);
      cur.draft.qtyOpened = sQty.abs().toString();
      continue;
    }
    if (e.priceStatus !== 'CONFIRMED') cur.draft.hasUnresolved = true;
    if (price == null) cur.priceMissing = true;

    if (cur.pos.gt(0) === sQty.gt(0)) {
      // 買い増し: 平均建値を加重平均で更新
      const newPos = cur.pos.plus(sQty);
      if (price) {
        cur.avg = cur.pos.times(cur.avg).plus(sQty.times(price)).div(newPos);
        cur.entryNotional = cur.entryNotional.plus(price.times(sQty.abs()));
      }
      cur.pos = newPos;
      cur.fees = cur.fees.plus(fee);
      cur.draft.qtyOpened = new Decimal(cur.draft.qtyOpened).plus(sQty.abs()).toString();
      cur.draft.executions.push({ id: e.id, role: 'SCALE_IN' });
      continue;
    }

    // 反対売買: 決済（決済しすぎた分はドテンで逆方向の新ラウンド）
    const closingQty = Decimal.min(cur.pos.abs(), sQty.abs());
    if (price) {
      const perUnit = cur.pos.gt(0) ? price.minus(cur.avg) : cur.avg.minus(price);
      cur.realized = cur.realized.plus(perUnit.times(closingQty));
      cur.exitNotional = cur.exitNotional.plus(price.times(closingQty));
    }
    cur.exitQty = cur.exitQty.plus(closingQty);
    cur.fees = cur.fees.plus(fee);
    cur.draft.executions.push({ id: e.id, role: 'SCALE_OUT' });

    const closeSigned = cur.pos.gt(0) ? closingQty.neg() : closingQty;
    const remaining = sQty.minus(closeSigned);
    cur.pos = cur.pos.plus(closeSigned);

    if (cur.pos.isZero()) {
      cur.draft.closedAt = e.executedAt;
      cur.draft.holdSeconds = Math.max(
        0,
        Math.floor((e.executedAt.getTime() - cur.draft.openedAt.getTime()) / 1000),
      );
      cur.draft.executions[cur.draft.executions.length - 1].role = 'CLOSE';
      out.push(finalize(cur));
      cur = null;
      if (!remaining.isZero()) {
        if (noShort) {
          // 超過分はドテンと同じく 1 約定を 2 ラウンドに分け（-flip）、手数料は決済側で計上済み
          out.push(priorHoldingSale(e, remaining.abs(), idFor(e, out.length, true), 'FLIP', false));
        } else {
          cur = open(e, remaining, idFor(e, out.length, true), 'FLIP', false);
          cur.draft.qtyOpened = remaining.abs().toString();
        }
      }
    }
  }
  if (cur) out.push(finalize(cur));
  return out;
}

function sbiRoundId(first: ExecForRound, _index: number, flipped: boolean): string {
  const base = `sbi-${(first.dedupeHash ?? first.id).slice(0, 16)}`;
  return flipped ? `${base}-flip` : base;
}

/** SBI: 銘柄 × 口座 × 信用区分 ごとに 0 → 0 で区切る */
export function buildSbiRounds(execs: ExecForRound[]): RoundDraft[] {
  const groups = new Map<string, ExecForRound[]>();
  for (const e of execs) {
    const key = `${e.instrumentId}|${e.account}|${e.marginType}`;
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }
  const out: RoundDraft[] = [];
  for (const arr of groups.values()) {
    arr.sort(compareExecs);
    const cash = arr[0].source === 'SBI' && arr[0].marginType === 'CASH';
    out.push(...buildCycles(arr, sbiRoundId, cash));
  }
  return out.sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || (a.id < b.id ? -1 : 1));
}

/** PAPER: 建玉 ID ごとに 1 ラウンド。契約外の動き（0 に戻った後の約定・決済しすぎ）は分割して警告 */
export function buildPaperRounds(execs: ExecForRound[]): RoundDraft[] {
  const groups = new Map<string, ExecForRound[]>();
  for (const e of execs) {
    if (!e.positionId) throw new Error(`PAPER の約定に positionId が無い: ${e.id}`);
    const arr = groups.get(e.positionId);
    if (arr) arr.push(e);
    else groups.set(e.positionId, [e]);
  }
  const out: RoundDraft[] = [];
  for (const [positionId, arr] of groups) {
    arr.sort(compareExecs);
    const instruments = new Set(arr.map((e) => e.instrumentId));
    const cycles = buildCycles(arr, (_f, index) => (index === 0 ? positionId : `${positionId}#${index + 1}`));
    if (instruments.size > 1) {
      for (const c of cycles) c.warnings.push('同じ建玉 ID に複数の銘柄の約定がある');
    }
    if (cycles.length > 1) {
      for (const c of cycles) {
        c.warnings.push(`建玉 ID ${positionId} が 0 に戻った後にも約定があり、${cycles.length} 本に分割した`);
      }
    }
    out.push(...cycles);
  }
  return out.sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || (a.id < b.id ? -1 : 1));
}
