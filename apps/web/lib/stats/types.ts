// 統計の入出力型。お金は 10 進数文字列（decimal.js で計算）、比率は number。

export type StatsRound = {
  id: string;
  source: 'PAPER' | 'SBI';
  symbol: string;
  direction: 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED';
  /** UTC。時間帯別はこれの JST で振り分ける */
  openedAt: Date;
  closedAt: Date | null;
  /** day（日付だけ）は保有時間・時間帯別から除外する */
  timePrecision: 'ms' | 'day';
  /** 手数料込み。null は価格未確定で計算できない */
  netPnl: string | null;
  holdSeconds: number | null;
};

export type Bucket = {
  count: number;
  wins: number;
  winRate: number;
  netPnl: string;
};

export type Stats = {
  /** 集計に入った件数（決済済みで netPnl がある） */
  counted: number;
  /** 決済済みだが netPnl=null で外した件数 */
  excludedNoPnl: number;
  openCount: number;
  wins: number;
  losses: number;
  draws: number;
  /** wins / counted（引き分けは勝ちに数えない） */
  winRate: number | null;
  totalNetPnl: string;
  grossProfit: string;
  /** 総損失の絶対値（正） */
  grossLoss: string;
  avgWin: string | null;
  /** 負値 */
  avgLoss: string | null;
  /** avgWin / |avgLoss|。どちらかが無ければ null */
  payoffRatio: number | null;
  /** grossProfit / grossLoss。grossLoss=0 なら null */
  profitFactor: number | null;
  /** netPnl の平均 */
  expectancy: string | null;
  /** 決済済み累積 netPnl のピーク（0 起点）からの最大下落。正値 */
  maxDrawdown: string;
  /** day 精度を除く */
  avgHoldSeconds: number | null;
  maxWinStreak: number;
  maxLossStreak: number;
  currentStreak: { kind: 'WIN' | 'LOSS' | null; count: number };
  /** JST 30 分刻み（エントリー時刻）。slot は 'HH:MM' */
  byHalfHour: Array<{ slot: string } & Bucket>;
  bySymbol: Array<{ symbol: string } & Bucket>;
  equityCurve: Array<{ at: Date; roundId: string; netPnl: string; cumulative: string }>;
};
