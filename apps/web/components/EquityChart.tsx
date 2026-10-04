'use client';
// エクイティカーブ（決済済みラウンドの累積損益）。時刻付きはラウンドごと、日付だけは日ごとの最終値。

import { useEffect, useRef } from 'react';
import { ColorType, LineSeries, LineStyle, createChart, type Time } from 'lightweight-charts';
import type { EquityPoint } from '@/lib/stats/equity';
import { onSchemeChange, readChartColors } from './chart-colors';

export default function EquityChart({ points, precision }: { points: EquityPoint[]; precision: 'ms' | 'day' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || points.length === 0) return;
    const c0 = readChartColors();
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: c0.bg }, textColor: c0.muted, fontFamily: 'inherit' },
      grid: { vertLines: { color: c0.border }, horzLines: { color: c0.border } },
      rightPriceScale: { borderColor: c0.border },
      timeScale: { borderColor: c0.border, timeVisible: precision === 'ms', secondsVisible: false },
    });
    const lastValue = points[points.length - 1].value;
    const line = chart.addSeries(LineSeries, {
      color: lastValue >= 0 ? c0.up : c0.down,
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
        layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.muted },
        grid: { vertLines: { color: c.border }, horzLines: { color: c.border } },
        rightPriceScale: { borderColor: c.border },
        timeScale: { borderColor: c.border },
      });
      line.applyOptions({ color: lastValue >= 0 ? c.up : c.down });
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
