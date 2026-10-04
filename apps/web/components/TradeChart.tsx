'use client';
// 個別トレードのチャート。ペーパーは 1 分足、SBI は日足（時刻なし）+ 出来高。
// 売買マーカー: 約定ごとに 2 つ。「ピン」（買いは足の下の上向き矢印・売りは上の下向き矢印、「買 100@2,925」付き）と、
// 約定価格の位置の小さな点（atPriceMiddle）。要確認は黄、未確定は灰で「?」付き（未確定は価格が無いので点なし）。
// 平均建値: 建玉中の区間だけの破線（右軸に価格タグ）。

import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  createSeriesMarkers,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { fmtPrice } from '@/lib/format';
import type { ChartAvgStep, ChartBar, ChartExec } from '@/lib/review/queries';
import { onSchemeChange, readChartColors, withAlpha, type ChartColors } from './chart-colors';

type T = number | string;
const cmp = (a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/** t 以前で最後の足の時間（無ければ最初の足）。約定時刻に足が無い場合（引けの板寄せ 15:30 など）に使う */
function snapTime(times: T[], t: T): T {
  let lo = 0;
  let hi = times.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(times[mid], t) <= 0) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return times[ans];
}

function decimalsOf(values: number[]): number {
  let d = 0;
  for (const v of values) {
    const s = String(v);
    const i = s.indexOf('.');
    if (i >= 0) d = Math.max(d, Math.min(2, s.length - i - 1));
  }
  return d;
}

export function buildMarkers(execs: ChartExec[], times: T[], c: ChartColors): SeriesMarker<Time>[] {
  const out: SeriesMarker<Time>[] = [];
  for (const e of execs) {
    const time = snapTime(times, e.time) as Time;
    const buy = e.side === 'BUY';
    const color = e.priceStatus === 'CONFIRMED' ? (buy ? c.up : c.down) : e.priceStatus === 'NEEDS_REVIEW' ? c.warn : c.muted;
    const mark = e.priceStatus === 'CONFIRMED' ? '' : '? ';
    const text = `${mark}${buy ? '買' : '売'} ${fmtPrice(e.qty)}@${e.price == null ? '未確定' : fmtPrice(e.price)}`;
    out.push({ time, position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown', color, text, id: `${e.id}:pin` });
    if (e.price != null) {
      out.push({ time, position: 'atPriceMiddle', price: Number(e.price), shape: 'circle', color, size: 0.6, id: `${e.id}:dot` });
    }
  }
  return out.sort((a, b) => cmp(a.time as T, b.time as T));
}

/** 平均建値の線の点列。区間ごとに足の時間を並べる（1 点しかない区間は隣の足まで広げて線にする） */
export function buildAvgLine(steps: ChartAvgStep[], times: T[]): Array<{ time: Time; value: number }> {
  const byTime = new Map<T, number>();
  for (const s of steps) {
    const to = s.to ?? times[times.length - 1];
    let idx = times.map((t, i) => [t, i] as const).filter(([t]) => cmp(t, s.from) >= 0 && cmp(t, to) <= 0).map(([, i]) => i);
    if (idx.length === 0) {
      const sn = times.indexOf(snapTime(times, s.from));
      idx = [sn];
    }
    if (idx.length < 2) {
      const i = idx[0];
      if (i + 1 < times.length) idx = [i, i + 1];
      else if (i - 1 >= 0) idx = [i - 1, i];
    }
    for (const i of idx) byTime.set(times[i], Number(s.avg));
  }
  return [...byTime].sort((a, b) => cmp(a[0], b[0])).map(([time, value]) => ({ time: time as Time, value }));
}

export default function TradeChart(props: { kind: '1m' | '1d'; bars: ChartBar[]; execs: ChartExec[]; avgSteps: ChartAvgStep[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { kind, bars, execs, avgSteps } = props;
    const times = bars.map((b) => b.time);
    const c0 = readChartColors();
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: c0.bg }, textColor: c0.muted, fontFamily: 'inherit' },
      grid: { vertLines: { color: c0.border }, horzLines: { color: c0.border } },
      rightPriceScale: { borderColor: c0.border },
      timeScale: { borderColor: c0.border, timeVisible: kind === '1m', secondsVisible: false, rightOffset: 3 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const prec = decimalsOf(bars.flatMap((b) => [b.open, b.high, b.low, b.close]));
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: c0.up,
      downColor: c0.down,
      borderUpColor: c0.up,
      borderDownColor: c0.down,
      wickUpColor: c0.up,
      wickDownColor: c0.down,
      priceLineVisible: false,
      priceFormat: { type: 'price', precision: prec, minMove: prec ? 10 ** -prec : 1 },
    });
    candles.setData(bars.map((b) => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })));
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.25 } });

    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const setVolume = (c: ChartColors) =>
      volume.setData(bars.map((b) => ({ time: b.time as Time, value: b.volume, color: withAlpha(b.close >= b.open ? c.up : c.down, 0.45) })));
    setVolume(c0);

    const avg = chart.addSeries(LineSeries, {
      color: c0.fg,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineType: LineType.WithSteps,
      title: '平均建値',
      lastValueVisible: true,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: { type: 'price', precision: Math.max(prec, 1), minMove: 0.1 },
    });
    avg.setData(buildAvgLine(avgSteps, times));

    const markers = createSeriesMarkers(candles, buildMarkers(execs, times, c0));
    chart.timeScale().fitContent();

    const theme = () => {
      const c = readChartColors();
      chart.applyOptions({
        layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.muted },
        grid: { vertLines: { color: c.border }, horzLines: { color: c.border } },
        rightPriceScale: { borderColor: c.border },
        timeScale: { borderColor: c.border },
      });
      candles.applyOptions({ upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
      avg.applyOptions({ color: c.fg });
      setVolume(c);
      markers.setMarkers(buildMarkers(execs, times, c));
    };
    const off = onSchemeChange(theme);
    return () => {
      off();
      chart.remove();
    };
  }, [props]);

  return <div ref={ref} className="chart" role="img" aria-label="ローソク足と売買マーカー" />;
}
