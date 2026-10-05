// ペーパー注文の約定価格の確定規則（docs/paper-events.md「約定価格の確定規則」）。純粋関数のみ。
// 判定は JST、足の時刻は開始時刻（分足 ts = その分の頭）。
//
// 規則（契約 + この実装で決めた細部）
// 1. 板寄せの時間帯に出した成行は、その板寄せの価格・時刻で確定（auctionFor）。価格の足が無ければ未確定。
//    - 寄り前（〜08:59:59）→ 日足始値・09:00（OPEN_AUCTION）。特別気配で寄りが遅れた日も 09:00 のまま。
//    - 昼休み（11:30〜12:29）→ 12:30 の分足始値・12:30（OPEN_AUCTION）。
//    - 引けの板寄せ（15:25〜15:29）→ 日足終値・15:30（CLOSE_AUCTION）。
//    - 大引け後（15:30〜）→ 当日には約定しないので未確定（手入力で決める）。
//    発注時刻のままにすると保有時間・時間帯別・MAE/MFE の窓がずれる。
// 2. 連続売買中の成行 → shot.price を照合（SCREEN）。
//    その分の分足があれば [low, high] 内で確定、範囲外はその分の close を仮置きして要確認（BAR）。
//    分足が無ければ日足 [low, high] で照合し、範囲内で確定、範囲外は（仮置きできる分足も無いので）未確定。
//    shot.price が読めないときは分足 close を仮置きして要確認、分足も無ければ未確定。
//    shot.price（手で囲んだ領域）が読めない・その分の足の外のときは、サイドカーの auto.price（画面全体の自動読取）を
//    次の候補にし、その分の分足の [low, high] 内なら確定（SCREEN_AUTO）。範囲外・分足が無いときは上の規則のまま。
//    auto.symbol が読めていて発注銘柄と違うときは、別の銘柄の画面なので shot.price も auto.price も候補にしない。
//    ここで確定に使う値（verifiedCurrentPrice）を「検証済みの現在値」と呼ぶ。
// 3. 指値 → 板寄せの時間帯に出した指値は、板寄せの価格が指値以内（買い: ≤ / 売り: ≥）ならその価格で確定。
//    連続売買中は、規則 2 の検証済みの現在値が指値以内なら、発注時刻・その現在値で即約定（指値ではない。
//    実際の約定は現在値付近で、指値で約定させると買いが不利側に寄る）。判定と価格に同じ値を使うので、
//    誤読（足の外の値）で即約定と判定したまま別の値で約定させることはない。検証済みの現在値が無ければ下の通常の判定。
//    それ以外は fill_mark の時刻・指値で約定とし、発注の分〜fill_mark の分の分足が指値を「越えて」いれば確定
//    （買い: low < 指値 / 売り: high > 指値。同値は越えていない）。越えていない場合、連続売買の分に欠けが無ければ
//    要確認（指値を仮置き）、欠けがあれば判定できないので未確定。
//    fill_mark が無い指値（待機中・取消・失効）は約定しない。
// 4. 要確認・未確定は手入力で確定する（manualResolution、priceBasis = MANUAL）。

import Decimal from 'decimal.js';
import { floorToMinute, isContinuousSessionMinute, isPreOpen, jstAt, jstMinuteOfDay, jstYmd, SESSION } from '@/lib/time';
import type { DerivedState } from './events';

export type BarLite = { ts: Date; open: number; high: number; low: number; close: number };

export type PriceStatus = 'CONFIRMED' | 'NEEDS_REVIEW' | 'UNRESOLVED';
export type PriceBasis = 'OPEN_AUCTION' | 'CLOSE_AUCTION' | 'SCREEN' | 'SCREEN_AUTO' | 'BAR' | 'LIMIT' | 'MANUAL';

export type ResolveOrder = {
  orderType: 'market' | 'limit';
  side: 'buy' | 'sell';
  limitPrice: string | null;
  placedAt: Date;
  state: DerivedState;
  fillMarkedAt: Date | null;
  shotPrice: string | null;
  /** サイドカーの auto.price（画面全体の自動読取）。サイドカーがまだ無ければ null */
  autoPrice?: string | null;
  /** auto.source（region / label）。注記に使う */
  autoSource?: string | null;
  /** 発注銘柄と auto.symbol。両方あって違えば auto.price を使わない */
  symbol?: string;
  autoSymbol?: string | null;
};

export type Fill = {
  kind: 'FILL';
  executedAt: Date;
  /** 未確定は null */
  price: string | null;
  priceStatus: PriceStatus;
  priceBasis: PriceBasis | null;
  priceNote: string | null;
};
export type NoFill = { kind: 'NO_FILL'; reason: 'PENDING' | 'CANCELLED' | 'EXPIRED' };
export type Resolution = Fill | NoFill;

/** Yahoo の Float を 10 進数文字列に（2856.5000000001 のような誤差を落とす） */
export function barPrice(x: number): string {
  return new Decimal(x.toPrecision(12)).toString();
}

function inRange(price: string, bar: BarLite): boolean {
  const p = new Decimal(price);
  return p.gte(barPrice(bar.low)) && p.lte(barPrice(bar.high));
}

