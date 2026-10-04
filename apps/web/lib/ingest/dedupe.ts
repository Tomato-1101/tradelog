// 重複検出ハッシュ。同じファイルを 2 度取り込んでも重複が検出されるよう決定論的に作る。
// 1) 注文番号 + 約定番号があれば最優先
// 2) 注文番号だけなら 注文番号 + 売買 + 数量 + 価格
// 3) どちらも無ければ 口座 + 銘柄 + 約定日時 + 売買 + 信用区分 + 数量 + 価格
// roleSuffix（現引/現渡の分解・pnl=・seq=）があれば混ぜる。

import { createHash } from 'node:crypto';
import type { NormalizedExecution, NormalizedInstrument } from './types';

export function instrumentNaturalKey(inst: NormalizedInstrument): string {
  // 旧版と同じ形（EQUITY_JP:7203）を保つ
  return ['EQUITY_JP', inst.symbol].join(':');
}

export function makeDedupeHash(e: NormalizedExecution): string {
  let parts: string[];
  if (e.externalOrderId && e.externalFillId) {
    parts = [e.broker, e.accountExternalId, 'OF', e.externalOrderId, e.externalFillId];
  } else if (e.externalOrderId) {
    parts = [e.broker, e.accountExternalId, 'O', e.externalOrderId, e.side, e.qty, e.price];
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
  if (e.roleSuffix) parts.push('R', e.roleSuffix);
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
