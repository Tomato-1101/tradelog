'use client';
// エクイティカーブ（決済済みラウンドの累積損益）。時刻付きはラウンドごと、日付だけは日ごとの最終値。

import { useEffect, useRef } from 'react';
import { AreaSeries, ColorType, LineStyle, createChart, type Time } from 'lightweight-charts';
import type { EquityPoint } from '@/lib/stats/equity';
import { onSchemeChange, readChartColors, withAlpha, type ChartColors } from './chart-colors';

function fmtTick(t: Time): string {
  if (typeof t === 'number') {
    const d = new Date(t * 1000).toISOString();
    return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  }
  if (typeof t === 'string') return `${Number(t.slice(5, 7))}/${Number(t.slice(8, 10))}`;
  return `${t.month}/${t.day}`;
}

export default function EquityChart({ points, precision }: { points: EquityPoint[]; precision: 'ms' | 'day' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || points.length === 0) return;
    const c0 = readChartColors();
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: c0.surface }, textColor: c0.muted, fontFamily: 'inherit', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: c0.grid } },
      rightPriceScale: { borderVisible: false },
      // 時刻付きは JST にずらした秒。軸の目盛りが「14:00」「2日」と混ざらないよう日付で揃える
      timeScale: { borderVisible: false, timeVisible: precision === 'ms', secondsVisible: false, tickMarkFormatter: fmtTick },
      localization: { timeFormatter: fmtTick },
    });
    const lastValue = points[points.length - 1].value;
    // 最終値の符号で線の色を決め、下に薄い塗り（moomoo の資産推移と同じ見せ方）
    const tone = (c: ChartColors) => {
      const col = lastValue >= 0 ? c.up : c.down;
      return { lineColor: col, topColor: withAlpha(col, 0.22), bottomColor: withAlpha(col, 0.01) };
    };
    const line = chart.addSeries(AreaSeries, {
      ...tone(c0),
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
      priceLineVisible: false,
    });
    line.setData(points.map((p) => ({ time: p.time as Time, value: p.value })));
    const zero = line.createPriceLine({ price: 0, color: c0.muted, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
    chart.timeScale().fitContent();
    const theme = () => {
      const c = readChartColors();
      chart.applyOptions({
        layout: { background: { type: ColorType.Solid, color: c.surface }, textColor: c.muted },
        grid: { horzLines: { color: c.grid } },
      });
      line.applyOptions(tone(c));
      zero.applyOptions({ color: c.muted });
    };
    const off = onSchemeChange(theme);
    return () => {
      off();
      chart.remove();
    };
  }, [points, precision]);
  if (points.length === 0) return <div className="empty">決済済みのトレードがありません</div>;
  return <div ref={ref} className="chart small" role="img" aria-label="エクイティカーブ" />;
}
