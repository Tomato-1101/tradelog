// 集計: lib/stats の値とエクイティカーブ。ペーパー / 本番(SBI) の切り替えと期間プリセット。
import { prisma } from '@/lib/db';
import { fmtHold, fmtYen, pnlSign } from '@/lib/format';
import { parsePeriodParams } from '@/lib/period';
import { loadStatsRounds } from '@/lib/review/queries';
import { buildHref, parseSource, sourceParam, type SP } from '@/lib/review/url';
import { computeStats } from '@/lib/stats/compute';
import { equitySeries } from '@/lib/stats/equity';
import EquityChart from '@/components/EquityChart';
import PeriodNav from '@/components/PeriodNav';

export const dynamic = 'force-dynamic';

const pct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const ratio = (x: number | null) => (x == null ? '—' : x.toFixed(2));
const cls = (s: string | null) => (pnlSign(s) > 0 ? 'up' : pnlSign(s) < 0 ? 'down' : '');

export default async function StatsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const source = parseSource(sp.source);
  const period = parsePeriodParams(sp);
  const precision = source === 'SBI' ? 'day' : 'ms';
  const rounds = await loadStatsRounds(prisma, source, period, new Date());
  const st = computeStats(rounds);
  const periodParams = {
    preset: period.preset === 'all' ? undefined : period.preset,
    from: period.preset === 'custom' ? period.from : undefined,
    to: period.preset === 'custom' ? period.to : undefined,
  };
  const tab = (s: 'PAPER' | 'SBI', label: string) => (
    <a href={buildHref('/stats', { source: sourceParam(s), ...periodParams })} aria-current={source === s ? 'page' : undefined}>
      {label}
    </a>
  );
  const card = (k: string, v: string, c = '') => (
    <div className="card">
      <div className="k">{k}</div>
      <div className={`v ${c}`}>{v}</div>
    </div>
  );

  return (
    <>
      <h1>集計</h1>
      <div className="bar">
        <nav className="tabs" aria-label="種別">
          {tab('PAPER', 'ペーパー')}
          {tab('SBI', '本番(SBI)')}
        </nav>
      </div>
      <PeriodNav path="/stats" keep={{ source: sourceParam(source) }} period={period} />

      <div className="cards">
        {card('トレード数', `${st.counted}`)}
        {card('勝率', pct(st.winRate))}
        {card('損益合計(円)', fmtYen(st.totalNetPnl, true), cls(st.totalNetPnl))}
        {card('ペイオフレシオ', ratio(st.payoffRatio))}
        {card('期待値(円/回)', fmtYen(st.expectancy, true), cls(st.expectancy))}
        {card('プロフィットファクター', ratio(st.profitFactor))}
        {card('最大ドローダウン(円)', st.maxDrawdown === '0' ? '0' : `-${fmtYen(st.maxDrawdown)}`, st.maxDrawdown === '0' ? '' : 'down')}
        {card('平均保有時間', fmtHold(st.avgHoldSeconds == null ? null : Math.round(st.avgHoldSeconds), 'ms'))}
        {card('平均利益(円)', fmtYen(st.avgWin, true), 'up')}
        {card('平均損失(円)', fmtYen(st.avgLoss, true), 'down')}
        {card('勝ち / 負け / 引分', `${st.wins} / ${st.losses} / ${st.draws}`)}
        {card('最大連勝 / 連敗', `${st.maxWinStreak} / ${st.maxLossStreak}`)}
      </div>
      <p className="muted">
        保有中 {st.openCount} 件は集計に入らない。{st.excludedNoPnl > 0 && `価格未確定で損益が出せない ${st.excludedNoPnl} 件も除外。`}
        {precision === 'day' && '本番(SBI)は約定履歴に時刻が無いため、保有時間と時間帯別は出さない。'}
      </p>

      <h2>エクイティカーブ（累積損益）</h2>
      <EquityChart points={equitySeries(st.equityCurve, precision)} precision={precision} />

      <h2>時間帯別（エントリー時刻 JST・30分刻み）</h2>
      {st.byHalfHour.length === 0 ? (
        <div className="empty">時刻付きのトレードがありません</div>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr><th>時間帯</th><th className="num">件数</th><th className="num">勝率</th><th className="num">損益(円)</th></tr>
            </thead>
            <tbody>
              {st.byHalfHour.map((b) => (
                <tr key={b.slot}>
                  <td>{b.slot}〜</td>
                  <td className="num">{b.count}</td>
                  <td className="num">{pct(b.winRate)}</td>
                  <td className={`num ${cls(b.netPnl)}`}>{fmtYen(b.netPnl, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>銘柄別</h2>
      {st.bySymbol.length === 0 ? (
        <div className="empty">決済済みのトレードがありません</div>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr><th>銘柄</th><th className="num">件数</th><th className="num">勝率</th><th className="num">損益(円)</th></tr>
            </thead>
            <tbody>
              {st.bySymbol.map((b) => (
                <tr key={b.symbol}>
                  <td>{b.symbol}</td>
                  <td className="num">{b.count}</td>
                  <td className="num">{pct(b.winRate)}</td>
                  <td className={`num ${cls(b.netPnl)}`}>{fmtYen(b.netPnl, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
