'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type IRange,
} from 'lightweight-charts';

export type ChartExecution = {
  id: number;
  executedAt: string; // ISO8601
  side: 'BUY' | 'SELL';
  qty: string;
  price: string;
  role: 'OPEN' | 'SCALE_IN' | 'SCALE_OUT' | 'CLOSE' | 'FLIP';
};

export type TimeframeKey = '1d' | '60m' | '5m' | '1m';

export type ReviewChartProps = {
  instrumentId: number;
  symbol: string;
  ccy: string;
  defaultTimeframe?: TimeframeKey;
  /** 表示する timeframe を限定する */
  availableTimeframes?: TimeframeKey[];
  /** 分足では取引マーカーを描画しない (時刻情報が不正確な SBI 用) */
  hideMarkersOnIntraday?: boolean;
  /** OPTION_US 用: OCC コード (US.MSFT261218C00400000)。サーバーが本体 OHLC を取りにいく */
  occSymbol?: string | null;
  /** 楽器種別。OPTION_US の場合は本体 OHLC を取得する想定で UI 文言が変わる */
  kind?: string;
  executions: ChartExecution[];
};

const TIMEFRAMES: Array<{ key: TimeframeKey; label: string; daysBefore: number; daysAfter: number }> = [
  { key: '1d', label: '日足', daysBefore: 90, daysAfter: 30 },
  { key: '60m', label: '1h', daysBefore: 20, daysAfter: 10 },
  { key: '5m', label: '5m', daysBefore: 5, daysAfter: 3 },
  { key: '1m', label: '1m', daysBefore: 2, daysAfter: 2 },
];

