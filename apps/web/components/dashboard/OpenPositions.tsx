// 未クローズ Round (closedAt=null) を集めて、現在価格 (OHLC キャッシュ経由) と
// 評価損益 (native / JPY) を表示するダッシュボード用 async server component。
//
// 現在価格は fetchOhlc を直近 7 日 1d で叩き、最新 bar の close を採用。
// 失敗時は「価格取得失敗」と表示し、評価損益は出さない。

import { revalidatePath } from 'next/cache';
import { Decimal } from 'decimal.js';
import { prisma } from '@/lib/db';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import DeleteRoundButton from '@/components/dashboard/DeleteRoundButton';
import Pill from '@/components/ui/Pill';
import { fmtMoney } from '@/lib/format';
import { fetchOhlc } from '@/lib/ohlc/cache';
import { getFxRateToJpy } from '@/lib/fx';
import { distinctGroups, reaggregateGroups, type RoundGroupKey } from '@/lib/rounds/reaggregate';

// Round を構成する Execution を物理削除する。
// 削除後は reaggregate で同 (instrument, account, marginType) を再構築するので、
// 過去の Closed Round への影響も即座に反映される。
async function deleteRoundAction(formData: FormData): Promise<void> {
  'use server';
  const roundId = Number(formData.get('roundId') ?? 0);
  if (!roundId) return;
  const r = await prisma.round.findUnique({ where: { id: roundId } });
  if (!r) return;
  const execIds = (JSON.parse(r.executionsJson) as Array<{ id: number }>).map((x) => x.id);
  const groupKey: RoundGroupKey = {
    instrumentId: r.instrumentId,
    accountId: r.accountId,
    marginType: r.marginType as RoundGroupKey['marginType'],
  };
  if (execIds.length) {
    await prisma.execution.deleteMany({ where: { id: { in: execIds } } });
  }
  await reaggregateGroups(distinctGroups([groupKey]));
  revalidatePath('/');
}

