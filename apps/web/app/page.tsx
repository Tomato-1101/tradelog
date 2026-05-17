import { Suspense } from 'react';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { computeStats } from '@/lib/stats/compute';
import type { StatsRound } from '@/lib/stats/types';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import Stat from '@/components/ui/Stat';
import Pill from '@/components/ui/Pill';
import EquityCurve from '@/components/stats/EquityCurve';
import MonthlyBars from '@/components/stats/MonthlyBars';
import PeriodFilter from '@/components/ui/PeriodFilter';
import { fmtMoney, fmtPercent } from '@/lib/format';
import { parsePeriodParams, periodToRange } from '@/lib/period';

export const dynamic = 'force-dynamic';

async function loadRounds(range: { gte?: Date; lte?: Date }): Promise<StatsRound[]> {
  const closedAtFilter =
    range.gte || range.lte
      ? { closedAt: { not: null, ...(range.gte ? { gte: range.gte } : {}), ...(range.lte ? { lte: range.lte } : {}) } }
      : {};
  const rows = await prisma.round.findMany({
    where: closedAtFilter,
    orderBy: { openedAt: 'asc' },
    include: { instrument: true },
  });
  return rows.map((r) => ({
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
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const period = parsePeriodParams(sp);
  const range = periodToRange(period);
  const rounds = await loadRounds(range);
  const s = computeStats(rounds);
  const k = s.kpis;

  // ノーカン (hidden=true) のバッチは表示集計から除外。
  const [executions, batches, instruments] = await Promise.all([
    prisma.execution.count({ where: { importBatch: { hidden: false } } }),
    prisma.importBatch.count({ where: { hidden: false } }),
    prisma.instrument.count(),
  ]);

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">ダッシュボード</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            全 {k.totalRounds} ラウンド (クローズ済 {k.closedRounds})・JPY 換算
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Pill tone="neutral">Executions {executions}</Pill>
          <Pill tone="neutral">Instruments {instruments}</Pill>
          <Pill tone="neutral">Batches {batches}</Pill>
        </div>
      </div>

      <div className="mt-4">
        <Suspense fallback={null}>
          <PeriodFilter storageKey="dashboardPeriod" />
        </Suspense>
      </div>

      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card className="md:col-span-2">
          <CardBody>
            <Stat
              label="総合損益 (JPY)"
              value={fmtMoney(k.totalPnlJpy, 'JPY')}
              tone={k.totalPnlJpy >= 0 ? 'pos' : 'neg'}
              sub={`勝率 ${fmtPercent(k.winRate)} · ${k.wins}勝 ${k.losses}敗 ${k.flats}引分`}
              size="lg"
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="期待値 / ラウンド"
              value={fmtMoney(k.expectancyJpy, 'JPY')}
              tone={k.expectancyJpy >= 0 ? 'pos' : 'neg'}
              sub={`PF ${Number.isFinite(k.profitFactor) ? k.profitFactor.toFixed(2) : '∞'}`}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="最大DD"
              value={fmtMoney(k.maxDrawdownJpy, 'JPY')}
              tone="neg"
              sub={fmtPercent(k.maxDrawdownPct)}
            />
          </CardBody>
        </Card>
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="累積エクイティカーブ" subtitle="手数料控除後 (ネット)" />
          <CardBody>
            <EquityCurve points={s.equity} width={680} height={240} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="月次損益" />
          <CardBody>
            <MonthlyBars months={s.monthly} width={340} height={240} />
          </CardBody>
        </Card>
      </section>

      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="銘柄別損益 (Top 5)" />
          <CardBody className="px-0 py-0">
            <table className="min-w-full text-sm">
              <thead className="border-b border-[var(--border)] text-left text-[11px] uppercase text-[var(--muted)]">
                <tr>
                  <th className="px-5 py-2">銘柄</th>
                  <th className="px-5 py-2 text-right">ラウンド</th>
                  <th className="px-5 py-2 text-right">損益</th>
                </tr>
              </thead>
              <tbody>
                {s.bySymbol.slice(0, 5).map((r) => (
                  <tr key={r.symbol} className="border-t border-[var(--border)]">
                    <td className="px-5 py-2 font-mono">{r.symbol}</td>
                    <td className="px-5 py-2 text-right">{r.rounds}</td>
                    <td className={`px-5 py-2 text-right font-mono tabular-nums ${r.pnlJpy >= 0 ? 'text-[var(--pos)]' : 'text-[var(--neg)]'}`}>
                      {fmtMoney(r.pnlJpy, 'JPY')}
                    </td>
                  </tr>
                ))}
                {s.bySymbol.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-5 py-6 text-center text-[var(--muted)]">
                      クローズ済ラウンドなし
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="border-t border-[var(--border)] px-5 py-2 text-right text-xs">
              <Link href="/stats" className="text-[var(--primary)] hover:underline">
                統計を全部見る →
              </Link>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="アクション" />
          <CardBody className="space-y-2">
            <ActionLink href="/import" label="取引履歴を取り込む" desc="SBI CSV / moomoo API" />
            <ActionLink href="/trades" label="トレード一覧を見る" desc="ラウンド単位でフィルタ・ソート" />
            <ActionLink href="/stats" label="統計を分析する" desc="勝率・PF・カレンダー・月次" />
            <ActionLink href="/api/healthz" label="ヘルスチェック" desc="DB / sidecar / OpenD" />
          </CardBody>
        </Card>
      </section>
    </main>
  );
}

function ActionLink({ href, label, desc }: { href: string; label: string; desc: string }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 transition-colors hover:border-[var(--primary)] hover:bg-[var(--primary-soft)]"
    >
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-[var(--muted)]">{desc}</div>
      </div>
      <span className="text-[var(--primary)]">→</span>
    </Link>
  );
}
