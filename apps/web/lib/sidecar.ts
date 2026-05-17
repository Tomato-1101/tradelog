// ローカル他プロセスとの衝突を避けるため 8770 に固定。
// 必要なら SIDECAR_URL 環境変数で上書き可。
const SIDECAR_URL = process.env.SIDECAR_URL ?? 'http://127.0.0.1:8770';

export type SidecarHealth = {
  ok: boolean;
  opend: 'connected' | 'disconnected' | 'unknown';
  yfinance: 'ok' | 'unknown';
  error?: string;
};

export async function sidecarHealth(): Promise<SidecarHealth> {
  try {
    const res = await fetch(`${SIDECAR_URL}/healthz`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return { ok: false, opend: 'unknown', yfinance: 'unknown', error: `HTTP ${res.status}` };
    }
    return (await res.json()) as SidecarHealth;
  } catch (e) {
    return {
      ok: false,
      opend: 'unknown',
      yfinance: 'unknown',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function sidecarUrl(path: string): string {
  return `${SIDECAR_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
