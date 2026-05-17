// 重複検出ハッシュ生成。
// 1) externalOrderId + externalFillId があればそれを最優先
// 2) externalOrderId のみあれば orderId + side + qty + price で複合
// 3) どちらも無ければ broker + accountExternalId + 銘柄自然キー + executedAt + side + marginType + qty + price
// 同じファイルを 2 度投入しても重複が検出されるよう、ハッシュは決定論的に。

import { createHash } from 'node:crypto';
import type { NormalizedExecution, NormalizedInstrument } from './types';

export function instrumentNaturalKey(inst: NormalizedInstrument): string {
  if (inst.kind === 'OPTION_US') {
    return [
      'OPT',
      inst.underlying,
      inst.expiry.toISOString().slice(0, 10),
      inst.strike,
      inst.right,
    ].join(':');
  }
  return [inst.kind, inst.symbol].join(':');
}

export function makeDedupeHash(e: NormalizedExecution): string {
  let parts: string[];
  if (e.externalOrderId && e.externalFillId) {
    parts = [e.broker, e.accountExternalId, 'OF', e.externalOrderId, e.externalFillId];
  } else if (e.externalOrderId) {
    parts = [
      e.broker,
      e.accountExternalId,
      'O',
      e.externalOrderId,
      e.side,
      e.qty,
      e.price,
    ];
  } else {
    parts = [
      e.broker,
      e.accountExternalId,
      'K',
      instrumentNaturalKey(e.instrument),
      e.executedAt.toISOString(),
      e.side,
      e.marginType,
      e.qty,
      e.price,
    ];
  }
  // 現引/現渡 のように 1 行を 2 Execution に分解した場合、片方は marginType が
  // 異なるため通常は衝突しないが、念のため roleSuffix を hash に混ぜて防御。
  if (e.roleSuffix) parts.push('R', e.roleSuffix);
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
