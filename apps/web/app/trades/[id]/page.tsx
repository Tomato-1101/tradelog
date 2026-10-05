// 個別トレード: チャート（売買マーカー・平均建値）、約定一覧、メモ、発注時スクショ。要確認・未確定の約定はここで価格を手入力して確定する。
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import {
  DIRECTION_LABEL,
  MARGIN_LABEL,
  PRICE_BASIS_LABEL,
  PRICE_STATUS_LABEL,
  SIDE_LABEL,
  fmtHold,
  fmtJst,
  fmtJstDate,
  fmtPrice,
  fmtVideoMs,
  fmtYen,
  pnlSign,
} from '@/lib/format';
import { canSetManualPrice } from '@/lib/paper/ingest';
import { shotUrl } from '@/lib/paper/shots';
import { loadRoundDetail } from '@/lib/review/queries';
import { SOURCE_LABEL, buildHref, sourceParam } from '@/lib/review/url';
import FetchDailyButton from '@/components/FetchDailyButton';
import ManualPriceForm from '@/components/ManualPriceForm';
import ShotGallery from '@/components/ShotGallery';
import TradeChart from '@/components/TradeChart';

export const dynamic = 'force-dynamic';

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const INTENT_LABEL = { OPEN: '新規', ADD: '買い増し', CLOSE: '決済' } as const;

/** 撮影の遅れ（撮影完了 − 発注）。小窓が記録していなければ null */
const captureDelay = (ms: number | null) => (ms == null ? null : `撮影の遅れ ${ms.toLocaleString('ja-JP')}ms`);