type EnrichedRound = {
  id: number;
  brokerCode: string;
  symbol: string;
  // OPTION_US は "NVDA 26-05-15 500C" 表示、Equity は symbol そのまま
  displayLabel: string;
  instrumentName: string | null;
  instrumentKind: string;
  ccy: string;
  marginType: string;
  direction: 'BUY' | 'SELL';
  openedAt: Date;
  qtyOpened: string;
  avgEntryPrice: string;
  multiplier: number;
  currentPrice: number | null;
  priceSource: string;
  pnlNative: Decimal | null;
  pnlJpy: Decimal | null;
  holdDays: number;
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchCurrentPrice(
  instrument: {
    id: number;
    kind: string;
    symbol: string;
    occSymbol: string | null;
    ccy: string;
  },
): Promise<{ price: number | null; source: string }> {
  try {
    const market: 'JP' | 'US' = instrument.ccy === 'JPY' ? 'JP' : 'US';
    const occSymbol = instrument.kind === 'OPTION_US' ? instrument.occSymbol ?? undefined : undefined;
    const r = await fetchOhlc({
      instrumentId: instrument.id,
      market,
      symbol: instrument.symbol,
      occSymbol,
      timeframe: '1d',
      start: isoDaysAgo(10),
      end: isoDaysAgo(-1),
      // 評価損益は常に最新終値で出したいので、キャッシュ十分性判定を飛ばして末尾を取り直す
      forceRefreshTail: true,
    });
    if (!r.bars.length) return { price: null, source: r.source };
    return { price: r.bars[r.bars.length - 1].close, source: r.source };
  } catch (e) {
    return { price: null, source: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function loadOpenPositions(): Promise<EnrichedRound[]> {
  const rounds = await prisma.round.findMany({
    where: { closedAt: null },
    include: {
      instrument: true,
      account: { include: { broker: true } },
    },
    orderBy: { openedAt: 'desc' },
  });

  const today = new Date();
  return Promise.all(
    rounds.map(async (r) => {
      const { price, source } = await fetchCurrentPrice({
        id: r.instrument.id,
        kind: r.instrument.kind,
        symbol: r.instrument.symbol,
        occSymbol: r.instrument.occSymbol,
        ccy: r.instrument.ccy,
      });

      const multiplier =
        r.instrument.kind === 'OPTION_US'
          ? Number(r.instrument.multiplier?.toString() ?? '100')
          : 1;

      let pnlNative: Decimal | null = null;
      let pnlJpy: Decimal | null = null;
      if (price !== null) {
        const qty = new Decimal(r.qtyOpened.toString());
        const entry = new Decimal(r.avgEntryPrice.toString());
        const cur = new Decimal(price);
        const sign = r.direction === 'BUY' ? 1 : -1;
        pnlNative = cur.minus(entry).times(qty).times(multiplier).times(sign);
        const fxRate = await getFxRateToJpy(r.instrument.ccy, today);
        pnlJpy = pnlNative.times(new Decimal(fxRate));
      }

      const holdDays = Math.floor((today.getTime() - r.openedAt.getTime()) / 86400000);

      const displayLabel =
        r.instrument.kind === 'OPTION_US'
          ? `${r.instrument.symbol} ${r.instrument.expiry?.toISOString().slice(2, 10) ?? '?'} ${r.instrument.strike?.toString() ?? '?'}${r.instrument.right === 'CALL' ? 'C' : r.instrument.right === 'PUT' ? 'P' : '?'}`
          : r.instrument.symbol;

      return {
        id: r.id,
        brokerCode: r.account.broker.code,
        symbol: r.instrument.symbol,
        displayLabel,
        instrumentName: r.instrument.name,
        instrumentKind: r.instrument.kind,
        ccy: r.instrument.ccy,
        marginType: r.marginType,
        direction: r.direction,
        openedAt: r.openedAt,
        qtyOpened: r.qtyOpened.toString(),
        avgEntryPrice: r.avgEntryPrice.toString(),
        multiplier,
        currentPrice: price,
        priceSource: source,
        pnlNative,
        pnlJpy,
        holdDays,
      };
    }),
  );
}

function marginTypeLabel(m: string): string {
  if (m === 'MARGIN_LONG') return '信用買';
  if (m === 'MARGIN_SHORT') return '信用売';
  return '現物';
}

function tone(v: Decimal | null): string {
  if (!v) return 'text-[var(--muted)]';
  return v.gte(0) ? 'text-[var(--pos)]' : 'text-[var(--neg)]';
}

export default async function OpenPositions() {
  const positions = await loadOpenPositions();

  const totalPnlJpy = positions.reduce(
    (a, p) => (p.pnlJpy ? a.plus(p.pnlJpy) : a),
    new Decimal(0),
  );

  return (
    <Card>
      <CardHeader
        title="保有ポジション (未クローズ)"
        subtitle="評価損益は OHLC キャッシュの直近終値で算出。OPTION は乗数 100。"
        right={
          positions.length > 0 ? (
            <span className={tone(totalPnlJpy)}>
              合計 {fmtMoney(totalPnlJpy.toFixed(0), 'JPY')}
            </span>
          ) : null
        }
      />
      <CardBody className="px-0 py-0">
        {positions.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-[var(--muted)]">
            未クローズの Round はありません。
          </div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="border-b border-[var(--border)] text-left text-[11px] uppercase text-[var(--muted)]">
              <tr>
                <th className="px-4 py-2">口座</th>
                <th className="px-4 py-2">銘柄</th>
                <th className="px-4 py-2">区分</th>
                <th className="px-4 py-2 text-right">数量</th>
                <th className="px-4 py-2 text-right">平均建値</th>
                <th className="px-4 py-2 text-right">現在価格</th>
                <th className="px-4 py-2 text-right">評価損益</th>
                <th className="px-4 py-2 text-right">評価損益 (JPY)</th>
                <th className="px-4 py-2 text-right">保有日数</th>
                <th className="px-4 py-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.id} className="border-t border-[var(--border)]">
                  <td className="px-4 py-2">
                    <Pill tone="primary">{p.brokerCode}</Pill>
                  </td>
                  <td className="px-4 py-2">
                    <div className="font-medium font-mono">{p.displayLabel}</div>
                    {p.instrumentName && (
                      <div className="text-xs text-[var(--muted)]">{p.instrumentName}</div>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div>{marginTypeLabel(p.marginType)}</div>
                    <div className={`text-xs ${p.direction === 'BUY' ? 'text-[var(--pos)]' : 'text-[var(--neg)]'}`}>
                      {p.direction}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{p.qtyOpened}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {fmtMoney(p.avgEntryPrice, p.ccy)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {p.currentPrice !== null ? (
                      fmtMoney(p.currentPrice, p.ccy)
                    ) : (
                      <span className="text-xs text-[var(--muted)]" title={p.priceSource}>
                        価格取得失敗
                      </span>
                    )}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono ${tone(p.pnlNative)}`}>
                    {p.pnlNative ? fmtMoney(p.pnlNative.toFixed(2), p.ccy) : '—'}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono ${tone(p.pnlJpy)}`}>
                    {p.pnlJpy ? fmtMoney(p.pnlJpy.toFixed(0), 'JPY') : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">{p.holdDays}d</td>
                  <td className="px-4 py-2 text-right">
                    <form action={deleteRoundAction}>
                      <input type="hidden" name="roundId" value={p.id} />
                      <DeleteRoundButton label={p.displayLabel} />
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
}
