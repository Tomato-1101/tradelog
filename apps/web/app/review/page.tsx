// 要確認・未確定の約定だけの一覧。その場で価格を手入力して確定する。
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { PRICE_BASIS_LABEL, PRICE_STATUS_LABEL, SIDE_LABEL, fmtJst, fmtPrice } from '@/lib/format';
import { shotUrl } from '@/lib/paper/shots';
import { listPendingExecutions } from '@/lib/review/queries';
import ManualPriceForm from '@/components/ManualPriceForm';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const rows = await listPendingExecutions(prisma);
  return (
    <>
      <h1>要確認・未確定の約定</h1>
      <p className="muted">
        要確認は仮置きの価格、未確定は価格なし。発注時のスクショなどを見て約定価格を入れると確定し、トレードの損益が再計算される。
      </p>
      {rows.length === 0 ? (
        <div className="empty">要確認・未確定の約定はありません</div>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>時刻</th>
                <th>銘柄</th>
                <th>売買</th>
                <th className="num">数量</th>
                <th className="num">仮置き価格</th>
                <th>状態</th>
                <th>根拠</th>
                <th>理由</th>
                <th>スクショ</th>
                <th>手入力で確定</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const url = e.shotPath ? shotUrl(e.shotPath) : null;
                return (
                  <tr key={e.id}>
                    <td>
                      {e.roundId ? <Link href={`/trades/${encodeURIComponent(e.roundId)}`}>{fmtJst(e.executedAt, 'ms', true)}</Link> : fmtJst(e.executedAt, 'ms', true)}
                    </td>
                    <td>
                      {e.symbol} <span className="muted">{e.name ?? ''}</span>
                    </td>
                    <td className={e.side === 'BUY' ? 'up' : 'down'}>{SIDE_LABEL[e.side]}</td>
                    <td className="num">{fmtPrice(e.qty)}</td>
                    <td className="num">{e.price == null ? '—' : fmtPrice(e.price)}</td>
                    <td>
                      <span className="chip warn">{PRICE_STATUS_LABEL[e.priceStatus]}</span>
                    </td>
                    <td>{e.priceBasis ? PRICE_BASIS_LABEL[e.priceBasis as keyof typeof PRICE_BASIS_LABEL] : '—'}</td>
                    <td>{e.priceNote ?? ''}</td>
                    <td>
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer">
                          開く{e.shotPriceText ? `（読取 ${e.shotPriceText}）` : ''}
                        </a>
                      ) : (
                        <span className="muted">なし</span>
                      )}
                    </td>
                    <td>
                      <ManualPriceForm executionId={e.id} initial={e.price} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
