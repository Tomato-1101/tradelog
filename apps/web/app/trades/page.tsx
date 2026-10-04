// Trades タブ: 銘柄まとめ表示。
// 左に銘柄リスト (期間内のクローズ済ラウンドを (kind, symbol) で集約・並び替え可)、
// 右に選択銘柄のチャート + カスタマイズ可能 KPI パネル。
// 旧 Round 単位一覧は /trades/list に退避。

import { Suspense } from 'react';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import Pill from '@/components/ui/Pill';
import PeriodFilter from '@/components/ui/PeriodFilter';
import ReviewChart, { type ChartExecution } from '@/components/chart/ReviewChart';
import SymbolKpiPanel, { type SymbolKpis } from '@/components/trades/SymbolKpiPanel';
import { isSbiCsvSource } from '@/lib/ingest/source';
import { parsePeriodParams, periodToRange } from '@/lib/period';
import { computeStats } from '@/lib/stats/compute';
import type { StatsRound } from '@/lib/stats/types';
import { fmtMoney, fmtPercent } from '@/lib/format';

export const dynamic = 'force-dynamic';

type SortKey = 'pnl' | 'winRate' | 'count' | 'symbol';
const SORT_LABELS: Record<SortKey, string> = {
  pnl: '損益 (JPY) 大きい順',
  winRate: '勝率',
  count: '取引件数',
  symbol: '銘柄名',
};
function parseSortKey(s: string | undefined): SortKey {
  if (s === 'pnl' || s === 'winRate' || s === 'count' || s === 'symbol') return s;
  return 'pnl';
}

type Bucket = {
  // OPTION_US は `${kind}|${symbol}|${expiry}|${strike}|${right}`、
  // Equity は `${kind}|${symbol}`。同じ underlying でも option の契約条件が違えば別 bucket。
  key: string;
  kind: 'EQUITY_JP' | 'EQUITY_US' | 'OPTION_US';
  symbol: string;
  label: string; // 表示用 (OPTION は "NVDA 26-05-15 500C")
  instrumentName: string | null;
  ccy: string;
  rounds: number;
  wins: number;
  losses: number;
  totalPnl: number;
  totalPnlJpy: number;
  bestInstrumentId: number; // 最も Round 数が多い instrumentId (チャート表示用)
  optionContracts: number; // OPTION_US の Round 数 (Pill 表示用)
};

type RoundWithInst = {
  id: number;
  instrumentId: number;
  marginType: 'CASH' | 'MARGIN_LONG' | 'MARGIN_SHORT';
  direction: 'BUY' | 'SELL';
  openedAt: Date;
  closedAt: Date | null;
  qtyOpened: { toString(): string };
  avgEntryPrice: { toString(): string };
  realizedPnl: { toString(): string };
  realizedPnlJpy: { toString(): string };
  feesTotal: { toString(): string };
  feesTotalJpy: { toString(): string };
  holdSeconds: number | null;
  executionsJson: string;
  instrument: {
    id: number;
    kind: 'EQUITY_JP' | 'EQUITY_US' | 'OPTION_US';
    symbol: string;
    name: string | null;
    ccy: string;
    expiry: Date | null;
    strike: { toString(): string } | null;
    right: 'CALL' | 'PUT' | null;
  };
};

function bucketKey(r: RoundWithInst): string {
  if (r.instrument.kind === 'OPTION_US') {
    const exp = r.instrument.expiry?.toISOString().slice(0, 10) ?? '?';
    const strike = r.instrument.strike?.toString() ?? '?';
    return `${r.instrument.kind}|${r.instrument.symbol}|${exp}|${strike}|${r.instrument.right ?? '?'}`;
  }
  return `${r.instrument.kind}|${r.instrument.symbol}`;
}

function bucketLabel(r: RoundWithInst): string {
  if (r.instrument.kind === 'OPTION_US') {
    const exp = r.instrument.expiry?.toISOString().slice(2, 10) ?? '?';
    const strike = r.instrument.strike?.toString() ?? '?';
    const rt = r.instrument.right === 'CALL' ? 'C' : r.instrument.right === 'PUT' ? 'P' : '?';
    return `${r.instrument.symbol} ${exp} ${strike}${rt}`;
  }
  return r.instrument.symbol;
}

