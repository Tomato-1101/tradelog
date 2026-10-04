// 期間プリセット（lib/period.ts）の切り替え。クエリ preset / from / to を付け替えるだけのリンク + カスタム期間のフォーム。
import { getPresetLabel, type Period, type PeriodPreset } from '@/lib/period';
import { buildHref } from '@/lib/review/url';

const SHOWN: PeriodPreset[] = ['today', 'thisWeek', 'thisMonth', 'last30', 'last90', 'thisYear', 'all'];

export default function PeriodNav({ path, keep, period }: { path: string; keep: Record<string, string | undefined>; period: Period }) {
  return (
    <div className="bar">
      <nav className="presets" aria-label="期間">
        {SHOWN.map((p) => (
          <a key={p} href={buildHref(path, { ...keep, preset: p === 'all' ? undefined : p })} aria-current={period.preset === p ? 'page' : undefined}>
            {getPresetLabel(p)}
          </a>
        ))}
      </nav>
      <form method="get" action={path} className="range">
        {Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
        <input type="hidden" name="preset" value="custom" />
        <input type="date" name="from" defaultValue={period.preset === 'custom' ? period.from : undefined} aria-label="開始日" />
        <span className="muted">〜</span>
        <input type="date" name="to" defaultValue={period.preset === 'custom' ? period.to : undefined} aria-label="終了日" />
        <button type="submit">適用</button>
      </form>
    </div>
  );
}
