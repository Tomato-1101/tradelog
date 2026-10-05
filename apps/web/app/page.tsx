// 取引一覧: ペーパー / 本番(SBI) / リプレイ のタブ、期間プリセット、要確認だけの絞り込み。新しい順。
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { DIRECTION_LABEL, MARGIN_LABEL, fmtHold, fmtJst, fmtPrice, fmtYen, pnlSign } from '@/lib/format';
import { parsePeriodParams } from '@/lib/period';
import { PAGE_SIZE, listRounds, reviewRoundCounts, type ListedRound } from '@/lib/review/queries';
import { SOURCE_LABEL, buildHref, first, parseSource, sourceParam, type SP, type SourceKey } from '@/lib/review/url';
import PeriodNav from '@/components/PeriodNav';

export const dynamic = 'force-dynamic';

function pnlClass(s: string | null) {
  const x = pnlSign(s);
  return x > 0 ? 'up' : x < 0 ? 'down' : '';
}

function StateCell({ r }: { r: ListedRound }) {
  return (
    <>
      {r.status === 'OPEN' ? <span className="chip live">保有中</span> : <span className="chip">決済済</span>}
      {r.unresolved > 0 && <span className="chip warn"> 未確定{r.unresolved > 1 ? ` ${r.unresolved}` : ''}</span>}
      {r.needsReview > 0 && <span className="chip warn"> 要確認{r.needsReview > 1 ? ` ${r.needsReview}` : ''}</span>}
    </>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const source = parseSource(sp.source);
  const period = parsePeriodParams(sp);
  const reviewOnly = first(sp.review) === '1';
  const page = Math.max(1, Number.parseInt(first(sp.page) ?? '1', 10) || 1);
  const now = new Date();

  const [counts, list] = await Promise.all([
    reviewRoundCounts(prisma),
    listRounds(prisma, { source, period, reviewOnly, page, now }),
  ]);

  const keep = { source: sourceParam(source), review: reviewOnly ? '1' : undefined };
  const periodParams = {
    preset: period.preset === 'all' ? undefined : period.preset,
    from: period.preset === 'custom' ? period.from : undefined,
    to: period.preset === 'custom' ? period.to : undefined,
  };
  const href = (extra: Record<string, string | undefined>) => buildHref('/', { ...keep, ...periodParams, ...extra });
  const tab = (s: SourceKey, label: string) => (
    <a href={buildHref('/', { source: sourceParam(s), review: reviewOnly ? '1' : undefined, ...periodParams })} aria-current={source === s ? 'page' : undefined}>
      {label}
      {counts[s] > 0 && <span className="badge" title="要確認・未確定の約定があるトレード">{counts[s]}</span>}
    </a>
  );

  return (
    <>
      <h1>取引一覧</h1>
      <div className="bar">
        <nav className="tabs" aria-label="種別">
          {tab('PAPER', SOURCE_LABEL.PAPER)}
          {tab('SBI', SOURCE_LABEL.SBI)}
          {tab('REPLAY', SOURCE_LABEL.REPLAY)}
        </nav>
        <nav className="tabs" aria-label="絞り込み">
          <a href={href({ review: undefined, page: undefined })} aria-current={!reviewOnly ? 'page' : undefined}>すべて</a>
          <a href={href({ review: '1', page: undefined })} aria-current={reviewOnly ? 'page' : undefined}>要確認・未確定のみ</a>
        </nav>
        <span className="muted">{list.total} 件</span>
      </div>
      <PeriodNav path="/" keep={keep} period={period} />

      {list.rows.length === 0 ? (
        <div className="empty">該当するトレードがありません</div>
      ) : (
        <div className="panel scroll">
          <table>
            <thead>
              <tr>
                <th>日時</th>
                <th>銘柄</th>
                <th className="hide-sm">方向</th>
                <th className="num hide-sm">数量</th>
                <th className="num hide-sm">建値 → 決済値</th>
                <th className="num">損益(円)</th>
                <th className="num hide-sm">保有時間</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className="muted">{fmtJst(r.openedAt, r.timePrecision)}</span>
                  </td>
                  <td>
                    <Link className="sym" href={`/trades/${encodeURIComponent(r.id)}`}>{r.symbol}</Link>
                    {r.name && <span className="sub">{r.name}</span>}
                    <span className={`chip only-sm ${r.direction === 'LONG' ? 'up' : 'down'}`}>{DIRECTION_LABEL[r.direction]}</span>
                  </td>
                  <td className="hide-sm">
                    <span className={`chip ${r.direction === 'LONG' ? 'up' : 'down'}`}>{DIRECTION_LABEL[r.direction]}</span>
                    {r.marginType && <span className="sub">{MARGIN_LABEL[r.marginType]}</span>}
                  </td>
                  <td className="num hide-sm">{fmtPrice(r.qtyOpened)}</td>
                  <td className="num hide-sm">
                    {fmtPrice(r.avgEntryPrice ?? r.remainingAvgPrice, 2)} → {r.status === 'OPEN' ? '—' : fmtPrice(r.avgExitPrice, 2)}
                  </td>
                  <td className={`num pnl ${pnlClass(r.netPnl)}`}>{r.status === 'OPEN' ? '—' : fmtYen(r.netPnl, true)}</td>
                  <td className="num hide-sm">{r.status === 'OPEN' ? '—' : fmtHold(r.holdSeconds, r.timePrecision)}</td>
                  <td>
                    <StateCell r={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.pages > 1 && (
        <div className="pager">
          {page > 1 && <a href={href({ page: String(page - 1) })}>前へ</a>}
          <span className="muted">
            {Math.min(page, list.pages)} / {list.pages}（{PAGE_SIZE} 件ずつ）
          </span>
          {page < list.pages && <a href={href({ page: String(page + 1) })}>次へ</a>}
        </div>
      )}
    </>
  );
}