function bucketize(rounds: RoundWithInst[]): Bucket[] {
  const map = new Map<string, Bucket & { _instrumentCount: Map<number, number> }>();
  for (const r of rounds) {
    const key = bucketKey(r);
    let b = map.get(key);
    if (!b) {
      b = {
        key,
        kind: r.instrument.kind,
        symbol: r.instrument.symbol,
        label: bucketLabel(r),
        instrumentName: r.instrument.name,
        ccy: r.instrument.ccy,
        rounds: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        totalPnlJpy: 0,
        bestInstrumentId: r.instrument.id,
        optionContracts: 0,
        _instrumentCount: new Map(),
      };
      map.set(key, b);
    }
    b.rounds++;
    const pnl = Number(r.realizedPnl.toString());
    const pnlJpy = Number(r.realizedPnlJpy.toString());
    b.totalPnl += pnl;
    b.totalPnlJpy += pnlJpy;
    if (pnlJpy > 0) b.wins++;
    else if (pnlJpy < 0) b.losses++;
    if (r.instrument.kind === 'OPTION_US') b.optionContracts++;
    b._instrumentCount.set(r.instrument.id, (b._instrumentCount.get(r.instrument.id) ?? 0) + 1);
  }
  // 最多 instrumentId を確定
  return Array.from(map.values()).map((b) => {
    let best = b.bestInstrumentId;
    let bestCount = -1;
    for (const [id, c] of b._instrumentCount) {
      if (c > bestCount) {
        best = id;
        bestCount = c;
      }
    }
    return { ...b, bestInstrumentId: best };
  });
}

function sortBuckets(items: Bucket[], sort: SortKey): Bucket[] {
  const a = [...items];
  switch (sort) {
    case 'pnl':
      return a.sort((x, y) => y.totalPnlJpy - x.totalPnlJpy);
    case 'winRate':
      return a.sort((x, y) => {
        const wx = x.rounds ? x.wins / x.rounds : 0;
        const wy = y.rounds ? y.wins / y.rounds : 0;
        return wy - wx;
      });
    case 'count':
      return a.sort((x, y) => y.rounds - x.rounds);
    case 'symbol':
      return a.sort((x, y) => x.symbol.localeCompare(y.symbol));
  }
}

function toStatsRound(r: RoundWithInst): StatsRound {
  return {
    id: r.id,
    instrumentId: r.instrumentId,
    symbol: r.instrument.symbol,
    instrumentName: r.instrument.name,
    instrumentKind: r.instrument.kind as 'EQUITY_JP' | 'EQUITY_US' | 'OPTION_US',
    expiry: r.instrument.expiry?.toISOString() ?? null,
    strike: r.instrument.strike?.toString() ?? null,
    right: (r.instrument.right ?? null) as 'CALL' | 'PUT' | null,
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
    feesTotalJpy: r.feesTotalJpy.toString(),
    holdSeconds: r.holdSeconds,
  };
}

function buildSymbolKpis(rounds: RoundWithInst[]): SymbolKpis {
  const stats = computeStats(rounds.map(toStatsRound));
  const k = stats.kpis;
  return {
    totalPnlJpy: k.totalPnlJpy,
    netPnlJpy: k.netPnlJpy,
    totalFeesJpy: k.totalFeesJpy,
    winRate: k.winRate,
    wins: k.wins,
    losses: k.losses,
    flats: k.flats,
    closedRounds: k.closedRounds,
    avgWin: k.avgWin,
    avgLoss: k.avgLoss,
    maxWin: k.maxWin,
    maxLoss: k.maxLoss,
    expectancyJpy: k.expectancyJpy,
    profitFactor: k.profitFactor,
    payoffRatio: k.payoffRatio,
    maxDrawdownJpy: k.maxDrawdownJpy,
    maxDrawdownPct: k.maxDrawdownPct,
    avgHoldSeconds: k.avgHoldSeconds,
    maxWinStreak: k.maxWinStreak,
    maxLossStreak: k.maxLossStreak,
  };
}

