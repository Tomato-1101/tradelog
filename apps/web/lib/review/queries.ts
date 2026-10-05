// 振り返り画面用の読み取り。集計は lib/stats、ラウンドの構築は lib/rounds、約定の確定は lib/paper に任せ、
// ここは「画面に出す形に取り出す」だけ。金額・数量は 10 進数文字列のまま返す。

import Decimal from 'decimal.js';
import type { PrismaClient } from '@/generated/prisma/client';
import { dailyWindow } from '@/lib/bars/round-daily';
import { BAR_WINDOW_MIN } from '@/lib/ai/export';
import { chartDay, chartSeconds } from '@/lib/chart-time';
import { fmtJst, fmtJstDate, fmtPrice, PRICE_BASIS_LABEL } from '@/lib/format';
import { floorToMinute } from '@/lib/time';
import { applyPeriodToRounds, periodToRange, type Period } from '@/lib/period';
import { PRIOR_HOLDING_SALE_WARNING } from '@/lib/rounds/builder';
import { avgPriceTimeline, avgSteps, type AvgStep, type TimelinePoint } from '@/lib/rounds/timeline';
import type { StatsRound } from '@/lib/stats/types';

export type SourceKey = 'PAPER' | 'SBI';

export const PAGE_SIZE = 100;

export type ListedRound = {
  id: string;
  source: SourceKey;
  symbol: string;
  name: string | null;
  direction: 'LONG' | 'SHORT';
  marginType: 'CASH' | 'MARGIN_LONG' | 'MARGIN_SHORT' | null;
  openedAt: Date;
  closedAt: Date | null;
  timePrecision: 'ms' | 'day';
  qtyOpened: string;
  remainingQty: string;
  avgEntryPrice: string | null;
  avgExitPrice: string | null;
  remainingAvgPrice: string | null;
  netPnl: string | null;
  holdSeconds: number | null;
  status: 'OPEN' | 'CLOSED';
  needsReview: number;
  unresolved: number;
};

/** 期間に入るか: 決済済みは決済日、未決済は建て日（統計の applyPeriodToRounds と同じ決済日基準に、未決済を足したもの） */
function periodWhere(p: Period, now: Date) {
  const r = periodToRange(p, now);
  if (!r.gte && !r.lte) return {};
  const range = { ...(r.gte ? { gte: r.gte } : {}), ...(r.lte ? { lte: r.lte } : {}) };
  return { OR: [{ closedAt: range }, { closedAt: null, openedAt: range }] };
}

export async function listRounds(
  db: PrismaClient,
  opts: { source: SourceKey; period: Period; reviewOnly: boolean; page: number; now: Date },
): Promise<{ rows: ListedRound[]; total: number; pages: number }> {
  const where = {
    source: opts.source,
    ...(opts.reviewOnly ? { hasUnresolved: true } : {}),
    ...periodWhere(opts.period, opts.now),
  };
  const total = await db.round.count({ where });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, opts.page), pages);
  const rs = await db.round.findMany({
    where,
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    include: { instrument: true, executions: { select: { priceStatus: true } } },
  });
  return {
    total,
    pages,
    rows: rs.map((r) => ({
      id: r.id,
      source: r.source,
      symbol: r.instrument.symbol,
      name: r.instrument.name,
      direction: r.direction,
      marginType: r.marginType,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      timePrecision: r.timePrecision,
      qtyOpened: r.qtyOpened,
      remainingQty: r.remainingQty,
      avgEntryPrice: r.avgEntryPrice,
      avgExitPrice: r.avgExitPrice,
      remainingAvgPrice: r.remainingAvgPrice,
      netPnl: r.netPnl,
      holdSeconds: r.holdSeconds,
      status: r.status,
      needsReview: r.executions.filter((e) => e.priceStatus === 'NEEDS_REVIEW').length,
      unresolved: r.executions.filter((e) => e.priceStatus === 'UNRESOLVED').length,
    })),
  };
}

