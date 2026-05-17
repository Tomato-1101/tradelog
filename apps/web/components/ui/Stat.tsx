// 大きな数値 + 補助ラベル/サブテキスト の KPI ブロック。moomoo の数字ファーストデザインを参考。
import type { ReactNode } from 'react';

export type StatTone = 'pos' | 'neg' | 'neutral' | 'primary';

function toneCls(tone: StatTone | undefined): string {
  switch (tone) {
    case 'pos':
      return 'text-[var(--pos)]';
    case 'neg':
      return 'text-[var(--neg)]';
    case 'primary':
      return 'text-[var(--primary)]';
    default:
      return 'text-[var(--foreground)]';
  }
}

export default function Stat({
  label,
  value,
  sub,
  tone,
  size = 'md',
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: StatTone;
  size?: 'sm' | 'md' | 'lg';
}) {
  const v =
    size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-lg' : 'text-2xl';
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className={`font-mono font-semibold tabular-nums ${v} ${toneCls(tone)}`}>{value}</div>
      {sub && <div className="text-xs text-[var(--muted)]">{sub}</div>}
    </div>
  );
}
