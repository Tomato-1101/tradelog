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
  fmtPrice,
  fmtYen,
  pnlSign,
} from '@/lib/format';
import { shotUrl } from '@/lib/paper/shots';
import { loadRoundDetail } from '@/lib/review/queries';
import { buildHref, sourceParam } from '@/lib/review/url';
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

export default async function TradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = safeDecode(raw);
  const d = await loadRoundDetail(prisma, id, new Date());
  if (!d) notFound();
  const { round: r, chart } = d;
  const ms = r.timePrecision === 'ms';
  const sign = pnlSign(r.netPnl);
  const pnlCls = sign > 0 ? 'up' : sign < 0 ? 'down' : '';

  const shots = d.shots.flatMap((s) => {
    const url = shotUrl(s.path);
    if (!url) return [];
    const px = s.priceText ?? s.price;
    return [{ url, caption: `${fmtJst(s.placedAt, 'ms', true)} 読み取り ${px ?? '不明'}${s.confidence != null ? `（信頼度 ${s.confidence}）` : ''}` }];
  });

  return (
    <>
      <p>
        <Link href={buildHref('/', { source: sourceParam(r.source) })}>← 取引一覧</Link>
      </p>
      <h1>
        {r.symbol} <span className="muted">{r.name ?? ''}</span> {DIRECTION_LABEL[r.direction]}
        {r.marginType && <span className="muted"> {MARGIN_LABEL[r.marginType]}</span>}{' '}
        <span className="chip">{r.status === 'OPEN' ? '保有中' : '決済済'}</span>
      </h1>

      <dl className="kv">
        <div><dt>建て</dt><dd>{fmtJst(r.openedAt, r.timePrecision)}</dd></div>
        <div><dt>決済</dt><dd>{r.closedAt ? fmtJst(r.closedAt, r.timePrecision) : '—'}</dd></div>
        <div><dt>数量</dt><dd>{fmtPrice(r.qtyOpened)}{r.status === 'OPEN' && `（残 ${fmtPrice(r.remainingQty)}）`}</dd></div>
        <div><dt>平均建値</dt><dd>{fmtPrice(r.avgEntryPrice ?? r.remainingAvgPrice, 4)}</dd></div>
        <div><dt>平均決済値</dt><dd>{fmtPrice(r.avgExitPrice, 4)}</dd></div>
        <div><dt>損益(手数料込)</dt><dd className={pnlCls}>{r.status === 'OPEN' ? '—' : fmtYen(r.netPnl, true)}</dd></div>
        <div><dt>手数料</dt><dd>{fmtYen(r.fees)}</dd></div>
        <div><dt>保有時間</dt><dd>{r.status === 'OPEN' ? '—' : fmtHold(r.holdSeconds, r.timePrecision)}</dd></div>
        {ms && <div><dt>最大逆行(1株)</dt><dd>{fmtPrice(r.mae, 4)}</dd></div>}
        {ms && <div><dt>最大順行(1株)</dt><dd>{fmtPrice(r.mfe, 4)}</dd></div>}
      </dl>
      {r.warnings.length > 0 && (
        <ul className="warn">
          {r.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <h2>チャート（{ms ? '1分足' : '日足'}）</h2>
      {chart.bars.length > 0 ? (
        <TradeChart kind={chart.kind} bars={chart.bars} execs={chart.execs} avgSteps={chart.avgSteps} />
      ) : (
        <div className="empty">
          <p>{ms ? '1分足がありません（Yahoo の 1 分足は約 30 日前までしか遡れない。daily で取得）' : '日足がありません'}</p>
          {!ms && <FetchDailyButton roundId={r.id} />}
        </div>
      )}

      <h2>約定</h2>
      <div className="scroll">
        <table>
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
                  <td>
                    {fmtJst(e.executedAt, e.timePrecision, true)}
                    {e.intent && <span className="muted"> {INTENT_LABEL[e.intent]}{e.orderType === 'LIMIT' ? `・指値${e.limitPrice ? ` ${fmtPrice(e.limitPrice)}` : ''}` : ''}</span>}
                  </td>
                  <td className={e.side === 'BUY' ? 'up' : 'down'}>{SIDE_LABEL[e.side]}</td>
                  <td className="num">{fmtPrice(e.qty)}{e.flipShared && <span className="muted" title="反転: 一部は次の取引の建て"> *</span>}</td>
                  <td className="num">{e.price == null ? <span className="warn">未確定</span> : fmtPrice(e.price)}</td>
                  <td className="num">{fmtPrice(e.posAfter)}</td>
                  <td className="num">{fmtPrice(e.avgAfter, 4)}</td>
                  <td>
                    <span className={`chip ${pending ? 'warn' : ''}`}>{PRICE_STATUS_LABEL[e.priceStatus]}</span>
                  </td>
                  <td>{e.priceBasis ? PRICE_BASIS_LABEL[e.priceBasis as keyof typeof PRICE_BASIS_LABEL] : '—'}</td>
                  <td>{e.flipShared ? '反転（* 一部は次の取引の建て）' : (e.priceNote ?? '')}</td>
                  <td>
                    {e.source === 'PAPER' && (pending || e.priceBasis === 'MANUAL') && (
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
        <table>
          <tbody>
            {d.memos.map((m) => (
              <tr key={m.id}>
                <td className="num muted">{fmtJst(m.ts, 'ms', true)}</td>
                <td>{m.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {ms && (
        <>
          <h2>発注時のスクショ</h2>
          <ShotGallery items={shots} />
        </>
      )}
    </>
  );
}
