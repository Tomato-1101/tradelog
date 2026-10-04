// 取り込み直後の NormalizedExecution を builder の入力に変換する（DB を通さない検証用。ゴールデンテストで使う）。

import Decimal from 'decimal.js';
import { makeDedupeHash } from './dedupe';
import type { NormalizedExecution } from './types';
import type { ExecForRound } from '@/lib/rounds/types';

export function normalizedToExecForRound(e: NormalizedExecution, instrumentId: number): ExecForRound {
  const hash = makeDedupeHash(e);
  return {
    id: hash,
    source: 'SBI',
    instrumentId,
    account: e.accountExternalId,
    marginType: e.marginType,
    positionId: null,
    executedAt: e.executedAt,
    timePrecision: e.timePrecision,
    seq: e.seq,
    side: e.side,
    qty: e.qty,
    price: e.price,
    // DB の Execution.fee と同じく手数料 + 税
    fee: new Decimal(e.fee).plus(e.tax).toString(),
    priceStatus: 'CONFIRMED',
    dedupeHash: hash,
  };
}