const fill = (
  executedAt: Date,
  price: string | null,
  priceStatus: PriceStatus,
  priceBasis: PriceBasis | null,
  priceNote: string | null,
): Fill => ({ kind: 'FILL', executedAt, price, priceStatus, priceBasis, priceNote });

/**
 * @param minuteBars 必要な時間帯を含む 1 分足（余分があってもよい）。取得できなかった分は含めない
 * @param dailyBar 発注日（JST）の日足。無ければ null
 */
export function resolveOrder(o: ResolveOrder, minuteBars: BarLite[], dailyBar: BarLite | null): Resolution {
  const byMinute = new Map(minuteBars.map((b) => [b.ts.getTime(), b]));
  const auction = auctionFor(o.placedAt, byMinute, dailyBar);

  if (o.orderType === 'market') {
    if (auction === 'AFTER_CLOSE') return fill(o.placedAt, null, 'UNRESOLVED', null, '大引け後の成行は当日には約定しない。手入力で決める');
    if (auction) {
      if (auction.price === null) return fill(auction.at, null, 'UNRESOLVED', null, `${auction.what}の足が無い`);
      return fill(auction.at, auction.price, 'CONFIRMED', auction.basis, null);
    }
    return resolveContinuousMarket(o, byMinute, dailyBar);
  }

  // 指値
  if (o.limitPrice === null) throw new Error('指値なのに limitPrice が無い');
  if (o.state === 'CANCELLED') return { kind: 'NO_FILL', reason: 'CANCELLED' };
  const limit = new Decimal(o.limitPrice);
  const within = (price: string) => (o.side === 'buy' ? limit.gte(price) : limit.lte(price));
  if (auction && auction !== 'AFTER_CLOSE' && auction.price !== null && within(auction.price)) {
    return fill(auction.at, auction.price, 'CONFIRMED', auction.basis, `${auction.what}で約定する指値`);
  }
  if (auction === null) {
    const v = verifiedCurrentPrice(o, minuteBarOf(o, byMinute), dailyBar);
    if (v && within(v.price)) {
      const note = `発注時の現在値 ${v.price} で即約定する指値`;
      return fill(o.placedAt, v.price, 'CONFIRMED', v.basis, v.note ? `${note}。${v.note}` : note);
    }
  }
  if (o.state !== 'FILL_MARKED' || !o.fillMarkedAt) {
    return { kind: 'NO_FILL', reason: o.state === 'EXPIRED' ? 'EXPIRED' : 'PENDING' };
  }

  const from = floorToMinute(o.placedAt).getTime();
  const to = floorToMinute(o.fillMarkedAt).getTime();
  let missing = 0;
  for (let t = from; t <= to; t += 60_000) {
    const b = byMinute.get(t);
    if (!b) {
      if (isContinuousSessionMinute(jstMinuteOfDay(new Date(t)))) missing++;
      continue;
    }
    const crossed = o.side === 'buy' ? limit.gt(barPrice(b.low)) : limit.lt(barPrice(b.high));
    if (crossed) return fill(o.fillMarkedAt, o.limitPrice, 'CONFIRMED', 'LIMIT', null);
  }
  if (missing > 0) {
    return fill(o.fillMarkedAt, null, 'UNRESOLVED', null, `指値を越えた足が見つからず、連続売買の分足が ${missing} 本欠けていて判定できない`);
  }
  return fill(
    o.fillMarkedAt,
    o.limitPrice,
    'NEEDS_REVIEW',
    'LIMIT',
    '発注〜約定マークの分足が指値を越えていない（同値止まり以下）。指値を仮置き',
  );
}

type Auction = { at: Date; price: string | null; what: string; basis: 'OPEN_AUCTION' | 'CLOSE_AUCTION' };

/** 発注時刻が板寄せの時間帯ならその板寄せ、大引け後なら AFTER_CLOSE、連続売買中なら null */
export function auctionFor(placedAt: Date, byMinute: Map<number, BarLite>, dailyBar: BarLite | null): Auction | 'AFTER_CLOSE' | null {
  const ymd = jstYmd(placedAt);
  const m = jstMinuteOfDay(placedAt);
  if (isPreOpen(placedAt)) {
    return { at: jstAt(ymd, SESSION.open), price: dailyBar ? barPrice(dailyBar.open) : null, what: '寄り（日足始値）', basis: 'OPEN_AUCTION' };
  }
  if (m >= SESSION.amClose && m < SESSION.pmOpen) {
    const at = jstAt(ymd, SESSION.pmOpen);
    const b = byMinute.get(at.getTime());
    return { at, price: b ? barPrice(b.open) : null, what: '後場寄り（12:30 の分足始値）', basis: 'OPEN_AUCTION' };
  }
  if (m >= SESSION.close - 5 && m < SESSION.close) {
    return { at: jstAt(ymd, SESSION.close), price: dailyBar ? barPrice(dailyBar.close) : null, what: '大引け（日足終値）', basis: 'CLOSE_AUCTION' };
  }
  if (m >= SESSION.close) return 'AFTER_CLOSE';
  return null;
}

