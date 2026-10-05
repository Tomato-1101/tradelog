// AI 分析用の書き出し。毎回全量を書き直す（追記しない）。
//  - trades.jsonl: 1 行 1 ラウンド。約定・メモ・前後 30 分の 1 分足・スクショのパスまで、そのラウンドの判断材料を全部入れる。
//    リプレイ（source=REPLAY）は録画 ID・セッション ID と、約定・メモごとの再生位置も入れる。
//  - summary.md: 全体 / 直近 30 日 / PAPER / SBI / REPLAY の統計。
// 時刻はすべて JST の ISO8601（+09:00）。金額・数量は 10 進数文字列、足の OHLCV は数値。

import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { computeStats } from '@/lib/stats/compute';
import type { Stats, StatsRound } from '@/lib/stats/types';
import { loadMinuteBarsWithVolume } from '@/lib/bars/store';
import { floorToMinute, isContinuousSessionMinute, jstMinuteOfDay } from '@/lib/time';
import { barWindowTo } from '@/lib/rounds/excursion';
import { paperDir } from '@/lib/paper/shots';
import { replayEndResolver, type ReplayEndResolver } from '@/lib/paper/recordings';

const JST_MS = 9 * 3600_000;
export function toJstIso(d: Date): string {
  return new Date(d.getTime() + JST_MS).toISOString().replace('Z', '+09:00');
}
const iso = (d: Date | null) => (d ? toJstIso(d) : null);

export const BAR_WINDOW_MIN = 30;

export type ExportReport = { trades: number; withBars: number; tradesPath: string; summaryPath: string };

