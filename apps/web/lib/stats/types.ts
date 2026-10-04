// 統計計算の入出力型。Round (Prisma) を JSON 化したものを入力とする。

export type StatsRound = {
  id: number;
  instrumentId: number;
  symbol: string;
  instrumentName: string | null;
  // 集約キー区別用。OPTION_US は同じ underlying でも expiry/strike/right が違えば別物として扱う。
  instrumentKind: 'EQUITY_JP' | 'EQUITY_US' | 'OPTION_US';
  expiry: string | null;
  strike: string | null;
  right: 'CALL' | 'PUT' | null;
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
  feesTotalJpy: string;
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
  totalFeesJpy: number;   // 各約定の fxRateToJpy で按分済み (Round.feesTotalJpy の合計)
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
  // 集約キー (OPTION_US は "NVDA|2026-05-15|500|CALL" のように合成、Equity は symbol)
  key: string;
  // 表示用ラベル (OPTION_US は "NVDA 26-05-15 500C")
  label: string;
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
