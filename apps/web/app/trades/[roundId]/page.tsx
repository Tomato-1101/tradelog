import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { fmtDate, fmtDuration, fmtMoney, fmtNumber } from '@/lib/format';
import ReviewChart, { type ChartExecution } from '@/components/chart/ReviewChart';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import Pill from '@/components/ui/Pill';
import Stat from '@/components/ui/Stat';

export const dynamic = 'force-dynamic';

export default async function RoundDetailPage({
  params,
}: {
  params: Promise<{ roundId: string }>;
}) {
  const { roundId } = await params;
  const id = Number(roundId);
  if (!Number.isFinite(id)) notFound();

  const round = await prisma.round.findUnique({
    where: { id },
    include: {
      instrument: true,
      account: { include: { broker: true } },
    },
  });
  if (!round) notFound();

  const execIds: Array<{ id: number; role: string }> = JSON.parse(round.executionsJson);
  const execs = await prisma.execution.findMany({
    where: { id: { in: execIds.map((e) => e.id) } },
    orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
    include: { importBatch: { select: { source: true } } },
  });
  const roleById = new Map(execIds.map((e) => [e.id, e.role]));
  const pnl = Number(round.realizedPnl.toString());

  // SBI CSV は約定時刻が欠落しており UTC 00:00 (JST 09:00) 固定。
  // 分足は見れるようにするが、分足では取引マーカーを表示しない (時刻がデタラメになるため)。
  const hasSbiSource = execs.some((e) => e.importBatch?.source === 'sbi-csv');
  const hideMarkersOnIntraday = round.instrument.kind === 'EQUITY_JP' && hasSbiSource;

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <nav className="text-sm">
        <Link href="/trades" className="text-[var(--primary)] hover:underline">
          ← トレード一覧
        </Link>
      </nav>

      <div className="mt-3 flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {round.instrument.symbol}
        </h1>
        <span className="text-base text-[var(--muted)]">{round.instrument.name ?? round.instrument.kind}</span>
        <Pill tone="neutral">{round.account.broker.code}</Pill>
        {round.marginType !== 'CASH' && (
          <Pill tone="primary">{round.marginType === 'MARGIN_LONG' ? '信用買' : '信用売'}</Pill>
        )}
        <Pill tone={round.direction === 'BUY' ? 'pos' : 'neg'}>
          {round.direction === 'BUY' ? 'LONG' : 'SHORT'}
        </Pill>
      </div>

      <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card><CardBody><Stat label="数量" value={fmtNumber(round.qtyOpened.toString())} /></CardBody></Card>
        <Card><CardBody><Stat label="平均建値" value={fmtNumber(round.avgEntryPrice.toString())} /></CardBody></Card>
        <Card><CardBody><Stat label="実現損益" value={fmtMoney(round.realizedPnl.toString(), round.instrument.ccy)} tone={pnl >= 0 ? 'pos' : 'neg'} /></CardBody></Card>
        <Card><CardBody><Stat label="実現損益 (JPY)" value={fmtMoney(round.realizedPnlJpy.toString(), 'JPY')} tone={Number(round.realizedPnlJpy.toString()) >= 0 ? 'pos' : 'neg'} /></CardBody></Card>
        <Card><CardBody><Stat label="手数料計" value={fmtMoney(round.feesTotal.toString(), round.instrument.ccy)} /></CardBody></Card>
        <Card><CardBody><Stat label="オープン" value={fmtDate(round.openedAt)} size="sm" /></CardBody></Card>
        <Card><CardBody><Stat label="クローズ" value={fmtDate(round.closedAt)} size="sm" /></CardBody></Card>
        <Card><CardBody><Stat label="保有時間" value={fmtDuration(round.holdSeconds)} /></CardBody></Card>
      </section>

      <section className="mt-6">
        <Card>
          <CardHeader title="チャート" subtitle="エントリー/エグジット位置をマーカーで表示" />
          <CardBody>
            <ReviewChart
              instrumentId={round.instrumentId}
              symbol={round.instrument.symbol}
              ccy={round.instrument.ccy}
              kind={round.instrument.kind}
              occSymbol={round.instrument.occSymbol ?? null}
              defaultTimeframe="1d"
              hideMarkersOnIntraday={hideMarkersOnIntraday}
              executions={execs.map<ChartExecution>((e) => ({
                id: e.id,
                executedAt: e.executedAt.toISOString(),
                side: e.side,
                qty: e.qty.toString(),
                price: e.price.toString(),
                role: (roleById.get(e.id) ?? 'OPEN') as ChartExecution['role'],
              }))}
            />
          </CardBody>
        </Card>
      </section>

      <section className="mt-6">
        <Card>
          <CardHeader title={`構成 Execution`} subtitle={`${execs.length} 件`} />
          <CardBody className="px-0 py-0">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-left text-[11px] uppercase text-[var(--muted)]">
                  <tr>
                    <th className="px-4 py-2">ロール</th>
                    <th className="px-4 py-2">日時</th>
                    <th className="px-4 py-2">方向</th>
                    <th className="px-4 py-2 text-right">数量</th>
                    <th className="px-4 py-2 text-right">単価</th>
                    <th className="px-4 py-2 text-right">手数料</th>
                    <th className="px-4 py-2 text-right">税</th>
                    <th className="px-4 py-2">外部 ID</th>
                  </tr>
                </thead>
                <tbody>
                  {execs.map((e) => (
                    <tr key={e.id} className="border-t border-[var(--border)]">
                      <td className="px-4 py-2 text-xs">
                        <RoleBadge role={roleById.get(e.id) ?? '?'} />
                      </td>
                      <td className="px-4 py-2 text-xs">{fmtDate(e.executedAt)}</td>
                      <td className={`px-4 py-2 text-xs ${e.side === 'BUY' ? 'text-[var(--pos)]' : 'text-[var(--neg)]'}`}>
                        {e.side}
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtNumber(e.qty.toString())}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtNumber(e.price.toString())}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-[var(--muted)]">{fmtNumber(e.fee.toString())}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-[var(--muted)]">{fmtNumber(e.tax.toString())}</td>
                      <td className="px-4 py-2 text-xs text-[var(--muted)]">
                        {[e.externalOrderId, e.externalFillId].filter(Boolean).join(' / ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </section>
    </main>
  );
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    OPEN: 'bg-[var(--pos-bg)] text-[var(--pos)]',
    SCALE_IN: 'bg-[var(--primary-soft)] text-[var(--primary)]',
    SCALE_OUT: 'bg-[var(--primary-soft)] text-[var(--primary)]',
    CLOSE: 'bg-[var(--neg-bg)] text-[var(--neg)]',
    FLIP: 'bg-[var(--neg-bg)] text-[var(--neg)]',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${colors[role] ?? 'bg-[var(--surface-muted)] text-[var(--muted-strong)]'}`}>
      {role}
    </span>
  );
}
