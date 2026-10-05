// events.jsonl → DB（PaperOrder / Shot / Memo / PaperEventLog）と、約定の確定（Execution）。
// ファイルは追記専用なので毎回全行を読み直す。DB への反映は id で冪等（何度流しても同じ結果）。

import type { PrismaClient } from '@/generated/prisma/client';
import { floorToMinute, jstAt, jstMinuteOfDay, jstYmd, SESSION } from '@/lib/time';
import { loadDailyBar, loadMinuteBars } from '@/lib/bars/store';
import { deriveOrderState, parseEventsText, type EventError } from './events';
import { manualResolution, resolveOrder } from './resolve';
import { readSidecar } from './sidecar';

export const PAPER_ACCOUNT = 'paper';

export type IngestReport = {
  lines: number;
  /** 取り込んだ注文（order 行）の数 */
  orders: number;
  accepted: number;
  newEvents: number;
  errors: EventError[];
  /** サイドカー（ocr.json）: 読めた数 / まだ無い数 / 読めなかったもの（書きかけ等。次回の daily で読み直す） */
  sidecars: { loaded: number; missing: number; errors: Array<{ orderId: string; path: string; message: string }> };
};

async function instrumentId(db: PrismaClient, symbol: string): Promise<number> {
  const i = await db.instrument.upsert({
    where: { market_symbol: { market: 'TSE', symbol } },
    create: { symbol, market: 'TSE' },
    update: {},
  });
  return i.id;
}

/** @param opts.paperDir サイドカーの基準ディレクトリ（data/paper）。省略時はサイドカーを読まない */
export async function ingestPaperEvents(db: PrismaClient, text: string, now: Date, opts: { paperDir?: string } = {}): Promise<IngestReport> {
  const p = parseEventsText(text);
  const sidecars: IngestReport['sidecars'] = { loaded: 0, missing: 0, errors: [] };
  const logged = new Set((await db.paperEventLog.findMany({ select: { id: true } })).map((x) => x.id));

  for (const o of p.orders) {
    const fm = p.fillMarks.get(o.id);
    const cc = p.cancels.get(o.id);
    const state = deriveOrderState(o, fm, cc, now).toUpperCase() as 'MARKET' | 'PENDING' | 'FILL_MARKED' | 'CANCELLED' | 'EXPIRED';
    const instId = await instrumentId(db, o.symbol);
    // 発注内容はイベントから不変。状態（約定マーク・取消・失効）だけ毎回更新する
    await db.paperOrder.upsert({
      where: { id: o.id },
      create: {
        id: o.id,
        positionId: o.positionId,
        intent: o.intent.toUpperCase() as 'OPEN' | 'ADD' | 'CLOSE',
        side: o.side.toUpperCase() as 'BUY' | 'SELL',
        qty: o.qty,
        orderType: o.orderType.toUpperCase() as 'MARKET' | 'LIMIT',
        limitPrice: o.limitPrice,
        placedAt: o.ts,
        state,
        fillMarkedAt: fm?.ts ?? null,
        fillMarkId: fm?.id ?? null,
        cancelId: cc?.id ?? null,
        instrumentId: instId,
        rawJson: JSON.stringify(o.raw),
      },
      update: { state, fillMarkedAt: fm?.ts ?? null, fillMarkId: fm?.id ?? null, cancelId: cc?.id ?? null },
    });
    if (o.shot) {
      const s = o.shot;
      // order 行由来の値は不変だが、列を足す前に取り込んだ行にも入るよう毎回書く（同じ値なので冪等）
      const fromOrder = {
        capturedAt: s.capturedAt ?? null,
        captureDelayMs: s.capturedAt ? s.capturedAt.getTime() - o.ts.getTime() : null,
        windowTitle: s.windowTitle ?? null,
        ocrPath: s.ocrPath ?? null,
      };
      // サイドカーは後から書かれる。読めたときだけ反映し、まだ無い・読めないときは前回の値を残す
      let fromSidecar = {};
      if (s.ocrPath && opts.paperDir) {
        const sc = readSidecar(opts.paperDir, s.ocrPath);
        if (sc === null) sidecars.missing++;
        else if (!sc.ok) sidecars.errors.push({ orderId: o.id, path: s.ocrPath, message: sc.message });
        else {
          sidecars.loaded++;
          const a = sc.auto;
          fromSidecar = { ocrReadAt: now, autoPrice: a.price, autoPriceText: a.priceText, autoPriceTime: a.priceTime, autoSymbol: a.symbol, autoSource: a.source };
        }
      }
      await db.shot.upsert({
        where: { paperOrderId: o.id },
        create: {
          paperOrderId: o.id,
          path: s.path,
          priceText: s.priceText,
          price: s.price,
          symbolText: s.symbolText,
          confidence: s.confidence,
          ...fromOrder,
          ...fromSidecar,
        },
        update: { ...fromOrder, ...fromSidecar },
      });
    }
  }
  for (const m of p.memos) {
    await db.memo.upsert({
      where: { id: m.id },
      create: { id: m.id, positionId: m.positionId, orderId: m.orderId, ts: m.ts, text: m.text },
      update: {},
    });
  }
  const fresh = p.accepted.filter((e) => !logged.has(e.id));
  if (fresh.length) {
    await db.paperEventLog.createMany({ data: fresh.map((e) => ({ id: e.id, type: e.type, ts: e.ts, importedAt: now })) });
  }
  return {
    lines: text.split('\n').filter((l) => l.trim() !== '').length,
    orders: p.orders.length,
    accepted: p.accepted.length,
    newEvents: fresh.length,
    errors: p.errors,
    sidecars,
  };
}

