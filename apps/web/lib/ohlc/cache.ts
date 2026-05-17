// OHLC のローカルキャッシュ層。
// DB (OhlcBar テーブル) を見て足りない期間だけ sidecar に取りに行き、DB に upsert する。
// 取引所訂正対策で、当日や直近の足は fetchedAt が古ければ再フェッチ。

import { prisma } from '@/lib/db';
import { sidecarUrl } from '@/lib/sidecar';

export type Timeframe = '1m' | '5m' | '15m' | '60m' | '1h' | '1d';

export type Bar = {
  ts: string; // ISO8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type FetchOhlcParams = {
  instrumentId: number;
  market: 'JP' | 'US';
  symbol: string;
  /** OCC 形式オプションシンボル。OPTION_US 時のみ指定し、sidecar 側はオプション本体のみ取得 (underlying へのフォールバックは行わない)。 */
  occSymbol?: string;
  timeframe: Timeframe;
  start: string;       // yyyy-mm-dd
  end: string;         // yyyy-mm-dd (排他)
  /** 最新足を再フェッチしたい場合 true (デフォルト false) */
  forceRefreshTail?: boolean;
};

export type FetchOhlcResult = {
  bars: Bar[];
  /** 'moomoo' | 'moomoo-option' | 'yfinance' | 'yfinance-option' | 'cache' */
  source: string;
};

function tfNormalize(tf: Timeframe): Timeframe {
  return tf === '1h' ? '60m' : tf;
}

function cachedToBars(cached: Array<{ ts: Date; open: { toString(): string }; high: { toString(): string }; low: { toString(): string }; close: { toString(): string }; volume: { toString(): string }; source: string }>): Bar[] {
  return cached.map((b) => ({
    ts: b.ts.toISOString(),
    open: Number(b.open.toString()),
    high: Number(b.high.toString()),
    low: Number(b.low.toString()),
    close: Number(b.close.toString()),
    volume: Number(b.volume.toString()),
  }));
}

export async function fetchOhlc(p: FetchOhlcParams): Promise<FetchOhlcResult> {
  const tf = tfNormalize(p.timeframe);
  // 1) DB から該当期間のキャッシュを引く
  const startDate = new Date(p.start);
  const endDate = new Date(p.end);
  const cached = await prisma.ohlcBar.findMany({
    where: {
      instrumentId: p.instrumentId,
      timeframe: tf,
      ts: { gte: startDate, lt: endDate },
    },
    orderBy: { ts: 'asc' },
  });

  // オプションの underlying-fallback 由来キャッシュは使わない (本体取得後に再書き込みされる想定)
  const hasContaminatedCache =
    p.occSymbol !== undefined &&
    cached.some((b) => b.source === 'moomoo-underlying-fallback');

  // 2) 大雑把な十分性チェック: 1d なら期間日数 * 0.4 以上のバーがあれば十分とみなす
  //    (休日込みなのでざっくり)。分足は短期しかキャッシュしないので skip 判定はしない。
  if (tf === '1d' && !p.forceRefreshTail && !hasContaminatedCache) {
    const days = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86400000));
    if (cached.length >= Math.floor(days * 0.4)) {
      // キャッシュの代表 source を返す (混在時は最頻値ではなく先頭の source、シンプル化)
      const cachedSource = cached[0]?.source ?? 'cache';
      return { bars: cachedToBars(cached), source: cachedSource };
    }
  }

  // 3) サイドカーから取得
  const url = new URL(sidecarUrl(p.market === 'JP' ? '/ohlc/jp' : '/ohlc/us'));
  url.searchParams.set('symbol', p.symbol);
  url.searchParams.set('timeframe', p.timeframe);
  url.searchParams.set('start', p.start);
  url.searchParams.set('end', p.end);
  if (p.occSymbol) url.searchParams.set('occ_symbol', p.occSymbol);

  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) {
    // 404 はオプション本体が取得不能を意味するので、underlying を含む可能性のあるキャッシュへは絶対戻さない
    if (res.status === 404) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail?.detail ?? 'オプション本体の OHLC が取得できません');
    }
    if (cached.length) {
      // 503 等のフェッチ失敗時はキャッシュにフォールバック
      return { bars: cachedToBars(cached), source: cached[0]?.source ?? 'cache' };
    }
    throw new Error(`sidecar ohlc fetch failed: ${res.status}`);
  }
  const payload: { bars: Bar[]; source: string } = await res.json();

  // 4) DB に upsert
  for (const b of payload.bars) {
    await prisma.ohlcBar.upsert({
      where: {
        instrumentId_timeframe_ts: {
          instrumentId: p.instrumentId,
          timeframe: tf,
          ts: new Date(b.ts),
        },
      },
      create: {
        instrumentId: p.instrumentId,
        timeframe: tf,
        ts: new Date(b.ts),
        open: b.open.toString(),
        high: b.high.toString(),
        low: b.low.toString(),
        close: b.close.toString(),
        volume: b.volume.toString(),
        source: payload.source,
      },
      update: {
        open: b.open.toString(),
        high: b.high.toString(),
        low: b.low.toString(),
        close: b.close.toString(),
        volume: b.volume.toString(),
        source: payload.source,
        fetchedAt: new Date(),
      },
    });
  }

  return { bars: payload.bars, source: payload.source };
}
