// 統計計算の入出力型。Round (Prisma) を JSON 化したものを入力とする。

export type StatsRound = {
  id: number;
  instrumentId: number;
  symbol: string;
  instrumentName: string | null;
  ccy: string;
  marginType: 'CASH' | 'MARGIN_LONG' | 'MARGIN_SHORT';
  direction: 'BUY' | 'SELL';
  openedAt: string;
  closedAt: string | null;
  qtyOpened: string;
  avgEntryPrice: string;
  realizedPnl: string;
  realizedPnlJpy: string;
  feesTotal: string;
  holdSeconds: number | null;
};

export type Kpis = {
  totalRounds: number;
  closedRounds: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number;        // 0..1
  totalPnlJpy: number;
  totalFeesJpy: number;   // 概算 (ccy 別 fees を fxRate で換算しない簡易版)
  netPnlJpy: number;
  avgWin: number;
  avgLoss: number;        // 負値 (損失なので負)
  maxWin: number;
  maxLoss: number;
  expectancyJpy: number;
  payoffRatio: number;    // avgWin / |avgLoss|
  profitFactor: number;   // sumWin / |sumLoss|
  maxDrawdownJpy: number;
  maxDrawdownPct: number; // 0..1
  avgHoldSeconds: number | null;
  avgHoldSecondsWin: number | null;
  avgHoldSecondsLoss: number | null;
  currentWinStreak: number;
  currentLossStreak: number;
  maxWinStreak: number;
  maxLossStreak: number;
};

export type EquityPoint = {
  t: string;        // ISO closedAt
  cum: number;      // 累積 PnL (JPY, 手数料前)
  cumNet: number;   // 累積 net (PnL - fees)
};

export type MonthlyPnl = {
  ym: string;       // yyyy-mm
  pnlJpy: number;
  rounds: number;
};

export type SymbolPnl = {
  symbol: string;
  instrumentName: string | null;
  rounds: number;
  pnlJpy: number;
};

export type DailyPnl = {
  date: string;     // yyyy-mm-dd (closedAt の JST 日)
  pnlJpy: number;
  rounds: number;
};

export type Stats = {
  kpis: Kpis;
  equity: EquityPoint[];
  monthly: MonthlyPnl[];
  bySymbol: SymbolPnl[];
  daily: DailyPnl[];
};
