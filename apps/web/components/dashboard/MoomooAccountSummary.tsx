// moomoo OpenAPI accinfo_query の集計結果を表示する。
// 自家計算した realizedPnl (Round/Execution 由来) と "答え合わせ" するための broker 真値。
//
// 注意: 米株 CASH 口座は realized_pl / unrealized_pl が "N/A" で返るため、
// 表示は total_assets / cash / market_val / USD・JPY 内訳が主役。

import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { fmtMoney } from '@/lib/format';
import { fetchMoomooAccountSummary, type AccountTotalsNormalized } from '@/lib/moomoo/account-summary';

function accTypeLabel(t: string): string {
  if (t === 'CASH') return '現物 (CASH)';
  if (t === 'MARGIN') return '信用 (MARGIN)';
  if (t === 'DERIVATIVES') return 'オプション (DERIVATIVES)';
  return t;
}

function ccyForAccount(a: AccountTotalsNormalized): 'USD' | 'JPY' {
  // DERIVATIVES / CASH は USD 主, MARGIN は uni_card_num 構造からは判別不能なので
  // jpAssets > 0 を優先
  if ((a.jpAssets ?? 0) > 0 && (a.usAssets ?? 0) === 0) return 'JPY';
  return 'USD';
}

function MoneyCell({ v, ccy }: { v: number | null; ccy: 'USD' | 'JPY' }) {
  if (v == null) {
    return <span className="text-[var(--muted)]">—</span>;
  }
  return (
    <span className={v >= 0 ? 'text-[var(--foreground)]' : 'text-[var(--neg)]'}>
      {fmtMoney(v, ccy)}
    </span>
  );
}

export default async function MoomooAccountSummary() {
  const r = await fetchMoomooAccountSummary();

  return (
    <Card>
      <CardHeader
        title="moomoo 口座サマリー (broker)"
        subtitle={
          r.ok
            ? 'accinfo_query 由来。自家計算した実現損益との答え合わせ用。N/A は OpenAPI 未対応フィールド。'
            : 'sidecar 接続失敗'
        }
        right={r.ok ? <span>OpenD 取得</span> : <span className="text-[var(--neg)]">{r.error}</span>}
      />
      <CardBody className="px-0 py-0">
        {!r.ok ? (
          <div className="px-5 py-6 text-sm text-[var(--muted)]">
            sidecar から取得できませんでした。OpenD が起動しているか確認してください。
            <div className="mt-2 font-mono text-xs">{r.error}</div>
          </div>
        ) : r.accounts.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-[var(--muted)]">
            REAL 口座が見つかりません
          </div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="border-b border-[var(--border)] text-left text-[11px] uppercase text-[var(--muted)]">
              <tr>
                <th className="px-5 py-2">口座</th>
                <th className="px-5 py-2 text-right">総資産</th>
                <th className="px-5 py-2 text-right">現金</th>
                <th className="px-5 py-2 text-right">持株評価額</th>
                <th className="px-5 py-2 text-right">含み損益</th>
                <th className="px-5 py-2 text-right">実現損益</th>
                <th className="px-5 py-2 text-right">USD 内訳</th>
                <th className="px-5 py-2 text-right">JPY 内訳</th>
              </tr>
            </thead>
            <tbody>
              {r.accounts.map((a) => {
                const ccy = ccyForAccount(a);
                return (
                  <tr key={a.accId} className="border-t border-[var(--border)]">
                    <td className="px-5 py-2">
                      <div className="font-medium">{accTypeLabel(a.accType)}</div>
                      <div className="font-mono text-[10px] text-[var(--muted)]">
                        ****{a.uniCardNum.slice(-4)}
                      </div>
                    </td>
                    <td className="px-5 py-2 text-right font-mono tabular-nums">
                      <MoneyCell v={a.totalAssets} ccy={ccy} />
                    </td>
                    <td className="px-5 py-2 text-right font-mono tabular-nums">
                      <MoneyCell v={a.cash} ccy={ccy} />
                    </td>
                    <td className="px-5 py-2 text-right font-mono tabular-nums">
                      <MoneyCell v={a.marketVal} ccy={ccy} />
                    </td>
                    <td className="px-5 py-2 text-right font-mono tabular-nums">
                      <MoneyCell v={a.unrealizedPl} ccy={ccy} />
                    </td>
                    <td className="px-5 py-2 text-right font-mono tabular-nums">
                      <MoneyCell v={a.realizedPl} ccy={ccy} />
                    </td>
                    <td className="px-5 py-2 text-right font-mono tabular-nums">
                      <MoneyCell v={a.usAssets} ccy="USD" />
                    </td>
                    <td className="px-5 py-2 text-right font-mono tabular-nums">
                      <MoneyCell v={a.jpAssets} ccy="JPY" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="border-t border-[var(--border)] px-5 py-2 text-[11px] text-[var(--muted)]">
          ※ moomoo OpenAPI は米株現物の <code>realized_pl</code> / <code>unrealized_pl</code> を返さない (N/A)。
          総資産・持株評価額・現金は実値。
        </div>
      </CardBody>
    </Card>
  );
}