/** 要確認・未確定の約定があるラウンド数（ソース別。期間に関係なく全件） */
export async function reviewRoundCounts(db: PrismaClient): Promise<Record<SourceKey, number>> {
  const [paper, sbi] = await Promise.all([
    db.round.count({ where: { source: 'PAPER', hasUnresolved: true } }),
    db.round.count({ where: { source: 'SBI', hasUnresolved: true } }),
  ]);
  return { PAPER: paper, SBI: sbi };
}

/** 損益が要確認（仮置きの価格）を含む決済済みラウンドの数。集計の「暫定」表示用 */
export async function provisionalRoundCount(db: PrismaClient, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return db.round.count({ where: { id: { in: ids }, netPnl: { not: null }, executions: { some: { priceStatus: 'NEEDS_REVIEW' } } } });
}

export async function pendingExecutionCount(db: PrismaClient): Promise<number> {
  return db.execution.count({ where: { priceStatus: { not: 'CONFIRMED' } } });
}

export type StatsInput = { rounds: StatsRound[]; precision: 'ms' | 'day' };

export async function loadStatsRounds(db: PrismaClient, source: SourceKey, period: Period, now: Date): Promise<StatsRound[]> {
  const rs = await db.round.findMany({ where: { source }, include: { instrument: { select: { symbol: true } } } });
  const all: Array<StatsRound & { closedAt: Date | null }> = rs.map((r) => ({
    id: r.id,
    source: r.source,
    symbol: r.instrument.symbol,
    direction: r.direction,
    status: r.status,
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    timePrecision: r.timePrecision,
    netPnl: r.netPnl,
    holdSeconds: r.holdSeconds,
  }));
  // 期間は決済日で絞る（未決済は集計に入らない）。未決済の件数は「全期間の未決済」を別に数えない（期間内の建て日で見る）
  const closed = applyPeriodToRounds(all, period, now);
  const r = periodToRange(period, now);
  const open = all.filter(
    (x) => x.status === 'OPEN' && (!r.gte || x.openedAt >= r.gte) && (!r.lte || x.openedAt <= r.lte),
  );
  return [...closed, ...open];
}

export type PendingExecution = {
  id: string;
  roundId: string | null;
  symbol: string;
  name: string | null;
  executedAt: Date;
  side: 'BUY' | 'SELL';
  qty: string;
  price: string | null;
  priceStatus: 'NEEDS_REVIEW' | 'UNRESOLVED';
  priceBasis: string | null;
  priceNote: string | null;
  shotPath: string | null;
  shotPriceText: string | null;
};

export async function listPendingExecutions(db: PrismaClient): Promise<PendingExecution[]> {
  const es = await db.execution.findMany({
    where: { priceStatus: { not: 'CONFIRMED' } },
    orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
    include: { instrument: true, paperOrder: { include: { shot: true } } },
  });
  return es.map((e) => ({
    id: e.id,
    roundId: e.roundId,
    symbol: e.instrument.symbol,
    name: e.instrument.name,
    executedAt: e.executedAt,
    side: e.side,
    qty: e.qty,
    price: e.price,
    priceStatus: e.priceStatus as 'NEEDS_REVIEW' | 'UNRESOLVED',
    priceBasis: e.priceBasis,
    priceNote: e.priceNote,
    shotPath: e.paperOrder?.shot?.path ?? null,
    shotPriceText: e.paperOrder?.shot?.priceText ?? null,
  }));
}

export type ChartBar = { time: number | string; open: number; high: number; low: number; close: number; volume: number };
export type ChartExec = {
  id: string;
  time: number | string;
  side: 'BUY' | 'SELL';
  qty: string;
  price: string | null;
  priceStatus: 'CONFIRMED' | 'NEEDS_REVIEW' | 'UNRESOLVED';
  /** ツールチップ用: JST の約定時刻と価格の根拠 */
  at: string;
  basis: string | null;
};
export type ChartAvgStep = { from: number | string; to: number | string | null; avg: string };

