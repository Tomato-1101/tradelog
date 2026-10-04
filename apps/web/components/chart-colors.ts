// チャートの色は globals.css の CSS 変数から読む（直書きしない）。ライト/ダークの切り替えにも追従する。

export type ChartColors = { bg: string; fg: string; muted: string; border: string; up: string; down: string; warn: string };

export function readChartColors(): ChartColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return { bg: v('--bg'), fg: v('--fg'), muted: v('--muted'), border: v('--border'), up: v('--up'), down: v('--down'), warn: v('--warn') };
}

/** #rrggbb に透明度を付ける（出来高など） */
export function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** 配色（ライト/ダーク）が切り替わったら呼ぶ。解除関数を返す */
export function onSchemeChange(cb: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
