// Round/集計画面で共通的に使うフィルタ (ブローカー / 商品種別 / 取引区分)。
// URL の searchParams からフィルタを取り出し、Prisma の where に流せる形に整える。
// ページ遷移しても保持できるよう、cookie に最後に選んだ値を保存する。
// URL > cookie の優先度でマージ (URL で指定があればそれを使い、無ければ cookie で補う)。

import { cookies } from 'next/headers';

export type BrokerCode = 'SBI' | 'MOOMOO';
export type InstrumentKind = 'EQUITY_JP' | 'EQUITY_US' | 'OPTION_US';
export type MarginType = 'CASH' | 'MARGIN_LONG' | 'MARGIN_SHORT';

export type RoundFilter = {
  broker?: BrokerCode;
  instKind?: InstrumentKind;
  marginType?: MarginType;
};

const VALID_BROKER = new Set<BrokerCode>(['SBI', 'MOOMOO']);
const VALID_KIND = new Set<InstrumentKind>(['EQUITY_JP', 'EQUITY_US', 'OPTION_US']);
const VALID_MARGIN = new Set<MarginType>(['CASH', 'MARGIN_LONG', 'MARGIN_SHORT']);

export const ROUND_FILTER_COOKIE_KEYS = {
  broker: 'rf_broker',
  instKind: 'rf_instKind',
  marginType: 'rf_marginType',
} as const;

function pickBroker(v: string | undefined): BrokerCode | undefined {
  return v && VALID_BROKER.has(v as BrokerCode) ? (v as BrokerCode) : undefined;
}
function pickKind(v: string | undefined): InstrumentKind | undefined {
  return v && VALID_KIND.has(v as InstrumentKind) ? (v as InstrumentKind) : undefined;
}
function pickMargin(v: string | undefined): MarginType | undefined {
  return v && VALID_MARGIN.has(v as MarginType) ? (v as MarginType) : undefined;
}

export function parseRoundFilter(sp: {
  broker?: string;
  instKind?: string;
  marginType?: string;
}): RoundFilter {
  return {
    broker: pickBroker(sp.broker),
    instKind: pickKind(sp.instKind),
    marginType: pickMargin(sp.marginType),
  };
}

// URL に来た searchParams + cookie をマージしたフィルタを返す。URL が優先。
// Server Component から await して使う。クッキー書き込みは server action 側で行う。
export async function getEffectiveRoundFilter(sp: {
  broker?: string;
  instKind?: string;
  marginType?: string;
}): Promise<RoundFilter> {
  const fromUrl = parseRoundFilter(sp);
  const c = await cookies();
  return {
    broker: fromUrl.broker ?? pickBroker(c.get(ROUND_FILTER_COOKIE_KEYS.broker)?.value),
    instKind: fromUrl.instKind ?? pickKind(c.get(ROUND_FILTER_COOKIE_KEYS.instKind)?.value),
    marginType: fromUrl.marginType ?? pickMargin(c.get(ROUND_FILTER_COOKIE_KEYS.marginType)?.value),
  };
}

/** Prisma の Round.findMany({ where }) に AND マージできる where 断片を返す */
export function roundFilterToWhere(f: RoundFilter): Record<string, unknown> {
  const w: Record<string, unknown> = {};
  if (f.broker) w.account = { broker: { code: f.broker } };
  if (f.instKind) w.instrument = { kind: f.instKind };
  if (f.marginType) w.marginType = f.marginType;
  return w;
}

export function hasAnyFilter(f: RoundFilter): boolean {
  return Boolean(f.broker || f.instKind || f.marginType);
}
