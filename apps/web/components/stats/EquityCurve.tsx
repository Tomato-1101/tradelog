// 累積エクイティカーブ。x = closedAt の順序、y = 累積 PnL (JPY, 手数料控除後ネット)。SVG ベース。
import type { EquityPoint } from '@/lib/stats/types';

export default function EquityCurve({
  points,
  width = 720,
  height = 220,
}: {
  points: EquityPoint[];
  width?: number;
  height?: number;
}) {
  if (points.length === 0) {
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
  const padB = 24;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const xs = points.map((_, i) => i);
  const ys = points.map((p) => p.cumNet);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const yRange = maxY - minY || 1;

  const x = (i: number) =>
    padL + (xs.length === 1 ? innerW / 2 : (i / (xs.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - ((v - minY) / yRange) * innerH;

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(p.cumNet).toFixed(2)}`)
    .join(' ');

  const zeroY = y(0);
  const finalNet = points[points.length - 1].cumNet;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {/* y=0 ライン */}
      <line x1={padL} x2={width - padR} y1={zeroY} y2={zeroY} stroke="var(--border)" strokeDasharray="3 3" />
      {/* y 軸ラベル */}
      <text x={padL - 6} y={padT + 10} textAnchor="end" fontSize="10" fill="var(--muted)">
        {Math.round(maxY).toLocaleString()}
      </text>
      <text x={padL - 6} y={height - padB} textAnchor="end" fontSize="10" fill="var(--muted)">
        {Math.round(minY).toLocaleString()}
      </text>
      <text x={padL - 6} y={zeroY + 4} textAnchor="end" fontSize="10" fill="var(--muted)">
        0
      </text>

      <path d={pathD} fill="none" stroke="var(--pos)" strokeWidth={2} />

      {/* 最終値ラベル */}
      <text x={width - padR} y={y(finalNet) - 4} textAnchor="end" fontSize="11" fill="var(--pos)">
        {Math.round(finalNet).toLocaleString()}
      </text>
    </svg>
  );
}