export default async function TradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = safeDecode(raw);
  const d = await loadRoundDetail(prisma, id, new Date());
  if (!d) notFound();
  const { round: r, chart } = d;
  const ms = r.timePrecision === 'ms';
  const sign = pnlSign(r.netPnl);
  const pnlCls = sign > 0 ? 'up' : sign < 0 ? 'down' : '';
  // 日付だけの取引（SBI）は年まで出す。時刻付きは月日と時刻
  const when = (d: Date, seconds = false) => (ms ? fmtJst(d, 'ms', seconds) : fmtJstDate(d));

  // 損益は要確認（仮置きの価格）を含むと暫定。未確定があれば損益自体が出ない
  const pendingN = d.executions.filter((e) => e.priceStatus !== 'CONFIRMED').length;

  const shots = d.shots.flatMap((s) => {
    const url = shotUrl(s.path);
    if (!url) return [];
    const px = s.price != null ? `OCR読取価格 ${fmtPrice(s.price)}円` : `読み取れず${s.priceText ? `（${s.priceText}）` : ''}`;
    const conf = s.confidence != null ? `／読取信頼度${Math.round(s.confidence * 100)}%` : '';
    const auto = s.autoPrice != null ? `／自動読取 ${fmtPrice(s.autoPrice)}円` : '';
    const video = s.videoMs != null ? `／再生 ${fmtVideoMs(s.videoMs)}` : '';
    return [{ url, caption: `${fmtJst(s.placedAt, 'ms', true).slice(6)}${video}／${px}${conf}${auto}` }];
  });

  return (
    <>
      <Link className="back" href={buildHref('/', { source: sourceParam(r.source) })}>← 取引一覧</Link>
      <header className="hero">
        <div>
          <h1 className="title" style={{ margin: 0 }}>
            <span className="code">{r.symbol}</span>
            {r.name && <span className="name">{r.name}</span>}
          </h1>
          <div className="meta">
            <span className={`chip ${r.direction === 'LONG' ? 'up' : 'down'}`}>{DIRECTION_LABEL[r.direction]}</span>
            {r.marginType && <span className="chip">{MARGIN_LABEL[r.marginType]}</span>}
            <span className="chip">{SOURCE_LABEL[r.source]}</span>
            {r.status === 'OPEN' ? <span className="chip live">保有中</span> : <span className="chip">決済済</span>}
          </div>
        </div>
        <div className="result">
          <div className={`big ${r.netPnl == null ? 'muted' : pnlCls}`}>
            {r.status === 'OPEN' ? '保有中' : r.netPnl == null ? '損益なし' : `${fmtYen(r.netPnl, true)}円`}
          </div>
          {r.status !== 'OPEN' && r.netPnl != null && pendingN > 0 && (
            <a className="chip warn provisional" href="#execs">暫定・約定{pendingN}件を要確認</a>
          )}
          <div className="small">
            {when(r.openedAt)}
            {r.closedAt && ` → ${when(r.closedAt)}`}
            {r.status !== 'OPEN' && ms && `・${fmtHold(r.holdSeconds, r.timePrecision)}`}
          </div>
        </div>
      </header>

      <dl className="stats">
        <div><dt>数量</dt><dd>{fmtPrice(r.qtyOpened)}株{r.status === 'OPEN' && <span className="muted">（残 {fmtPrice(r.remainingQty)}）</span>}</dd></div>
        <div><dt>平均建値</dt><dd>{fmtPrice(r.avgEntryPrice ?? r.remainingAvgPrice, 2)}</dd></div>
        <div><dt>平均決済値</dt><dd>{fmtPrice(r.avgExitPrice, 2)}</dd></div>
        <div><dt>手数料</dt><dd>{fmtYen(r.fees)}円</dd></div>
        <div><dt>保有時間</dt><dd>{r.status === 'OPEN' ? '—' : fmtHold(r.holdSeconds, r.timePrecision)}</dd></div>
        {ms && <div><dt>最大逆行（1株）</dt><dd className="down">{fmtPrice(r.mae, 2)}</dd></div>}
        {ms && <div><dt>最大順行（1株）</dt><dd className="up">{fmtPrice(r.mfe, 2)}</dd></div>}
      </dl>
      {d.replay && (
        <p className="muted">
          録画を再生しながらの練習。録画 {d.replay.recordingIds.join('・') || '—'}／セッション {d.replay.sessionIds.map((x) => x.slice(0, 8)).join('・') || '—'}
          ／再生位置 {d.executions.filter((e) => e.videoMs != null).map((e) => fmtVideoMs(e.videoMs)).join('・') || '—'}（時刻は録画上の実時刻）
        </p>
      )}
      {r.warnings.length > 0 && (
        <ul className="notes">
          {r.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <h2>チャート（{ms ? '1分足' : '日足'}）</h2>
      {chart.bars.length > 0 ? (
        <TradeChart kind={chart.kind} direction={r.direction} bars={chart.bars} execs={chart.execs} avgSteps={chart.avgSteps} />
      ) : (
        <div className="empty">
          <p>{ms ? '1分足がありません（Yahoo の 1 分足は約 30 日前までしか遡れない。daily で取得）' : '日足がありません'}</p>
          {!ms && <FetchDailyButton roundId={r.id} />}
        </div>
      )}

      <h2 id="execs">約定</h2>
      {/* スマホでは表を横に流さず、1 約定 1 行で状態と確定フォームまで見せる */}
      <ul className="panel execs-sm">
        {d.executions.map((e) => {
          const pending = e.priceStatus !== 'CONFIRMED';
          return (
            <li key={e.id}>
              <div className="row">
                <span className={`side ${e.side === 'BUY' ? 'buy' : 'sell'}`}>{SIDE_LABEL[e.side]}</span>
                <b>
                  {fmtPrice(e.qty)}株 @ {e.price == null ? <span className="warn">未確定</span> : fmtPrice(e.price)}
                </b>
                <span className={`chip ${pending ? 'warn' : ''}`}>{PRICE_STATUS_LABEL[e.priceStatus]}</span>
              </div>
              <div className="sub">
                {when(e.executedAt, true)}
                {e.intent && `・${INTENT_LABEL[e.intent]}`}
                {e.priceBasis && `・${PRICE_BASIS_LABEL[e.priceBasis as keyof typeof PRICE_BASIS_LABEL]}`}
                {e.shareNote ? `・${e.shareNote}` : e.priceNote ? `・${e.priceNote}` : ''}
                {e.captureDelayMs != null && `・${captureDelay(e.captureDelayMs)}`}
                {e.videoMs != null && `・再生 ${fmtVideoMs(e.videoMs)}`}
              </div>
              {canSetManualPrice(e.source) && (pending || e.priceBasis === 'MANUAL') && (
                <ManualPriceForm executionId={e.id} initial={e.price} label={pending ? '確定' : '修正'} />
              )}
            </li>
          );
        })}
      </ul>
      <div className="panel scroll hide-sm">
        <table className="wide">
          <thead>
            <tr>
              <th>時刻</th>
              <th>売買</th>
              <th className="num">数量</th>
              <th className="num">価格</th>
              <th className="num">建玉</th>
              <th className="num">平均建値</th>
              <th>状態</th>
              <th>根拠</th>
              <th>メモ（根拠の説明）</th>
              <th>手入力で確定</th>
            </tr>
          </thead>
          <tbody>
            {d.executions.map((e) => {
              const pending = e.priceStatus !== 'CONFIRMED';
              return (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {when(e.executedAt, true)}
                    {e.intent && <span className="sub">{INTENT_LABEL[e.intent]}{e.orderType === 'LIMIT' ? `・指値${e.limitPrice ? ` ${fmtPrice(e.limitPrice)}` : ''}` : ''}</span>}
                    {e.captureDelayMs != null && <span className="sub">{captureDelay(e.captureDelayMs)}</span>}
                    {e.videoMs != null && <span className="sub">再生 {fmtVideoMs(e.videoMs)}</span>}
                  </td>
                  <td><span className={`side ${e.side === 'BUY' ? 'buy' : 'sell'}`}>{SIDE_LABEL[e.side]}</span></td>
                  <td className="num">{fmtPrice(e.qty)}{e.shareNote && <span className="muted" title={e.shareNote}> *</span>}</td>
                  <td className="num">{e.price == null ? <span className="warn">未確定</span> : fmtPrice(e.price)}</td>
                  <td className="num">{fmtPrice(e.posAfter)}</td>
                  <td className="num">{fmtPrice(e.avgAfter, 2)}</td>
                  <td>
                    <span className={`chip ${pending ? 'warn' : ''}`}>{PRICE_STATUS_LABEL[e.priceStatus]}</span>
                  </td>
                  <td>{e.priceBasis ? PRICE_BASIS_LABEL[e.priceBasis as keyof typeof PRICE_BASIS_LABEL] : '—'}</td>
                  <td>{e.shareNote ? `* ${e.shareNote}` : (e.priceNote ?? '')}</td>
                  <td>
                    {canSetManualPrice(e.source) && (pending || e.priceBasis === 'MANUAL') && (
                      <ManualPriceForm executionId={e.id} initial={e.price} label={pending ? '確定' : '修正'} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>メモ</h2>
      {d.memos.length === 0 ? (
        <div className="empty">メモはありません</div>
      ) : (
        <ul className="panel memos">
          {d.memos.map((m) => (
            <li key={m.id}>
              <time>
                {fmtJst(m.ts, 'ms', true)}
                {m.videoMs != null && <span className="sub">再生 {fmtVideoMs(m.videoMs)}</span>}
              </time>
              <span>{m.text}</span>
            </li>
          ))}
        </ul>
      )}

      {ms && (
        <>
          <h2>{r.source === 'REPLAY' ? '発注時の録画のフレーム' : '発注時のスクショ'}</h2>
          <ShotGallery items={shots} />
        </>
      )}
    </>
  );
}
