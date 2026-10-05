// 小窓の新しい契約（両建て禁止・ドテン 2 行・shot の任意フィールド・サイドカー ocr.json）のうち、DB を使わない部分。
// DB を通した一連の流れ（取り込み → 確定 → ラウンド → 書き出し）は flow.test.ts。
import { describe, expect, it } from 'vitest';
import { parseEventLine, parseEventsText } from '@/lib/paper/events';
import { resolveOrder, type BarLite, type ResolveOrder } from '@/lib/paper/resolve';
import { parseSidecar } from '@/lib/paper/sidecar';
import { buildPaperRounds, SCREEN_SYMBOL_MISMATCH_WARNING } from '@/lib/rounds/builder';
import { screenSymbolMismatch } from '@/lib/rounds/rebuild';
import type { ExecForRound } from '@/lib/rounds/types';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jst = (hms: string) => new Date(`2026-10-05T${hms}+09:00`);
const bar = (hm: string, low: number, high: number, close = (low + high) / 2): BarLite => ({ ts: jst(`${hm}:00`), open: close, high, low, close });

function order(p: Record<string, unknown>, shot: Record<string, unknown> | null = {}): string {
  return JSON.stringify({
    v: 1,
    id: U(1),
    type: 'order',
    ts: '2026-10-05T10:05:20.123+09:00',
    position_id: U(900),
    intent: 'open',
    symbol: '7203',
    side: 'buy',
    qty: '100',
    order_type: 'market',
    limit_price: null,
    shot:
      shot === null
        ? null
        : { path: `shots/2026-10-05/${U(1)}.png`, price_text: '1,010', price: '1010', symbol_text: '7203', confidence: 0.99, ...shot },
    ...p,
  });
}

describe('order.shot の任意フィールド（captured_at / window_title / ocr_path）', () => {
  it('3 つとも読める', () => {
    const r = parseEventLine(
      order({}, { captured_at: '2026-10-05T10:05:20.973+09:00', window_title: '全板　フジクラ(5803)', ocr_path: `shots/2026-10-05/${U(1)}.ocr.json` }),
      1,
    );
    expect(r.ok).toBe(true);
    const s = r.ok && r.event.type === 'order' ? r.event.shot : null;
    expect(s?.capturedAt?.toISOString()).toBe('2026-10-05T01:05:20.973Z');
    expect(s?.windowTitle).toBe('全板　フジクラ(5803)');
    expect(s?.ocrPath).toBe(`shots/2026-10-05/${U(1)}.ocr.json`);
  });
  it('無い行は従来どおり（キー自体が載らない）', () => {
    const r = parseEventLine(order({}), 1);
    const s = r.ok && r.event.type === 'order' ? r.event.shot : null;
    expect(s).toEqual({ path: `shots/2026-10-05/${U(1)}.png`, priceText: '1,010', price: '1010', symbolText: '7203', confidence: 0.99 });
    expect(s && 'capturedAt' in s).toBe(false);
  });
  it('window_title は null 可', () => {
    const r = parseEventLine(order({}, { window_title: null }), 1);
    expect(r.ok && r.event.type === 'order' && r.event.shot?.windowTitle).toBeNull();
  });
  it('captured_at の書式違反・ocr_path の絶対パス / .. は契約違反', () => {
    expect(parseEventLine(order({}, { captured_at: '2026-10-05T10:05:20+09:00' }), 1).ok).toBe(false);
    expect(parseEventLine(order({}, { ocr_path: '/etc/passwd' }), 1).ok).toBe(false);
    expect(parseEventLine(order({}, { ocr_path: 'shots/../../x.ocr.json' }), 1).ok).toBe(false);
  });
  it('契約に無いキーは今までどおり弾く', () => {
    expect(parseEventLine(order({}, { foo: 1 }), 1).ok).toBe(false);
  });
});