function toUnixSec(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

// IEEE 754 由来の `1.140000000000000001` のような末尾ノイズを丸める。
// 整数なら整数のまま、小数なら最大 6 桁で丸めて末尾の 0 を落とす。
function fmtNum(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (Number.isInteger(n)) return n.toString();
  return Number(n.toFixed(6)).toString();
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rangeFor(tf: TimeframeKey, executions: ChartExecution[]): { start: string; end: string } {
  const t = TIMEFRAMES.find((x) => x.key === tf)!;
  const ts = executions.map((e) => new Date(e.executedAt).getTime());
  const minT = ts.length ? Math.min(...ts) : Date.now();
  const maxT = ts.length ? Math.max(...ts) : Date.now();
  const start = new Date(minT - t.daysBefore * 86400000);
  const end = new Date(maxT + t.daysAfter * 86400000);
  return { start: ymd(start), end: ymd(end) };
}

type Bar = { ts: string; open: number; high: number; low: number; close: number; volume: number };

export default function ReviewChart({
  instrumentId,
  symbol,
  ccy,
  defaultTimeframe = '1d',
  availableTimeframes,
  hideMarkersOnIntraday = false,
  occSymbol = null,
  kind,
  executions,
}: ReviewChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma5Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ma25Ref = useRef<ISeriesApi<'Line'> | null>(null);
  // マーカープラグインのハンドル。createSeriesMarkers は呼ぶたびに新しい primitive を
  // アタッチしてしまうので、必ずマウント時に 1 度だけ作って setMarkers() で更新する。
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const enabledTimeframes = availableTimeframes ?? TIMEFRAMES.map((t) => t.key);
  const timeframesToRender = TIMEFRAMES.filter((t) => enabledTimeframes.includes(t.key));
  const resolvedDefault: TimeframeKey = enabledTimeframes.includes(defaultTimeframe)
    ? defaultTimeframe
    : (enabledTimeframes[0] ?? '1d');

  const [tf, setTf] = useState<TimeframeKey>(resolvedDefault);
  const [bars, setBars] = useState<Bar[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMa, setShowMa] = useState(true);
  const [showVol, setShowVol] = useState(true);
  // 可視範囲 (UNIX sec) — マーカー絞込専用。null は範囲未確定 (全件描画)。
  // ※ fitContent には絶対に使わない (ズーム/パンするたびに巻き戻る原因になる)
  const [visibleRange, setVisibleRange] = useState<{ from: number; to: number } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // chart 初期化 (マウント時 1 回)
  useEffect(() => {
    if (!containerRef.current) return;
    const cs = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string) =>
      cs.getPropertyValue(name).trim() || fallback;
    const bgColor = cssVar('--surface', '#ffffff');
    const textColor = cssVar('--foreground', '#333333');
    const borderColor = cssVar('--border', '#dddddd');
    const gridColor = cssVar('--surface-muted', '#eeeeee');
    const posColor = cssVar('--pos', '#10b981');
    const negColor = cssVar('--neg', '#ef4444');
    const mutedStrong = cssVar('--muted-strong', '#94a3b8');

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 480,
      layout: { background: { color: bgColor }, textColor },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      timeScale: { rightOffset: 5, borderColor },
      rightPriceScale: { borderColor },
      // マグネット OFF (TradingView の Magnet 風挙動を切る)
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartRef.current = chart;
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: posColor,
      downColor: negColor,
      borderUpColor: posColor,
      borderDownColor: negColor,
      wickUpColor: posColor,
      wickDownColor: negColor,
    });
    volumeRef.current = chart.addSeries(HistogramSeries, {
      color: mutedStrong,
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    // 5MA = 黄、25MA = 青。crosshairMarker/pointMarker を抑止して吸着点 (丸い marker) を消す
    ma5Ref.current = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      pointMarkersVisible: false,
    });
    ma25Ref.current = chart.addSeries(LineSeries, {
      color: '#3b82f6',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      pointMarkersVisible: false,
    });

    // マーカープラグインを 1 度だけ作って ref に保存。以後の更新は setMarkers() で。
    markersPluginRef.current = createSeriesMarkers(candleRef.current, []);

    const onResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', onResize);

    // ビューポート購読 — 100ms デバウンスで可視範囲を更新し、マーカーを絞り込む
    const rangeHandler = (range: IRange<Time> | null) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (!range) {
          setVisibleRange(null);
          return;
        }
        const from = typeof range.from === 'number' ? range.from : Number(range.from);
        const to = typeof range.to === 'number' ? range.to : Number(range.to);
        if (Number.isFinite(from) && Number.isFinite(to)) {
          setVisibleRange({ from, to });
        }
      }, 100);
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(rangeHandler);

    // テーマ変更時 (data-theme 属性の変化) にチャート配色を更新
    const themeObserver = new MutationObserver(() => {
      const cs2 = getComputedStyle(document.documentElement);
      const get = (n: string, f: string) => cs2.getPropertyValue(n).trim() || f;
      chart.applyOptions({
        layout: {
          background: { color: get('--surface', '#ffffff') },
          textColor: get('--foreground', '#333333'),
        },
        grid: {
          vertLines: { color: get('--surface-muted', '#eeeeee') },
          horzLines: { color: get('--surface-muted', '#eeeeee') },
        },
        timeScale: { borderColor: get('--border', '#dddddd') },
        rightPriceScale: { borderColor: get('--border', '#dddddd') },
      });
      const pos = get('--pos', '#10b981');
      const neg = get('--neg', '#ef4444');
      candleRef.current?.applyOptions({
        upColor: pos,
        downColor: neg,
        borderUpColor: pos,
        borderDownColor: neg,
        wickUpColor: pos,
        wickDownColor: neg,
      });
      volumeRef.current?.applyOptions({ color: get('--muted-strong', '#94a3b8') });
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      window.removeEventListener('resize', onResize);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      chart.timeScale().unsubscribeVisibleTimeRangeChange(rangeHandler);
      themeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      ma5Ref.current = null;
      ma25Ref.current = null;
      markersPluginRef.current = null;
    };
  }, []);

  // 期間 / TF が変わったら fetch (executions は range 計算用なので依存に含む)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const { start, end } = rangeFor(tf, executions);
        const url = new URL('/api/ohlc', window.location.origin);
        url.searchParams.set('instrumentId', String(instrumentId));
        url.searchParams.set('timeframe', tf);
        url.searchParams.set('start', start);
        url.searchParams.set('end', end);
        const res = await fetch(url.toString());
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const j: { bars: Bar[]; source?: string } = await res.json();
        if (!cancelled) {
          setBars(j.bars);
          setSource(j.source ?? null);
          // 新しいデータが来たので可視範囲をリセット (fitContent は別 effect が拾う)
          setVisibleRange(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setBars([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [instrumentId, tf, executions]);

  // bars / インジケーター描画 (visibleRange に依存しない)
  useEffect(() => {
    const candle = candleRef.current;
    const vol = volumeRef.current;
    const ma5 = ma5Ref.current;
    const ma25 = ma25Ref.current;
    if (!candle || !vol || !ma5 || !ma25) return;

    const sortedBars = [...bars].sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
    );

    // 重複時刻を排除 (lightweight-charts はユニーク time 必須)
    const dedup: Bar[] = [];
    let prevTs = -1;
    for (const b of sortedBars) {
      const t = toUnixSec(b.ts);
      if (t === prevTs) continue;
      dedup.push(b);
      prevTs = t;
    }

    candle.setData(
      dedup.map((b) => ({
        time: toUnixSec(b.ts) as Time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );

    vol.setData(
      showVol
        ? dedup.map((b) => ({
            time: toUnixSec(b.ts) as Time,
            value: b.volume,
            color: b.close >= b.open ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)',
          }))
        : [],
    );

    const smaSeries = (window: number) => {
      if (!showMa || dedup.length < window) return [];
      const out: { time: Time; value: number }[] = [];
      let sum = 0;
      for (let i = 0; i < dedup.length; i++) {
        sum += dedup[i].close;
        if (i >= window) sum -= dedup[i - window].close;
        if (i >= window - 1) {
          out.push({ time: toUnixSec(dedup[i].ts) as Time, value: sum / window });
        }
      }
      return out;
    };
    ma5.setData(smaSeries(5));
    ma25.setData(smaSeries(25));
  }, [bars, showMa, showVol]);

  // bars が新しく入ったら 1 回だけ fitContent (visibleRange を巻き戻さない)
  useEffect(() => {
    if (bars.length > 0) {
      chartRef.current?.timeScale().fitContent();
    }
  }, [bars]);

  // マーカー (entry/exit) — visibleRange と hideMarkersOnIntraday を反映、fitContent しない
  useEffect(() => {
    const plugin = markersPluginRef.current;
    if (!plugin) return;

    // 分足では SBI などのマーカーを隠す
    const hideMarkers = hideMarkersOnIntraday && tf !== '1d';
    const baseExecs = hideMarkers ? [] : executions;

    const visibleExecs = visibleRange
      ? baseExecs.filter((e) => {
          const ts = toUnixSec(e.executedAt);
          return ts >= visibleRange.from && ts <= visibleRange.to;
        })
      : baseExecs;

    // 1 Execution に対して最大 3 マーカー:
    //   ① 矢印 + テキスト (belowBar/aboveBar) … 「エントリーした事実」
    //   ② 黒い外枠の円 (atPriceMiddle, size やや大) … 同色 ロウソクに埋もれないための輪郭
    //   ③ side 色の円 (atPriceMiddle, size 小) … 実価格位置の点本体
    //
    //   ②③ をスタックさせて「黒縁取り + 中央 BUY=緑/SELL=赤 のドット」に見せる。
    //   v5 SeriesMarker は描画順で z-order が決まるため、外枠 → 本体の順で push。
    //   size は lightweight-charts のスケール係数 (1.0 がデフォルト)。candle 幅より十分小さい 0.3-0.5 帯。
    const markers: SeriesMarker<Time>[] = visibleExecs.flatMap((e) => {
      const t = toUnixSec(e.executedAt) as Time;
      const sideColor = e.side === 'BUY' ? '#10b981' : '#ef4444';
      const price = Number(e.price);
      const arrow: SeriesMarker<Time> = {
        time: t,
        position: e.side === 'BUY' ? 'belowBar' : 'aboveBar',
        color: sideColor,
        shape: e.side === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: `${e.role} ${e.side} ${fmtNum(e.qty)}@${fmtNum(e.price)}`,
      };
      if (!Number.isFinite(price)) return [arrow];
      const outline: SeriesMarker<Time> = {
        time: t,
        position: 'atPriceMiddle',
        price,
        color: '#000000',
        shape: 'circle',
        size: 0.5,
      };
      const dot: SeriesMarker<Time> = {
        time: t,
        position: 'atPriceMiddle',
        price,
        color: sideColor,
        shape: 'circle',
        size: 0.3,
      };
      return [arrow, outline, dot];
    });
    markers.sort((a, b) => (a.time as number) - (b.time as number));

    plugin.setMarkers(markers);
  }, [executions, visibleRange, hideMarkersOnIntraday, tf]);

  const isOption = kind === 'OPTION_US';
  const hideMarkersBanner = hideMarkersOnIntraday && tf !== '1d';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {timeframesToRender.map((t) => (
            <button
              key={t.key}
              onClick={() => setTf(t.key)}
              className={`rounded px-3 py-1 text-sm ${
                tf === t.key
                  ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                  : 'border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--muted-strong)]">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showMa} onChange={(e) => setShowMa(e.target.checked)} />
            <span className="inline-flex items-center gap-1">
              MA
              <span className="text-[10px] text-[#f59e0b]">5</span>
              <span className="text-[10px] text-[#3b82f6]">25</span>
            </span>
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showVol} onChange={(e) => setShowVol(e.target.checked)} />
            出来高
          </label>
          {loading && <span>取得中…</span>}
        </div>
      </div>
      {error && (
        <div className="mb-2 rounded border border-[var(--neg)] bg-[var(--neg-bg)] px-3 py-2 text-xs text-[var(--neg)]">
          {isOption
            ? `オプション本体の OHLC を取得できませんでした: ${error}`
            : error}
        </div>
      )}
      {hideMarkersBanner && (
        <div className="mb-2 rounded border border-[var(--border-strong)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--muted-strong)]">
          SBI の取引時刻は CSV に記録されていないため、分足では取引マーカーを非表示にしています。
        </div>
      )}
      <div ref={containerRef} className="rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
      <div className="mt-1 text-xs text-[var(--muted)]">
        {symbol} ({ccy}) · {bars.length} bars · TF={tf}
        {source && source !== 'moomoo' && source !== 'yfinance' ? ` · src=${source}` : ''}
      </div>
    </div>
  );
}
