// sidecar /moomoo/account-summary の薄い proxy。クライアントから直接呼べるように。
import { fetchMoomooAccountSummary } from '@/lib/moomoo/account-summary';

export const dynamic = 'force-dynamic';

export async function GET() {
  const r = await fetchMoomooAccountSummary();
  if (!r.ok) {
    return Response.json({ ok: false, error: r.error }, { status: 503 });
  }
  return Response.json({ ok: true, accounts: r.accounts, raw: r.raw });
}
