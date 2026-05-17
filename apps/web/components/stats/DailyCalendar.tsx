// 日次損益カレンダー。月別に 7 列 × 6 行のグリッドを描画し、各セルの色を P&L 強度で塗る。
import type { DailyPnl } from '@/lib/stats/types';

function parseYmd(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function monthsBetween(from: string, to: string): string[] {
  // yyyy-mm の昇順配列
  const a = parseYmd(from);
  const b = parseYmd(to);
  const out: string[] = [];
  let y = a.y;
  let m = a.m;
  while (y < b.y || (y === b.y && m <= b.m)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

function bgFor(pnl: number, scale: number): string {
  if (pnl === 0 || scale === 0) return 'transparent';
  const ratio = Math.min(1, Math.abs(pnl) / scale);
  const alpha = 0.08 + 0.20 * ratio;
  return pnl > 0 ? `rgba(22,163,74,${alpha})` : `rgba(220,38,38,${alpha})`;
}

function fmtCellAmount(n: number): string {
  // 999 まで: そのまま、それ以上は千区切り、1万以上は "1.2万"
  const abs = Math.abs(n);
  if (abs >= 10000) return `${n >= 0 ? '+' : '-'}${(abs / 10000).toFixed(2)}万`;
  if (abs >= 1000) return `${n >= 0 ? '+' : '-'}${Math.round(abs).toLocaleString()}`;
  return `${n >= 0 ? '+' : '-'}${Math.round(abs)}`;
}

export default function DailyCalendar({ days }: { days: DailyPnl[] }) {
  if (days.length === 0) {
    return (
      <div className="rounded border border-dashed border-[var(--border)] bg-[var(--surface)] p-6 text-center text-sm text-[var(--muted)]">
        クローズ済ラウンドなし
      </div>
    );
  }

  const byDate = new Map(days.map((d) => [d.date, d]));
  const months = monthsBetween(days[0].date.slice(0, 7) + '-01', days[days.length - 1].date.slice(0, 7) + '-01');
  const maxAbs = Math.max(1, ...days.map((d) => Math.abs(d.pnlJpy)));

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
      {months.map((ym) => (
        <MonthGrid key={ym} ym={ym} byDate={byDate} scale={maxAbs} />
      ))}
    </div>
  );
}

function MonthGrid({
  ym,
  byDate,
  scale,
}: {
  ym: string;
  byDate: Map<string, DailyPnl>;
  scale: number;
}) {
  const [yStr, mStr] = ym.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // 月初の曜日 (0=日)
  const firstDow = first.getUTCDay();

  const cells: Array<{ key: string; ymd: string | null; pnl: number | null; rounds: number | null }> = [];
  for (let i = 0; i < firstDow; i++) {
    cells.push({ key: `pad-${i}`, ymd: null, pnl: null, rounds: null });
  }
  for (let d = 1; d <= lastDay; d++) {
    const ymd = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const v = byDate.get(ymd);
    cells.push({
      key: ymd,
      ymd,
      pnl: v?.pnlJpy ?? null,
      rounds: v?.rounds ?? null,
    });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ key: `tail-${cells.length}`, ymd: null, pnl: null, rounds: null });
  }

  const monthlyTotal = [...byDate.values()]
    .filter((v) => v.date.startsWith(ym))
    .reduce((s, v) => s + v.pnlJpy, 0);

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-sm font-semibold">{ym}</div>
        <div className={`text-xs font-mono ${monthlyTotal >= 0 ? 'text-[var(--pos)]' : 'text-[var(--neg)]'}`}>
          {monthlyTotal >= 0 ? '+' : ''}¥{Math.round(monthlyTotal).toLocaleString()}
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-[10px] text-[var(--muted)]">
        {['日', '月', '火', '水', '木', '金', '土'].map((d) => (
          <div key={d} className="text-center">
            {d}
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-px overflow-hidden rounded-md border border-[var(--border)] bg-[var(--border)]">
        {cells.map((c) => (
          <div
            key={c.key}
            className="aspect-[5/4] bg-[var(--surface)] text-[10px] leading-tight"
            style={{ background: c.pnl == null ? 'var(--surface)' : bgFor(c.pnl, scale) }}
            title={
              c.ymd && c.pnl != null
                ? `${c.ymd}  ${c.pnl >= 0 ? '+' : ''}¥${Math.round(c.pnl).toLocaleString()}  ${c.rounds} ラウンド`
                : undefined
            }
          >
            {c.ymd && (
              <div className="flex h-full flex-col items-start justify-between p-1">
                <div className="text-[10px] text-[var(--muted-strong)]">{Number(c.ymd.slice(8, 10))}</div>
                {c.pnl != null && c.pnl !== 0 && (
                  <div className="w-full text-right">
                    <div
                      className={`font-mono text-[10px] font-semibold tabular-nums ${c.pnl >= 0 ? 'text-[var(--pos)]' : 'text-[var(--neg)]'}`}
                    >
                      {fmtCellAmount(c.pnl)}
                    </div>
                    <div className="text-[9px] text-[var(--muted)]">{c.rounds}ラウンド</div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
