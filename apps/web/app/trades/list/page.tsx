// 旧 Trades 一覧 (Round 単位テーブル)。新「銘柄まとめ表示」(/trades) からリンクで遷移する退避ページ。
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { fmtDate, fmtDuration, fmtMoney, fmtNumber } from '@/lib/format';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import Pill from '@/components/ui/Pill';

export const dynamic = 'force-dynamic';

type SortKey =
  | 'openedAt-desc'
  | 'openedAt-asc'
  | 'closedAt-desc'
  | 'pnl-desc'
  | 'pnl-asc'
  | 'pnlJpy-desc'
  | 'pnlJpy-asc'
  | 'hold-desc'
  | 'hold-asc';

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'openedAt-desc', label: 'オープン日時 (新しい順)' },
  { key: 'openedAt-asc', label: 'オープン日時 (古い順)' },
  { key: 'closedAt-desc', label: 'クローズ日時 (新しい順)' },
  { key: 'pnl-desc', label: '実現損益 (取引通貨) 大きい順' },
  { key: 'pnl-asc', label: '実現損益 (取引通貨) 小さい順' },
  { key: 'pnlJpy-desc', label: '実現損益 (JPY) 大きい順' },
  { key: 'pnlJpy-asc', label: '実現損益 (JPY) 小さい順' },
  { key: 'hold-desc', label: '保有時間 (長い順)' },
  { key: 'hold-asc', label: '保有時間 (短い順)' },
];

function parseSort(s: string | undefined): SortKey {
  return (SORT_OPTIONS.find((o) => o.key === s)?.key ?? 'openedAt-desc') as SortKey;
}

function orderByFromSort(sort: SortKey) {
  switch (sort) {
    case 'openedAt-desc': return { openedAt: 'desc' as const };
    case 'openedAt-asc': return { openedAt: 'asc' as const };
    case 'closedAt-desc': return { closedAt: 'desc' as const };
    case 'pnl-desc': return { realizedPnl: 'desc' as const };
    case 'pnl-asc': return { realizedPnl: 'asc' as const };
    case 'pnlJpy-desc': return { realizedPnlJpy: 'desc' as const };
    case 'pnlJpy-asc': return { realizedPnlJpy: 'asc' as const };
    case 'hold-desc': return { holdSeconds: 'desc' as const };
    case 'hold-asc': return { holdSeconds: 'asc' as const };
  }
}