const minuteBarOf = (o: ResolveOrder, byMinute: Map<number, BarLite>) => byMinute.get(floorToMinute(o.placedAt).getTime()) ?? null;

/** auto.symbol が読めていて発注銘柄と違うか（別の銘柄の画面を撮った） */
function autoSymbolMismatch(o: ResolveOrder): boolean {
  const s = o.autoSymbol?.trim();
  return !!s && o.symbol !== undefined && s !== o.symbol;
}
/** 候補にできる現在値（同じ画面から読むので、銘柄が違えば領域・自動読取とも null） */
const usableShot = (o: ResolveOrder) => (autoSymbolMismatch(o) ? null : o.shotPrice);
const usableAuto = (o: ResolveOrder) => (autoSymbolMismatch(o) ? null : (o.autoPrice ?? null));
const autoWhat = (o: ResolveOrder) => `画面の自動読取${o.autoSource ? `（${o.autoSource}）` : ''}の現在値 ${o.autoPrice}`;

/**
 * 検証済みの現在値（規則 2）。領域の値がその分の分足内 → SCREEN、だめなら auto.price が分足内 → SCREEN_AUTO。
 * その分の分足が無ければ領域の値を日足で照合する（自動読取は日足の幅では誤読を見分けられないので照合しない）。
 * 成行の約定価格と、指値の即約定の判定・価格の両方にこの同じ値を使う。どれも外れなら null。
 */
function verifiedCurrentPrice(
  o: ResolveOrder,
  bar: BarLite | null,
  dailyBar: BarLite | null,
): { price: string; basis: 'SCREEN' | 'SCREEN_AUTO'; note: string | null } | null {
  const shot = usableShot(o);
  if (bar) {
    if (shot !== null && inRange(shot, bar)) return { price: shot, basis: 'SCREEN', note: null };
    const auto = usableAuto(o);
    if (auto !== null && inRange(auto, bar)) {
      const range = `その分の足 [${barPrice(bar.low)}, ${barPrice(bar.high)}]`;
      const why = shot === null ? '手で囲んだ領域の現在値が読めない' : `手で囲んだ領域の現在値 ${shot} が${range} の外`;
      return { price: auto, basis: 'SCREEN_AUTO', note: `${why}。${autoWhat(o)} で確定` };
    }
    return null;
  }
  if (shot !== null && dailyBar && inRange(shot, dailyBar)) {
    return { price: shot, basis: 'SCREEN', note: 'その分の分足が無く、日足の範囲で照合' };
  }
  return null;
}

/** 規則 2: 連続売買中の成行 */
function resolveContinuousMarket(o: ResolveOrder, byMinute: Map<number, BarLite>, dailyBar: BarLite | null): Fill {
  const bar = minuteBarOf(o, byMinute);
  const v = verifiedCurrentPrice(o, bar, dailyBar);
  if (v) return fill(o.placedAt, v.price, 'CONFIRMED', v.basis, v.note);
  const shot = usableShot(o);
  const auto = usableAuto(o);
  const ignored = [o.shotPrice !== null ? `画面の現在値 ${o.shotPrice}` : null, o.autoPrice ? autoWhat(o) : null].filter((x) => x !== null);
  const skipped =
    autoSymbolMismatch(o) && ignored.length ? `（画面の銘柄 ${o.autoSymbol?.trim()} が発注 ${o.symbol} と違うので${ignored.join('・')} は使わない）` : '';
  if (bar) {
    const range = `その分の足 [${barPrice(bar.low)}, ${barPrice(bar.high)}]`;
    const reads = [shot !== null ? `画面の現在値 ${shot}` : null, auto !== null ? autoWhat(o) : null].filter((x) => x !== null);
    if (reads.length) {
      return fill(o.placedAt, barPrice(bar.close), 'NEEDS_REVIEW', 'BAR', `${reads.join('・')} が${range} の外。足の終値を仮置き${skipped}`);
    }
    return fill(o.placedAt, barPrice(bar.close), 'NEEDS_REVIEW', 'BAR', `画面の現在値が読めない。足の終値を仮置き${skipped}`);
  }
  if (shot !== null) {
    return fill(
      o.placedAt,
      null,
      'UNRESOLVED',
      null,
      dailyBar
        ? `画面の現在値 ${shot} が日足 [${barPrice(dailyBar.low)}, ${barPrice(dailyBar.high)}] の外で、その分の分足も無い`
        : 'その分の分足も日足も無い',
    );
  }
  return fill(o.placedAt, null, 'UNRESOLVED', null, `画面の現在値が読めず${auto !== null ? `（${autoWhat(o)}）` : ''}、その分の分足も無い${skipped}`);
}

/** 手入力での確定（規則 4）。DB 側はこれで上書きし、以降の自動確定で上書きしない */
export function manualResolution(price: string, note?: string): Pick<Fill, 'price' | 'priceStatus' | 'priceBasis' | 'priceNote'> {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(price) || new Decimal(price).lte(0)) {
    throw new Error(`手入力の価格が不正: ${JSON.stringify(price)}`);
  }
  return { price, priceStatus: 'CONFIRMED', priceBasis: 'MANUAL', priceNote: note ?? '手入力で確定' };
}