describe('ドテン: 同じ ts・同じ shot の close + open の 2 行', () => {
  const shot = { path: 'shots/2026-10-05/doten.png', captured_at: '2026-10-05T10:05:21.000+09:00', window_title: null, ocr_path: 'shots/2026-10-05/doten.ocr.json' };
  const text = [
    order({ id: U(1), ts: '2026-10-05T10:00:10.000+09:00', intent: 'open', side: 'buy', qty: '100' }),
    order({ id: U(2), intent: 'close', side: 'sell', qty: '100' }, shot),
    order({ id: U(3), position_id: U(901), intent: 'open', side: 'sell', qty: '50' }, shot),
  ].join('\n');

  it('2 行とも採用され、2 行目は新しい建玉の open', () => {
    const p = parseEventsText(text);
    expect(p.errors).toEqual([]);
    expect(p.orders.map((o) => [o.id, o.positionId, o.intent, o.side, o.qty])).toEqual([
      [U(1), U(900), 'open', 'buy', '100'],
      [U(2), U(900), 'close', 'sell', '100'],
      [U(3), U(901), 'open', 'sell', '50'],
    ]);
    expect(p.orders[1].ts.getTime()).toBe(p.orders[2].ts.getTime());
    expect(p.orders[1].shot?.path).toBe(p.orders[2].shot?.path);
  });

  it('ラウンドは建玉 ID ごとに分かれ、損益もそれぞれで出る', () => {
    const t = (hms: string) => jst(hms);
    const ex = (id: string, positionId: string, side: 'BUY' | 'SELL', qty: string, price: string, at: Date): ExecForRound => ({
      id,
      source: 'PAPER',
      instrumentId: 1,
      account: 'paper',
      marginType: null,
      positionId,
      executedAt: at,
      timePrecision: 'ms',
      seq: 0,
      side,
      qty,
      price,
      fee: '0',
      priceStatus: 'CONFIRMED',
      dedupeHash: null,
    });
    const rounds = buildPaperRounds([
      ex('a1', U(900), 'BUY', '100', '1000', t('10:00:10.000')),
      ex('a2', U(900), 'SELL', '100', '1010', t('10:05:20.123')),
      ex('b1', U(901), 'SELL', '50', '1010', t('10:05:20.123')),
      ex('b2', U(901), 'BUY', '50', '1005', t('10:10:30.000')),
    ]);
    expect(rounds.map((r) => [r.id, r.direction, r.status, r.qtyOpened, r.realizedPnl, r.netPnl, r.warnings])).toEqual([
      [U(900), 'LONG', 'CLOSED', '100', '1000', '1000', []],
      [U(901), 'SHORT', 'CLOSED', '50', '250', '250', []],
    ]);
    expect(rounds[0].closedAt?.getTime()).toBe(rounds[1].openedAt.getTime());
  });
});

describe('サイドカー（ocr.json）のパース', () => {
  const sample = {
    v: 1,
    width: 3074,
    height: 2714,
    captured_at: '2026-10-05T10:05:20.973+09:00',
    window_title: '全板　フジクラ(5803)',
    auto: { price: '5566', price_text: '5,566', price_time: '15:30', symbol: '5803', source: 'label' },
    items: [{ text: '現在値', conf: 0.98, x: 0.27, y: 0.06, w: 0.02, h: 0.01 }],
  };
  it('契約の見本を読める', () => {
    expect(parseSidecar(JSON.stringify(sample))).toEqual({
      ok: true,
      auto: { price: '5566', priceText: '5,566', priceTime: '15:30', symbol: '5803', source: 'label' },
    });
  });
  it('auto の各値は null 可（読めなかった）', () => {
    const r = parseSidecar(JSON.stringify({ ...sample, auto: { price: null, price_text: null, price_time: null, symbol: null, source: null } }));
    expect(r).toEqual({ ok: true, auto: { price: null, priceText: null, priceTime: null, symbol: null, source: null } });
  });
  it('書きかけ（JSON が途中で切れている）・形式違反は読めない扱い', () => {
    expect(parseSidecar(JSON.stringify(sample).slice(0, 40)).ok).toBe(false);
    expect(parseSidecar(JSON.stringify({ ...sample, v: 2 })).ok).toBe(false);
    expect(parseSidecar(JSON.stringify({ ...sample, auto: { ...sample.auto, price: '5,566' } })).ok).toBe(false);
    expect(parseSidecar(JSON.stringify({ ...sample, auto: { ...sample.auto, source: 'ocr' } })).ok).toBe(false);
  });
});

