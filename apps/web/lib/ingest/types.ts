// SBI CSV 取り込み層の中間型。DB 書き込み前なので id を持たず、数値は 10 進数文字列。

export type Side = 'BUY' | 'SELL';
export type MarginType = 'CASH' | 'MARGIN_LONG' | 'MARGIN_SHORT';
export type TimePrecision = 'ms' | 'day';

/** 東証の個別銘柄（v1 は日本株だけを扱う） */
export type NormalizedInstrument = {
  symbol: string;
  exchange?: string;
  name?: string;
};

export type NormalizedExecution = {
  broker: 'SBI';
  accountExternalId: string;
  instrument: NormalizedInstrument;
  /** UTC。timePrecision=day のときは JST 当日 09:00（= UTC 00:00）で、日付だけが意味を持つ */
  executedAt: Date;
  /** 約定履歴照会・当日約定の CSV は時刻が無いので day。時刻列がある旧形式だけ ms */
  timePrecision: TimePrecision;
  side: Side;
  marginType: MarginType;
  qty: string;
  price: string;
  fee: string;
  tax: string;
  externalOrderId?: string;
  externalFillId?: string;
  // 1 つの CSV 行から複数 Execution に分解されるケース（現引/現渡）や、同じ自然キーの行を
  // 区別するためのタグ（pnl=… / seq=N）。dedupeHash に混ぜる。
  roleSuffix?: string;
  /** 信用返済の行だけ: CSV の「決済損益」（SBI が計算した手数料・諸経費込みの損益）。それ以外は null */
  brokerPnl: string | null;
  /** CSV 内の出現順（0 起点、分解した行は同じ値） */
  seq: number;
  raw: Record<string, unknown>;
};

export type ParseWarning = {
  line: number;
  code: string;
  message: string;
};

// third-savefile = 約定履歴照会（SaveFile_*.csv）/ new-daily = 注文一覧_当日約定 / legacy = 時刻列ありの旧形式
export type SbiCsvFormat = 'third-savefile' | 'new-daily' | 'legacy' | 'unknown';

export type ParseResult = {
  executions: NormalizedExecution[];
  warnings: ParseWarning[];
  format: SbiCsvFormat;
  earliestDate: Date | null;
  latestDate: Date | null;
};
