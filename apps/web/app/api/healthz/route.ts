import { prisma } from '@/lib/db';
import { sidecarHealth } from '@/lib/sidecar';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [dbResult, sidecar] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1 as ok`,
    sidecarHealth(),
  ]);

  const db = dbResult.status === 'fulfilled'
    ? { ok: true }
    : { ok: false, error: errString(dbResult.reason) };

  const sc = sidecar.status === 'fulfilled'
    ? sidecar.value
    : { ok: false, opend: 'unknown', yfinance: 'unknown', error: errString(sidecar.reason) };

  return Response.json({
    ok: db.ok,
    db,
    sidecar: sc,
    ts: new Date().toISOString(),
  });
}

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