export type RoundDetail = {
  round: {
    id: string;
    source: SourceKey;
    symbol: string;
    name: string | null;
    direction: 'LONG' | 'SHORT';
    marginType: 'CASH' | 'MARGIN_LONG' | 'MARGIN_SHORT' | null;
    openedAt: Date;
    closedAt: Date | null;
    timePrecision: 'ms' | 'day';
    qtyOpened: string;
    remainingQty: string;
    avgEntryPrice: string | null;
    avgExitPrice: string | null;
    remainingAvgPrice: string | null;
    realizedPnl: string | null;
    fees: string;
    netPnl: string | null;
    holdSeconds: number | null;
    mae: string | null;
    mfe: string | null;
    status: 'OPEN' | 'CLOSED';
    warnings: string[];
  };
  instrumentId: number;
  executions: Array<{
    id: string;
    executedAt: Date;
    timePrecision: 'ms' | 'day';
    side: 'BUY' | 'SELL';
    qty: string;
    price: string | null;
    fee: string;
    priceStatus: 'CONFIRMED' | 'NEEDS_REVIEW' | 'UNRESOLVED';
    priceBasis: string | null;
    priceNote: string | null;
    intent: 'OPEN' | 'ADD' | 'CLOSE' | null;
    orderType: 'MARKET' | 'LIMIT' | null;
    limitPrice: string | null;
    paperOrderId: string | null;
    source: SourceKey;
    /** 約定後の建玉数（ロング正・ショート負）と平均建値 */
    /** 反転約定: この約定の一部は次のラウンドの建て（数量は約定全体） */
    flipShared: boolean;
    /** 1 約定を 2 つの取引で分け合うときの注記（反転・期間外に買った株の売却）。無ければ null */
    shareNote: string | null;
    posAfter: string | null;
    avgAfter: string | null;
    /** 撮影の遅れ（撮影完了 − 発注、ms）。ペーパーで小窓が記録したときだけ */
    captureDelayMs: number | null;
  }>;
  memos: Array<{ id: string; ts: Date; text: string; orderId: string | null }>;
  shots: Array<{
    orderId: string;
    placedAt: Date;
    path: string;
    priceText: string | null;
    price: string | null;
    confidence: number | null;
    autoPrice: string | null;
  }>;
  chart: {
    kind: '1m' | '1d';
    bars: ChartBar[];
    execs: ChartExec[];
    avgSteps: ChartAvgStep[];
  };
};

type RoundWithExecs = {
  id: string;
  source: string;
  instrumentId: number;
  account: string;
  marginType: 'CASH' | 'MARGIN_LONG' | 'MARGIN_SHORT' | null;
  closedAt: Date | null;
  status: string;
  timePrecision: string;
  direction: string;
};

/**
 * 反転で次ラウンド（-flip）に紐づいた、このラウンドの決済約定を探す（SBI の決済済みラウンドのみ）。
 * 同じ日の別の取引（別の建値不明ラウンド・別の信用区分）の約定を拾わないよう、信用区分が同じで、
 * かつその約定自身が建てた -flip ラウンド（ID は builder の sbiRoundId と同じ規則）に属するものだけを返す。
 */
async function findFlipClosers(db: PrismaClient, r: RoundWithExecs) {
  if (r.source !== 'SBI' || r.status !== 'CLOSED' || !r.closedAt || r.id.endsWith('-flip')) return [];
  const closeSide = r.direction === 'LONG' ? 'SELL' : 'BUY';
  const es = await db.execution.findMany({
    where: {
      source: r.source,
      instrumentId: r.instrumentId,
      account: r.account,
      marginType: r.marginType,
      executedAt: r.closedAt,
      side: closeSide,
      roundId: { endsWith: '-flip', not: r.id },
    },
    include: { paperOrder: { include: { shot: true } } },
    orderBy: [{ executedAt: 'asc' }, { seq: 'asc' }],
  });
  return es.filter((e) => e.roundId === `sbi-${(e.dedupeHash ?? e.id).slice(0, 16)}-flip`);
}