export type ResolveReport = { confirmed: number; needsReview: number; unresolved: number; manualKept: number; noFill: number; removed: number };

/** すべての注文の約定を規則どおりに確定し直す。手入力（MANUAL）で確定済みのものは上書きしない */
export async function resolvePaperExecutions(db: PrismaClient): Promise<ResolveReport> {
  const rep: ResolveReport = { confirmed: 0, needsReview: 0, unresolved: 0, manualKept: 0, noFill: 0, removed: 0 };
  const orders = await db.paperOrder.findMany({ include: { shot: true, execution: true, instrument: { select: { symbol: true } } }, orderBy: { placedAt: 'asc' } });
  for (const o of orders) {
    if (o.execution?.priceBasis === 'MANUAL') {
      rep.manualKept++;
      continue;
    }
    // 昼休みの発注は後場寄り（12:30）の分足で約定するので、そこまで読む
    const pmOpen = jstAt(jstYmd(o.placedAt), SESSION.pmOpen);
    const end0 = o.fillMarkedAt ?? o.placedAt;
    const end = jstMinuteOfDay(o.placedAt) >= SESSION.amClose && end0 < pmOpen ? pmOpen : end0;
    const minuteBars = await loadMinuteBars(db, o.instrumentId, floorToMinute(o.placedAt), floorToMinute(end));
    const dailyBar = await loadDailyBar(db, o.instrumentId, jstYmd(o.placedAt));
    const r = resolveOrder(
      {
        orderType: o.orderType === 'MARKET' ? 'market' : 'limit',
        side: o.side === 'BUY' ? 'buy' : 'sell',
        limitPrice: o.limitPrice,
        placedAt: o.placedAt,
        state: o.state,
        fillMarkedAt: o.fillMarkedAt,
        shotPrice: o.shot?.price ?? null,
        autoPrice: o.shot?.autoPrice ?? null,
        autoSource: o.shot?.autoSource ?? null,
        // 撮影画面の銘柄が違えば auto.price は使わない（ラウンドの警告は rebuild 側で残る）
        symbol: o.instrument.symbol,
        autoSymbol: o.shot?.autoSymbol ?? null,
      },
      minuteBars,
      dailyBar,
    );
    if (r.kind === 'NO_FILL') {
      rep.noFill++;
      if (o.execution) {
        await db.execution.delete({ where: { id: o.execution.id } });
        rep.removed++;
      }
      continue;
    }
    // fill_mark 無しで約定した指値（検証済みの現在値で即約定・板寄せで約定）は、時刻だけで決めた EXPIRED / PENDING のままにせず
    // MARKET（成行と同じく発注で約定した）にする。失効の件数に数えないため
    if (o.orderType === 'LIMIT' && !o.fillMarkedAt && (o.state === 'EXPIRED' || o.state === 'PENDING')) {
      await db.paperOrder.update({ where: { id: o.id }, data: { state: 'MARKET' } });
    }
    const data = {
      executedAt: r.executedAt,
      price: r.price,
      priceStatus: r.priceStatus,
      priceBasis: r.priceBasis,
      priceNote: r.priceNote,
    };
    await db.execution.upsert({
      where: { paperOrderId: o.id },
      create: {
        ...data,
        source: 'PAPER',
        instrumentId: o.instrumentId,
        account: PAPER_ACCOUNT,
        timePrecision: 'ms',
        side: o.side,
        qty: o.qty,
        fee: '0',
        paperOrderId: o.id,
        rawJson: o.rawJson,
      },
      update: data,
    });
    if (r.priceStatus === 'CONFIRMED') rep.confirmed++;
    else if (r.priceStatus === 'NEEDS_REVIEW') rep.needsReview++;
    else rep.unresolved++;
  }
  return rep;
}

/** 要確認・未確定の約定を手入力で確定する（規則 4）。画面ができるまでは CLI/スクリプトから呼ぶ */
export async function setManualPrice(db: PrismaClient, executionId: string, price: string, note?: string) {
  const e = await db.execution.findUniqueOrThrow({ where: { id: executionId } });
  if (e.source !== 'PAPER') throw new Error('手入力で確定できるのはペーパーの約定だけ');
  return db.execution.update({ where: { id: executionId }, data: manualResolution(price, note) });
}
