// 発注時スクショの配信。shots ディレクトリ配下の PNG だけ返す（検査は lib/paper/shots.ts）。
import fs from 'node:fs';
import { resolveShotFile, shotsDir } from '@/lib/paper/shots';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: segs } = await ctx.params;
  let decoded: string[];
  try {
    decoded = segs.map((s) => decodeURIComponent(s));
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  const file = resolveShotFile(shotsDir(), decoded);
  if (!file) return new Response('Not Found', { status: 404 });
  const body = fs.readFileSync(file);
  return new Response(body, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' },
  });
}