/** ラウンド 1 件の画面用データ（約定・メモ・スクショ・足・平均建値の推移）。無ければ null */
export async function loadRoundDetail(db: PrismaClient, id: string, now: Date): Promise<RoundDetail | null> {
  const r = await db.round.findUnique({
    where: { id },
    include: {
      instrument: true,
      executions: { include: { paperOrder: { include: { shot: true } } }, orderBy: [{ executedAt: 'asc' }, { seq: 'asc' }] },
      memos: { orderBy: { ts: 'asc' } },
    },
  });
  if (!r) return null;
  const paper = r.timePrecision === 'ms';
  const kind: '1m' | '1d' = paper ? '1m' : '1d';
  const tChart = (d: Date) => (paper ? chartSeconds(d) : chartDay(d));

  let barRows: Array<{ ts: Date; open: number; high: number; low: number; close: number; volume: number }>;
  if (paper) {
    const from = new Date(floorToMinute(r.openedAt).getTime() - BAR_WINDOW_MIN * 60_000);
    const to = new Date(floorToMinute(r.closedAt ?? now).getTime() + BAR_WINDOW_MIN * 60_000);
    barRows = await db.bar.findMany({
      where: { instrumentId: r.instrumentId, timeframe: '1m', ts: { gte: from, lte: to } },
      orderBy: { ts: 'asc' },
      select: { ts: true, open: true, high: true, low: true, close: true, volume: true },
    });
  } else {
    const w = dailyWindow(r.openedAt, r.closedAt);
    barRows = await db.bar.findMany({
      where: { instrumentId: r.instrumentId, timeframe: '1d', ts: { gte: w.from, lte: w.to } },
      orderBy: { ts: 'asc' },
      select: { ts: true, open: true, high: true, low: true, close: true, volume: true },
    });
  }

  const toTl = (e: (typeof r.executions)[number], qty = e.qty) => ({
    id: e.id,
    executedAt: e.executedAt,
    timePrecision: e.timePrecision,
    marginType: e.marginType,
    side: e.side,
    seq: e.seq,
    qty,
    price: e.price,
  });
  // 期間外に買った株の売却は建玉を持たない（建値不明）ので、建玉数も平均建値の線も出さない
  const priorSale = (JSON.parse(r.warningsJson) as string[]).includes(PRIOR_HOLDING_SALE_WARNING);
  let timeline = priorSale ? [] : avgPriceTimeline(r.executions.map((e) => toTl(e)));

  // SBI の反転（建玉をまたいで逆売買）では、決済と次の建てが 1 約定のため、約定は次ラウンド（-flip）にだけ紐づく。
  // このラウンドの画面にも決済側として見せる（平均建値の線もここで止める）。
  // 自分の約定だけで建玉が 0 に戻らないときだけ探す（建値不明ラウンドは建玉を持たないので探さない）。
  const lastPos = timeline.length ? new Decimal(timeline[timeline.length - 1].pos).abs() : new Decimal(0);
  const flipExecs = !priorSale && lastPos.gt(0) ? await findFlipClosers(db, r) : [];
  if (flipExecs.length > 0) {
    timeline = avgPriceTimeline([...r.executions.map((e) => toTl(e)), ...flipExecs.map((e) => toTl(e, lastPos.toFixed()))]);
  }
  const shareNote = (qty: string, flipShared: boolean): string | null => {
    if (flipShared) return r.marginType === 'CASH' ? '一部は期間外に買った株の売却（別の取引）' : '反転（一部は次の取引の建て）';
    // 建値不明ラウンドの約定が前の取引の決済も兼ねる（現物の建玉超過売り）とき、ラウンドの数量はその一部
    if (priorSale && !new Decimal(qty).eq(r.qtyOpened)) return `うち ${fmtPrice(r.qtyOpened)} 株が期間外に買った株の売却（残りは前の取引の決済）`;
    return null;
  };
  const tl = new Map<string, TimelinePoint>(timeline.map((p) => [p.id, p]));
  const steps: AvgStep[] = avgSteps(timeline);

  return {
    instrumentId: r.instrumentId,
    round: {
      id: r.id,
      source: r.source,
      symbol: r.instrument.symbol,
      name: r.instrument.name,
      direction: r.direction,
      marginType: r.marginType,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      timePrecision: r.timePrecision,
      qtyOpened: r.qtyOpened,
      remainingQty: r.remainingQty,
      avgEntryPrice: r.avgEntryPrice,
      avgExitPrice: r.avgExitPrice,
      remainingAvgPrice: r.remainingAvgPrice,
      realizedPnl: r.realizedPnl,
      fees: r.fees,
      netPnl: r.netPnl,
      holdSeconds: r.holdSeconds,
      mae: r.mae,
      mfe: r.mfe,
      status: r.status,
      warnings: JSON.parse(r.warningsJson) as string[],
    },
    executions: [...r.executions.map((e) => ({ e, flipShared: false })), ...flipExecs.map((e) => ({ e, flipShared: true }))].map(({ e, flipShared }) => ({
      flipShared,
      shareNote: shareNote(e.qty, flipShared),
      id: e.id,
      executedAt: e.executedAt,
      timePrecision: e.timePrecision,
      side: e.side,
      qty: e.qty,
      price: e.price,
      fee: e.fee,
      priceStatus: e.priceStatus,
      priceBasis: e.priceBasis,
      priceNote: e.priceNote,
      intent: e.paperOrder?.intent ?? null,
      orderType: e.paperOrder?.orderType ?? null,
      limitPrice: e.paperOrder?.limitPrice ?? null,
      paperOrderId: e.paperOrderId,
      source: e.source,
      posAfter: tl.get(e.id)?.pos ?? null,
      avgAfter: tl.get(e.id)?.avg ?? null,
      captureDelayMs: e.paperOrder?.shot?.captureDelayMs ?? null,
    })),
    memos: r.memos.map((m) => ({ id: m.id, ts: m.ts, text: m.text, orderId: m.orderId })),
    shots: r.executions.flatMap((e) =>
      e.paperOrder?.shot
        ? [
            {
              orderId: e.paperOrder.id,
              placedAt: e.paperOrder.placedAt,
              path: e.paperOrder.shot.path,
              priceText: e.paperOrder.shot.priceText,
              price: e.paperOrder.shot.price,
              confidence: e.paperOrder.shot.confidence,
              autoPrice: e.paperOrder.shot.autoPrice,
            },
          ]
        : [],
    ),
    chart: {
      kind,
      bars: barRows.map((b) => ({ time: tChart(b.ts), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
      execs: [...r.executions, ...flipExecs].map((e) => ({
        id: e.id,
        time: tChart(paper ? floorToMinute(e.executedAt) : e.executedAt),
        side: e.side,
        qty: e.qty,
        price: e.price,
        priceStatus: e.priceStatus,
        at: r.timePrecision === 'day' ? fmtJstDate(e.executedAt) : fmtJst(e.executedAt, 'ms', true),
        basis: e.priceBasis ? PRICE_BASIS_LABEL[e.priceBasis as keyof typeof PRICE_BASIS_LABEL] : null,
      })),
      avgSteps: steps.map((s) => ({ from: tChart(paper ? floorToMinute(s.from) : s.from), to: s.to ? tChart(paper ? floorToMinute(s.to) : s.to) : null, avg: s.avg })),
    },
  };
}
