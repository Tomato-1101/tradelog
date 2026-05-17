// Round builder の入出力型。Prisma の Execution と Round を仲介する。
// DB に保存する前の純粋計算用の構造体。

import type { MarginType, Side } from '@/lib/ingest/types';

/** builder に渡す Execution の最小情報 */
export type ExecForRound = {
  id: number;
  instrumentId: number;
  accountId: number;
  marginType: MarginType;
  executedAt: Date;
  side: Side;
  /** Decimal 文字列 (絶対値) */
  qty: string;
  /** Decimal 文字列 (instrument の取引通貨ベース) */
  price: string;
  /** Decimal 文字列 (取引通貨ベース) */
  fee: string;
  /** Decimal 文字列 (取引通貨ベース) */
  tax: string;
  /** 取引日の USDJPY 中値 (instrument.ccy が JPY なら "1") */
  fxRateToJpy: string;
  /**
   * 契約乗数 (Decimal 文字列)。米株オプションは 100、現物は 1。
   * 同一グループ内では同じ値 (instrument 単位)。
   */
  multiplier?: string;
};

export type ExecutionRole = 'OPEN' | 'SCALE_IN' | 'SCALE_OUT' | 'CLOSE' | 'FLIP';

export type RoundDraft = {
  instrumentId: number;
  accountId: number;
  marginType: MarginType;
  direction: Side; // BUY = ロング, SELL = ショート
  openedAt: Date;
  closedAt: Date | null;
  /** ラウンド内の方向側 (open + scale-in) の数量合計 (絶対値) */
  qtyOpened: string;
  /** 加重平均エントリー価格 (open + scale-in 加重) */
  avgEntryPrice: string;
  /** 実現損益 (instrument.ccy 建て、手数料前) */
  realizedPnl: string;
  /** 実現損益 (JPY 換算、手数料前、各約定の fxRateToJpy で按分) */
  realizedPnlJpy: string;
  /** 手数料 + 税金の合計 (取引通貨ベース) */
  feesTotal: string;
  /** holdSeconds: closedAt - openedAt 秒 */
  holdSeconds: number | null;
  /** 構成 Execution の id + ロール */
  executions: Array<{ id: number; role: ExecutionRole }>;
};
