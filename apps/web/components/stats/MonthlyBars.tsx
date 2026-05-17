// 月次損益の棒グラフ。プラスは緑、マイナスは赤。SVG ベース。
import type { MonthlyPnl } from '@/lib/stats/types';

export default function MonthlyBars({
  months,
  width = 720,
  height = 220,
}: {
  months: MonthlyPnl[];
  width?: number;
  height?: number;
}) {
  if (months.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded border border-dashed border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--muted)]"
        style={{ width, height }}
      >
        データなし
      </div>
    );
  }

  const padL = 56;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const vals = months.map((m) => m.pnlJpy);
  const minY = Math.min(0, ...vals);
  const maxY = Math.max(0, ...vals);
  const yRange = maxY - minY || 1;

  const barGap = 4;
  const barW = Math.max(2, innerW / months.length - barGap);

  const x = (i: number) =>
    padL + (innerW / months.length) * i + (innerW / months.length - barW) / 2;
  const y = (v: number) => padT + innerH - ((v - minY) / yRange) * innerH;
  const zeroY = y(0);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <line x1={padL} x2={width - padR} y1={zeroY} y2={zeroY} stroke="var(--border-strong)" />
      <text x={padL - 6} y={padT + 10} textAnchor="end" fontSize="10" fill="var(--muted)">
        {Math.round(maxY).toLocaleString()}
      </text>
      <text x={padL - 6} y={height - padB} textAnchor="end" fontSize="10" fill="var(--muted)">
        {Math.round(minY).toLocaleString()}
      </text>
      <text x={padL - 6} y={zeroY + 4} textAnchor="end" fontSize="10" fill="var(--muted)">
        0
      </text>

      {months.map((m, i) => {
        const top = Math.min(zeroY, y(m.pnlJpy));
        const h = Math.abs(zeroY - y(m.pnlJpy));
        const color = m.pnlJpy >= 0 ? 'var(--pos)' : 'var(--neg)';
        return (
          <g key={m.ym}>
            <rect x={x(i)} y={top} width={barW} height={h} fill={color} opacity={0.85}>
              <title>
                {m.ym} {Math.round(m.pnlJpy).toLocaleString()} JPY · {m.rounds} ラウンド
              </title>
            </rect>
            {i % Math.max(1, Math.ceil(months.length / 12)) === 0 && (
              <text
                x={x(i) + barW / 2}
                y={height - padB + 14}
                textAnchor="middle"
                fontSize="9"
                fill="var(--muted)"
              >
                {m.ym.slice(2)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
