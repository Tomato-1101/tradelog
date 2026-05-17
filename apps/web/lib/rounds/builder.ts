// ポジションラウンド集計。
// 「銘柄 (instrumentId) + 口座 (accountId) + 信用区分 (marginType)」の 3 つ組単位で、
// ポジションが 0 から積まれて再び 0 に戻るまでを 1 ラウンドとする。
// ロング (符号 +) / ショート (符号 -) を符号付き Decimal でトラッキングし、
// 部分決済・増し玉・反対売買 (flip / overfill) に対応。
// 詳細仕様は plan ファイル §5 を参照。

import Decimal from 'decimal.js';
import type { Side } from '@/lib/ingest/types';
import type { ExecForRound, ExecutionRole, RoundDraft } from './types';

const ZERO = new Decimal(0);

function signedQty(side: Side, qty: Decimal): Decimal {
  return side === 'BUY' ? qty : qty.neg();
}

function newDraft(e: ExecForRound, firstSigned: Decimal): RoundDraft {
  return {
    instrumentId: e.instrumentId,
    accountId: e.accountId,
    marginType: e.marginType,
    direction: firstSigned.gt(0) ? 'BUY' : 'SELL',
    openedAt: e.executedAt,
    closedAt: null,
    qtyOpened: firstSigned.abs().toString(),
    avgEntryPrice: e.price,
    realizedPnl: '0',
    realizedPnlJpy: '0',
    feesTotal: addStr(e.fee, e.tax),
    holdSeconds: null,
    executions: [],
  };
}

function addStr(a: string, b: string): string {
  return new Decimal(a).plus(b).toString();
}

function holdSecondsBetween(openedAt: Date, closedAt: Date): number {
  return Math.max(0, Math.floor((closedAt.getTime() - openedAt.getTime()) / 1000));
}

/**
 * 1 グループ分 (instrumentId + accountId + marginType) の Execution 列から
 * Round の列を生成する。入力は executedAt + id 昇順を前提。
 */
export function buildRoundsForGroup(execs: ExecForRound[]): RoundDraft[] {
  const out: RoundDraft[] = [];
  let cur: RoundDraft | null = null;
  let pos = ZERO;       // ロング正、ショート負
  let avgPx = ZERO;
  // 契約乗数。米株オプションは 100、現物・米株は 1。同一グループ内では一定。
  const multiplier = new Decimal(execs[0]?.multiplier ?? '1');

  const pushRole = (role: ExecutionRole, id: number) => {
    cur!.executions.push({ id, role });
  };

  for (const e of execs) {
    const qty = new Decimal(e.qty);
    if (qty.lte(0)) continue; // 数量 0 はスキップ

    const sQty = signedQty(e.side, qty);
    const price = new Decimal(e.price);
    const fxRate = new Decimal(e.fxRateToJpy);
    const feeSum = new Decimal(e.fee).plus(e.tax);

    if (pos.isZero()) {
      cur = newDraft(e, sQty);
      pos = sQty;
      avgPx = price;
      pushRole('OPEN', e.id);
      continue;
    }

    const sameDirection = pos.gt(0) === sQty.gt(0);

    if (sameDirection) {
      // 増し玉: 加重平均更新
      const newPos = pos.plus(sQty);
      avgPx = pos
        .times(avgPx)
        .plus(sQty.times(price))
        .div(newPos);
      pos = newPos;
      pushRole('SCALE_IN', e.id);
      cur!.qtyOpened = new Decimal(cur!.qtyOpened).plus(sQty.abs()).toString();
      cur!.feesTotal = new Decimal(cur!.feesTotal).plus(feeSum).toString();
      cur!.avgEntryPrice = avgPx.toString();
      continue;
    }

    // 反対売買: クローズ or オーバーフィル
    const closingQty = Decimal.min(pos.abs(), sQty.abs());
    const pnlPerUnit = pos.gt(0)
      ? price.minus(avgPx)        // ロングを売る → (売値 - 平均取得)
      : avgPx.minus(price);       // ショートを買い戻す → (平均建値 - 買い戻し値)
    // multiplier は 1 契約あたりの原資産単位数 (オプション=100)。fee/tax は対価建てそのままなので掛けない。
    const pnl = pnlPerUnit.times(closingQty).times(multiplier);

    cur!.realizedPnl = new Decimal(cur!.realizedPnl).plus(pnl).toString();
    cur!.realizedPnlJpy = new Decimal(cur!.realizedPnlJpy)
      .plus(pnl.times(fxRate))
      .toString();
    cur!.feesTotal = new Decimal(cur!.feesTotal).plus(feeSum).toString();
    pushRole('SCALE_OUT', e.id);

    // closeSign は pos を 0 に近づける向きの符号付き量。
    // ロングをクローズする (pos>0, sQty<0) なら closeSign = -closingQty。
    // ショートをクローズする (pos<0, sQty>0) なら closeSign = +closingQty。
    const closeSign = pos.gt(0) ? closingQty.neg() : closingQty;
    // remaining は「sQty のうちクローズに使われなかった残り」を符号付きで。
    // sQty は反対方向 (= -closeSign 方向) なので、sQty から closeSign 分を差し引く。
    const remaining = sQty.minus(closeSign);
    pos = pos.plus(closeSign);

    if (pos.isZero()) {
      cur!.closedAt = e.executedAt;
      cur!.holdSeconds = holdSecondsBetween(cur!.openedAt, e.executedAt);
      // 最後にプッシュした SCALE_OUT を CLOSE に格上げ
      cur!.executions[cur!.executions.length - 1].role = 'CLOSE';
      out.push(cur!);
      cur = null;
      avgPx = ZERO;

      if (!remaining.isZero()) {
        // オーバーフィル: 残りを逆方向の新ラウンドにする
        cur = newDraft(e, remaining);
        pos = remaining;
        avgPx = price;
        // FLIP の場合 newDraft が feeSum 加算済みなのを取り消し、後段で扱わない
        // (反対売買時にすでに加算済み)
        cur.feesTotal = '0';
        cur.executions.push({ id: e.id, role: 'FLIP' });
      }
    }
  }

  if (cur) {
    out.push(cur);
  }
  return out;
}

/**
 * 並べ替えと境界グルーピングを行ったうえで builder を回す。
 * 入力は単一銘柄に限らない複数の execution。
 */
export function buildRoundsFromExecutions(execs: ExecForRound[]): RoundDraft[] {
  const groups = new Map<string, ExecForRound[]>();
  for (const e of execs) {
    const key = `${e.instrumentId}|${e.accountId}|${e.marginType}`;
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }
  const out: RoundDraft[] = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      const da = a.executedAt.getTime();
      const db = b.executedAt.getTime();
      if (da !== db) return da - db;
      return a.id - b.id;
    });
    out.push(...buildRoundsForGroup(arr));
  }
  // 出力は openedAt 昇順で安定化
  out.sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  return out;
}
