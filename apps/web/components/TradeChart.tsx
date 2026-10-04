'use client';
// 個別トレードのチャート。ペーパーは 1 分足、SBI は日足（時刻なし）+ 出来高。
// 売買の表示は moomoo の 2 層（ピン + 約定価格の点）と GMGN の平均建値線を組み合わせる:
// - ピン: 買いは足の下・売りは足の上に「買」「売」の丸バッジ。約定価格の点と細い線で結び、ホバーで明細を出す。
// - 要確認は警告色の枠、未確定は灰色の枠で「?」（未確定は価格が無いので点なし）。
// - 平均建値: 建玉中の区間だけの金色の破線（右軸に価格タグ）。保有区間は背景を薄く塗る。
// lightweight-charts の marker では明細の吹き出しが作れず、端で切れて重なるので、座標を合わせた HTML を重ねている。

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
  type Logical,
  type Time,
} from 'lightweight-charts';
import { fmtPrice } from '@/lib/format';
import type { ChartAvgStep, ChartBar, ChartExec } from '@/lib/review/queries';
import { onSchemeChange, readChartColors, withAlpha, type ChartColors } from './chart-colors';

type T = number | string;
const cmp = (a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/** t 以前で最後の足の位置（無ければ 0）。約定時刻に足が無い場合（引けの板寄せ 15:30 など）に使う */
function snapIndex(times: T[], t: T): number {
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
  return ans;
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

/** 平均建値の線の点列。区間ごとに足の時間を並べる（1 点しかない区間は隣の足まで広げて線にする） */
export function buildAvgLine(steps: ChartAvgStep[], times: T[]): Array<{ time: Time; value: number }> {
  const byTime = new Map<T, number>();
  for (const s of steps) {
    const to = s.to ?? times[times.length - 1];
    let idx: number[] = [];
    times.forEach((t, i) => {
      if (cmp(t, s.from) >= 0 && cmp(t, to) <= 0) idx.push(i);
    });
    if (idx.length === 0) idx = [snapIndex(times, s.from)];
    if (idx.length < 2) {
      const i = idx[0];
      if (i + 1 < times.length) idx = [i, i + 1];
      else if (i - 1 >= 0) idx = [i - 1, i];
    }
    for (const i of idx) byTime.set(times[i], Number(s.avg));
  }
  return [...byTime].sort((a, b) => cmp(a[0], b[0])).map(([time, value]) => ({ time: time as Time, value }));
}

export type PinGroup = { index: number; side: 'BUY' | 'SELL'; execs: ChartExec[] };

/** 同じ足・同じ売買の約定を 1 本のピンにまとめる（重なり防止） */
export function groupExecs(execs: ChartExec[], times: T[]): PinGroup[] {
  const m = new Map<string, PinGroup>();
  for (const e of execs) {
    const index = snapIndex(times, e.time);
    const k = `${index}:${e.side}`;
    const g = m.get(k) ?? { index, side: e.side, execs: [] };
    g.execs.push(e);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => a.index - b.index);
}

/** 約定時刻にちょうどの足が無い（直前の足にまとめて表示している）か。1 分足は 60 秒以上ずれていれば足なし */
function noBarFor(times: T[], index: number, t: T): boolean {
  const bt = times[index];
  if (bt == null) return true;
  if (typeof t === 'number' && typeof bt === 'number') return t < bt || t - bt >= 60;
  return t !== bt;
}

const groupStatus = (g: PinGroup) =>
  g.execs.some((e) => e.priceStatus === 'UNRESOLVED') ? 'unres' : g.execs.some((e) => e.priceStatus === 'NEEDS_REVIEW') ? 'review' : 'ok';

const STATUS_TEXT = { CONFIRMED: '確定', NEEDS_REVIEW: '要確認', UNRESOLVED: '未確定' } as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** チャートの時間（JST にずらした UTC 秒 / 日足は YYYY-MM-DD）を凡例用に */
function fmtBarTime(t: T): string {
  if (typeof t === 'string') return t.replaceAll('-', '/');
  const d = new Date(t * 1000).toISOString();
  return `${d.slice(5, 7)}/${d.slice(8, 10)} ${d.slice(11, 16)}`;
}

const PIN_GAP = 22; // 足の高値/安値からバッジ中心までの距離(px)
const EDGE = 15; // バッジがチャートの上下端で切れないための余白(px)
const PIN_STEP = 27; // 横に近いピン同士を縦にずらす量(px)

export default function TradeChart(props: {
  kind: '1m' | '1d';
  direction: 'LONG' | 'SHORT';
  bars: ChartBar[];
  execs: ChartExec[];
  avgSteps: ChartAvgStep[];
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const ovRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLButtonElement>(null);
  const avgLabel = props.direction === 'SHORT' ? '平均売建値' : '平均買建値';
  const holds = props.avgSteps.length > 0;

  useEffect(() => {
    const host = chartRef.current;
    const ov = ovRef.current;
    const legend = legendRef.current;
    const fitBtn = fitRef.current;
    if (!host || !ov || !legend || !fitBtn) return;
    const { kind, bars, execs, avgSteps } = props;
    const times = bars.map((b) => b.time);
    const c0 = readChartColors();

    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: c0.surface }, textColor: c0.muted, fontFamily: 'inherit', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: c0.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: kind === '1m', secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const prec = decimalsOf(bars.flatMap((b) => [b.open, b.high, b.low, b.close]));
    const candles = chart.addSeries(CandlestickSeries, {
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: 'price', precision: prec, minMove: prec ? 10 ** -prec : 1 },
    });
    candles.setData(bars.map((b) => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })));
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.14, bottom: 0.26 } });

    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    const avg = chart.addSeries(LineSeries, {
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineType: LineType.WithSteps,
      title: avgLabel,
      lastValueVisible: true,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: { type: 'price', precision: Math.max(prec, 1), minMove: 0.1 },
    });
    avg.setData(buildAvgLine(avgSteps, times));

    const paint = (c: ChartColors) => {
      chart.applyOptions({
        layout: { background: { type: ColorType.Solid, color: c.surface }, textColor: c.muted },
        grid: { horzLines: { color: c.grid } },
        crosshair: {
          vertLine: { color: withAlpha(c.muted, 0.6), style: LineStyle.Dashed, labelBackgroundColor: c.fg },
          horzLine: { color: withAlpha(c.muted, 0.6), style: LineStyle.Dashed, labelBackgroundColor: c.fg },
        },
      });
      candles.applyOptions({ upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
      volume.setData(bars.map((b) => ({ time: b.time as Time, value: b.volume, color: withAlpha(b.close >= b.open ? c.up : c.down, 0.28) })));
      avg.applyOptions({ color: c.gold });
    };
    paint(c0);

    // --- 重ねる HTML: 保有区間の帯・線・点・ピン ---
    const groups = groupExecs(execs, times);
    const band = el('div', 'tc-hold');
    ov.replaceChildren(band);
    const pins = groups.map((g) => {
      const buy = g.side === 'BUY';
      const sideCls = buy ? 'buy' : 'sell';
      const st = groupStatus(g);
      const stem = el('div', `tc-stem ${sideCls} ${st}`);
      const dots = g.execs
        .filter((e) => e.price != null)
        .map((e) => ({ node: el('div', `tc-dot ${sideCls} ${st}`), price: Number(e.price) }));
      const pin = el('div', `tc-pin ${sideCls} ${st}`);
      const badge = el('button', 'tc-badge', `${buy ? '買' : '売'}${st === 'ok' ? '' : '?'}`);
      badge.type = 'button';
      badge.setAttribute('aria-label', g.execs.map((e) => `${buy ? '買い' : '売り'} ${e.qty}株 ${e.price ?? '価格未確定'}`).join('、'));
      if (g.execs.length > 1) badge.append(el('span', 'tc-count', String(g.execs.length)));
      const tip = el('div', 'tc-tip');
      for (const e of g.execs) {
        const head = el('div', 'tc-tip-head');
        head.append(el('span', `tc-tag ${sideCls}`, buy ? '買' : '売'), el('b', '', `${fmtPrice(e.qty)}株 @ ${e.price == null ? '未確定' : fmtPrice(e.price)}`));
        const sub = el('div', 'tc-tip-sub', e.at);
        if (noBarFor(times, g.index, e.time)) sub.append(el('span', 'tc-nobar', '該当時刻の足なし'));
        const stt = el('div', `tc-tip-st ${e.priceStatus === 'CONFIRMED' ? '' : e.priceStatus === 'NEEDS_REVIEW' ? 'review' : 'unres'}`);
        stt.textContent = `${STATUS_TEXT[e.priceStatus]}${e.basis ? `・${e.basis}` : ''}`;
        tip.append(head, sub, stt);
      }
      pin.append(badge, tip);
      ov.append(stem, ...dots.map((d) => d.node), pin);
      return { g, buy, stem, dots, pin };
    });

    const holdFrom = avgSteps.length ? snapIndex(times, avgSteps[0].from) : null;
    const lastTo = avgSteps.length ? avgSteps[avgSteps.length - 1].to : null;
    const holdTo = avgSteps.length ? (lastTo == null ? times.length - 1 : snapIndex(times, lastTo)) : null;

    const render = () => {
      const ts = chart.timeScale();
      const pane = chart.paneSize(0);
      ov.style.width = `${pane.width}px`;
      ov.style.height = `${pane.height}px`;
      const half = ts.options().barSpacing / 2;
      if (holdFrom != null && holdTo != null) {
        const x0 = ts.logicalToCoordinate(holdFrom as Logical);
        const x1 = ts.logicalToCoordinate(holdTo as Logical);
        const show = x0 != null && x1 != null;
        band.style.display = show ? '' : 'none';
        if (show) {
          const l = Math.max(0, x0 - half);
          band.style.left = `${l}px`;
          band.style.width = `${Math.max(2, Math.min(pane.width, x1 + half) - l)}px`;
        }
      } else band.style.display = 'none';

      // 同じ側（買い=下 / 売り=上）で横に近いピンは段をずらして重ねない
      const lastX = { buy: -Infinity, sell: -Infinity };
      const level = { buy: 0, sell: 0 };
      for (const p of pins) {
        const b = bars[p.g.index];
        const x = ts.logicalToCoordinate(p.g.index as Logical);
        const yHi = candles.priceToCoordinate(b.high);
        const yLo = candles.priceToCoordinate(b.low);
        const hidden = x == null || yHi == null || yLo == null || x < -8 || x > pane.width + 8;
        for (const n of [p.stem, p.pin, ...p.dots.map((d) => d.node)]) n.style.display = hidden ? 'none' : '';
        if (hidden) continue;
        const ys = p.dots.map((d) => candles.priceToCoordinate(d.price) ?? null);
        const k = p.buy ? 'buy' : 'sell';
        level[k] = x - lastX[k] < PIN_STEP ? (level[k] + 1) % 3 : 0;
        lastX[k] = x;
        const off = PIN_GAP + level[k] * PIN_STEP;
        const yBadge = Math.min(pane.height - EDGE, Math.max(EDGE, p.buy ? yLo + off : yHi - off));
        const known = ys.filter((y): y is NonNullable<typeof y> => y != null);
        const yAnchor = known.length ? (p.buy ? Math.max(...known) : Math.min(...known)) : p.buy ? yLo : yHi;
        const top = Math.min(yAnchor, yBadge);
        p.stem.style.transform = `translate(${x}px, ${top}px)`;
        p.stem.style.height = `${Math.abs(yBadge - yAnchor)}px`;
        p.dots.forEach((d, i) => {
          d.node.style.display = ys[i] == null ? 'none' : '';
          d.node.style.transform = `translate(${x}px, ${ys[i] ?? 0}px)`;
        });
        p.pin.style.transform = `translate(${x}px, ${yBadge}px)`;
        // 明細は端で切れないよう、左右の端では内側に寄せる。買い(下のピン)は上に、売り(上のピン)は下に出す
        p.pin.classList.toggle('al', x < 120);
        p.pin.classList.toggle('ar', x > pane.width - 120);
        p.pin.classList.toggle('tip-up', p.buy ? yBadge > 140 : yBadge > pane.height - 140);
      }
    };
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    };

    // --- 左上の凡例: カーソル位置の足の四本値と、その足の約定 ---
    const showLegend = (i: number) => {
      const b = bars[i];
      if (!b) return;
      const ch = b.close - b.open;
      const tone = ch > 0 ? 'up' : ch < 0 ? 'down' : '';
      const row = el('div', 'tc-ohlc');
      row.append(el('span', 'tc-time', fmtBarTime(b.time)));
      const cells: Array<[string, number, string]> = [
        ['始', b.open, ''],
        ['高', b.high, ''],
        ['安', b.low, ''],
        ['終', b.close, tone],
        ['出来高', b.volume, ''],
      ];
      for (const [k, v, cls] of cells) {
        const s = el('span', k === '出来高' ? 'vol' : '');
        s.append(el('i', '', k), el('b', cls, fmtPrice(String(v))));
        row.append(s);
      }
      const fills = groups.filter((g) => g.index === i).flatMap((g) => g.execs);
      const parts: HTMLElement[] = [row];
      if (fills.length) {
        const fr = el('div', 'tc-fills');
        for (const e of fills) {
          const buy = e.side === 'BUY';
          const f = el('span', 'tc-fill');
          f.append(el('span', `tc-tag ${buy ? 'buy' : 'sell'}`, buy ? '買' : '売'), document.createTextNode(`${fmtPrice(e.qty)}株 @ ${e.price == null ? '未確定' : fmtPrice(e.price)}`));
          // 足の無い時刻の約定（大引け後など）は、表示中の足の時刻と混同しないよう約定時刻を添える
          if (noBarFor(times, i, e.time)) f.append(el('span', 'tc-nobar', `${e.at}・該当時刻の足なし`));
          fr.append(f);
        }
        parts.push(fr);
      }
      legend.replaceChildren(...parts);
    };
    // 既定は建玉の終わりの足。建玉を持たない取引（期間外の株の売却など）は約定の足
    const lastIdx = holdTo ?? groups[0]?.index ?? bars.length - 1;
    showLegend(lastIdx);
    chart.subscribeCrosshairMove((p) => {
      const i = p.logical == null ? null : Math.round(p.logical);
      showLegend(i == null || i < 0 || i >= bars.length ? lastIdx : i);
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    chart.timeScale().subscribeSizeChange(schedule);
    // 価格軸のドラッグ・縦方向の拡大は範囲変更イベントが出ないので、押している間は毎フレーム合わせる
    let dragging = false;
    const loop = () => {
      render();
      if (dragging) raf = requestAnimationFrame(loop);
    };
    const down = () => {
      dragging = true;
      cancelAnimationFrame(raf);
      loop();
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      schedule();
    };
    host.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    host.addEventListener('wheel', schedule, { passive: true });
    host.addEventListener('dblclick', schedule);

    // 1 分足は保有区間の前後 30〜60 分に寄せて表示（終日の足を全部詰めるとピンが潰れる）。「全体」で切り替え
    const canZoom = kind === '1m' && holdFrom != null && holdTo != null && bars.length > 90;
    let zoomed = canZoom;
    const applyRange = () => {
      if (zoomed && holdFrom != null && holdTo != null) {
        const pad = Math.min(60, Math.max(30, Math.round((holdTo - holdFrom) * 0.8)));
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, holdFrom - pad), to: Math.min(bars.length - 1, holdTo + pad) + 4 });
      } else chart.timeScale().fitContent();
      fitBtn.textContent = zoomed ? '全体' : '保有区間';
      schedule();
    };
    fitBtn.hidden = !canZoom;
    const toggle = () => {
      zoomed = !zoomed;
      applyRange();
    };
    fitBtn.addEventListener('click', toggle);
    applyRange();

    const off = onSchemeChange(() => {
      paint(readChartColors());
      schedule();
    });
    return () => {
      off();
      cancelAnimationFrame(raf);
      host.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      host.removeEventListener('wheel', schedule);
      host.removeEventListener('dblclick', schedule);
      fitBtn.removeEventListener('click', toggle);
      chart.remove();
    };
  }, [props, avgLabel]);

  return (
    <div className="tc">
      <div ref={chartRef} className="tc-chart" role="img" aria-label="ローソク足と売買の位置" />
      <div ref={ovRef} className="tc-ov" />
      <div ref={legendRef} className="tc-legend" aria-hidden="true" />
      <button ref={fitRef} type="button" className="tc-fit" hidden />
      <div className="tc-key" aria-hidden="true">
        <span><i className="k-buy" />買い</span>
        <span><i className="k-sell" />売り</span>
        {holds && <span><i className="k-avg" />{avgLabel}</span>}
        {holds && <span><i className="k-hold" />保有中</span>}
        <span><i className="k-review" />要確認</span>
      </div>
    </div>
  );
}