/** opts.replayEnd: 録画 ID → 録画の終わり（既定は data/paper の録画メタを読む） */
export async function exportForAi(db: PrismaClient, outDir: string, now: Date, opts: { replayEnd?: ReplayEndResolver } = {}): Promise<ExportReport> {
  const replayEnd = opts.replayEnd ?? replayEndResolver(paperDir());
  fs.mkdirSync(outDir, { recursive: true });
  const rounds = await db.round.findMany({
    include: {
      instrument: true,
      executions: { include: { paperOrder: { include: { shot: true } } }, orderBy: [{ executedAt: 'asc' }, { seq: 'asc' }] },
      memos: { orderBy: { ts: 'asc' } },
    },
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
  });

  const lines: string[] = [];
  let withBars = 0;
  for (const r of rounds) {
    let bars: unknown = null;
    if (r.timePrecision === 'ms') {
      const from = new Date(floorToMinute(r.openedAt).getTime() - BAR_WINDOW_MIN * 60_000);
      const last = r.executions.length ? r.executions[r.executions.length - 1].executedAt : null;
      const rec = r.executions.find((e) => e.paperOrder?.replayRecordingId)?.paperOrder?.replayRecordingId ?? null;
      const to = barWindowTo(r, last, replayEnd(rec), now, BAR_WINDOW_MIN);
      const rows = await loadMinuteBarsWithVolume(db, r.instrumentId, from, to);
      const have = new Set(rows.map((b) => b.ts.getTime()));
      let missing = 0;
      for (let t = from.getTime(); t <= Math.min(to.getTime(), now.getTime()); t += 60_000) {
        if (!have.has(t) && isContinuousSessionMinute(jstMinuteOfDay(new Date(t)))) missing++;
      }
      if (rows.length) withBars++;
      bars = {
        interval: '1m',
        from: toJstIso(from),
        to: toJstIso(to),
        note: 't は足の開始時刻。売買の無かった分・取得できなかった分は行が無い',
        missing_session_minutes: missing,
        columns: ['t', 'open', 'high', 'low', 'close', 'volume'],
        rows: rows.map((b) => [toJstIso(b.ts), b.open, b.high, b.low, b.close, b.volume]),
      };
    }
    const shots = r.executions.flatMap((e) => (e.paperOrder?.shot ? [`data/paper/${e.paperOrder.shot.path}`] : []));
    // リプレイは建て始めの注文の録画・セッション（建玉が複数の練習にまたがれば約定ごとの replay を見る）
    const opening = r.executions.find((e) => e.paperOrder?.replayRecordingId)?.paperOrder ?? null;
    const rec = {
      round_id: r.id,
      source: r.source,
      recording_id: r.source === 'REPLAY' ? (opening?.replayRecordingId ?? null) : null,
      session_id: r.source === 'REPLAY' ? (opening?.replaySessionId ?? null) : null,
      symbol: r.instrument.symbol,
      name: r.instrument.name,
      direction: r.direction,
      margin_type: r.marginType,
      status: r.status,
      time_precision: r.timePrecision,
      opened_at: iso(r.openedAt),
      closed_at: iso(r.closedAt),
      hold_seconds: r.holdSeconds,
      qty_opened: r.qtyOpened,
      remaining_qty: r.remainingQty,
      avg_entry_price: r.avgEntryPrice,
      avg_exit_price: r.avgExitPrice,
      remaining_avg_price: r.remainingAvgPrice,
      realized_pnl: r.realizedPnl,
      fees: r.fees,
      net_pnl: r.netPnl,
      result: r.netPnl === null ? null : Number(r.netPnl) > 0 ? 'WIN' : Number(r.netPnl) < 0 ? 'LOSS' : 'DRAW',
      mae_per_share: r.mae,
      mfe_per_share: r.mfe,
      has_unresolved: r.hasUnresolved,
      warnings: JSON.parse(r.warningsJson) as string[],
      executions: r.executions.map((e) => ({
        at: iso(e.executedAt),
        side: e.side,
        qty: e.qty,
        price: e.price,
        fee: e.fee,
        price_status: e.priceStatus,
        price_basis: e.priceBasis,
        price_note: e.priceNote,
        intent: e.paperOrder?.intent ?? null,
        order_type: e.paperOrder?.orderType ?? null,
        limit_price: e.paperOrder?.limitPrice ?? null,
        placed_at: iso(e.paperOrder?.placedAt ?? null),
        screen_price: e.paperOrder?.shot?.price ?? null,
        // 画面全体の自動読取（サイドカー auto）。price_basis が SCREEN_AUTO ならこちらで確定している
        screen_auto_price: e.paperOrder?.shot?.autoPrice ?? null,
        screen_auto_source: e.paperOrder?.shot?.autoSource ?? null,
        // 撮影の遅れ（撮影完了 − 発注、ms）。大きいと画面の値が発注の瞬間からずれている
        capture_delay_ms: e.paperOrder?.shot?.captureDelayMs ?? null,
        shot: e.paperOrder?.shot ? `data/paper/${e.paperOrder.shot.path}` : null,
        // リプレイだけ: 発注の瞬間の録画と再生位置（録画の先頭からの ms）。at / placed_at は録画上の実時刻
        replay: e.paperOrder?.replayRecordingId
          ? { recording_id: e.paperOrder.replayRecordingId, session_id: e.paperOrder.replaySessionId, video_ms: e.paperOrder.replayVideoMs }
          : null,
      })),
      memos: r.memos.map((m) => ({ at: iso(m.ts), order_id: m.orderId, text: m.text, ...(m.replayRecordingId ? { video_ms: m.replayVideoMs } : {}) })),
      shots,
      bars_1m: bars,
    };
    lines.push(JSON.stringify(rec));
  }
  const tradesPath = path.join(outDir, 'trades.jsonl');
  const summaryPath = path.join(outDir, 'summary.md');
  fs.writeFileSync(tradesPath, lines.length ? lines.join('\n') + '\n' : '');

  const statsRounds: StatsRound[] = rounds.map((r) => ({
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
  const since = new Date(now.getTime() - 30 * 86400_000);
  const quality = {
    needsReview: await db.execution.count({ where: { priceStatus: 'NEEDS_REVIEW' } }),
    unresolved: await db.execution.count({ where: { priceStatus: 'UNRESOLVED' } }),
    barErrors: await db.barFetch.count({ where: { status: 'ERROR' } }),
    barUnavailable: await db.barFetch.count({ where: { status: 'UNAVAILABLE' } }),
    expired: await db.paperOrder.count({ where: { state: 'EXPIRED' } }),
  };
  const md = renderSummary(
    [
      ['全体', computeStats(statsRounds)],
      ['直近 30 日（決済日基準）', computeStats(statsRounds.filter((r) => r.closedAt && r.closedAt >= since))],
      ['PAPER', computeStats(statsRounds.filter((r) => r.source === 'PAPER'))],
      ['SBI', computeStats(statsRounds.filter((r) => r.source === 'SBI'))],
      ['REPLAY（録画を再生しながらの練習）', computeStats(statsRounds.filter((r) => r.source === 'REPLAY'))],
    ],
    now,
    quality,
  );
  fs.writeFileSync(summaryPath, md);
  return { trades: lines.length, withBars, tradesPath, summaryPath };
}

const yen = (s: string | null) => (s === null ? '—' : Number(s).toLocaleString('ja-JP', { maximumFractionDigits: 2 }));
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null, d = 2) => (x === null ? '—' : x.toFixed(d));
const dur = (s: number | null) => (s === null ? '—' : s < 3600 ? `${(s / 60).toFixed(1)} 分` : `${(s / 3600).toFixed(1)} 時間`);

function renderSection(title: string, s: Stats): string {
  const out = [`## ${title}`, ''];
  if (s.counted === 0) {
    out.push(`集計対象なし（未決済 ${s.openCount}、損益なし（価格未確定・建値不明の売却） ${s.excludedNoPnl}）`, '');
    return out.join('\n');
  }
  out.push(
    '| 項目 | 値 |',
    '|---|---|',
    `| 件数（決済済み・損益あり。要確認の仮価格を含みうる） | ${s.counted}（勝 ${s.wins} / 負 ${s.losses} / 分 ${s.draws}） |`,
    `| 除外 | 未決済 ${s.openCount}、損益なし（価格未確定・建値不明の売却） ${s.excludedNoPnl} |`,
    `| 勝率 | ${pct(s.winRate)} |`,
    `| 損益合計（手数料込み） | ${yen(s.totalNetPnl)} |`,
    `| 総利益 / 総損失 | ${yen(s.grossProfit)} / ${yen(s.grossLoss)} |`,
    `| PF | ${num(s.profitFactor)} |`,
    `| 平均勝ち / 平均負け | ${yen(s.avgWin)} / ${yen(s.avgLoss)} |`,
    `| ペイオフレシオ | ${num(s.payoffRatio)} |`,
    `| 期待値（1 回あたり） | ${yen(s.expectancy)} |`,
    `| 最大ドローダウン | ${yen(s.maxDrawdown)} |`,
    `| 平均保有時間（日付だけの取引は除く） | ${dur(s.avgHoldSeconds)} |`,
    `| 最大連勝 / 最大連敗 / 現在 | ${s.maxWinStreak} / ${s.maxLossStreak} / ${s.currentStreak.kind ? `${s.currentStreak.kind === 'WIN' ? '連勝' : '連敗'} ${s.currentStreak.count}` : '—'} |`,
    '',
  );
  if (s.byHalfHour.length) {
    out.push('時間帯別（JST 30 分刻み・エントリー時刻）', '', '| 時間帯 | 件数 | 勝率 | 損益 |', '|---|---|---|---|');
    for (const b of s.byHalfHour) out.push(`| ${b.slot} | ${b.count} | ${pct(b.winRate)} | ${yen(b.netPnl)} |`);
    out.push('');
  }
  if (s.bySymbol.length) {
    out.push('銘柄別（件数の多い順、上位 15）', '', '| 銘柄 | 件数 | 勝率 | 損益 |', '|---|---|---|---|');
    for (const b of s.bySymbol.slice(0, 15)) out.push(`| ${b.symbol} | ${b.count} | ${pct(b.winRate)} | ${yen(b.netPnl)} |`);
    out.push('');
  }
  return out.join('\n');
}

function renderSummary(
  sections: Array<[string, Stats]>,
  now: Date,
  q: { needsReview: number; unresolved: number; barErrors: number; barUnavailable: number; expired: number },
): string {
  return [
    '# 取引サマリ',
    '',
    `生成: ${toJstIso(now)}（毎回全量を書き直す）。勝敗は手数料込みの損益 > 0。金額は円。`,
    '1 ラウンドごとの詳細（約定・メモ・前後 30 分の 1 分足・スクショ）は `trades.jsonl`。',
    '',
    ...sections.map(([t, s]) => renderSection(t, s)),
    '## データ品質',
    '',
    `- 約定価格: 要確認 ${q.needsReview} 件 / 未確定 ${q.unresolved} 件（手入力で確定するまで、未確定を含むラウンドは損益が出ない）`,
    `- 失効した指値: ${q.expired} 件`,
    `- 足の取得: 失敗 ${q.barErrors} 日 / 遡れず取得不可 ${q.barUnavailable} 日`,
    '- SBI の約定は日付だけ（時刻なし）なので、保有時間・時間帯別・1 分足・MAE/MFE は出ない',
    '- REPLAY の時刻は録画上の実時刻（押した現実の時刻ではない）。trades.jsonl の各ラウンドに recording_id / session_id、約定に replay.video_ms（再生位置）がある',
    '- 全体・直近 30 日には PAPER・SBI・REPLAY がすべて入る。種別ごとの成績は各節を見る',
    '',
  ].join('\n');
}
