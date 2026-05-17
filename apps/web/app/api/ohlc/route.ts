import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { fetchOhlc, type Timeframe } from '@/lib/ohlc/cache';

export const dynamic = 'force-dynamic';

const VALID_TF = new Set(['1m', '5m', '15m', '60m', '1h', '1d']);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const instrumentId = Number(sp.get('instrumentId'));
  const timeframe = (sp.get('timeframe') ?? '1d') as Timeframe;
  const start = sp.get('start');
  const end = sp.get('end');

  if (!Number.isFinite(instrumentId)) {
    return Response.json({ error: 'instrumentId required' }, { status: 400 });
  }
  if (!VALID_TF.has(timeframe)) {
    return Response.json({ error: 'invalid timeframe' }, { status: 400 });
  }
  if (!start || !end) {
    return Response.json({ error: 'start and end required (yyyy-mm-dd)' }, { status: 400 });
  }

  const inst = await prisma.instrument.findUnique({ where: { id: instrumentId } });
  if (!inst) {
    return Response.json({ error: 'instrument not found' }, { status: 404 });
  }

  const market: 'JP' | 'US' = inst.kind === 'EQUITY_JP' ? 'JP' : 'US';
  // OPTION_US は OCC 形式 (例: 'MSFT  260515C00415000') を sidecar に渡す。
  // sidecar はオプション本体のみ取得 (underlying へのフォールバックは廃止)。失敗時は 404 → UI でエラー表示。
  const occSymbol = inst.kind === 'OPTION_US' ? inst.occSymbol ?? undefined : undefined;

  try {
    const { bars, source } = await fetchOhlc({
      instrumentId,
      market,
      symbol: inst.symbol,
      occSymbol,
      timeframe,
      start,
      end,
    });
    return Response.json({
      bars,
      source,
      instrument: { id: inst.id, symbol: inst.symbol, ccy: inst.ccy, kind: inst.kind },
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