describe('規則 2 の追加: 自動読取（auto.price）で確定', () => {
  const mkt = (p: Partial<ResolveOrder>): ResolveOrder => ({
    orderType: 'market',
    side: 'buy',
    limitPrice: null,
    placedAt: jst('10:00:30.000'),
    state: 'MARKET',
    fillMarkedAt: null,
    shotPrice: null,
    autoPrice: null,
    autoSource: null,
    ...p,
  });
  const bars = [bar('10:00', 995, 1005, 1003)];

  it('領域が読めず、自動読取が同じ分足の範囲内 → 確定（SCREEN_AUTO）', () => {
    const r = resolveOrder(mkt({ autoPrice: '1001', autoSource: 'label' }), bars, null);
    expect(r).toMatchObject({ kind: 'FILL', price: '1001', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN_AUTO' });
    expect((r as { priceNote: string }).priceNote).toMatch(/手で囲んだ領域の現在値が読めない.*自動読取（label）の現在値 1001 で確定/);
  });
  it('領域の値が足の外でも、自動読取が範囲内なら確定', () => {
    const r = resolveOrder(mkt({ shotPrice: '1100', autoPrice: '1004' }), bars, null);
    expect(r).toMatchObject({ price: '1004', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN_AUTO' });
    expect((r as { priceNote: string }).priceNote).toMatch(/1100/);
  });
  it('領域の値が範囲内なら領域を優先（SCREEN のまま）', () => {
    const r = resolveOrder(mkt({ shotPrice: '1000', autoPrice: '1004' }), bars, null);
    expect(r).toMatchObject({ price: '1000', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN', priceNote: null });
  });
  it('自動読取も範囲外 → 足の終値を仮置きして要確認', () => {
    const r = resolveOrder(mkt({ autoPrice: '1200', autoSource: 'region' }), bars, null);
    expect(r).toMatchObject({ price: '1003', priceStatus: 'NEEDS_REVIEW', priceBasis: 'BAR' });
    expect((r as { priceNote: string }).priceNote).toMatch(/自動読取（region）の現在値 1200 がその分の足 \[995, 1005\] の外/);
  });
  it('その分の分足が無ければ自動読取では確定しない（日足があっても）', () => {
    const r = resolveOrder(mkt({ autoPrice: '1001' }), [], { ts: jst('00:00:00'), open: 990, high: 1050, low: 950, close: 1000 });
    expect(r).toMatchObject({ price: null, priceStatus: 'UNRESOLVED' });
  });
});

describe('撮影画面の銘柄と発注銘柄の食い違い', () => {
  it('読めていなければ比べない、同じなら何もしない、違えば組を返す', () => {
    expect(screenSymbolMismatch(null, '7203')).toBeNull();
    expect(screenSymbolMismatch('', '7203')).toBeNull();
    expect(screenSymbolMismatch('7203', '7203')).toBeNull();
    expect(screenSymbolMismatch('5803', '7203')).toEqual({ screen: '5803', order: '7203' });
  });
  it('ラウンドの警告に残る（同じ組は 1 回だけ）', () => {
    const base = { source: 'PAPER' as const, instrumentId: 1, account: 'paper', marginType: null, positionId: U(900), timePrecision: 'ms' as const, seq: 0, fee: '0', priceStatus: 'CONFIRMED' as const, dedupeHash: null, qty: '100', price: '1000' };
    const m = { screen: '5803', order: '7203' };
    const [r] = buildPaperRounds([
      { ...base, id: 'x1', side: 'BUY', executedAt: jst('10:00:00.000'), screenSymbolMismatch: m },
      { ...base, id: 'x2', side: 'SELL', executedAt: jst('10:01:00.000'), screenSymbolMismatch: m },
    ]);
    expect(r.warnings).toEqual([`${SCREEN_SYMBOL_MISMATCH_WARNING}（画面 5803 / 発注 7203）`]);
  });
});

describe('検証済みの現在値（成行と指値の即約定で同じ値を使う）', () => {
  const lmt = (p: Partial<ResolveOrder>): ResolveOrder => ({
    orderType: 'limit',
    side: 'buy',
    limitPrice: '990',
    placedAt: jst('10:00:30.000'),
    state: 'PENDING',
    fillMarkedAt: null,
    shotPrice: null,
    autoPrice: null,
    autoSource: null,
    ...p,
  });
  const bars = [bar('10:00', 995, 1005, 1003)];

  it('指摘3: 領域の誤読 980 で即約定にしない（検証済みの現在値は auto 1001 > 買い指値 990）', () => {
    const r = resolveOrder(lmt({ shotPrice: '980', autoPrice: '1001', autoSource: 'label' }), bars, null);
    expect(r).toEqual({ kind: 'NO_FILL', reason: 'PENDING' });
  });
  it('指摘3: 誤読で即約定にせず、fill_mark があれば以降の足で判定（足が指値を越えていなければ要確認）', () => {
    const r = resolveOrder(lmt({ shotPrice: '980', autoPrice: '1001', state: 'FILL_MARKED', fillMarkedAt: jst('10:00:50.000') }), bars, null);
    expect(r).toMatchObject({ price: '990', priceStatus: 'NEEDS_REVIEW', priceBasis: 'LIMIT' });
  });
  it('指摘7: 領域が読めず auto.price だけ読めた即約定の指値は、auto の値で即約定（SCREEN_AUTO）', () => {
    const r = resolveOrder(lmt({ limitPrice: '1010', autoPrice: '1001', autoSource: 'label' }), bars, null);
    expect(r).toMatchObject({ kind: 'FILL', executedAt: jst('10:00:30.000'), price: '1001', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN_AUTO' });
  });
  it('指摘7: 状態が失効（auto だけで即約定と分かる指値）でも即約定を優先する', () => {
    const r = resolveOrder(lmt({ limitPrice: '1010', autoPrice: '1001', state: 'EXPIRED' }), bars, null);
    expect(r).toMatchObject({ price: '1001', priceStatus: 'CONFIRMED', priceBasis: 'SCREEN_AUTO' });
  });
  it('検証済みの現在値が無い指値は即約定にしない（領域も auto も足の外）', () => {
    const r = resolveOrder(lmt({ limitPrice: '1100', shotPrice: '1050', autoPrice: '1060' }), bars, null);
    expect(r).toEqual({ kind: 'NO_FILL', reason: 'PENDING' });
  });
});

describe('指摘4: 自動読取の銘柄が発注銘柄と違えば auto.price を使わない', () => {
  const mkt = (p: Partial<ResolveOrder>): ResolveOrder => ({
    orderType: 'market',
    side: 'buy',
    limitPrice: null,
    placedAt: jst('10:00:30.000'),
    state: 'MARKET',
    fillMarkedAt: null,
    shotPrice: null,
    autoPrice: '1001',
    autoSource: 'label',
    symbol: '7203',
    autoSymbol: '5803',
    ...p,
  });
  const bars = [bar('10:00', 995, 1005, 1003)];

  it('価格帯が重なっても確定しない（足の終値を仮置きして要確認、理由を注記）', () => {
    const r = resolveOrder(mkt({}), bars, null);
    expect(r).toMatchObject({ price: '1003', priceStatus: 'NEEDS_REVIEW', priceBasis: 'BAR' });
    expect((r as { priceNote: string }).priceNote).toMatch(/画面の銘柄 5803 が発注 7203 と違う/);
  });
  it('即約定の指値の判定にも使わない', () => {
    const r = resolveOrder(mkt({ orderType: 'limit', limitPrice: '1010', state: 'PENDING' }), bars, null);
    expect(r).toEqual({ kind: 'NO_FILL', reason: 'PENDING' });
  });
  it('追加1: 同じ画面から読んだ領域の値（shot.price）も使わない（範囲内でも確定しない）', () => {
    const r = resolveOrder(mkt({ shotPrice: '1000' }), bars, null);
    expect(r).toMatchObject({ price: '1003', priceStatus: 'NEEDS_REVIEW', priceBasis: 'BAR' });
    expect((r as { priceNote: string }).priceNote).toMatch(/画面の銘柄 5803 が発注 7203 と違う/);
    expect(resolveOrder(mkt({ shotPrice: '1000' }), [], { ts: jst('00:00:00'), open: 990, high: 1050, low: 950, close: 1000 })).toMatchObject({
      price: null,
      priceStatus: 'UNRESOLVED',
    });
    expect(resolveOrder(mkt({ orderType: 'limit', limitPrice: '1010', state: 'PENDING', shotPrice: '1000' }), bars, null)).toEqual({
      kind: 'NO_FILL',
      reason: 'PENDING',
    });
  });
  it('追加1: auto.symbol が null なら領域の値は従来どおり使う', () => {
    expect(resolveOrder(mkt({ shotPrice: '1000', autoSymbol: null }), bars, null)).toMatchObject({ price: '1000', priceBasis: 'SCREEN' });
  });
  it('銘柄が同じ・読めていないときは従来どおり使う', () => {
    expect(resolveOrder(mkt({ autoSymbol: '7203' }), bars, null)).toMatchObject({ price: '1001', priceBasis: 'SCREEN_AUTO' });
    expect(resolveOrder(mkt({ autoSymbol: null }), bars, null)).toMatchObject({ price: '1001', priceBasis: 'SCREEN_AUTO' });
  });
});