function sparkPath(rounds: RoundWithInst[], width: number, height: number): string {
  const closed = rounds
    .filter((r) => r.closedAt)
    .sort((a, b) => (a.closedAt!.getTime() - b.closedAt!.getTime()));
  if (closed.length === 0) return '';
  const cums: number[] = [];
  let cum = 0;
  for (const r of closed) {
    cum += Number(r.realizedPnlJpy.toString());
    cums.push(cum);
  }
  const minY = Math.min(0, ...cums);
  const maxY = Math.max(0, ...cums);
  const range = maxY - minY || 1;
  return cums
    .map((v, i) => {
      const x = (i / Math.max(1, cums.length - 1)) * width;
      const y = height - ((v - minY) / range) * height;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function buildLink(sp: Record<string, string | undefined>, overrides: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...overrides })) {
    if (v !== undefined && v !== '') usp.set(k, v);
    else usp.delete(k);
  }
  const s = usp.toString();
  return s ? `/trades?${s}` : '/trades';
}

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<{
    preset?: string;
    from?: string;
    to?: string;
    // 旧形式 (symbol+kind) は互換維持のため残置。OPTION_US は instId を優先採用。
    symbol?: string;
    kind?: string;
    instId?: string;
    sort?: string;
    broker?: string;
    instKind?: string;
    marginType?: string;
  }>;
}) {
  const sp = await searchParams;
  const period = parsePeriodParams(sp);
  const range = periodToRange(period);
  const sort = parseSortKey(sp.sort);

  // 絞り込みフィルタ (ブローカー / 商品種別 / 取引区分)。すべて Round.findMany の where に流す。
  const VALID_KIND = new Set(['EQUITY_JP', 'EQUITY_US', 'OPTION_US']);
  const VALID_MARGIN = new Set(['CASH', 'MARGIN_LONG', 'MARGIN_SHORT']);
  const VALID_BROKER = new Set(['SBI', 'MOOMOO']);
  const brokerFilter = sp.broker && VALID_BROKER.has(sp.broker) ? (sp.broker as 'SBI' | 'MOOMOO') : undefined;
  const instKindFilter = sp.instKind && VALID_KIND.has(sp.instKind)
    ? (sp.instKind as 'EQUITY_JP' | 'EQUITY_US' | 'OPTION_US')
    : undefined;
  const marginFilter = sp.marginType && VALID_MARGIN.has(sp.marginType)
    ? (sp.marginType as 'CASH' | 'MARGIN_LONG' | 'MARGIN_SHORT')
    : undefined;

  // 期間内のクローズ済 Round を取得
  const closedAtFilter = {
    closedAt: { not: null, ...(range.gte ? { gte: range.gte } : {}), ...(range.lte ? { lte: range.lte } : {}) },
    ...(brokerFilter ? { account: { broker: { code: brokerFilter } } } : {}),
    ...(instKindFilter ? { instrument: { kind: instKindFilter } } : {}),
    ...(marginFilter ? { marginType: marginFilter } : {}),
  };
  const rounds = (await prisma.round.findMany({
    where: closedAtFilter,
    orderBy: { openedAt: 'asc' },
    include: { instrument: true },
  })) as RoundWithInst[];

  const buckets = sortBuckets(bucketize(rounds), sort);

  // 選択銘柄。instId があれば最優先 (OPTION_US で同 underlying の別契約を区別するため)。
  // なければ旧形式 (kind|symbol) でフォールバック。
  const selected =
    (sp.instId && buckets.find((b) => b.bestInstrumentId === Number(sp.instId))) ||
    (sp.symbol && sp.kind && buckets.find((b) => b.key === `${sp.kind}|${sp.symbol}`)) ||
    buckets[0];

  // 選択銘柄の全 Round と全 Execution を取得 (チャート用)
  let executions: Array<{
    id: number;
    executedAt: Date;
    side: 'BUY' | 'SELL';
    qty: { toString(): string };
    price: { toString(): string };
    role: string;
    importBatchSource: string | null;
  }> = [];
  let selectedRounds: RoundWithInst[] = [];
  if (selected) {
    selectedRounds = rounds.filter((r) => bucketKey(r) === selected.key);
    // OPTION_US は同 symbol の中に複数 strike/expiry の Instrument がぶら下がる。
    // チャートは bestInstrumentId 1 つを描画するので、混在防止に Execution 集合も
    // bestInstrumentId に紐づくラウンドだけに絞る (他 strike の点が別 OHLC スケールに浮かんで見える問題対策)。
    const roundsForChart =
      selected.kind === 'OPTION_US'
        ? selectedRounds.filter((r) => r.instrumentId === selected.bestInstrumentId)
        : selectedRounds;
    const execRoleById = new Map<number, string>();
    for (const r of roundsForChart) {
      try {
        const arr = JSON.parse(r.executionsJson) as Array<{ id: number; role: string }>;
        for (const e of arr) execRoleById.set(e.id, e.role);
      } catch {
        /* ignore */
      }
    }
    const execIds = Array.from(execRoleById.keys());
    if (execIds.length) {
      const rows = await prisma.execution.findMany({
        where: { id: { in: execIds } },
        orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
        include: { importBatch: { select: { source: true } } },
      });
      executions = rows.map((e) => ({
        id: e.id,
        executedAt: e.executedAt,
        side: e.side,
        qty: e.qty,
        price: e.price,
        role: execRoleById.get(e.id) ?? 'OPEN',
        importBatchSource: e.importBatch?.source ?? null,
      }));
    }
  }

  const hasSbiSource = executions.some((e) => isSbiCsvSource(e.importBatchSource));
  const hideMarkersOnIntraday = selected?.kind === 'EQUITY_JP' && hasSbiSource;

  // OPTION_US の場合、サーバー API に渡す OCC コードを引く (チャート本体取得用)
  let selectedOccSymbol: string | null = null;
  if (selected && selected.kind === 'OPTION_US') {
    const inst = await prisma.instrument.findUnique({
      where: { id: selected.bestInstrumentId },
      select: { occSymbol: true },
    });
    selectedOccSymbol = inst?.occSymbol ?? null;
  }

  const kpis = selected ? buildSymbolKpis(selectedRounds) : null;

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">トレード</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            銘柄まとめ表示 · {buckets.length} 銘柄 / {rounds.length} ラウンド
          </p>
        </div>
        <Link href="/trades/list" className="text-xs text-[var(--primary)] hover:underline">
          旧テーブル表示 →
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Suspense fallback={null}>
          <PeriodFilter storageKey="tradesPeriod" />
        </Suspense>
        {/*
          GET フォームで /trades に絞り込みを送り直す。フィルタを切り替えると銘柄選択
          (symbol, kind) は維持しない方が自然なので、hidden で preset/from/to/sort
          だけ引き継いで symbol/kind は捨てる。
        */}
        <form className="flex flex-wrap items-end gap-2 text-xs">
          {sp.preset && <input type="hidden" name="preset" value={sp.preset} />}
          {sp.from && <input type="hidden" name="from" value={sp.from} />}
          {sp.to && <input type="hidden" name="to" value={sp.to} />}
          {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
          <label className="font-medium text-[var(--muted)]">
            <span className="block">ブローカー</span>
            <select
              name="broker"
              defaultValue={brokerFilter ?? ''}
              className="mt-0.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
            >
              <option value="">すべて</option>
              <option value="SBI">SBI</option>
              <option value="MOOMOO">MOOMOO</option>
            </select>
          </label>
          <label className="font-medium text-[var(--muted)]">
            <span className="block">商品種別</span>
            <select
              name="instKind"
              defaultValue={instKindFilter ?? ''}
              className="mt-0.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
            >
              <option value="">すべて</option>
              <option value="EQUITY_JP">日本株</option>
              <option value="EQUITY_US">米株</option>
              <option value="OPTION_US">米株オプション</option>
            </select>
          </label>
          <label className="font-medium text-[var(--muted)]">
            <span className="block">取引区分</span>
            <select
              name="marginType"
              defaultValue={marginFilter ?? ''}
              className="mt-0.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
            >
              <option value="">すべて</option>
              <option value="CASH">現物</option>
              <option value="MARGIN_LONG">信用買</option>
              <option value="MARGIN_SHORT">信用売</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90"
          >
            絞り込み
          </button>
          {(brokerFilter || instKindFilter || marginFilter) && (
            <Link
              href={buildLink(sp, { broker: '', instKind: '', marginType: '', symbol: '', kind: '' })}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs hover:bg-[var(--surface-muted)]"
            >
              クリア
            </Link>
          )}
        </form>
        <div className="ml-auto flex items-center gap-1 text-xs text-[var(--muted)]">
          並び替え:
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <Link
              key={k}
              href={buildLink(sp, { sort: k })}
              className={`rounded-full px-2.5 py-1 transition ${
                sort === k
                  ? 'bg-[var(--primary-soft)] text-[var(--primary)] font-medium'
                  : 'text-[var(--muted-strong)] hover:bg-[var(--surface-muted)]'
              }`}
            >
              {SORT_LABELS[k]}
            </Link>
          ))}
        </div>
      </div>

      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
        <aside className="lg:col-span-4">
          <Card>
            <CardHeader title="銘柄" subtitle={`${buckets.length} 件`} />
            <CardBody className="px-0 py-0">
              {buckets.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-[var(--muted)]">
                  選択期間内にクローズ済みのトレードがありません。
                </p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {buckets.map((b) => {
                    const isSelected = b.key === selected?.key;
                    const winRate = b.rounds ? b.wins / b.rounds : 0;
                    const pnlClass = b.totalPnlJpy >= 0 ? 'text-[var(--pos)]' : 'text-[var(--neg)]';
                    return (
                      <li key={b.key}>
                        <Link
                          href={buildLink(sp, {
                            symbol: '',
                            kind: '',
                            instId: String(b.bestInstrumentId),
                          })}
                          className={`flex flex-col gap-1 px-4 py-3 transition ${
                            isSelected
                              ? 'bg-[var(--primary-soft)]'
                              : 'hover:bg-[var(--surface-muted)]'
                          }`}
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="flex items-baseline gap-2">
                              <span className="font-mono font-medium text-sm">{b.label}</span>
                              {b.kind === 'OPTION_US' && <Pill tone="primary">opt</Pill>}
                              {b.kind === 'EQUITY_US' && <Pill tone="neutral">US</Pill>}
                              {b.kind === 'EQUITY_JP' && <Pill tone="neutral">JP</Pill>}
                            </div>
                            <span className={`font-mono tabular-nums text-sm ${pnlClass}`}>
                              {fmtMoney(b.totalPnlJpy, 'JPY')}
                            </span>
                          </div>
                          {b.instrumentName && (
                            <div className="truncate text-xs text-[var(--muted)]">{b.instrumentName}</div>
                          )}
                          <div className="flex items-center justify-between text-[11px] text-[var(--muted-strong)]">
                            <span>
                              勝率 {fmtPercent(winRate)} · {b.rounds} トレード
                            </span>
                            <svg width={80} height={20} viewBox="0 0 80 20">
                              <path
                                d={sparkPath(rounds.filter((r) => bucketKey(r) === b.key), 80, 20)}
                                fill="none"
                                stroke={b.totalPnlJpy >= 0 ? 'var(--pos)' : 'var(--neg)'}
                                strokeWidth={1.2}
                              />
                            </svg>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>
        </aside>

        <section className="space-y-4 lg:col-span-8">
          {selected && kpis ? (
            <>
              <Card>
                <CardHeader
                  title={`チャート: ${selected.label}`}
                  subtitle={
                    selected.kind === 'OPTION_US'
                      ? `オプション契約 · ${selectedRounds.length} ラウンドの約定マーカー (instrument ${selected.bestInstrumentId})`
                      : `${selectedRounds.length} ラウンド分の約定マーカー`
                  }
                />
                <CardBody>
                  <ReviewChart
                    instrumentId={selected.bestInstrumentId}
                    symbol={selected.symbol}
                    ccy={selected.ccy}
                    kind={selected.kind}
                    occSymbol={selectedOccSymbol}
                    defaultTimeframe="1d"
                    hideMarkersOnIntraday={hideMarkersOnIntraday}
                    executions={executions.map<ChartExecution>((e) => ({
                      id: e.id,
                      executedAt: e.executedAt.toISOString(),
                      side: e.side,
                      qty: e.qty.toString(),
                      price: e.price.toString(),
                      role: (e.role ?? 'OPEN') as ChartExecution['role'],
                    }))}
                  />
                </CardBody>
              </Card>
              <SymbolKpiPanel kpis={kpis} symbol={selected.label} />
            </>
          ) : (
            <Card>
              <CardBody>
                <p className="text-sm text-[var(--muted)]">銘柄を選択してください。</p>
              </CardBody>
            </Card>
          )}
        </section>
      </section>
    </main>
  );
}
