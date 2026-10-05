// Round 構築の入出力型（DB に依存しない純粋計算用）。数値は 10 進数文字列。

import type { MarginType, Side, TimePrecision } from '@/lib/ingest/types';

export type Source = 'PAPER' | 'SBI';
export type PriceStatus = 'CONFIRMED' | 'NEEDS_REVIEW' | 'UNRESOLVED';

export type ExecForRound = {
  id: string;
  source: Source;
  instrumentId: number;
  /** SBI の口座識別。ペーパーは "paper" */
  account: string;
  /** SBI のみ。ペーパーは null */
  marginType: MarginType | null;
  /** ペーパーのみ（建玉 ID）。SBI は null */
  positionId: string | null;
  executedAt: Date;
  timePrecision: TimePrecision;
  /** 同時刻・同日の並べ替え用（CSV の行順など） */
  seq: number;
  side: Side;
  qty: string;
  /** 未確定は null */
  price: string | null;
  fee: string;
  priceStatus: PriceStatus;
  /** SBI のみ。Round の安定 ID の元 */
  dedupeHash: string | null;
  /** PAPER のみ: 撮影画面の自動読取の銘柄（サイドカー auto.symbol）が発注銘柄と違うとき、その組 */
  screenSymbolMismatch?: { screen: string; order: string } | null;
};

export type ExecutionRole = 'OPEN' | 'SCALE_IN' | 'SCALE_OUT' | 'CLOSE' | 'FLIP';

export type RoundDraft = {
  /** 安定 ID（PAPER = positionId / SBI = 先頭約定の dedupeHash 由来） */
  id: string;
  source: Source;
  instrumentId: number;
  account: string;
  marginType: MarginType | null;
  direction: 'LONG' | 'SHORT';
  openedAt: Date;
  closedAt: Date | null;
  /** 建て始めの約定の時刻精度 */
  timePrecision: TimePrecision;
  /** 建て（新規 + 買い増し）の数量合計 */
  qtyOpened: string;
  /** 残数量（決済済みなら 0） */
  remainingQty: string;
  /** 建ての加重平均価格。価格の欠けた約定を含むと null */
  avgEntryPrice: string | null;
  /** 残り建玉の平均建値（移動平均法）。決済済み・価格欠けは null */
  remainingAvgPrice: string | null;
  /** 決済の加重平均価格。決済が無い・価格欠けは null */
  avgExitPrice: string | null;
  /** 実現損益（手数料前、移動平均法）。価格欠けは null */
  realizedPnl: string | null;
  fees: string;
  /** realizedPnl - fees。価格欠けは null */
  netPnl: string | null;
  holdSeconds: number | null;
  status: 'OPEN' | 'CLOSED';
  /** CONFIRMED 以外の価格を含む */
  hasUnresolved: boolean;
  executions: Array<{ id: string; role: ExecutionRole }>;
  warnings: string[];
};
