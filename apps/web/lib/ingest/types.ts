// 取り込み層で扱う中間型。Prisma の Execution / Instrument に近いが、
// DB 書き込み前なので id を持たず文字列ベース。Decimal 演算は decimal.js を使う。

export type BrokerCode = 'SBI' | 'MOOMOO';
export type Side = 'BUY' | 'SELL';
export type MarginType = 'CASH' | 'MARGIN_LONG' | 'MARGIN_SHORT';
export type InstrumentKind = 'EQUITY_JP' | 'EQUITY_US' | 'OPTION_US';
export type OptionRight = 'CALL' | 'PUT';

export type NormalizedInstrument =
  | {
      kind: 'EQUITY_JP' | 'EQUITY_US';
      symbol: string;
      exchange?: string;
      name?: string;
      ccy: 'JPY' | 'USD';
    }
  | {
      kind: 'OPTION_US';
      symbol: string;     // 表示用シンボル (underlying と同じことが多い)
      underlying: string;
      expiry: Date;       // 満期日 (UTC 00:00)
      strike: string;     // Decimal 文字列
      right: OptionRight;
      multiplier: number; // 通常 100
      occSymbol: string;  // 例: "AAPL  250515C00136000"
      ccy: 'USD';
      exchange?: string;
      name?: string;
    };

export type NormalizedExecution = {
  broker: BrokerCode;
  accountExternalId: string;
  instrument: NormalizedInstrument;
  executedAt: Date;       // UTC
  side: Side;
  marginType: MarginType;
  qty: string;            // Decimal 文字列 (枚数 / 株数、絶対値)
  price: string;          // Decimal 文字列 (取引通貨ベース)
  fee: string;            // Decimal 文字列 (取引通貨ベース)
  tax: string;            // Decimal 文字列 (取引通貨ベース)
  externalOrderId?: string;
  externalFillId?: string;
  // 1 つの CSV 行から複数 Execution に分解されるケース (現引/現渡 など) の
  // 役割タグ。dedupeHash の衝突を避けるためと、後段デバッグ用。
  roleSuffix?: string;
  raw: Record<string, unknown>;
};

export type ParseWarning = {
  line: number;
  code: string;
  message: string;
};

export type ParseResult = {
  executions: NormalizedExecution[];
  warnings: ParseWarning[];
};