export default async function TradesListPage({
  searchParams,
}: {
  searchParams: Promise<{
    sort?: string;
    broker?: string;
    symbol?: string;
    openOnly?: string;
    page?: string;
  }>;
}) {
  const sp = await searchParams;
  const sort = parseSort(sp.sort);
  const broker = sp.broker?.trim() || undefined;
  const symbol = sp.symbol?.trim() || undefined;
  const openOnly = sp.openOnly === '1';
  const pageSize = 50;
  const page = Math.max(1, Number(sp.page) || 1);

  const where = {
    ...(openOnly ? { closedAt: null } : {}),
    ...(symbol ? { instrument: { symbol: { contains: symbol } } } : {}),
    ...(broker
      ? { account: { broker: { code: broker as 'SBI' | 'MOOMOO' } } }
      : {}),
  };

  const [rounds, total] = await Promise.all([
    prisma.round.findMany({
      where,
      orderBy: orderByFromSort(sort),
      include: {
        instrument: true,
        account: { include: { broker: true } },
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.round.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <nav className="text-sm">
        <Link href="/trades" className="text-[var(--primary)] hover:underline">
          ← 銘柄まとめ表示に戻る
        </Link>
      </nav>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">トレード一覧 (旧)</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            ポジションラウンド単位 · {total.toLocaleString()} 件中 {Math.min(pageSize, rounds.length)} 件表示
          </p>
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader title="フィルタ" />
        <CardBody>
          <form className="grid grid-cols-1 gap-3 md:grid-cols-5">
            <label className="text-xs font-medium text-[var(--muted)]">
              ブローカー
              <select
                name="broker"
                defaultValue={broker ?? ''}
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
              >
                <option value="">すべて</option>
                <option value="SBI">SBI</option>
                <option value="MOOMOO">MOOMOO</option>
              </select>
            </label>
            <label className="text-xs font-medium text-[var(--muted)]">
              銘柄 (部分一致)
              <input
                name="symbol"
                defaultValue={symbol ?? ''}
                placeholder="7203, AAPL..."
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-[var(--muted)]">
              並び順
              <select
                name="sort"
                defaultValue={sort}
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="openOnly" value="1" defaultChecked={openOnly} />
                未クローズのみ
              </label>
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
              >
                適用
              </button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardBody className="px-0 py-0">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-left text-[11px] uppercase text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-2">銘柄</th>
                  <th className="px-4 py-2">区分</th>
                  <th className="px-4 py-2">方向</th>
                  <th className="px-4 py-2 text-right">数量</th>
                  <th className="px-4 py-2 text-right">平均建値</th>
                  <th className="px-4 py-2 text-right">実現損益</th>
                  <th className="px-4 py-2 text-right">JPY 換算</th>
                  <th className="px-4 py-2 text-right">手数料計</th>
                  <th className="px-4 py-2">オープン</th>
                  <th className="px-4 py-2">クローズ</th>
                  <th className="px-4 py-2 text-right">保有</th>
                </tr>
              </thead>
              <tbody>
                {rounds.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="px-4 py-8 text-center text-[var(--muted)]">
                      該当ラウンドがありません。
                      <Link href="/import" className="text-[var(--primary)] hover:underline">
                        取り込み
                      </Link>
                      から CSV を投入してください。
                    </td>
                  </tr>
                ) : (
                  rounds.map((r) => {
                    const pnl = Number(r.realizedPnl.toString());
                    const pnlCls =
                      pnl > 0 ? 'text-[var(--pos)]' : pnl < 0 ? 'text-[var(--neg)]' : '';
                    return (
                      <tr key={r.id} className="border-t border-[var(--border)] hover:bg-[var(--surface-muted)]">
                        <td className="px-4 py-2">
                          <Link href={`/trades/${r.id}`} className="font-medium text-[var(--primary)] hover:underline">
                            {r.instrument.symbol}
                          </Link>
                          <div className="text-xs text-[var(--muted)]">{r.instrument.name ?? r.instrument.kind}</div>
                        </td>
                        <td className="px-4 py-2 text-xs">
                          <span className="text-[var(--muted-strong)]">{r.account.broker.code}</span>
                          {r.marginType !== 'CASH' && (
                            <span className="ml-1">
                              <Pill tone="primary">{r.marginType === 'MARGIN_LONG' ? '信用買' : '信用売'}</Pill>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          <span className={r.direction === 'BUY' ? 'text-[var(--pos)]' : 'text-[var(--neg)]'}>
                            {r.direction === 'BUY' ? 'LONG' : 'SHORT'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtNumber(r.qtyOpened.toString())}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtNumber(r.avgEntryPrice.toString())}</td>
                        <td className={`px-4 py-2 text-right font-mono tabular-nums ${pnlCls}`}>
                          {fmtMoney(r.realizedPnl.toString(), r.instrument.ccy)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtMoney(r.realizedPnlJpy.toString(), 'JPY')}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-[var(--muted)]">{fmtMoney(r.feesTotal.toString(), r.instrument.ccy)}</td>
                        <td className="px-4 py-2 text-xs text-[var(--muted-strong)]">{fmtDate(r.openedAt)}</td>
                        <td className="px-4 py-2 text-xs text-[var(--muted-strong)]">{fmtDate(r.closedAt)}</td>
                        <td className="px-4 py-2 text-right text-xs">{fmtDuration(r.holdSeconds)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-[var(--muted)]">ページ {page} / {totalPages}</span>
          <div className="space-x-2">
            {page > 1 && (
              <Link
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1 hover:bg-[var(--surface-muted)]"
                href={`/trades/list?${buildQuery(sp, page - 1)}`}
              >
                ← 前
              </Link>
            )}
            {page < totalPages && (
              <Link
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1 hover:bg-[var(--surface-muted)]"
                href={`/trades/list?${buildQuery(sp, page + 1)}`}
              >
                次 →
              </Link>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function buildQuery(sp: Record<string, string | undefined>, page: number): string {
  const usp = new URLSearchParams();
  if (sp.sort) usp.set('sort', sp.sort);
  if (sp.broker) usp.set('broker', sp.broker);
  if (sp.symbol) usp.set('symbol', sp.symbol);
  if (sp.openOnly) usp.set('openOnly', sp.openOnly);
  usp.set('page', String(page));
  return usp.toString();
}
