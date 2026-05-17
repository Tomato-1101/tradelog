import { Suspense } from 'react';
import { prisma } from '@/lib/db';
import { computeStats } from '@/lib/stats/compute';
import type { StatsRound } from '@/lib/stats/types';
import { fmtDuration, fmtMoney, fmtPercent, fmtRatio } from '@/lib/format';
import EquityCurve from '@/components/stats/EquityCurve';
import MonthlyBars from '@/components/stats/MonthlyBars';
import DailyCalendar from '@/components/stats/DailyCalendar';
import MoomooAccountSummary from '@/components/dashboard/MoomooAccountSummary';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import Stat from '@/components/ui/Stat';
import PeriodFilter from '@/components/ui/PeriodFilter';
import { parsePeriodParams, periodToRange } from '@/lib/period';

export const dynamic = 'force-dynamic';

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const period = parsePeriodParams(sp);
  const range = periodToRange(period);
  const closedAtFilter =
    range.gte || range.lte
      ? { closedAt: { not: null, ...(range.gte ? { gte: range.gte } : {}), ...(range.lte ? { lte: range.lte } : {}) } }
      : {};
  const rows = await prisma.round.findMany({
    where: closedAtFilter,
    orderBy: { openedAt: 'asc' },
    include: { instrument: true },
  });

  const rounds: StatsRound[] = rows.map((r) => ({
    id: r.id,
    instrumentId: r.instrumentId,
    symbol: r.instrument.symbol,
    instrumentName: r.instrument.name,
    ccy: r.instrument.ccy,
    marginType: r.marginType,
    direction: r.direction,
    openedAt: r.openedAt.toISOString(),
    closedAt: r.closedAt?.toISOString() ?? null,
    qtyOpened: r.qtyOpened.toString(),
    avgEntryPrice: r.avgEntryPrice.toString(),
    realizedPnl: r.realizedPnl.toString(),
    realizedPnlJpy: r.realizedPnlJpy.toString(),
    feesTotal: r.feesTotal.toString(),
    holdSeconds: r.holdSeconds,
  }));

  const s = computeStats(rounds);
  const k = s.kpis;

  const streakStr =
    k.currentWinStreak > 0
      ? `+${k.currentWinStreak}`
      : k.currentLossStreak > 0
      ? `-${k.currentLossStreak}`
      : '0';

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">統計ダッシュボード</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          全 {k.totalRounds} ラウンド (クローズ済 {k.closedRounds}) · JPY 換算
        </p>
      </div>

      <div className="mt-4">
        <Suspense fallback={null}>
          <PeriodFilter storageKey="statsPeriod" />
        </Suspense>
      </div>

      <Suspense fallback={null}>
        <section className="mt-6">
          <MoomooAccountSummary />
        </section>
      </Suspense>

      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardBody>
            <Stat label="総合損益" value={fmtMoney(k.totalPnlJpy, 'JPY')} tone={k.totalPnlJpy >= 0 ? 'pos' : 'neg'} sub="手数料前" size="lg" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="ネット (手数料控除)" value={fmtMoney(k.netPnlJpy, 'JPY')} tone={k.netPnlJpy >= 0 ? 'pos' : 'neg'} sub={`手数料計 ${fmtMoney(k.totalFeesJpy, 'JPY')}`} size="lg" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="勝率" value={fmtPercent(k.winRate)} sub={`${k.wins}勝 ${k.losses}敗 ${k.flats}引分`} size="lg" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="ストリーク" value={streakStr} sub={`最大連勝 ${k.maxWinStreak} / 連敗 ${k.maxLossStreak}`} size="lg" />
          </CardBody>
        </Card>
      </section>

      <section className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card><CardBody><Stat label="ペイオフレシオ" value={fmtRatio(k.payoffRatio)} sub="平均勝ち / |平均負け|" /></CardBody></Card>
        <Card><CardBody><Stat label="プロフィットファクター" value={fmtRatio(k.profitFactor)} sub="総勝ち / |総負け|" /></CardBody></Card>
        <Card><CardBody><Stat label="期待値 / ラウンド" value={fmtMoney(k.expectancyJpy, 'JPY')} tone={k.expectancyJpy >= 0 ? 'pos' : 'neg'} /></CardBody></Card>
        <Card><CardBody><Stat label="最大DD" value={fmtMoney(k.maxDrawdownJpy, 'JPY')} tone="neg" sub={fmtPercent(k.maxDrawdownPct)} /></CardBody></Card>
        <Card><CardBody><Stat label="平均勝ち" value={fmtMoney(k.avgWin, 'JPY')} tone="pos" /></CardBody></Card>
        <Card><CardBody><Stat label="平均負け" value={fmtMoney(k.avgLoss, 'JPY')} tone="neg" /></CardBody></Card>
        <Card><CardBody><Stat label="最大勝ち" value={fmtMoney(k.maxWin, 'JPY')} tone="pos" /></CardBody></Card>
        <Card><CardBody><Stat label="最大負け" value={fmtMoney(k.maxLoss, 'JPY')} tone="neg" /></CardBody></Card>
        <Card><CardBody><Stat label="平均保有時間" value={fmtDuration(k.avgHoldSeconds)} sub="全クローズ済" /></CardBody></Card>
        <Card><CardBody><Stat label="勝ち平均保有" value={fmtDuration(k.avgHoldSecondsWin)} tone="pos" /></CardBody></Card>
        <Card><CardBody><Stat label="負け平均保有" value={fmtDuration(k.avgHoldSecondsLoss)} tone="neg" /></CardBody></Card>
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="累積エクイティカーブ" subtitle="手数料控除後 (ネット)" />
          <CardBody>
            <EquityCurve points={s.equity} width={700} height={260} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="月次損益" />
          <CardBody>
            <MonthlyBars months={s.monthly} width={340} height={260} />
          </CardBody>
        </Card>
      </section>

      <section className="mt-6">
        <Card>
          <CardHeader title="日次損益カレンダー" subtitle="JST 日次 · 緑=利益 / 赤=損失。セルの濃さが PnL の絶対値強度" />
          <CardBody>
            <DailyCalendar days={s.daily} />
          </CardBody>
        </Card>
      </section>

      <section className="mt-6">
        <Card>
          <CardHeader title="銘柄別損益" />
          <CardBody className="px-0 py-0">
            <table className="min-w-full text-sm">
              <thead className="border-b border-[var(--border)] text-left text-[11px] uppercase text-[var(--muted)]">
                <tr>
                  <th className="px-5 py-2">銘柄</th>
                  <th className="px-5 py-2">名称</th>
                  <th className="px-5 py-2 text-right">ラウンド数</th>
                  <th className="px-5 py-2 text-right">損益 (JPY)</th>
                </tr>
              </thead>
              <tbody>
                {s.bySymbol.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-6 text-center text-[var(--muted)]">
                      クローズ済ラウンドなし
                    </td>
                  </tr>
                )}
                {s.bySymbol.map((row) => (
                  <tr key={row.symbol} className="border-t border-[var(--border)]">
                    <td className="px-5 py-2 font-mono">{row.symbol}</td>
                    <td className="px-5 py-2 text-[var(--muted-strong)]">{row.instrumentName ?? '—'}</td>
                    <td className="px-5 py-2 text-right">{row.rounds}</td>
                    <td className={`px-5 py-2 text-right font-mono tabular-nums ${row.pnlJpy >= 0 ? 'text-[var(--pos)]' : 'text-[var(--neg)]'}`}>
                      {fmtMoney(row.pnlJpy, 'JPY')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      </section>
    </main>
  );
}
